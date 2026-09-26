import { afterEach, describe, expect, it } from 'vitest';
import { BuildingType } from '../src/shared/buildings/index.js';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { Species } from '../src/shared/wildlife.js';
import { CommandKind, makeCommand } from '../src/sim/commands.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { Work } from '../src/sim/labour.js';
import { enqueueCommand, step } from '../src/sim/loop.js';
import { tuning } from '../src/sim/tuning.js';
import { spawnWild, speciesTuning } from '../src/sim/wildlife.js';
import { EntityKind, handleIndex, NULL_HANDLE, spawn } from '../src/sim/world.js';
import { flatMap, foundHomestead, makeSim, type Harness } from './simHarness.js';

/**
 * Hunting (ADR-0022): most hunts fail, a kill pays far more than a season's field, the
 * big ones can fight back, and hunters come both from a camp and from a direct order.
 */

const H = tuning.wildlife.hunting;
const species = tuning.wildlife.species as Record<string, { huntChance: number; fightBack: number }>;

/** Tuning overrides for a test, put back afterwards so no other test sees them. */
const saved: [Record<string, number>, string, number][] = [];
function override(table: Record<string, number>, key: string, value: number): void {
  saved.push([table, key, table[key]!]);
  table[key] = value;
}
afterEach(() => {
  while (saved.length > 0) {
    const [table, key, value] = saved.pop()!;
    table[key] = value;
  }
});

function veld(): Harness {
  return makeSim(512, 3, flatMap(64, 2));
}

let seq = 0;
function send(sim: Harness, player: number, kind: CommandKind, a = 0, b = 0): void {
  enqueueCommand(sim.loop, makeCommand(sim.world.tick, player, seq++, kind, a, b));
}

function run(sim: Harness, ticks: number, until?: (events: readonly SimEvent[]) => boolean): SimEvent[] {
  const seen: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    step(sim.loop);
    seen.push(...sim.loop.events);
    if (until?.(sim.loop.events)) break;
  }
  return seen;
}

const hunted = (events: readonly SimEvent[]): boolean => events.some((e) => e.type === EventType.Hunted);

describe('a direct hunt', () => {
  it('brings the animal down, and its meat and hide home, when the strike lands', () => {
    override(species.impala as unknown as Record<string, number>, 'huntChance', 1);
    const sim = veld();
    const person = spawn(sim.world, 20, 20, 0);
    const impala = spawnWild(sim.world, 32, 20, Species.Impala, 1);
    const skins = sim.economy.balance(0, Resource.Skins);
    send(sim, 0, CommandKind.Hunt, person, impala);
    const events = run(sim, H.pursueTicks, hunted);

    expect(hunted(events)).toBe(true);
    expect(sim.world.alive[handleIndex(impala)]).toBe(0);
    expect(sim.economy.balance(0, Resource.Skins)).toBe(skins + speciesTuning(Species.Impala).skins);
    expect(sim.economy.balance(0, Resource.Meat)).toBeGreaterThan(0);
  });

  it('gets within a spear\'s throw before the impala bolts, because a stalker is seen late', () => {
    override(species.impala as unknown as Record<string, number>, 'huntChance', 1);
    // Open ground far from any edge, so nothing but the stalk can bring the hunter close:
    // a bolting impala pinned against the map's edge would be caught by persistence.
    const sim = makeSim(512, 3, flatMap(128, 2));
    const person = spawn(sim.world, 50, 64, 0);
    const impala = spawnWild(sim.world, 64, 64, Species.Impala, 1);
    const index = handleIndex(impala);
    send(sim, 0, CommandKind.Hunt, person, impala);
    let bolted = false;
    const events = run(sim, H.pursueTicks, (e) => {
      if (sim.world.alive[index] === 1 && sim.world.stampedeTicks[index]! > 0) bolted = true;
      return hunted(e);
    });
    expect(hunted(events)).toBe(true);
    expect(bolted).toBe(false);
  });

  it('usually fails', () => {
    // The shipped odds, over many hunts of the same kind.
    let kills = 0;
    const trials = 24;
    for (let trial = 0; trial < trials; trial++) {
      const sim = makeSim(512, 100 + trial, flatMap(64, 2));
      const person = spawn(sim.world, 20, 20 + (trial % 5), 0);
      const kudu = spawnWild(sim.world, 30, 22, Species.Kudu, 1 + trial);
      send(sim, 0, CommandKind.Hunt, person, kudu);
      if (hunted(run(sim, H.pursueTicks, hunted))) kills++;
    }
    expect(kills).toBeLessThan(trials / 2);
  });

  it('pays ivory for an elephant', () => {
    override(species.elephant as unknown as Record<string, number>, 'huntChance', 1);
    override(species.elephant as unknown as Record<string, number>, 'fightBack', 0);
    const sim = veld();
    const person = spawn(sim.world, 20, 20, 0);
    const elephant = spawnWild(sim.world, 28, 20, Species.Elephant, 1);
    send(sim, 0, CommandKind.Hunt, person, elephant);
    run(sim, H.pursueTicks, hunted);
    expect(sim.economy.balance(0, Resource.Ivory)).toBe(speciesTuning(Species.Elephant).ivory);
  });

  it('can end with a buffalo turning on the hunter — laid up, not killed', () => {
    override(species.buffalo as unknown as Record<string, number>, 'huntChance', 0);
    override(species.buffalo as unknown as Record<string, number>, 'fightBack', 1);
    const sim = veld();
    const person = spawn(sim.world, 20, 20, 0);
    const buffalo = spawnWild(sim.world, 28, 20, Species.Buffalo, 1);
    send(sim, 0, CommandKind.Hunt, person, buffalo);
    const events = run(sim, H.pursueTicks, (e) => e.some((x) => x.type === EventType.Mauled));
    const index = handleIndex(person);
    expect(events.some((e) => e.type === EventType.Mauled)).toBe(true);
    expect(sim.world.alive[index]).toBe(1);
    expect(sim.world.injured[index]).toBeGreaterThan(0);
    expect(sim.world.hp[index]).toBeGreaterThanOrEqual(1);
  });

  it('is refused for a predator, and for scenery', () => {
    const sim = veld();
    const person = spawn(sim.world, 20, 20, 0);
    const lion = spawnWild(sim.world, 28, 20, Species.Lion, 1);
    const fowl = spawnWild(sim.world, 28, 26, Species.GuineaFowl, 2);
    send(sim, 0, CommandKind.Hunt, person, lion);
    send(sim, 0, CommandKind.Hunt, person, fowl);
    run(sim, 2);
    expect(sim.world.quarry[handleIndex(person)]).toBe(NULL_HANDLE);
  });

  it('is refused for somebody else\'s people', () => {
    const sim = veld();
    const person = spawn(sim.world, 20, 20, 0);
    const impala = spawnWild(sim.world, 28, 20, Species.Impala, 1);
    send(sim, 1, CommandKind.Hunt, person, impala);
    run(sim, 2);
    expect(sim.world.quarry[handleIndex(person)]).toBe(NULL_HANDLE);
  });

  it('is refused for the laid-up', () => {
    const sim = veld();
    const person = spawn(sim.world, 20, 20, 0);
    sim.world.injured[handleIndex(person)] = 500;
    const impala = spawnWild(sim.world, 28, 20, Species.Impala, 1);
    send(sim, 0, CommandKind.Hunt, person, impala);
    run(sim, 2);
    expect(sim.world.quarry[handleIndex(person)]).toBe(NULL_HANDLE);
  });
});

describe('a hunters\' camp', () => {
  function withCamp() {
    const sim = veld();
    expect(foundHomestead(sim, 0, 20, 20)).toBe(true);
    expect(foundHomestead(sim, 0, 26, 20, BuildingType.HuntersCamp)).toBe(true);
    for (let n = 0; n < 5; n++) spawn(sim.world, 22 + n, 23, 0);
    return sim;
  }

  it('draws its hunters from the village without being told', () => {
    const sim = withCamp();
    run(sim, tuning.labour.intervalTicks * 3);
    let hunters = 0;
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] === 1 && sim.world.kind[i] === EntityKind.Unit && sim.world.workKind[i] === Work.Hunt) hunters++;
    }
    expect(hunters).toBe(3);
  });

  it('sends them out after game in range, and brings a kill home', () => {
    override(species.zebra as unknown as Record<string, number>, 'huntChance', 1);
    const sim = withCamp();
    for (let n = 0; n < 6; n++) spawnWild(sim.world, 44 + (n % 3), 30 + Math.floor(n / 3), Species.Zebra, 4);
    const events = run(sim, 6000, hunted);
    expect(hunted(events)).toBe(true);
    const kill = events.find((e) => e.type === EventType.Hunted)!;
    expect(kill.payload % 16).toBe(0); // the village's own larder
    expect(Math.floor(kill.payload / 16)).toBe(Species.Zebra);
  });

  it('does not chase game beyond its range', () => {
    override(species.zebra as unknown as Record<string, number>, 'huntChance', 1);
    const sim = withCamp();
    // Far corner, well past the camp's reach.
    spawnWild(sim.world, 26 + H.huntRange + 4, 20 + 2, Species.Zebra, 4);
    run(sim, 1500);
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.kind[i] === EntityKind.Unit) expect(sim.world.quarry[i]).toBe(NULL_HANDLE);
    }
  });
});
