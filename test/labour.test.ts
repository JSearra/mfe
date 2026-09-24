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

  it('counts nobody idle once everybody has somewhere to be', () => {
    const sim = village();
    villagers(sim, 3);
    runTicks(sim.loop, L.intervalTicks + 1);
    expect(idleOf(sim.world, 0)).toBe(0);
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
