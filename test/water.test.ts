import { describe, expect, it } from 'vitest';
import { BuildingType } from '../src/shared/buildings/index.js';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { FactionId } from '../src/shared/factions/index.js';
import { heightmapWithWater, isFreshShore, seaMask, type Heightmap } from '../src/shared/heightmap.js';
import { RESOURCES } from '../src/shared/resources.js';
import { createEconomy, Ration, Resource } from '../src/sim/economy/ledger.js';
import { updateFishing } from '../src/sim/fishing.js';
import { Work } from '../src/sim/labour.js';
import { step } from '../src/sim/loop.js';
import { tuning } from '../src/sim/tuning.js';
import { updateWaterCarrying } from '../src/sim/water.js';
import { createWorld, EntityKind, spawn, type World } from '../src/sim/world.js';
import { foundHomestead, makeSim } from './simHarness.js';

/**
 * Water (ADR-0023): people drink it every upkeep, it comes from carriers, wells, the
 * rain and the weir, it does not keep, the sea is salt, and going short slows work
 * without harming anybody.
 */

const W = tuning.water;
const E = tuning.economy;
const PLAYERS = [FactionId.Zulu, FactionId.Sotho] as const;

/** A 64-square map: a sea of 40 columns on the east, and a river down column 10. */
function coastAndRiver(): Heightmap {
  const size = 64;
  const rows = Array.from({ length: size }, () => Array.from({ length: size }, (_, x) => (x >= 24 || x === 10 ? 0 : 2)));
  const wet = rows.map((row) => row.map((level) => (level === 0 ? 1 : 0)));
  return heightmapWithWater(rows, 8, wet);
}

function villageOf(people: number): World {
  const world = createWorld(256, 5);
  for (let i = 0; i < people; i++) spawn(world, i % 10, 0, 0);
  return world;
}

/** Nothing in store at all, so every figure a test reads is the one it made. */
function bare() {
  const economy = createEconomy(PLAYERS, 1);
  for (const resource of RESOURCES) economy.spend(0, resource, economy.balance(0, resource));
  // Grain enough that hunger never muddies a test about thirst.
  economy.add(0, Resource.Grain, 10_000);
  return economy;
}

type Yield = { water?: number; roofs?: number; waterStore?: number };
function upkeep(world: World, economy: ReturnType<typeof bare>, cycle: number, yields: Yield = {}): SimEvent[] {
  const events: SimEvent[] = [];
  world.tick = cycle * E.upkeepIntervalTicks;
  economy.update(world, events, (player) =>
    player === 0 ? { grain: 0, cattle: 0, hardyGrain: 0, ...yields } : { grain: 0, cattle: 0, hardyGrain: 0 },
  );
  return events;
}

describe('the sea', () => {
  const map = coastAndRiver();
  const sea = seaMask(map);

  it('is the big water, and the river is not', () => {
    expect(sea[5 * 64 + 40]).toBe(1);
    expect(sea[5 * 64 + 10]).toBe(0);
  });

  it('is salt: its strand is not a place to draw water, a river bank is', () => {
    expect(isFreshShore(map, 23, 5)).toBe(false);
    expect(isFreshShore(map, 9, 5)).toBe(true);
    expect(isFreshShore(map, 11, 5)).toBe(true);
  });
});

describe('drinking', () => {
  it('costs every person their share each upkeep', () => {
    const world = villageOf(10);
    const economy = bare();
    economy.add(0, Resource.Water, 100);
    upkeep(world, economy, 1);
    const left = 100 * (1 - W.evaporatePerCycle) - 10 * W.perUnit;
    expect(economy.balance(0, Resource.Water)).toBeCloseTo(left, 5);
    expect(economy.thirst[0]).toBe(0);
  });

  it('does not keep: water left standing is mostly gone by the next season', () => {
    const world = villageOf(0);
    const economy = bare();
    economy.add(0, Resource.Water, 100);
    for (let cycle = 1; cycle <= 4; cycle++) upkeep(world, economy, cycle);
    expect(economy.balance(0, Resource.Water)).toBeLessThan(10);
  });

  it('when short, slows work in proportion — and harms nobody', () => {
    const world = villageOf(10);
    const economy = bare();
    const events = upkeep(world, economy, 1);
    expect(economy.thirst[0]).toBe(1);
    expect(economy.labourFactor(0)).toBeCloseTo(1 - W.thirstLabourPenalty, 5);
    expect(events.some((e) => e.type === EventType.Starved)).toBe(false);
    for (let i = 0; i < 10; i++) expect(world.hp[i]).toBe(tuning.unit.maxHp);
  });

  it('half short is half the slowdown', () => {
    const world = villageOf(10);
    const economy = bare();
    economy.add(0, Resource.Water, (10 * W.perUnit) / 2 / (1 - W.evaporatePerCycle));
    upkeep(world, economy, 1);
    expect(economy.thirst[0]).toBeCloseTo(0.5, 5);
  });

  it('stacks with a cut ration', () => {
    const world = villageOf(10);
    const economy = bare();
    economy.setRation(0, Ration.Short);
    upkeep(world, economy, 1);
    expect(economy.labourFactor(0)).toBeCloseTo(E.rationShortLabour * (1 - W.thirstLabourPenalty), 5);
  });

  it('is only for people: a herd with nobody to water costs nothing', () => {
    const world = villageOf(0);
    const economy = bare();
    economy.add(0, Resource.Cattle, 100);
    upkeep(world, economy, 1);
    expect(economy.waterNeed[0]).toBe(0);
    expect(economy.thirst[0]).toBe(0);
  });
});

describe('where it comes from', () => {
  it('wells give their draw, weaker in a drought but never dry', () => {
    const economy = bare();
    const world = villageOf(0);
    upkeep(world, economy, 1, { water: 10 });
    const early = economy.balance(0, Resource.Water);
    expect(early).toBeGreaterThan(0);

    // The height of a dry year: the floor, not nothing.
    const dry = bare();
    const tick = Math.round(E.seasonTicks * 0.5 / E.upkeepIntervalTicks);
    upkeep(world, dry, tick, { water: 10 });
    expect(dry.balance(0, Resource.Water)).toBeGreaterThanOrEqual(10 * W.wellDroughtFloor * (1 - W.evaporatePerCycle) - 1e-9);
  });

  it('rain falls on the roofs in proportion to how wet the season is', () => {
    const world = villageOf(0);
    const wet = bare();
    upkeep(world, wet, 1, { roofs: 6 });
    const drought = wet.drought(1 * E.upkeepIntervalTicks);
    expect(wet.balance(0, Resource.Water)).toBeCloseTo(6 * W.rainPerDwelling * (1 - drought), 5);
  });

  it('the weir keeps a reserve from the surplus and gives it back in a shortfall', () => {
    const world = villageOf(10);
    const economy = bare();
    economy.add(0, Resource.Water, 200);
    upkeep(world, economy, 1, { waterStore: 160 });
    const held = economy.waterReserve[0]!;
    expect(held).toBeGreaterThan(0);

    // Nothing comes in now: the reserve covers the village, and it is not thirsty.
    economy.spend(0, Resource.Water, economy.balance(0, Resource.Water));
    upkeep(world, economy, 2, { waterStore: 160 });
    expect(economy.thirst[0]).toBe(0);
    expect(economy.waterReserve[0]).toBeLessThan(held);
  });

  it('nothing holds a reserve once the weir is gone', () => {
    const world = villageOf(10);
    const economy = bare();
    economy.waterReserve[0] = 100;
    upkeep(world, economy, 1, { waterStore: 0 });
    expect(economy.waterReserve[0]).toBe(0);
  });
});

describe('carrying from the river', () => {
  function carriers(bankX: number, bankY: number, homeX: number, homeY: number): number {
    const sim = makeSim(256, 2, coastAndRiver());
    expect(foundHomestead(sim, 0, homeX, homeY)).toBe(true);
    for (const economy of [sim.economy]) for (const r of RESOURCES) economy.spend(0, r, economy.balance(0, r));
    const person = spawn(sim.world, bankX + 0.5, bankY + 0.5, 0) & 0xffffff;
    sim.world.workKind[person] = Work.Water;
    updateWaterCarrying(sim.world, sim.map, sim.economy, E.upkeepIntervalTicks);
    return sim.economy.balance(0, Resource.Water);
  }

  it('brings water from a river bank', () => {
    expect(carriers(9, 20, 5, 20)).toBeGreaterThan(0);
  });

  it('brings less the farther the bank is from home', () => {
    expect(carriers(9, 20, 5, 20)).toBeGreaterThan(carriers(9, 50, 5, 20));
  });

  it('brings nothing from the strand: the sea is salt', () => {
    expect(carriers(23, 20, 18, 20)).toBe(0);
  });

  it('is not also paid as fishing', () => {
    const sim = makeSim(256, 2, coastAndRiver());
    const grain = sim.economy.balance(0, Resource.Grain);
    const person = spawn(sim.world, 9.5, 20.5, 0) & 0xffffff;
    sim.world.workKind[person] = Work.Water;
    updateFishing(sim.world, sim.map, sim.economy, E.upkeepIntervalTicks);
    expect(sim.economy.balance(0, Resource.Grain)).toBe(grain);
  });

  it('is a job labour gives out, on fresh banks only', () => {
    const sim = makeSim(256, 2, coastAndRiver());
    expect(foundHomestead(sim, 0, 16, 20)).toBe(true);
    for (let n = 0; n < 8; n++) spawn(sim.world, 14 + (n % 4), 22 + Math.floor(n / 4), 0);
    for (let t = 0; t < tuning.labour.intervalTicks * 3; t++) step(sim.loop);
    let carrying = 0;
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] !== 1 || sim.world.kind[i] !== EntityKind.Unit) continue;
      if (sim.world.workKind[i] !== Work.Water) continue;
      carrying++;
      const at = sim.world.workAt[i]!;
      expect(isFreshShore(sim.map, at % 64, Math.floor(at / 64))).toBe(true);
    }
    expect(carrying).toBeGreaterThan(0);
  });
});

describe('the well', () => {
  it('is a building that draws water with one pair of hands', async () => {
    const { BUILDINGS } = await import('../src/shared/buildings/index.js');
    const well = BUILDINGS[BuildingType.Well];
    expect(well.waterYield).toBeGreaterThan(0);
    expect(well.hands).toBe(1);
    expect(well.needsWater).toBe(false);
    expect(BUILDINGS[BuildingType.Isiziba].waterStore).toBeGreaterThan(0);
  });
});
