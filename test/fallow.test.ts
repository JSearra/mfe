import { describe, expect, it } from 'vitest';
import { heightmapFrom } from '../src/shared/heightmap.js';
import {
  createFarmland,
  harvestOf,
  isFallow,
  plant,
  PlantResult,
  setFallow,
  updateFarmland,
} from '../src/sim/economy/farmland.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { FactionId } from '../src/shared/factions/index.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, spawn } from '../src/sim/world.js';

/**
 * Letting a field rest.
 *
 * A field lost condition every season nobody stood on it, so siting more ground than a
 * village could work was simply a mistake — and the village had no way to say "not this
 * one, not this year". Fallow is that: the field pays nothing while it rests and comes
 * back better than it went in, which makes having more land than hands a POSITION
 * rather than an error.
 *
 * It is not free, and the price is the honest one: a resting field feeds nobody.
 */

const F = tuning.farmland;
const PLAYERS = [FactionId.Zulu, FactionId.Sotho] as const;

function flat(size = 24) {
  return heightmapFrom(
    Array.from({ length: size }, () => Array.from({ length: size }, () => 1)),
    8,
  );
}

/** One established field at (5,5), at a given condition, and a world with nobody in it. */
function fieldAt(condition: number) {
  const map = flat();
  const land = createFarmland(8);
  const world = createWorld(64, 3);
  const economy = createEconomy(PLAYERS, 1);
  economy.add(0, Resource.Grain, 1000);
  expect(plant(land, economy, map, 0, 5, 5)).toBe(PlantResult.Planted);
  land.work[0] = 10_000;
  land.condition[0] = condition;
  return { map, land, world, economy };
}

describe('fallow', () => {
  it('is off to begin with', () => {
    const { land } = fieldAt(0.8);
    expect(isFallow(land, 0)).toBe(false);
  });

  it('recovers condition where an idle field would lose it', () => {
    const idle = fieldAt(0.5);
    updateFarmland(idle.world, idle.land, 2);
    expect(idle.land.condition[0]!).toBeLessThan(0.5);

    const resting = fieldAt(0.5);
    setFallow(resting.land, 0, true);
    updateFarmland(resting.world, resting.land, 2);
    expect(resting.land.condition[0]!).toBeGreaterThan(0.5);
  });

  it('repairs about as fast as one pair of hands, and costs none', () => {
    // The honest claim, and the first version of this test got it wrong by asserting
    // that rest beats TENDING. It should not: a fully manned field repairs three times
    // faster than any fallow rate worth having, and it feeds the village while it does.
    //
    // What rest is actually worth is that it needs nobody. A villager standing on a
    // field is a villager not building, not herding and not breaking new ground, and
    // hands are the scarce thing in this game. So the bar is one pair of them.
    const tended = fieldAt(0.5);
    spawn(tended.world, 5.5, 5.5, 0);
    updateFarmland(tended.world, tended.land, 2);

    const resting = fieldAt(0.5);
    setFallow(resting.land, 0, true);
    updateFarmland(resting.world, resting.land, 2);

    expect(resting.land.condition[0]!).toBeGreaterThanOrEqual(tended.land.condition[0]!);
  });

  it('is beaten by a field the village can actually man', () => {
    // And it has to be, or resting land would dominate working it and the fields would
    // stop being the game. maxHands on a field is three.
    const manned = fieldAt(0.5);
    for (let i = 0; i < F.maxHands; i++) spawn(manned.world, 5.5 + i * 0.1, 5.5, 0);
    updateFarmland(manned.world, manned.land, 2);

    const resting = fieldAt(0.5);
    setFallow(resting.land, 0, true);
    updateFarmland(resting.world, resting.land, 2);

    expect(manned.land.condition[0]!).toBeGreaterThan(resting.land.condition[0]!);
  });

  it('is a trade and not a free repair: a resting field pays nothing this season', () => {
    // The decision fallow actually creates. A thin field with nobody on it still
    // yields its share and goes on rotting; resting it yields NOTHING and gets the
    // land back. Grain now against land later.
    const idle = fieldAt(0.5);
    expect(harvestOf(idle.land, 0)?.share).toBeCloseTo(0.5, 6);

    const resting = fieldAt(0.5);
    setFallow(resting.land, 0, true);
    expect(harvestOf(resting.land, 0)).toBeNull();
  });

  it('feeds nobody while it rests', () => {
    const { land } = fieldAt(0.9);
    expect(harvestOf(land, 0)).not.toBeNull();
    setFallow(land, 0, true);
    expect(harvestOf(land, 0)).toBeNull();
  });

  it('goes back to work, and pays again when it does', () => {
    const { land } = fieldAt(0.9);
    setFallow(land, 0, true);
    setFallow(land, 0, false);
    expect(isFallow(land, 0)).toBe(false);
    expect(harvestOf(land, 0)).not.toBeNull();
  });

  it('never climbs past a whole field', () => {
    const { world, land } = fieldAt(0.99);
    setFallow(land, 0, true);
    for (let cycle = 0; cycle < 20; cycle++) updateFarmland(world, land, 2);
    expect(land.condition[0]!).toBe(1);
  });

  it('is still trampled by cattle standing in it', () => {
    // Resting ground is not fenced ground. A herd parked in a fallow field is still a
    // herd in a field, and letting rest outrun the trampling would make fallow a way to
    // graze the crops for free.
    const { world, land } = fieldAt(0.6);
    setFallow(land, 0, true);
    const before = land.condition[0]!;
    for (let i = 0; i < F.maxTramplers + 2; i++) spawn(world, 5.5, 5.5, 3, 0, 1);
    updateFarmland(world, land, 2);
    expect(land.condition[0]!).toBeLessThan(before + F.fallowRecoveryPerUpkeep);
  });
});
