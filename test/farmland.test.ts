import { describe, expect, it } from 'vitest';
import {
  abandon,
  canPlant,
  createFarmland,
  harvestOf,
  isEstablished,
  packFarmland,
  plant,
  PlantResult,
  updateFarmland,

} from '../src/sim/economy/farmland.js';
import { fieldCondition, fieldEstablished, fieldSlot, FARMLAND_STRIDE } from '../src/shared/farmland.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { FactionId } from '../src/shared/factions/index.js';
import { NEUTRAL_FACTION } from '../src/sim/commands.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, EntityKind, spawn } from '../src/sim/world.js';
import { flatMap } from './simHarness.js';

const F = tuning.farmland;
const arable = (size = 32) => flatMap(size, F.minBand + 1);

function village(size = 32) {
  return {
    map: arable(size),
    world: createWorld(128, 5),
    economy: createEconomy([FactionId.Zulu, FactionId.Sotho], 5),
    land: createFarmland(),
  };
}

/** A field at (x, y), with `hands` villagers and `beasts` cattle standing in it. */
function fieldWith(v: ReturnType<typeof village>, x: number, y: number, hands: number, beasts: number) {
  const result = plant(v.land, v.economy, v.map, 0, x, y);
  expect(result).toBe(PlantResult.Planted);
  for (let i = 0; i < hands; i++) spawn(v.world, x + 0.5 + i * 0.1, y + 0.5, 0);
  for (let i = 0; i < beasts; i++) {
    spawn(v.world, x + 0.5 + i * 0.1, y + 0.6, NEUTRAL_FACTION, 1, EntityKind.Cattle);
  }
  return 0;
}

describe('breaking ground', () => {
  it('refuses stone and the high sourveld', () => {
    expect(canPlant(flatMap(16, 7), 8, 8)).toBe(false);
    expect(canPlant(arable(16), 8, 8)).toBe(true);
  });

  it('costs seed grain, and the seed is spent whether or not the field ever pays', () => {
    const v = village();
    const before = v.economy.balance(0, Resource.Grain);
    expect(plant(v.land, v.economy, v.map, 0, 10, 10)).toBe(PlantResult.Planted);
    expect(v.economy.balance(0, Resource.Grain)).toBe(before - F.seedGrain);

    // Abandoning does not give it back. That is what makes siting land a decision
    // rather than a free option.
    abandon(v.land, 0);
    expect(v.economy.balance(0, Resource.Grain)).toBe(before - F.seedGrain);
  });

  it('will not site a field on top of another', () => {
    const v = village();
    plant(v.land, v.economy, v.map, 0, 10, 10);
    expect(plant(v.land, v.economy, v.map, 0, 10, 10)).toBe(PlantResult.Occupied);
  });

  it('will not site one that cannot be paid for', () => {
    const v = village();
    v.economy.spend(0, Resource.Grain, v.economy.balance(0, Resource.Grain));
    expect(plant(v.land, v.economy, v.map, 0, 10, 10)).toBe(PlantResult.Unaffordable);
  });

  it('pays nothing until the ground is broken', () => {
    const v = village();
    fieldWith(v, 10, 10, 2, 0);

    expect(isEstablished(v.land, 0)).toBe(false);
    expect(harvestOf(v.land, 0)).toBeNull();

    // Work it until it takes.
    for (let i = 0; i < 20; i++) updateFarmland(v.world, v.land, 2);
    expect(isEstablished(v.land, 0)).toBe(true);
    expect(harvestOf(v.land, 0)).not.toBeNull();
  });

  it('takes longer with fewer hands', () => {
    const few = village();
    fieldWith(few, 10, 10, 1, 0);
    const many = village();
    fieldWith(many, 10, 10, F.maxHands, 0);

    for (let i = 0; i < 3; i++) {
      updateFarmland(few.world, few.land, 2);
      updateFarmland(many.world, many.land, 2);
    }
    expect(many.land.work[0]!).toBeGreaterThan(few.land.work[0]!);
  });
});

describe('cattle and crops want the same ground', () => {
  /**
   * The point of the phase. The drought arrives on a timer and treats everyone alike;
   * where the herd grazes is a choice, and it is the first scarcity in this game that
   * the player creates rather than inherits.
   */
  it('lets a herd standing in a field eat it down', () => {
    const v = village();
    fieldWith(v, 10, 10, 0, 4);
    v.land.work[0] = F.establishWork;

    const before = v.land.condition[0]!;
    for (let i = 0; i < 5; i++) updateFarmland(v.world, v.land, 2);
    expect(v.land.condition[0]!).toBeLessThan(before);
  });

  it('lets people standing in it bring it back', () => {
    const v = village();
    fieldWith(v, 10, 10, F.maxHands, 0);
    v.land.work[0] = F.establishWork;
    v.land.condition[0] = 0.3;

    for (let i = 0; i < 10; i++) updateFarmland(v.world, v.land, 2);
    expect(v.land.condition[0]!).toBeGreaterThan(0.3);
  });

  it('nets the two against each other rather than taking the better', () => {
    // A field that is both worked and grazed is worse off than one only worked, or the
    // player could park the herd in the crops and simply add people.
    const grazed = village();
    fieldWith(grazed, 10, 10, F.maxHands, F.maxTramplers);
    grazed.land.work[0] = F.establishWork;
    grazed.land.condition[0] = 0.5;

    const clear = village();
    fieldWith(clear, 10, 10, F.maxHands, 0);
    clear.land.work[0] = F.establishWork;
    clear.land.condition[0] = 0.5;

    for (let i = 0; i < 8; i++) {
      updateFarmland(grazed.world, grazed.land, 2);
      updateFarmland(clear.world, clear.land, 2);
    }
    expect(grazed.land.condition[0]!).toBeLessThan(clear.land.condition[0]!);
  });

  it('withers a field nobody tends, without ever going below nothing', () => {
    const v = village();
    fieldWith(v, 10, 10, 0, 0);
    v.land.work[0] = F.establishWork;

    for (let i = 0; i < 400; i++) updateFarmland(v.world, v.land, 2);
    expect(v.land.condition[0]!).toBe(0);
    // Still a field, and still costing the seed that was spent on it.
    expect(v.land.alive[0]).toBe(1);
  });

  it('never lets condition run past whole', () => {
    const v = village();
    fieldWith(v, 10, 10, F.maxHands, 0);
    v.land.work[0] = F.establishWork;
    for (let i = 0; i < 200; i++) updateFarmland(v.world, v.land, 2);
    expect(v.land.condition[0]!).toBeLessThanOrEqual(1);
  });

  it('does not let a neighbour work your field for you', () => {
    const v = village();
    plant(v.land, v.economy, v.map, 0, 10, 10);
    for (let i = 0; i < F.maxHands; i++) spawn(v.world, 10.5 + i * 0.1, 10.5, 1);

    for (let i = 0; i < 20; i++) updateFarmland(v.world, v.land, 2);
    expect(isEstablished(v.land, 0)).toBe(false);
  });
});

describe('what the harvest offers', () => {
  it('scales with condition, so a ruined field pays a ruined harvest', () => {
    const v = village();
    fieldWith(v, 10, 10, 0, 0);
    v.land.work[0] = F.establishWork;

    v.land.condition[0] = 1;
    expect(harvestOf(v.land, 0)!.share).toBe(1);
    v.land.condition[0] = 0.25;
    expect(harvestOf(v.land, 0)!.share).toBe(0.25);
  });

  it('offers nothing from a field that has been given up', () => {
    const v = village();
    fieldWith(v, 10, 10, 0, 0);
    v.land.work[0] = F.establishWork;
    abandon(v.land, 0);
    expect(harvestOf(v.land, 0)).toBeNull();
  });
});

describe('the packed form the renderer reads', () => {
  it('describes every living field, and carries its slot', () => {
    const v = village();
    for (const [x, y] of [[8, 8], [12, 12], [16, 16]] as [number, number][]) {
      plant(v.land, v.economy, v.map, 0, x, y);
    }
    abandon(v.land, 1);

    const packed = packFarmland(v.land);
    expect(packed.length).toBe(2 * FARMLAND_STRIDE);

    for (let at = 0; at < packed.length; at += FARMLAND_STRIDE) {
      const slot = fieldSlot(packed, at);
      expect(v.land.alive[slot]).toBe(1);
      expect(fieldEstablished(packed, at)).toBe(isEstablished(v.land, slot));
      expect(fieldCondition(packed, at)).toBeCloseTo(v.land.condition[slot]!, 5);
    }
    // The abandoned field is gone, so the second packed entry is slot 2 and not slot 1 —
    // which is exactly why the slot has to be carried.
    expect(fieldSlot(packed, FARMLAND_STRIDE)).toBe(2);
  });
});
