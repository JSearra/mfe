import { describe, expect, it } from 'vitest';
import { BuildingType, BUILDINGS, buildingSpec } from '../src/shared/buildings/index.js';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { heightmapFrom } from '../src/shared/heightmap.js';
import { createConstructionSystem, PlacementResult } from '../src/sim/construction.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { FactionId } from '../src/shared/factions/index.js';
import { createMovementSystem } from '../src/sim/movement.js';
import { CommandKind, makeCommand } from '../src/sim/commands.js';
import { enqueueCommand, step } from '../src/sim/loop.js';
import { TECH_IDS } from '../src/shared/tech/index.js';
import { makeSim } from './simHarness.js';
import { MovementClass, IMPASSABLE } from '../src/sim/pathing/costs.js';
import { buildFlowField } from '../src/sim/pathing/flowField.js';
import { createSpatialGrid } from '../src/sim/spatial/grid.js';
import { tuning } from '../src/sim/tuning.js';
import { EntityKind, createWorld, spawn } from '../src/sim/world.js';
import { flatMap } from './simHarness.js';

function site(mapSize = 24) {
  const map = flatMap(mapSize);
  const world = createWorld(64, 9);
  const movement = createMovementSystem(map);
  const construction = createConstructionSystem(map, movement.pathing);
  const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], 1);
  const grid = createSpatialGrid(mapSize, mapSize, 2);
  const events: SimEvent[] = [];

  const rebuild = (): void => {
    grid.clear();
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] === 1) grid.insert(i, world.posX[i]!, world.posY[i]!);
    }
  };
  const tick = (): void => {
    rebuild();
    construction.update(world, grid, events);
    world.tick++;
  };
  return { map, world, movement, construction, economy, grid, events, tick };
}

describe('who counts as a builder', () => {
  // The grid returns everything in the CELLS its query overlaps, which is a superset of
  // the radius asked for. Every other caller narrows that with its own distance check.
  // Construction did not, so with buildRadius 2.2 and cellSize 2 a unit up to about 4.2
  // away raised the building — roughly twice the intended reach, and it inflated the
  // builder count, so sites also completed faster than they were tuned to.
  it('ignores a unit outside the build radius that shares a grid cell', () => {
    const { world, construction, economy, tick } = site();
    construction.place(world, economy, 0, BuildingType.GrainStore, 5, 5, []);
    const building = 0;

    // Building centre is (5.5, 5.5). This unit is 3.39 away — well outside 2.2 — but
    // sits in cell (3,3), which the query's cell range includes.
    spawn(world, 7.9, 7.9, 0);

    tick();
    expect(world.buildProgress[building]).toBe(0);
  });

  it('still counts a unit genuinely within the radius', () => {
    const { world, construction, economy, tick } = site();
    construction.place(world, economy, 0, BuildingType.GrainStore, 5, 5, []);
    const building = 0;

    spawn(world, 6.5, 5.5, 0); // 1.0 away
    tick();
    expect(world.buildProgress[building]!).toBeGreaterThan(0);
  });
});

describe('building specs', () => {
  it('keeps footprints square and small, so depth sorting stays unambiguous', () => {
    for (const spec of Object.values(BUILDINGS)) {
      expect(spec.footprint).toBeGreaterThan(0);
      expect(spec.footprint).toBeLessThanOrEqual(2);
    }
  });

  it('falls back rather than throwing on an unknown type', () => {
    expect(buildingSpec(99).type).toBe(BuildingType.GrainStore);
  });
});

describe('placement', () => {
  it('spends the cost and announces the site', () => {
    const { world, construction, economy, events } = site();
    const spec = BUILDINGS[BuildingType.GrainStore];
    const before = economy.balance(0, Resource.Grain);

    expect(construction.place(world, economy, 0, BuildingType.GrainStore, 5, 5, events)).toBe(
      PlacementResult.Placed,
    );
    expect(economy.balance(0, Resource.Grain)).toBe(before - spec.grainCost);
    expect(events.some((e) => e.type === EventType.BuildingPlaced)).toBe(true);
    expect(world.kind[0]).toBe(EntityKind.Building);
  });

  it('refuses what cannot be paid for', () => {
    const { world, construction, economy, events } = site();
    economy.spend(0, Resource.Grain, economy.balance(0, Resource.Grain));
    expect(construction.place(world, economy, 0, BuildingType.Isibaya, 5, 5, events)).toBe(
      PlacementResult.Unaffordable,
    );
  });

  it('refuses to hang off the edge of the map', () => {
    const { world, construction, economy, events } = site(24);
    expect(construction.place(world, economy, 0, BuildingType.Isibaya, 23, 23, events)).toBe(
      PlacementResult.OffMap,
    );
  });

  it('refuses uneven ground', () => {
    const rows = Array.from({ length: 12 }, () => Array.from({ length: 12 }, () => 0));
    rows[5]![5] = 3;
    const map = heightmapFrom(rows, 8);
    const world = createWorld(32, 1);
    const movement = createMovementSystem(map);
    const construction = createConstructionSystem(map, movement.pathing);
    const economy = createEconomy([FactionId.Zulu], 1);

    expect(construction.place(world, economy, 0, BuildingType.Isibaya, 4, 4, [])).toBe(
      PlacementResult.TooSteep,
    );
    expect(construction.place(world, economy, 0, BuildingType.Isibaya, 1, 1, [])).toBe(
      PlacementResult.Placed,
    );
  });

  it('refuses to overlap an existing building', () => {
    const { world, construction, economy, events } = site();
    construction.place(world, economy, 0, BuildingType.Isibaya, 5, 5, events);
    expect(construction.place(world, economy, 0, BuildingType.GrainStore, 6, 6, events)).toBe(
      PlacementResult.Occupied,
    );
  });
});

describe('navigation', () => {
  // The obligation ADR-0013 warned about, collected on.
  it('blocks the footprint in every movement class at once', () => {
    const { map, world, movement, construction, economy } = site();
    construction.place(world, economy, 0, BuildingType.Isibaya, 5, 5, []);

    for (const movementClass of [MovementClass.Infantry, MovementClass.Cattle, MovementClass.Mounted]) {
      const layer = movement.pathing.layer(movementClass);
      for (const [x, y] of [[5, 5], [6, 5], [5, 6], [6, 6]] as const) {
        expect(layer.tileCost[y * map.width + x], `${movementClass} at ${x},${y}`).toBe(IMPASSABLE);
      }
      // And the derived tables followed, which writing tileCost alone would not do.
      expect(layer.dirs8[5 * map.width + 5]).toBe(0);
      expect(layer.edgeCost[(5 * map.width + 4) * 4 + 1]).toBe(0);
    }
  });

  it('routes around a new building instead of through it', () => {
    const { map, world, movement, construction, economy } = site();
    const layer = movement.pathing.layer(MovementClass.Infantry);

    // A wall of buildings with one gap.
    for (let y = 2; y < 20; y += 2) {
      if (y === 10) continue;
      construction.place(world, economy, 0, BuildingType.Isibaya, 10, y, []);
      economy.add(0, Resource.Grain, 1000); // keep it affordable
    }

    const field = buildFlowField(layer, 2, 2);
    // Everything still reachable must route through the gap, and the blocked tiles are
    // not reachable at all.
    expect(field.integration[3 * map.width + 10]).toBe(0xffff);
    expect(field.integration[10 * map.width + 10]).toBeLessThan(0xffff);
  });

  it('invalidates cached flow fields when a building appears', () => {
    const { world, movement, construction, economy } = site();
    movement.pathing.flowField(5 * 24 + 5, MovementClass.Infantry);
    const before = movement.pathing.stats.flowFieldMisses;

    construction.place(world, economy, 0, BuildingType.GrainStore, 8, 8, []);
    movement.pathing.flowField(5 * 24 + 5, MovementClass.Infantry);

    // Rebuilt, not served from a cache describing a world without the building.
    expect(movement.pathing.stats.flowFieldMisses).toBe(before + 1);
  });
});

describe('construction', () => {
  it('rises only while somebody is working on it', () => {
    const { world, construction, economy, events, tick } = site();
    construction.place(world, economy, 0, BuildingType.GrainStore, 5, 5, events);

    tick();
    expect(world.buildProgress[0]).toBe(0);

    spawn(world, 5.5, 5.5, 0);
    tick();
    expect(world.buildProgress[0]!).toBeGreaterThan(0);
  });

  it('goes faster with more hands', () => {
    const measure = (builders: number): number => {
      const { world, construction, economy, tick } = site();
      construction.place(world, economy, 0, BuildingType.GrainStore, 5, 5, []);
      for (let i = 0; i < builders; i++) spawn(world, 5.5 + i * 0.2, 5.5, 0);
      tick();
      return world.buildProgress[0]!;
    };
    expect(measure(3)).toBeGreaterThan(measure(1));
  });

  it('ignores hands belonging to the other side', () => {
    const { world, construction, economy, tick } = site();
    construction.place(world, economy, 0, BuildingType.GrainStore, 5, 5, []);
    spawn(world, 5.5, 5.5, 1);
    tick();
    expect(world.buildProgress[0]).toBe(0);
  });

  it('completes once and announces it', () => {
    const { world, construction, economy, events, tick } = site();
    construction.place(world, economy, 0, BuildingType.GrainStore, 5, 5, events);
    spawn(world, 5.5, 5.5, 0);

    const spec = BUILDINGS[BuildingType.GrainStore];
    for (let i = 0; i < spec.work + 10; i++) tick();

    expect(world.buildProgress[0]).toBe(spec.work);
    expect(events.filter((e) => e.type === EventType.BuildingCompleted)).toHaveLength(1);
  });
});

describe('yields', () => {
  it('produces nothing until finished', () => {
    const { world, construction, economy } = site();
    construction.place(world, economy, 0, BuildingType.GrainStore, 5, 5, []);
    expect(construction.yieldFor(world, 0).grain).toBe(0);

    world.buildProgress[0] = BUILDINGS[BuildingType.GrainStore].work;
    expect(construction.yieldFor(world, 0).grain).toBe(
      BUILDINGS[BuildingType.GrainStore].grainYield,
    );
  });

  it('credits the owner and nobody else', () => {
    const { world, construction, economy } = site();
    construction.place(world, economy, 0, BuildingType.GrainStore, 5, 5, []);
    world.buildProgress[0] = BUILDINGS[BuildingType.GrainStore].work;

    expect(construction.yieldFor(world, 1).grain).toBe(0);
  });

  it('reaches the ledger at upkeep', () => {
    const { world, construction, economy } = site();
    construction.place(world, economy, 0, BuildingType.GrainStore, 5, 5, []);
    world.buildProgress[0] = BUILDINGS[BuildingType.GrainStore].work;

    const withBuilding = createEconomy([FactionId.Zulu], 1);
    const without = createEconomy([FactionId.Zulu], 1);
    world.tick = tuning.economy.upkeepIntervalTicks;

    withBuilding.update(world, [], (owner) => construction.yieldFor(world, owner));
    without.update(world, []);

    expect(withBuilding.balance(0, Resource.Grain)).toBeGreaterThan(
      without.balance(0, Resource.Grain),
    );
  });
});

describe('who a command acts for', () => {
  /**
   * Build and Research read the acting player out of the command's PAYLOAD rather than
   * from its `playerId`. Every caller happens to pass its own id, so the two always
   * agree today and nothing is wrong on screen — but the payload is data a client sends
   * and `playerId` is who the command came from, and lockstep is a stated goal of this
   * project. Under it, the payload version lets any client raise buildings for a rival,
   * or spend a rival's grain.
   *
   * Cheap to close now and invisible to change, which is the best moment to do it.
   */
  it('builds for the player who issued the command, not the one named in it', () => {
    const { world, economy, loop } = makeSim(64, 2);
    const before = economy.balance(1, Resource.Grain);

    // Issued by player 0, but the payload names player 1.
    enqueueCommand(loop, makeCommand(0, 0, 0, CommandKind.Build, 6, 6, BuildingType.GrainStore, 1));
    step(loop);

    const site = world.kind.findIndex((k, i) => k === EntityKind.Building && world.alive[i] === 1);
    expect(site).toBeGreaterThanOrEqual(0);
    expect(world.faction[site]).toBe(0);
    expect(economy.balance(1, Resource.Grain)).toBe(before);
  });

  it('researches for the player who issued the command, not the one named in it', () => {
    const { tech, loop } = makeSim(64, 3);

    enqueueCommand(loop, makeCommand(0, 0, 0, CommandKind.Research, 0, 1, 0, 0));
    step(loop);

    // Player 1 was named in the payload; player 0 sent it, so player 0 is researching.
    expect(tech.status[1 * TECH_IDS.length]).toBe(0);
    expect(tech.status[0]).toBe(1);
  });
});
