import { describe, it } from 'vitest';
import { createDirectSimHost } from '../src/host/directHost.js';
import { NEIGHBOUR, PLAYER, seedOpening } from '../src/host/opening.js';
import { createAi } from '../src/sim/ai/opponent.js';
import { EventType } from '../src/shared/events.js';
import { FactionId } from '../src/shared/factions/index.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { runTicks } from '../src/sim/loop.js';
import { createHeightmap } from '../src/sim/terrain/generate.js';
import { generateMap, type MapScript } from '../src/sim/terrain/maps.js';
import { tuning } from '../src/sim/tuning.js';
import { EntityKind, handleIndex, createWorld, packHandle } from '../src/sim/world.js';
import { BuildingType } from '../src/shared/buildings/index.js';
import { CommandKind } from '../src/sim/commands.js';

/**
 * The soak: whole matches on the real opening, measured.
 *
 * `npm run soak` (SOAK=1). Not part of `npm test` — it runs years of simulation per seed
 * and prints a table rather than asserting, because what it is for is the before-and-after
 * of a retune (roadmap Phase B3), and a number that has to be looked at is not a gate.
 *
 * It seeds the opening through `seedOpening`, the same function main.ts calls, so the
 * village, the people and the herds are the ones a player gets — the rule in CLAUDE.md
 * about a harness that skips the starting force exists because one did.
 *
 * Player 0 gives no orders at all: work finds its own people now (Phase B2), so an
 * untouched village is a real baseline — the floor a player starts from, not a corpse.
 * Player 1 is the computer neighbour, which builds, trains and trades.
 */

const MAP_SIZE = 128;
const WORLD_SEED = 0x5eedcafe;
const YEARS = Number(process.env.SOAK_YEARS ?? 3);
const SEEDS = (process.env.SOAK_SEEDS ?? '0x4d666563,0x3a7,0xbeef,0xf00d,0x51de,0xa11ce')
  .split(',')
  .map((s) => Number(s));
const SCRIPT = (process.env.SOAK_MAP ?? '') as MapScript | '';

interface Tally {
  hungrySeasons: number;
  starved: number;
  deaths: number;
  /** Deaths of someone who had gone hungry in the last two seasons. The rest were crushed. */
  hungerDeaths: number;
  start: number;
  peak: number;
  end: number;
  minGrain: number;
  endGrain: number;
  firstHungryYear: number;
}

export interface SoakResult {
  seed: number;
  players: Tally[];
  stampedes: number;
}

export function soak(seed: number, years = YEARS, script: MapScript | '' = SCRIPT): SoakResult {
  const map = script === '' ? createHeightmap(MAP_SIZE, MAP_SIZE, seed) : generateMap(script, MAP_SIZE, MAP_SIZE, seed);
  const world = createWorld(512, WORLD_SEED);
  const centre = MAP_SIZE / 2;
  const host = createDirectSimHost({
    world,
    map,
    viewerId: PLAYER,
    playerId: PLAYER,
    neighbours: [NEIGHBOUR],
    factions: [FactionId.Zulu, FactionId.Sotho],
    starts: [{ x: centre, y: centre }],
  });
  // SOAK_POLICY=ai: the computer plays player 0, as a village "played well" — the AI
  // no longer runs in the game (ADR-0021), and this is what it is kept for.
  if (process.env.SOAK_POLICY === 'ai') host.loop.ai.push({ player: PLAYER, controller: createAi(PLAYER) });
  seedOpening((kind, a, b, c, d) => host.sendCommand(kind, a, b, c, d), map, centre);

  const players: Tally[] = [0, 1].map(() => ({
    hungrySeasons: 0,
    starved: 0,
    deaths: 0,
    hungerDeaths: 0,
    start: 0,
    peak: 0,
    end: 0,
    minGrain: Infinity,
    endGrain: 0,
    firstHungryYear: -1,
  }));
  let stampedes = 0;
  /** Handle -> tick it last went hungry. */
  const hungry = new Map<number, number>();

  const people = (owner: number): number => {
    let n = 0;
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] === 1 && world.kind[i] === EntityKind.Unit && world.faction[i] === owner) n++;
    }
    return n;
  };

  /*
   * SOAK_POLICY=greedy: player 0 raises a household at every homestead every season it
   * can afford one, whatever the land feeds. The bad decision the readout warns about —
   * so the soak can say whether starvation still follows from it.
   */
  const greedy = process.env.SOAK_POLICY === 'greedy';
  const homesteads = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Building || world.faction[i] !== 0) continue;
      if (world.buildingType[i] === BuildingType.Umuzi) out.push(packHandle(i, world.generation[i]!));
    }
    return out;
  };

  const season = tuning.economy.upkeepIntervalTicks;
  const total = Math.round(years * tuning.economy.seasonTicks);
  for (let tick = 0; tick < total; tick += season) {
    if (greedy) {
      for (const hut of homesteads()) host.sendCommand(CommandKind.Train, hut, 0, 0, 0);
    }
    runTicks(host.loop, season);
    for (const event of host.loop.events) {
      if (event.type === EventType.StampedeBegan) stampedes++;
      if (event.type === EventType.Starved || event.type === EventType.Died) {
        const owner = world.faction[handleIndex(event.handle)]!;
        if (owner > 1) continue;
        if (event.type === EventType.Starved) {
          players[owner]!.starved++;
          hungry.set(event.handle, event.tick);
        } else {
          players[owner]!.deaths++;
          const last = hungry.get(event.handle);
          if (last !== undefined && event.tick - last <= season * 2) players[owner]!.hungerDeaths++;
        }
      }
    }
    host.loop.events.length = 0;

    if (process.env.SOAK_TRACE === '1' && world.tick % (tuning.economy.seasonTicks / 4) < season) {
      const e = host.economy;
      console.log(
        `TRACE y${(world.tick / tuning.economy.seasonTicks).toFixed(2)} p0 people ${people(0)} cattle ${Math.round(e.balance(0, Resource.Cattle))} grain ${Math.round(e.balance(0, Resource.Grain))} harvest ${Math.round(e.harvested[0] ?? 0)} upkeep ${Math.round(e.upkeep[0] ?? 0)} drought ${e.drought(world.tick).toFixed(2)} short ${host.labour.short[0]} | nbr grain ${Math.round(e.balance(1, Resource.Grain))} cattle ${Math.round(e.balance(1, Resource.Cattle))} wood ${Math.round(e.balance(1, Resource.Wood))} hungry ${e.shortfall[1]}`,
      );
    }
    for (const owner of [0, 1]) {
      const t = players[owner]!;
      const n = people(owner);
      if (tick === 0) t.start = n;
      t.peak = Math.max(t.peak, n);
      t.end = n;
      const grain = host.economy.balance(owner, Resource.Grain);
      t.minGrain = Math.min(t.minGrain, grain);
      t.endGrain = grain;
      if ((host.economy.shortfall[owner] ?? 0) > 0) {
        t.hungrySeasons++;
        if (t.firstHungryYear < 0) t.firstHungryYear = world.tick / tuning.economy.seasonTicks;
      }
    }
  }
  return { seed, players, stampedes };
}

describe.runIf(process.env.SOAK === '1')('soak', () => {
  it('prints a table', { timeout: 0 }, () => {
    const rows: string[] = [];
    const head =
      'seed        | who  | hungry | starved | deaths (hunger) | people s/peak/end | grain min/end | 1st hungry yr | stampedes';
    rows.push(head);
    const sums = [0, 1].map(() => ({ hungry: 0, deaths: 0, end: 0, n: 0 }));
    for (const seed of SEEDS) {
      const r = soak(seed);
      for (const owner of [0, 1]) {
        const t = r.players[owner]!;
        const s = sums[owner]!;
        s.hungry += t.hungrySeasons;
        s.deaths += t.deaths;
        s.end += t.end;
        s.n++;
        rows.push(
          [
            `0x${seed.toString(16).padEnd(9)}`,
            owner === 0 ? (process.env.SOAK_POLICY ?? 'idle').slice(0, 4).padEnd(4) : 'nbr ',
            String(t.hungrySeasons).padStart(6),
            String(t.starved).padStart(7),
            `${t.deaths} (${t.hungerDeaths})`.padStart(15),
            `${t.start}/${t.peak}/${t.end}`.padStart(17),
            `${Math.round(t.minGrain)}/${Math.round(t.endGrain)}`.padStart(13),
            (t.firstHungryYear < 0 ? '-' : t.firstHungryYear.toFixed(2)).padStart(13),
            owner === 0 ? String(r.stampedes).padStart(9) : '',
          ].join(' | '),
        );
      }
    }
    for (const owner of [0, 1]) {
      const s = sums[owner]!;
      rows.push(
        `mean ${owner === 0 ? (process.env.SOAK_POLICY ?? 'idle') : 'neighbour'}: hungry seasons ${(s.hungry / s.n).toFixed(1)}, deaths ${(s.deaths / s.n).toFixed(1)}, people at end ${(s.end / s.n).toFixed(1)}`,
      );
    }
    console.log(`\nSOAK ${YEARS} years, map ${SCRIPT === '' ? 'veld' : SCRIPT}\n${rows.join('\n')}`);
  });
});
