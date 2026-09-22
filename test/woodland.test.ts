import { describe, expect, it } from 'vitest';
import {
  canRoot,
  createWoodland,
  fell,
  inSeason,
  Species,
  Stage,
  stageOf,
  updateWoodland,
  type Woodland,
} from '../src/sim/woodland.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { FactionId } from '../src/shared/factions/index.js';
import { createRng } from '../src/sim/math/rng.js';
import { packWoodland } from '../src/sim/woodland.js';
import { treeSlot, treeSpecies, treeStage, WOODLAND_STRIDE } from '../src/shared/woodland.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, spawn, type World } from '../src/sim/world.js';
import { flatMap } from './simHarness.js';

const W = tuning.woodland;
/** The common tree's own numbers; each species has its own row now. */
const ACACIA = W.species[0]!;
const wooded = (size = 48) => flatMap(size, W.minBand + 1);

function grove(size = 48, seed = 3) {
  const map = wooded(size);
  return {
    map,
    world: createWorld(64, seed),
    economy: createEconomy([FactionId.Zulu, FactionId.Sotho], seed),
    wood: createWoodland(map, seed),
    rng: createRng(seed),
  };
}

/** The first mature tree of a bearing kind, and a tick at which it is in season. */
function bearingTree(wood: Woodland, kind: Species = Species.Marula): number {
  for (let i = 0; i < wood.count; i++) {
    if (wood.alive[i] === 1 && wood.species[i] === kind && stageOf(wood, i) === Stage.Mature) {
      return i;
    }
  }
  throw new Error(`no mature ${kind} in the grove`);
}

/** A tick inside a species' fruiting window, so a bearing test is not at the mercy of
 * where the year happens to start. */
function inSeasonTick(kind: Species): number {
  const spec = W.species[kind]!;
  const year = tuning.economy.seasonTicks;
  const mid = spec.fruitFrom < spec.fruitTo
    ? (spec.fruitFrom + spec.fruitTo) / 2
    : (spec.fruitFrom + spec.fruitTo + 1) / 2;
  const at = Math.floor((mid % 1) * year);
  // Upkeep lands on exact multiples, and updateWoodland runs with it.
  return Math.max(1, Math.round(at / tuning.economy.upkeepIntervalTicks)) * tuning.economy.upkeepIntervalTicks;
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
  it('never bears on the thorn, whatever the season', () => {
    const { world, economy, wood, rng, map } = grove();
    for (const kind of [Species.Marula, Species.Baobab]) {
      world.tick = inSeasonTick(kind);
      for (let i = 0; i < 30; i++) updateWoodland(world, wood, economy, rng, map, 1);
    }

    for (let i = 0; i < wood.count; i++) {
      if (wood.alive[i] === 0) continue;
      if (wood.species[i] === Species.Acacia) expect(wood.fruit[i]).toBe(0);
    }
  });

  it('bears only inside its own season', () => {
    // The four are staggered across the year on purpose, so a village that wants to eat
    // from the veld all year has to reach more than one kind of country.
    const { world, economy, wood, rng, map } = grove();
    world.tick = inSeasonTick(Species.Marula);
    for (let i = 0; i < 40; i++) updateWoodland(world, wood, economy, rng, map, 1);
    const tree = bearingTree(wood);
    expect(wood.fruit[tree]!).toBeGreaterThan(0);

    // Strip it, then run on through a stretch of the year it does not bear in.
    wood.fruit[tree] = 0;
    world.tick = inSeasonTick(Species.Baobab);
    for (let i = 0; i < 40; i++) updateWoodland(world, wood, economy, rng, map, 1);
    expect(wood.fruit[tree]!).toBe(0);
  });

  it('gives the dry months to the baobab, when nothing else is carrying anything', () => {
    expect(inSeason(Species.Baobab, inSeasonTick(Species.Baobab))).toBe(true);
    expect(inSeason(Species.Marula, inSeasonTick(Species.Baobab))).toBe(false);
    expect(inSeason(Species.Marula, inSeasonTick(Species.Marula))).toBe(true);
    expect(inSeason(Species.Yellowwood, inSeasonTick(Species.Yellowwood))).toBe(true);
    // The thorn never bears at any point in the year.
    for (let t = 0; t < tuning.economy.seasonTicks; t += 200) {
      expect(inSeason(Species.Acacia, t)).toBe(false);
    }
  });

  it('feeds whoever stands under the tree, and takes it off the branch', () => {
    const { world, economy, wood, rng, map } = grove();
    world.tick = inSeasonTick(Species.Marula);
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
    world.tick = inSeasonTick(Species.Marula);
    for (let i = 0; i < 40; i++) updateWoodland(world, wood, economy, rng, map, 1);
    const before = economy.balance(0, Resource.Grain);
    updateWoodland(world, wood, economy, rng, map, 0);
    expect(economy.balance(0, Resource.Grain)).toBe(before);
  });

  it('gives a crowd under one tree diminishing returns', () => {
    const ripen = (g: ReturnType<typeof grove>) => {
      g.world.tick = inSeasonTick(Species.Marula);
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
  /** An axe-hand standing at the tree, which felling requires. */
  function withHands(g: ReturnType<typeof grove>, index: number, player = 0) {
    spawn(g.world, g.wood.x[index]!, g.wood.y[index]!, player);
  }

  it('needs somebody standing at the tree', () => {
    // Without this a village could clear a wood it had never walked to, which makes
    // distance free and the map flat.
    const g = grove();
    const tree = bearingTree(g.wood, Species.Acacia);
    expect(fell(g.world, g.wood, g.economy, 0, tree)).toBe(0);
    expect(g.wood.alive[tree]).toBe(1);

    withHands(g, tree);
    expect(fell(g.world, g.wood, g.economy, 0, tree)).toBe(ACACIA.timberMature);
  });

  it('will not let one village fell what another is standing at', () => {
    const g = grove();
    const tree = bearingTree(g.wood, Species.Acacia);
    withHands(g, tree, 1);
    expect(fell(g.world, g.wood, g.economy, 0, tree)).toBe(0);
  });

  it('pays timber for a grown tree and takes it out of the wood', () => {
    const g = grove();
    const { economy, wood } = g;
    const tree = bearingTree(wood, Species.Acacia);
    withHands(g, tree);

    const before = economy.balance(0, Resource.Wood);
    const taken = fell(g.world, wood, economy, 0, tree);

    expect(taken).toBe(ACACIA.timberMature);
    expect(economy.balance(0, Resource.Wood)).toBe(before + ACACIA.timberMature);
    expect(wood.alive[tree]).toBe(0);
  });

  it('pays what the species is worth, and a baobab is worth nothing', () => {
    // Its wood is fibrous and useless, so the table gives it nothing to yield. Felling
    // one is still allowed — a refusal the player cannot see coming is worse — it simply
    // buys them nothing, which is its own kind of lesson.
    const g = grove();
    const yellowwood = W.species[Species.Yellowwood]!;
    expect(yellowwood.timberMature).toBeGreaterThan(ACACIA.timberMature);
    expect(W.species[Species.Marula]!.timberMature).toBeLessThan(ACACIA.timberMature);
    expect(W.species[Species.Baobab]!.timberMature).toBe(0);

    const baobab = bearingTree(g.wood, Species.Baobab);
    withHands(g, baobab);
    const before = g.economy.balance(0, Resource.Wood);
    expect(fell(g.world, g.wood, g.economy, 0, baobab)).toBe(0);
    expect(g.economy.balance(0, Resource.Wood)).toBe(before);
    // It still comes down. It just pays for nothing.
    expect(g.wood.alive[baobab]).toBe(0);
  });

  it('pays nothing for a sapling, so nobody cuts one for timber', () => {
    const g = grove();
    const { economy, wood } = g;
    const slot = wood.count++;
    wood.x[slot] = 4.5;
    wood.y[slot] = 4.5;
    wood.age[slot] = 0;
    wood.alive[slot] = 1;

    spawn(g.world, 4.5, 4.5, 0);
    expect(fell(g.world, wood, economy, 0, slot)).toBe(0);
    // Clearing ground is still allowed; it just is not worth the axe.
    expect(wood.alive[slot]).toBe(0);
  });

  it('cannot be felled twice', () => {
    const g = grove();
    const tree = bearingTree(g.wood);
    withHands(g, tree);
    fell(g.world, g.wood, g.economy, 0, tree);
    expect(fell(g.world, g.wood, g.economy, 0, tree)).toBe(0);
  });

  it('gives a felled slot back to a new sapling rather than growing the arrays', () => {
    const { world, economy, wood, rng, map } = grove(64, 15);
    // An axe-hand in the middle of the wood; everything here is within reach of it.
    for (let i = 0; i < wood.count; i++) {
      if (wood.alive[i] === 0) continue;
      spawn(world, wood.x[i]!, wood.y[i]!, 0);
      fell(world, wood, economy, 0, i);
    }
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

describe('felling through a command, as the player does it', () => {
  /**
   * The link neither the unit tests nor the browser covered: a click resolves a tree to
   * an index, that index travels as a command, and the simulation has to cut down the
   * tree the player pointed at.
   *
   * It did not. `packWoodland` drops felled trees, so the renderer's index into the
   * packed array stopped matching the simulation's slot as soon as anything came down —
   * the first felling worked and every one after it took the wrong tree. The packed form
   * carries the slot now; this is what would have caught it.
   */
  it('cuts down the tree the packed form points at, after an earlier felling', () => {
    const g = grove(64, 21);
    const { world, wood, economy } = g;

    // Fell one tree early, so the packed indices and the real slots diverge.
    const first = bearingTree(wood);
    spawn(world, wood.x[first]!, wood.y[first]!, 0);
    expect(fell(world, wood, economy, 0, first)).toBeGreaterThan(0);

    const packed = packWoodland(wood);
    // Any tree well past the start of the array, where the shift would show.
    const at = WOODLAND_STRIDE * 20;
    const slot = treeSlot(packed, at);
    const targetX = packed[at]!;
    const targetY = packed[at + 1]!;

    expect(wood.x[slot]).toBeCloseTo(targetX, 5);
    expect(wood.y[slot]).toBeCloseTo(targetY, 5);

    spawn(world, targetX, targetY, 0);
    const before = economy.balance(0, Resource.Wood);
    fell(world, wood, economy, 0, slot);

    expect(wood.alive[slot]).toBe(0);
    expect(economy.balance(0, Resource.Wood)).toBeGreaterThan(before);
  });

  it('describes every packed tree the way the renderer reads it', () => {
    const { wood } = grove(48, 22);
    const packed = packWoodland(wood);

    let living = 0;
    for (let i = 0; i < wood.count; i++) living += wood.alive[i]!;
    expect(packed.length).toBe(living * WOODLAND_STRIDE);

    for (let at = 0; at < packed.length; at += WOODLAND_STRIDE) {
      const slot = treeSlot(packed, at);
      expect(wood.alive[slot]).toBe(1);
      expect(treeSpecies(packed, at)).toBe(wood.species[slot]);
      expect(treeStage(packed, at)).toBe(stageOf(wood, slot));
    }
  });
});

describe('where each kind grows', () => {
  it('puts the timber tree in the high kloofs and the baobab on the flats', () => {
    // The species root in different country on purpose: a village cannot have the best
    // timber and the dry-season fruit within walking distance of one kraal.
    const high = createWoodland(flatMap(48, W.species[Species.Yellowwood]!.minBand), 3);
    const low = createWoodland(flatMap(48, W.species[Species.Baobab]!.minBand), 3);

    const kindsIn = (wood: Woodland) => {
      const seen = new Set<number>();
      for (let i = 0; i < wood.count; i++) if (wood.alive[i] === 1) seen.add(wood.species[i]!);
      return seen;
    };

    expect(kindsIn(high).has(Species.Yellowwood)).toBe(true);
    expect(kindsIn(high).has(Species.Baobab)).toBe(false);
    expect(kindsIn(low).has(Species.Baobab)).toBe(true);
    expect(kindsIn(low).has(Species.Yellowwood)).toBe(false);
  });

  it('grows a mix rather than one species everywhere', () => {
    /*
     * The bug this pins was live and invisible. The density filter keeps a tile only
     * when its low sixteen bits are small, and the species roll was drawn from bits
     * inside that same range — so after the filter it could only ever come out at the
     * bottom of its scale, and every tree on every starting map was one kind. Two
     * fields drawn from one range are correlated whether or not anyone meant them to be.
     */
    const wood = createWoodland(flatMap(48, W.species[Species.Marula]!.minBand), 3);
    const counts = new Map<number, number>();
    for (let i = 0; i < wood.count; i++) {
      if (wood.alive[i] === 1) counts.set(wood.species[i]!, (counts.get(wood.species[i]!) ?? 0) + 1);
    }
    expect(wood.count).toBeGreaterThan(40);
    expect(counts.size).toBeGreaterThan(1);

    // And age must not be correlated with species either, which was the same bug a
    // second time: the commonest kind had not one mature tree among it.
    for (const [kind] of counts) {
      let mature = 0;
      for (let i = 0; i < wood.count; i++) {
        if (wood.alive[i] === 1 && wood.species[i] === kind && stageOf(wood, i) === Stage.Mature) {
          mature++;
        }
      }
      expect(mature, `no mature trees of species ${kind}`).toBeGreaterThan(0);
    }
  });
});
