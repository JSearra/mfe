import { describe, expect, it } from 'vitest';
import { BuildingType, BUILDINGS } from '../src/shared/buildings/index.js';
import { EventType } from '../src/shared/events.js';
import { heightmapWithWater, isShore } from '../src/shared/heightmap.js';
import { CommandKind, makeCommand } from '../src/sim/commands.js';
import { Work, idleOf } from '../src/sim/labour.js';
import { enqueueCommand, runTicks } from '../src/sim/loop.js';
import { hashWorld } from '../src/sim/replay.js';
import { tuning } from '../src/sim/tuning.js';
import { EntityKind, handleIndex, packHandle, spawn, type World } from '../src/sim/world.js';
import { flatMap, foundHomestead, makeSim, type Harness } from './simHarness.js';
import { PlacementResult } from '../src/sim/construction.js';
import { Role, roleOf } from '../src/sim/roles.js';
import { IMPASSABLE, MovementClass } from '../src/sim/pathing/costs.js';

/**
 * Work finds its own people (ADR-0020, roadmap Phase B2).
 *
 * Every test here runs the whole loop on a world with a village in it — founded
 * homestead, starting fields, villagers — because the allocator's job is to move people
 * through the real pathing onto the real places, and a test that assigned `workKind`
 * by hand would pass while nobody ever arrived.
 */

const L = tuning.labour;

function village(seed = 1, map = flatMap(32)): Harness {
  const sim = makeSim(256, seed, map, []);
  expect(foundHomestead(sim, 0, 8, 8)).toBe(true);
  return sim;
}

function villagers(sim: Harness, count: number, x = 12, y = 12, owner = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const handle = spawn(sim.world, x + (i % 4) * 0.6, y + Math.floor(i / 4) * 0.6, owner);
    out.push(handleIndex(handle));
  }
  return out;
}

function working(world: World, owner: number, kind: number): number {
  let n = 0;
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
    if (world.faction[i] === owner && world.workKind[i] === kind) n++;
  }
  return n;
}

function meanCondition(sim: Harness, owner: number): number {
  let total = 0;
  let n = 0;
  for (let f = 0; f < sim.farmland.count; f++) {
    if (sim.farmland.alive[f] === 0 || sim.farmland.owner[f] !== owner) continue;
    total += sim.farmland.condition[f]!;
    n++;
  }
  return total / n;
}

describe('work finds its own people', () => {
  it('puts free villagers on the fields without being told', () => {
    const sim = village();
    villagers(sim, 12);
    runTicks(sim.loop, L.intervalTicks + 1);
    expect(working(sim.world, 0, Work.Field)).toBeGreaterThan(0);
  });

  it('keeps the fields in condition where nobody has given an order', () => {
    // The rule that killed three playthroughs: a field loses condition every season
    // nobody stands on it. With the same people and no homestead, nothing sends anyone.
    const worked = village();
    villagers(worked, 14);
    const idle = makeSim(256, 1, flatMap(32), []);
    villagers(idle, 14);

    runTicks(worked.loop, 6000);
    runTicks(idle.loop, 6000);

    expect(meanCondition(worked, 0)).toBeGreaterThan(0.9);
    expect(meanCondition(idle, 0)).toBeLessThan(meanCondition(worked, 0) - 0.2);
  });

  it('leaves a world with no village in it alone', () => {
    const sim = makeSim(256, 1, flatMap(32), []);
    const people = villagers(sim, 6);
    runTicks(sim.loop, 200);
    for (const i of people) {
      expect(sim.world.workKind[i]).toBe(Work.None);
      expect(sim.world.hasTarget[i]).toBe(0);
    }
  });

  it('gives every place one pair of hands before any place gets a second', () => {
    // Few people, many places. Fields come first in priority; without the first round
    // they would soak up everybody and the kraal and the site would get nobody.
    const sim = village();
    const economy = sim.economy;
    sim.construction.place(sim.world, economy, 0, BuildingType.GrainStore, 12, 4, [], true);
    villagers(sim, 4);
    runTicks(sim.loop, L.intervalTicks + 1);

    // Four people, and more than four places asking: nobody may be doubled up.
    const perPlace = new Map<string, number>();
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] !== 1 || sim.world.kind[i] !== EntityKind.Unit) continue;
      const key = `${sim.world.workKind[i]}:${sim.world.workAt[i]}`;
      perPlace.set(key, (perPlace.get(key) ?? 0) + 1);
    }
    for (const [key, count] of perPlace) expect(count, key).toBe(1);
  });

  it('says so when work is waiting and nobody is free', () => {
    const sim = village();
    villagers(sim, 1);
    const every = tuning.economy.upkeepIntervalTicks * L.warnEverySeasons;
    runTicks(sim.loop, every + 1);
    const warned = sim.loop.events.some((e) => e.type === EventType.HandsShort && e.payload === 0);
    expect(warned).toBe(true);
    expect(sim.loop.labour.short[0]).toBeGreaterThan(0);
  });

  it('sends someone standing idle beyond the reach to work that is waiting', () => {
    // The reach is a preference for the nearer hand, not a wall. In a real opening three
    // people stood idle for a whole game at the far end of the village from a water bank
    // that was short of carriers, with the top bar reading "hands short".
    const sim = village(1, flatMap(64));
    const [far] = villagers(sim, 1, 56, 56);
    const dx = 56 - 8;
    expect(dx * Math.SQRT2).toBeGreaterThan(L.reach);
    runTicks(sim.loop, L.intervalTicks + 1);
    expect(sim.world.workKind[far!]).not.toBe(Work.None);
  });

  it('tends a field whose own tile nobody can stand on from the tile beside it', () => {
    // Built over, or cut off: the hands were sent to the field's own tile, the search
    // failed, and the next pass sent them again — 6,861 failed searches in one match.
    const sim = village();
    villagers(sim, 12);
    const layer = sim.loop.movement.pathing.layer(MovementClass.Infantry);
    let field = -1;
    for (let f = 0; f < sim.farmland.count; f++) {
      if (sim.farmland.alive[f] === 1 && sim.farmland.owner[f] === 0) field = f;
    }
    // Built over, the way it happened in play: a footprint on the field's own tile.
    sim.economy.add(0, 1 as never, 4000);
    expect(
      sim.construction.place(
        sim.world, sim.economy, 0, BuildingType.GrainStore,
        sim.farmland.tileX[field]!, sim.farmland.tileY[field]!, [], true,
      ),
    ).toBe(PlacementResult.Placed);
    const tile = sim.farmland.tileY[field]! * sim.map.width + sim.farmland.tileX[field]!;
    expect(layer.tileCost[tile]).toBe(IMPASSABLE);

    runTicks(sim.loop, L.intervalTicks + 1);
    const before = sim.loop.movement.stats.unreachableOrders;
    runTicks(sim.loop, L.intervalTicks * 20);
    expect(sim.loop.movement.stats.unreachableOrders - before).toBeLessThan(3);

    const cx = sim.farmland.tileX[field]! + 0.5;
    const cy = sim.farmland.tileY[field]! + 0.5;
    let tending = 0;
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] !== 1 || sim.world.workKind[i] !== Work.Field || sim.world.workAt[i] !== field) continue;
      const dx = sim.world.posX[i]! - cx;
      const dy = sim.world.posY[i]! - cy;
      if (dx * dx + dy * dy <= tuning.farmland.tendRadius * tuning.farmland.tendRadius) tending++;
    }
    expect(tending).toBeGreaterThan(0);
  });

  it('counts nobody idle once everybody has somewhere to be', () => {
    const sim = village();
    villagers(sim, 3);
    runTicks(sim.loop, L.intervalTicks + 1);
    expect(idleOf(sim.world, 0)).toBe(0);
  });
});

/** A site of `type` at the tile, not founded — raised by hands like any other. */
function site(sim: Harness, x: number, y: number, type = BuildingType.GrainStore): number {
  const before = new Set<number>();
  for (let i = 0; i < sim.world.capacity; i++) {
    if (sim.world.alive[i] === 1 && sim.world.kind[i] === EntityKind.Building) before.add(i);
  }
  const result = sim.construction.place(sim.world, sim.economy, 0, type, x, y, [], false);
  expect(result).toBe(PlacementResult.Placed);
  for (let i = 0; i < sim.world.capacity; i++) {
    if (sim.world.alive[i] === 1 && sim.world.kind[i] === EntityKind.Building && !before.has(i)) return i;
  }
  throw new Error('placed, but no new building');
}

function onSite(world: World, siteIndex: number): number {
  let n = 0;
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
    const kind = world.workKind[i];
    if ((kind === Work.Site || kind === Work.SpareSite) && world.workAt[i] === siteIndex) n++;
  }
  return n;
}

describe('the idle go to the building sites', () => {
  it('sends hands nothing else wants to a site, past the number it asks for', () => {
    const sim = village();
    const at = site(sim, 14, 6);
    villagers(sim, 30);
    runTicks(sim.loop, L.intervalTicks + 1);
    // Thirty people is more than the fields, the site and the water ask for between
    // them, so the site takes the spare up to its limit and nobody is left standing.
    expect(onSite(sim.world, at)).toBe(L.siteHands + L.spareSiteHands);
    expect(onSite(sim.world, at)).toBeGreaterThan(L.siteHands);
  });

  it('takes the idle to a site away from the homesteads, and it rises', () => {
    // Out of `homeRadius`, so the site asks for nobody — before this, it was raised
    // only by people sent there by hand, however many stood idle at home.
    const sim = village(1, flatMap(48));
    const at = site(sim, 36, 36);
    const dx = sim.world.posX[at]! - 8;
    const dy = sim.world.posY[at]! - 8;
    expect(dx * dx + dy * dy).toBeGreaterThan(L.homeRadius * L.homeRadius);
    villagers(sim, 30);
    runTicks(sim.loop, L.intervalTicks + 1);
    expect(onSite(sim.world, at)).toBeGreaterThan(0);
    runTicks(sim.loop, 1200);
    expect(sim.world.buildProgress[at]!).toBeGreaterThan(0);
  });

  it('draws the people on a site as building, and idle means the same in both readouts', () => {
    // The command bar lists the role nibble's "idle"; the top bar counts `idleOf`. They
    // disagreed by everyone who had work but no picture for it, builders above all.
    const sim = village();
    const at = site(sim, 14, 6);
    villagers(sim, 12);
    // Soon after the first pass, while the site is still a site: with the spare hands
    // on it a granary is up within a few hundred ticks.
    runTicks(sim.loop, L.intervalTicks + tuning.roles.intervalTicks + 1);
    expect(sim.world.buildProgress[at]!).toBeLessThan(BUILDINGS[BuildingType.GrainStore].work);
    let builders = 0;
    let idle = 0;
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] !== 1 || sim.world.kind[i] !== EntityKind.Unit) continue;
      if (roleOf(sim.world, i) === Role.Builder) {
        builders++;
        expect(sim.world.workAt[i]).toBe(at);
      }
      // Injured has its own role, so it is not idle in either count.
      if (roleOf(sim.world, i) === Role.None) idle++;
    }
    expect(builders).toBeGreaterThan(0);
    expect(idle).toBe(idleOf(sim.world, 0));
  });

  it('never keeps a field short to put a spare hand on a site', () => {
    const sim = village();
    site(sim, 14, 6);
    // Enough people that the site takes spare hands, not so many that every place is
    // full whatever the order — the case where the priority actually decides.
    villagers(sim, 14);
    for (let pass = 0; pass < 6; pass++) {
      runTicks(sim.loop, L.intervalTicks);
      let spare = 0;
      for (let i = 0; i < sim.world.capacity; i++) {
        if (sim.world.alive[i] === 1 && sim.world.workKind[i] === Work.SpareSite) spare++;
      }
      if (spare === 0) continue;
      for (let f = 0; f < sim.farmland.count; f++) {
        if (sim.farmland.alive[f] === 0 || sim.farmland.owner[f] !== 0) continue;
        expect(working(sim.world, 0, Work.Field) > 0).toBe(true);
        let assigned = 0;
        for (let i = 0; i < sim.world.capacity; i++) {
          if (sim.world.workKind[i] === Work.Field && sim.world.workAt[i] === f) assigned++;
        }
        expect(assigned, `field ${f}`).toBeGreaterThanOrEqual(sim.farmland.handsWanted[f]!);
      }
    }
  });
});

describe('a direct order is an override', () => {
  it('holds someone the player has moved, and returns them after the order and a wait', () => {
    const sim = village();
    const [first] = villagers(sim, 1);
    const handle = packHandle(first!, sim.world.generation[first!]!);
    enqueueCommand(sim.loop, makeCommand(0, 0, 0, CommandKind.MoveTo, handle, 20, 20, 0));

    runTicks(sim.loop, L.intervalTicks * 3);
    expect(sim.world.workKind[first!]).toBe(Work.Held);

    // Long enough to arrive and wait out the hold, and then one more pass.
    runTicks(sim.loop, 400 + L.holdTicks + L.intervalTicks * 2);
    expect(sim.world.workKind[first!]).not.toBe(Work.Held);
    expect(sim.world.workKind[first!]).not.toBe(Work.None);
  });

  it('returns a whole group sent to one point, not only whoever reached it', () => {
    // A right-click on open ground sends every selected person to the same point, and
    // only one of them can stand on it. The rest were held off at arm's length and
    // walked at it for ever — never arriving, so never released from the order, so
    // never counted idle and never sent to work. Two was enough.
    const sim = village();
    const people = villagers(sim, 10, 18, 18);
    let sequence = 0;
    for (const i of people) {
      const handle = packHandle(i, sim.world.generation[i]!);
      enqueueCommand(sim.loop, makeCommand(0, 0, sequence++, CommandKind.MoveTo, handle, 26, 26, 0));
    }
    runTicks(sim.loop, 400 + L.holdTicks + L.intervalTicks * 2);
    for (const i of people) {
      expect(sim.world.hasTarget[i], `unit ${i} still walking`).toBe(0);
      expect(sim.world.workKind[i], `unit ${i} still held`).not.toBe(Work.Held);
    }
  });

  it('never takes a drover off the herd he was sent to take', () => {
    const sim = village();
    const [drover] = villagers(sim, 1, 20, 20);
    const cow = spawn(sim.world, 20.8, 20, 2, 1, EntityKind.Cattle);
    const handle = packHandle(drover!, sim.world.generation[drover!]!);
    enqueueCommand(sim.loop, makeCommand(0, 0, 0, CommandKind.Leash, handle, cow, 0, 0));

    runTicks(sim.loop, L.holdTicks * 3);
    expect(sim.world.tetheredTo[handleIndex(cow)]).toBe(handle);
    expect(sim.world.workKind[drover!]).toBe(Work.Held);
  });

  it('releases nobody while they are still walking', () => {
    // Corner to corner of a larger map: longer on foot than the hold lasts.
    const sim = village(1, flatMap(64));
    const [walker] = villagers(sim, 1, 4, 60);
    const handle = packHandle(walker!, sim.world.generation[walker!]!);
    enqueueCommand(sim.loop, makeCommand(0, 0, 0, CommandKind.MoveTo, handle, 60, 4, 0));
    runTicks(sim.loop, L.holdTicks + L.intervalTicks);
    expect(sim.world.hasTarget[walker!]).toBe(1);
    expect(sim.world.workKind[walker!]).toBe(Work.Held);
  });
});

describe('buildings that need hands', () => {
  it('staffs a finished granary and pays for it', () => {
    const sim = village();
    sim.construction.place(sim.world, sim.economy, 0, BuildingType.GrainStore, 12, 4, [], true);
    villagers(sim, 20);
    runTicks(sim.loop, 600);

    let granary = -1;
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] !== 1 || sim.world.kind[i] !== EntityKind.Building) continue;
      if (sim.world.buildingType[i] === BuildingType.GrainStore) granary = i;
    }
    // At least the hands it asked for. Anyone else standing near it counts as well,
    // exactly as anyone near a field tends it — the count is of who is there.
    expect(sim.world.builders[granary]).toBeGreaterThanOrEqual(BUILDINGS[BuildingType.GrainStore].hands);
    expect(sim.construction.yieldFor(sim.world, 0).grain).toBeGreaterThanOrEqual(
      BUILDINGS[BuildingType.GrainStore].grainYield,
    );
  });

  it('keeps a kraal without frightening the herd in it', () => {
    // A kraal asks for hands who stand at its wall all day. Strangers that close wind
    // cattle toward bolting (ADR-0014); the herdsman is the herd's own.
    const sim = village();
    sim.construction.place(sim.world, sim.economy, 0, BuildingType.Isibaya, 13, 13, [], true);
    for (let i = 0; i < 6; i++) spawn(sim.world, 13.6 + (i % 2) * 0.6, 13.6 + (i >> 1) * 0.4, 2, 1, EntityKind.Cattle);
    // The village's people start on the far side of the homestead, not among the herd.
    villagers(sim, 20, 2, 2);
    runTicks(sim.loop, 1200);

    expect(working(sim.world, 0, Work.Kraal)).toBe(BUILDINGS[BuildingType.Isibaya].hands);
    let maxStress = 0;
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] !== 1 || sim.world.kind[i] !== EntityKind.Cattle) continue;
      maxStress = Math.max(maxStress, sim.world.stress[i]!);
    }
    expect(maxStress).toBeLessThan(tuning.cattle.stampedeCalmStress);
  });
});

describe('a penned herd and the village around it', () => {
  function pen(owner: number) {
    const sim = makeSim(128, 1, flatMap(32), []);
    sim.construction.place(sim.world, sim.economy, 0, BuildingType.Isibaya, 13, 13, [], true);
    const cow = spawn(sim.world, 14, 14, 2, 1, EntityKind.Cattle);
    // Two tiles off and standing still — a field hand, or a stranger at the wall.
    spawn(sim.world, 14, 12, owner);
    let most = 0;
    for (let t = 0; t < 600; t++) {
      runTicks(sim.loop, 1);
      most = Math.max(most, sim.world.stress[handleIndex(cow)]!);
    }
    return most;
  }

  it('is not wound up by its own village working beside it', () => {
    expect(pen(0)).toBe(0);
  });

  it('is still frightened by a stranger at the wall', () => {
    expect(pen(1)).toBeGreaterThan(1);
  });
});

describe('the water', () => {
  it('sends spare hands to fish the bank nearest the village', () => {
    // A river down columns 14 and 15. Water is impassable, so the anglers have to find the bank
    // through real pathing — the constraint a flat map would not have.
    const size = 32;
    const rows = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
    const wet = Array.from({ length: size }, () =>
      Array.from({ length: size }, (_, x) => (x === 14 || x === 15 ? 1 : 0)),
    );
    const sim = village(1, heightmapWithWater(rows, 8, wet));
    villagers(sim, 30);
    runTicks(sim.loop, 1500);

    const anglers = working(sim.world, 0, Work.Shore);
    expect(anglers).toBeGreaterThan(0);
    let onBank = 0;
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] !== 1 || sim.world.workKind[i] !== Work.Shore) continue;
      if (isShore(sim.map, Math.floor(sim.world.posX[i]!), Math.floor(sim.world.posY[i]!))) onBank++;
    }
    expect(onBank).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('reproduces itself', () => {
    const run = (): number => {
      const sim = village(7);
      villagers(sim, 16);
      sim.construction.place(sim.world, sim.economy, 0, BuildingType.GrainStore, 12, 4, [], true);
      runTicks(sim.loop, 3000);
      return hashWorld(sim.world);
    };
    expect(run()).toBe(run());
  });
});
