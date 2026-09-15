import { describe, expect, it } from 'vitest';
import {
  canRoot,
  createWoodland,
  fell,
  Species,
  Stage,
  stageOf,
  updateWoodland,
  type Woodland,
} from '../src/sim/woodland.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { FactionId } from '../src/shared/factions/index.js';
import { createRng } from '../src/sim/math/rng.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, spawn, type World } from '../src/sim/world.js';
import { flatMap } from './simHarness.js';

const W = tuning.woodland;
const wooded = (size = 48) => flatMap(size, W.minBand + 1);

function grove(size = 48, seed = 3) {
  const map = wooded(size);
  return {
    map,
    world: createWorld(64, seed),
    economy: createEconomy([FactionId.Zulu, FactionId.Sotho], seed, []),
    wood: createWoodland(map, seed),
    rng: createRng(seed),
  };
}

/** The first mature marula, which is the only kind that bears. */
function bearingTree(wood: Woodland): number {
  for (let i = 0; i < wood.count; i++) {
    if (wood.alive[i] === 1 && wood.species[i] === Species.Marula && stageOf(wood, i) === Stage.Mature) {
      return i;
    }
  }
  throw new Error('no bearing tree in the grove');
}

function sendPickers(world: World, wood: Woodland, index: number, count: number, player = 0) {
  for (let i = 0; i < count; i++) {
    spawn(world, wood.x[index]! + i * 0.15, wood.y[index]!, player);
  }
}

describe('where a tree will take root', () => {
  it('refuses the wet bottom and the bare stone', () => {
    expect(canRoot(flatMap(16, 0), 8, 8)).toBe(false);
    expect(canRoot(flatMap(16, 7), 8, 8)).toBe(false);
    expect(canRoot(wooded(16), 8, 8)).toBe(true);
  });

  it('puts a standing wood on ground that carries it, and none where it does not', () => {
    expect(createWoodland(wooded(48), 1).count).toBeGreaterThan(0);
    expect(createWoodland(flatMap(48, 0), 1).count).toBe(0);
  });

  it('starts a wood at mixed ages, so the first felling is not free', () => {
    const wood = createWoodland(wooded(64), 4);
    const stages = new Set<number>();
    for (let i = 0; i < wood.count; i++) stages.add(stageOf(wood, i));
    expect(stages.size).toBeGreaterThan(1);
  });

  it('grows the same wood twice, so two machines agree', () => {
    const a = createWoodland(wooded(48), 99);
    const b = createWoodland(wooded(48), 99);
    expect(a.count).toBe(b.count);
    expect([...a.x]).toEqual([...b.x]);
    expect([...a.species]).toEqual([...b.species]);
  });
});

describe('growing', () => {
  it('takes a sapling through to a mature tree', () => {
    const { world, economy, wood, rng, map } = grove();
    // A fresh sapling in a slot of its own.
    const slot = wood.count;
    wood.count++;
    wood.x[slot] = 5.5;
    wood.y[slot] = 5.5;
    wood.species[slot] = Species.Acacia;
    wood.age[slot] = 0;
    wood.alive[slot] = 1;

    expect(stageOf(wood, slot)).toBe(Stage.Sapling);
    for (let i = 0; i < W.youngAge + 2; i++) updateWoodland(world, wood, economy, rng, map, 1);
    expect(stageOf(wood, slot)).toBe(Stage.Young);
    for (let i = 0; i < W.matureAge; i++) updateWoodland(world, wood, economy, rng, map, 1);
    expect(stageOf(wood, slot)).toBe(Stage.Mature);
  });

  it('grows more slowly in a drought, but never stops', () => {
    const wet = grove();
    const dry = grove();
    for (let i = 0; i < 20; i++) {
      updateWoodland(wet.world, wet.wood, wet.economy, wet.rng, wet.map, 1);
      updateWoodland(dry.world, dry.wood, dry.economy, dry.rng, dry.map, 0);
    }
    expect(wet.wood.age[0]!).toBeGreaterThan(dry.wood.age[0]!);
    // A dry year sets a wood back; it does not sterilise it.
    expect(dry.wood.age[0]!).toBeGreaterThan(0);
  });
});

describe('bearing and picking', () => {
  it('only the marula bears', () => {
    const { world, economy, wood, rng, map } = grove();
    for (let i = 0; i < 30; i++) updateWoodland(world, wood, economy, rng, map, 1);

    for (let i = 0; i < wood.count; i++) {
      if (wood.alive[i] === 0) continue;
      if (wood.species[i] === Species.Acacia) expect(wood.fruit[i]).toBe(0);
    }
  });

  it('feeds whoever stands under the tree, and takes it off the branch', () => {
    const { world, economy, wood, rng, map } = grove();
    for (let i = 0; i < 40; i++) updateWoodland(world, wood, economy, rng, map, 1);

    const tree = bearingTree(wood);
    expect(wood.fruit[tree]!).toBeGreaterThan(0);
    sendPickers(world, wood, tree, 2);

    const onBranch = wood.fruit[tree]!;
    const before = economy.balance(0, Resource.Grain);
    updateWoodland(world, wood, economy, rng, map, 0);

    expect(economy.balance(0, Resource.Grain)).toBeGreaterThan(before);
    expect(wood.fruit[tree]!).toBeLessThan(onBranch);
  });

  it('pays nothing to a village that sent nobody', () => {
    const { world, economy, wood, rng, map } = grove();
    for (let i = 0; i < 40; i++) updateWoodland(world, wood, economy, rng, map, 1);
    const before = economy.balance(0, Resource.Grain);
    updateWoodland(world, wood, economy, rng, map, 0);
    expect(economy.balance(0, Resource.Grain)).toBe(before);
  });

  it('gives a crowd under one tree diminishing returns', () => {
    const ripen = (g: ReturnType<typeof grove>) => {
      for (let i = 0; i < 40; i++) updateWoodland(g.world, g.wood, g.economy, g.rng, g.map, 1);
      return bearingTree(g.wood);
    };
    const few = grove();
    const tree = ripen(few);
    sendPickers(few.world, few.wood, tree, 1);
    const a = few.economy.balance(0, Resource.Grain);
    updateWoodland(few.world, few.wood, few.economy, few.rng, few.map, 0);
    const withOne = few.economy.balance(0, Resource.Grain) - a;

    const many = grove();
    const tree2 = ripen(many);
    sendPickers(many.world, many.wood, tree2, W.maxGatherers * 4);
    const b = many.economy.balance(0, Resource.Grain);
    updateWoodland(many.world, many.wood, many.economy, many.rng, many.map, 0);
    const withCrowd = many.economy.balance(0, Resource.Grain) - b;

    expect(withCrowd).toBeGreaterThan(withOne);
    // One tree does not bear four times as fast because four times as many people are
    // standing under it. This is what keeps foraging a fallback rather than a strategy.
    expect(withCrowd).toBeLessThanOrEqual(withOne * W.maxGatherers + 1e-6);
  });
});

describe('seeding', () => {
  it('spreads a wood into ground it can reach', () => {
    const { world, economy, wood, rng, map } = grove(64, 11);
    const before = wood.count;
    for (let i = 0; i < 120; i++) updateWoodland(world, wood, economy, rng, map, 1);
    expect(wood.count).toBeGreaterThan(before);
  });

  it('does not seed onto ground that cannot carry a tree', () => {
    const { world, economy, wood, rng, map } = grove(64, 12);
    for (let i = 0; i < 120; i++) updateWoodland(world, wood, economy, rng, map, 1);
    for (let i = 0; i < wood.count; i++) {
      if (wood.alive[i] === 0) continue;
      expect(canRoot(map, Math.floor(wood.x[i]!), Math.floor(wood.y[i]!))).toBe(true);
    }
  });

  it('will not grow a thicket', () => {
    const { world, economy, wood, rng, map } = grove(64, 13);
    for (let i = 0; i < 200; i++) updateWoodland(world, wood, economy, rng, map, 1);

    // Every seeded tree respects the spacing. Without it a wood becomes a solid mat and
    // the ground under it stops being worth walking to.
    for (let i = 0; i < wood.count; i++) {
      if (wood.alive[i] === 0) continue;
      for (let j = i + 1; j < wood.count; j++) {
        if (wood.alive[j] === 0) continue;
        const dx = wood.x[i]! - wood.x[j]!;
        const dy = wood.y[i]! - wood.y[j]!;
        expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThanOrEqual(W.minSpacing - 1e-9);
      }
    }
  });

  it('seeds nothing in a drought', () => {
    const { world, economy, wood, rng, map } = grove(64, 14);
    const before = wood.count;
    for (let i = 0; i < 120; i++) updateWoodland(world, wood, economy, rng, map, 0);
    expect(wood.count).toBe(before);
  });
});

describe('felling', () => {
  it('pays timber for a grown tree and takes it out of the wood', () => {
    const { economy, wood } = grove();
    const tree = bearingTree(wood);

    const before = economy.balance(0, Resource.Wood);
    const taken = fell(wood, economy, 0, tree);

    expect(taken).toBe(W.timberMature);
    expect(economy.balance(0, Resource.Wood)).toBe(before + W.timberMature);
    expect(wood.alive[tree]).toBe(0);
  });

  it('pays nothing for a sapling, so nobody cuts one for timber', () => {
    const { economy, wood } = grove();
    const slot = wood.count++;
    wood.x[slot] = 4.5;
    wood.y[slot] = 4.5;
    wood.age[slot] = 0;
    wood.alive[slot] = 1;

    expect(fell(wood, economy, 0, slot)).toBe(0);
    // Clearing ground is still allowed; it just is not worth the axe.
    expect(wood.alive[slot]).toBe(0);
  });

  it('cannot be felled twice', () => {
    const { economy, wood } = grove();
    const tree = bearingTree(wood);
    fell(wood, economy, 0, tree);
    expect(fell(wood, economy, 0, tree)).toBe(0);
  });

  it('gives a felled slot back to a new sapling rather than growing the arrays', () => {
    const { world, economy, wood, rng, map } = grove(64, 15);
    for (let i = 0; i < wood.count; i++) if (wood.alive[i] === 1) fell(wood, economy, 0, i);
    // Nothing standing, so nothing can seed; put one mature tree back by hand.
    const seedSlot = 0;
    wood.alive[seedSlot] = 1;
    wood.age[seedSlot] = W.matureAge * 2;

    const highWater = wood.count;
    for (let i = 0; i < 200; i++) updateWoodland(world, wood, economy, rng, map, 1);
    expect(wood.count).toBe(highWater);

    let standing = 0;
    for (let i = 0; i < wood.count; i++) standing += wood.alive[i]!;
    expect(standing).toBeGreaterThan(1);
  });
});
