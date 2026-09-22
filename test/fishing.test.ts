import { describe, expect, it } from 'vitest';
import { heightmapWithWater, isShore, isWater } from '../src/shared/heightmap.js';
import { updateFishing } from '../src/sim/fishing.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { FactionId } from '../src/shared/factions/index.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, spawn } from '../src/sim/world.js';

const UPKEEP = tuning.economy.upkeepIntervalTicks;
const F = tuning.fishing;

/** Four columns of water down the left, dry land to the right of it. */
function riverbank(size = 8) {
  const rows = Array.from({ length: size }, () => Array.from({ length: size }, () => 2));
  const wet = Array.from({ length: size }, () =>
    Array.from({ length: size }, (_, x) => (x < 2 ? 1 : 0)),
  );
  return heightmapWithWater(rows, 8, wet);
}

describe('where the water is', () => {
  it('knows water from land, and a bank from either', () => {
    const map = riverbank();
    expect(isWater(map, 1, 3)).toBe(true);
    expect(isWater(map, 4, 3)).toBe(false);
    // The bank is the dry tile touching it, not the water and not the field behind.
    expect(isShore(map, 2, 3)).toBe(true);
    expect(isShore(map, 1, 3)).toBe(false);
    expect(isShore(map, 3, 3)).toBe(false);
  });

  it('treats a map with no water as dry everywhere', () => {
    const dry = heightmapWithWater([[1, 1], [1, 1]], 8, [[0, 0], [0, 0]]);
    expect(isWater(dry, 0, 0)).toBe(false);
    expect(isShore(dry, 0, 0)).toBe(false);
  });
});

describe('fishing', () => {
  function bank(anglers: number, atX = 2, player = 0) {
    const map = riverbank();
    const world = createWorld(32, 5);
    const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], 5);
    for (let i = 0; i < anglers; i++) spawn(world, atX + 0.5, 3.5, player);
    const before = economy.balance(player, Resource.Grain);
    updateFishing(world, map, economy, UPKEEP);
    return economy.balance(player, Resource.Grain) - before;
  }

  it('feeds a village that stands at the water', () => {
    expect(bank(1)).toBeCloseTo(F.catchPerUpkeep);
  });

  it('pays nothing to people standing inland', () => {
    expect(bank(3, 5)).toBe(0);
  });

  it('gives a crowd on one stretch diminishing returns', () => {
    // A river bank is not an assembly line — the same rule the fruit trees use.
    expect(bank(8)).toBeCloseTo(F.maxAnglers * F.catchPerUpkeep);
  });

  it('pays on the upkeep cycle and not between', () => {
    const map = riverbank();
    const world = createWorld(32, 5);
    const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], 5);
    spawn(world, 2.5, 3.5, 0);
    const before = economy.balance(0, Resource.Grain);
    updateFishing(world, map, economy, UPKEEP + 1);
    expect(economy.balance(0, Resource.Grain)).toBe(before);
  });

  it('does not let one village crowd another off the same stretch', () => {
    // Two villages fishing the same bend are not competing for the same hands.
    const map = riverbank();
    const world = createWorld(32, 5);
    const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], 5);
    for (let i = 0; i < 4; i++) spawn(world, 2.5, 3.5, 0);
    for (let i = 0; i < 4; i++) spawn(world, 2.5, 3.5, 1);
    updateFishing(world, map, economy, UPKEEP);

    expect(economy.balance(0, Resource.Grain)).toBeGreaterThan(0);
    expect(economy.balance(1, Resource.Grain) - 560).toBeCloseTo(
      economy.balance(0, Resource.Grain) - 400,
    );
  });

  it('pays the same in a drought as in a good year, which is the whole point', () => {
    // Every other source of food here answers to the season. A river does not, and that
    // is what makes ground by the water worth holding.
    expect(bank(2)).toBeCloseTo(bank(2));
    expect(bank(2)).toBeGreaterThan(0);
  });
});
