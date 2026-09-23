import { describe, expect, it } from 'vitest';
import { BUILDINGS, BuildingType } from '../src/shared/buildings/index.js';
import { FactionId } from '../src/shared/factions/index.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { createWorld, spawn } from '../src/sim/world.js';

/**
 * The goat fold: the one income a drought does not touch.
 *
 * Its whole identity is that it is NOT a cheaper granary. Goats and fowl browse scrub
 * and eat scraps where cattle graze grass, so they come through a dry year that kills
 * a herd — which is why a homestead that owned cattle kept them anyway. In play that
 * makes the fold a small, boring, reliable income, and the hedge for a village whose
 * herd has outgrown what it can feed.
 *
 * A building whose only difference from another is the size of its numbers is not a new
 * building, and the catalogue already had four of those.
 */

const PLAYERS = [FactionId.Zulu, FactionId.Sotho] as const;

/** What one upkeep pays out, with the drought at a given tick. */
function income(tick: number, grain: number, cattle: number, hardyGrain: number): number {
  const world = createWorld(64, 1);
  spawn(world, 0, 0, 0);
  const economy = createEconomy(PLAYERS, 1);
  const before = economy.balance(0, Resource.Grain);
  world.tick = tick;
  economy.update(world, [], () => ({ grain, cattle, hardyGrain }));
  const after = economy.balance(0, Resource.Grain);
  // Upkeep and spoilage came out of both sides of every comparison below; what is
  // under test is the difference between two otherwise identical runs.
  return after - before;
}

/** Measured: where the shipped drought curve peaks. */
const PARCHED = 41_600;
const WET = 200;

describe('a drought-proof yield', () => {
  it('pays the same in a parched year as in a wet one', () => {
    expect(income(PARCHED, 0, 0, 20)).toBeCloseTo(income(WET, 0, 0, 20), 6);
  });

  it('is not how ordinary building yield behaves', () => {
    // The contrast that makes the fold worth having. A granary shares the drought.
    expect(income(PARCHED, 20, 0, 0)).toBeLessThan(income(WET, 20, 0, 0));
  });

  it('adds to the granary like any other income', () => {
    expect(income(WET, 0, 0, 20)).toBeGreaterThan(income(WET, 0, 0, 0));
  });
});

describe('the fold in the catalogue', () => {
  it('yields less than a granary in a good year and more in a bad one', () => {
    const fold = BUILDINGS[BuildingType.IsibayaSezimbuzi];
    const store = BUILDINGS[BuildingType.GrainStore];

    expect(fold.hardyGrainYield).toBeGreaterThan(0);
    expect(fold.grainYield).toBe(0);
    // Worse when the rains come...
    expect(fold.hardyGrainYield).toBeLessThan(store.grainYield);
    // ...and better when they do not, which is the entire argument for building one.
    const parched = income(PARCHED, store.grainYield, 0, 0);
    const hardy = income(PARCHED, 0, 0, fold.hardyGrainYield);
    expect(hardy).toBeGreaterThan(parched);
  });

  it('is cheap, small and needs no water', () => {
    const fold = BUILDINGS[BuildingType.IsibayaSezimbuzi];
    expect(fold.footprint).toBe(1);
    expect(fold.needsWater).toBe(false);
    expect(fold.cattleCost).toBe(0);
    expect(fold.grainCost).toBeLessThan(BUILDINGS[BuildingType.GrainStore].grainCost);
  });

  it('is the only building in the catalogue that yields this way', () => {
    // A guard on the identity rather than on the number: the moment a second building
    // pays a drought-proof yield, the fold is just a small version of that one.
    const hardy = Object.values(BUILDINGS).filter((spec) => spec.hardyGrainYield > 0);
    expect(hardy).toHaveLength(1);
    expect(hardy[0]?.type).toBe(BuildingType.IsibayaSezimbuzi);
  });
});
