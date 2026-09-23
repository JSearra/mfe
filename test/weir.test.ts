import { describe, expect, it } from 'vitest';
import { BUILDINGS, BuildingType, EffectKind } from '../src/shared/buildings/index.js';
import { effectAt } from '../src/sim/buildingEffects.js';
import { createConstructionSystem, PlacementResult } from '../src/sim/construction.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { createPathingService } from '../src/sim/pathing/service.js';
import { FactionId } from '../src/shared/factions/index.js';
import { heightmapWithWater } from '../src/shared/heightmap.js';
import { createWorld, EntityKind, handleIndex, spawn } from '../src/sim/world.js';
import { buildingSpec } from '../src/shared/buildings/index.js';

/**
 * The isiziba: a weir, and the fields it keeps alive.
 *
 * The drought is the only pressure the economy has that a player cannot answer by
 * working harder — a field tended perfectly still fails in a bad year. This is the one
 * building that answers it, and the price of that is that it can only stand where there
 * is water to hold: siting it is a reason to settle a river rather than a thing you do
 * wherever there is room.
 */

const PLAYERS = [FactionId.Zulu, FactionId.Sotho] as const;

/** A small map with a river down the middle column. */
function riverMap() {
  const rows: number[][] = [];
  const wet: number[][] = [];
  for (let y = 0; y < 16; y++) {
    rows.push(Array.from({ length: 16 }, (_, x) => (x === 8 ? 0 : 1)));
    wet.push(Array.from({ length: 16 }, (_, x) => (x === 8 ? 1 : 0)));
  }
  return heightmapWithWater(rows, 8, wet);
}

function systemFor(map: ReturnType<typeof riverMap>) {
  const world = createWorld(128, 7);
  const economy = createEconomy(PLAYERS, 1);
  economy.add(0, Resource.Grain, 5000);
  economy.add(0, Resource.Wood, 5000);
  const construction = createConstructionSystem(map, createPathingService(map));
  return { world, economy, construction };
}

describe('siting a weir', () => {
  it('is allowed on a bank', () => {
    const map = riverMap();
    const { world, economy, construction } = systemFor(map);
    // Tile (7, 4) is dry and touches the water at (8, 4).
    expect(construction.place(world, economy, 0, BuildingType.Isiziba, 7, 4, [])).toBe(
      PlacementResult.Placed,
    );
  });

  it('is refused away from the water', () => {
    const map = riverMap();
    const { world, economy, construction } = systemFor(map);
    expect(construction.place(world, economy, 0, BuildingType.Isiziba, 2, 4, [])).toBe(
      PlacementResult.NoWater,
    );
  });

  it('is refused in the water', () => {
    // A weir is built ON the bank, not in the channel — and the channel is impassable
    // anyway, so this would be refused twice over. Asserted so the reason given is the
    // useful one.
    const map = riverMap();
    const { world, economy, construction } = systemFor(map);
    const result = construction.place(world, economy, 0, BuildingType.Isiziba, 8, 4, []);
    expect(result).not.toBe(PlacementResult.Placed);
  });

  it('does not restrict anything that is not a weir', () => {
    const map = riverMap();
    const { world, economy, construction } = systemFor(map);
    expect(construction.place(world, economy, 0, BuildingType.GrainStore, 2, 4, [])).toBe(
      PlacementResult.Placed,
    );
  });
});

describe('what a weir reaches', () => {
  function place(world: ReturnType<typeof createWorld>, tileX: number, tileY: number) {
    const handle = spawn(world, tileX, tileY, 0, 0, EntityKind.Building);
    const index = handleIndex(handle);
    world.buildingType[index] = BuildingType.Isiziba;
    world.buildProgress[index] = buildingSpec(BuildingType.Isiziba).work;
  }

  it('shelters ground inside its radius and not outside it', () => {
    const world = createWorld(64, 1);
    place(world, 10, 10);
    const radius = BUILDINGS[BuildingType.Isiziba].effect!.radius;

    expect(effectAt(world, 0, EffectKind.DroughtShelter, 10, 10)).toBeGreaterThan(0);
    expect(effectAt(world, 0, EffectKind.DroughtShelter, 10 + radius, 10)).toBeGreaterThan(0);
    expect(effectAt(world, 0, EffectKind.DroughtShelter, 10 + radius + 1, 10)).toBe(0);
  });
});

describe('what a weir does to a harvest', () => {
  it('lets a field inside it ride out a drought that costs an identical field outside', () => {
    // Two fields, same owner, same condition, same weather. One of them is within
    // reach of a weir and the other is nine tiles away. The only difference between
    // them is the building.
    const world = createWorld(128, 11);
    const economy = createEconomy(PLAYERS, 1);

    const place = (tileX: number, tileY: number) => {
      const handle = spawn(world, tileX, tileY, 0, 0, EntityKind.Building);
      const index = handleIndex(handle);
      world.buildingType[index] = BuildingType.Isiziba;
      world.buildProgress[index] = buildingSpec(BuildingType.Isiziba).work;
    };
    place(10, 10);

    const fields = [
      { tileX: 11, tileY: 10, owner: 0, sheltered: false, share: 1 },
      { tileX: 40, tileY: 40, owner: 0, sheltered: false, share: 1 },
    ];

    // The drought at its worst, so the difference is as large as it ever gets.
    const harvestFor = (which: number) => {
      const field = fields[which];
      if (field === undefined) return undefined;
      const watered =
        effectAt(world, field.owner, EffectKind.DroughtShelter, field.tileX, field.tileY) > 0;
      return { owner: field.owner, sheltered: field.sheltered || watered, share: field.share };
    };

    // Run each field alone so the two harvests can be told apart in the ledger.
    const yieldOf = (which: number): number => {
      const solo = createEconomy(PLAYERS, 1);
      const before = solo.balance(0, Resource.Grain);
      // Tick 41,600 is where the drought peaks at 1.00 on the shipped curve, measured
      // rather than guessed. It matters: shelteredYieldFactor is a FLOOR, so sheltered
      // ground and open ground yield exactly the same until the open factor falls below
      // it — which needs a drought past about 0.74. A first pass at this test ran at
      // tick 6,000, where the drought is 0.45, and both fields yielded the same to six
      // decimal places because neither was anywhere near the floor.
      world.tick = 41_600;
      solo.update(world, [], undefined, undefined, (i) => (i === 0 ? harvestFor(which) : undefined));
      // Upkeep and spoilage both came out too; what is compared is the DIFFERENCE
      // between two runs identical in every other respect.
      return solo.balance(0, Resource.Grain) - before;
    };

    void economy;
    expect(yieldOf(0)).toBeGreaterThan(yieldOf(1));
  });
});
