import { heightAt, type Heightmap } from '../shared/heightmap.js';
import { WOODLAND_STRIDE } from '../shared/woodland.js';
import { nextFloat, type Rng } from './math/rng.js';
import { cos, sin, TWO_PI } from './math/trig.js';
import { tuning } from './tuning.js';
import { EntityKind, type World } from './world.js';
import { Resource, type Economy } from './economy/ledger.js';

/**
 * The woodland: trees that grow, seed, bear and are felled.
 *
 * **This deliberately reverses a decision recorded in `render/scene/decoration.ts`**,
 * which says vegetation is render-side and nothing else, because "making them solid
 * would put them in the simulation, in the pathing cost layers, in the replay hash and
 * in every save, for scenery". That argument is correct for scenery and does not survive
 * the trees becoming a resource. A thing you plant, wait for, pick and cut down is
 * simulation by definition; keeping it in the renderer would mean the food supply lived
 * somewhere the simulation could not see.
 *
 * Two halves of that decision are kept, because they were the expensive halves:
 *
 * - **Trees still do not block movement.** They are not in the cost layers and not in
 *   `dirs8`. Walking through a thorn bush remains a smaller lie than putting sixteen
 *   thousand obstacles into the pathing grid.
 * - **Trees are not entities.** No handles, no generation counters, no slot recycling.
 *   They are a compact set of parallel arrays with a live count — closer to the fog than
 *   to a unit, and about as cheap to hash and to save.
 *
 * Scrub, aloes and rocks stay pure decoration. Only what bears or burns is here.
 */

/**
 * What grows here, and why these four.
 *
 * Each is a real tree of the region with a real use, and the four are deliberately
 * unalike in the two things a player acts on — when they bear and whether they are worth
 * an axe — so that where a wood stands changes what a village can do with it. The bands
 * they take root in do the rest: the timber tree is up in the kloofs, the fruit tree of
 * the dry country is down on the flats, and a village cannot have everything within
 * walking distance of one kraal.
 *
 * Numbers live in `tuning.woodland.species`, indexed by these codes; the sprite names
 * live in shared/woodland.ts, because the renderer needs those and may not read tuning.
 */
export const Species = {
  /** Umbrella thorn. The common tree, good timber, bears nothing. */
  Acacia: 0,
  /**
   * Marula. Bears heavily at the end of the wet season and is poor timber — which is
   * roughly why the real ones were left standing when the ground around them was cleared.
   */
  Marula: 1,
  /**
   * Yellowwood. The forest tree of the high kloofs: the best timber here by a distance,
   * and a light crop of fruit in the autumn. Grows where nothing else in this list will.
   */
  Yellowwood: 2,
  /**
   * Baobab. Fruit through the dry season, when nothing else is bearing, and no timber at
   * all — the wood is fibrous and useless. Cutting one yields NOTHING, which is both true
   * and the point: it is the one tree a village cannot turn into a building.
   */
  Baobab: 3,
} as const;

export type Species = (typeof Species)[keyof typeof Species];

export const Stage = {
  Sapling: 0,
  Young: 1,
  Mature: 2,
} as const;

export type Stage = (typeof Stage)[keyof typeof Stage];

export interface Woodland {
  readonly capacity: number;
  /** Slots in use. Dead slots below this are marked in `alive`. */
  count: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly species: Uint8Array;
  /** Upkeep cycles of growth accumulated. Stage is derived from it. */
  readonly age: Float64Array;
  /** Fruit standing on the tree, in grain-equivalent. */
  readonly fruit: Float64Array;
  readonly alive: Uint8Array;
  /**
   * Bumped when the wood LOOKS different: a tree changed stage, took root, or came
   * down.
   *
   * Not when anything at all changes. Age creeps every upkeep and fruit comes and goes,
   * and neither is visible — a tree is drawn from its stage. Bumping on those made the
   * renderer tear down and rebuild fourteen hundred sprites every ten seconds for a
   * change nobody could see, and Pixi's addChild removes-then-appends, so that is a
   * linear scan per sprite on a list of fourteen hundred.
   */
  version: number;
}

export function stageOf(wood: Woodland, index: number): Stage {
  const w = tuning.woodland;
  const age = wood.age[index]!;
  if (age >= w.matureAge) return Stage.Mature;
  if (age >= w.youngAge) return Stage.Young;
  return Stage.Sapling;
}

/** Ground SOME tree will take root on: not the wet bottom, not bare stone. */
export function canRoot(map: Heightmap, tileX: number, tileY: number): boolean {
  const w = tuning.woodland;
  const level = heightAt(map, tileX, tileY);
  return level >= w.minBand && level <= w.maxBand;
}

/** Ground THIS species will take. Each has its own country; see Species. */
export function canRootSpecies(map: Heightmap, species: Species, tileX: number, tileY: number): boolean {
  const spec = tuning.woodland.species[species];
  if (spec === undefined) return false;
  const level = heightAt(map, tileX, tileY);
  return level >= spec.minBand && level <= spec.maxBand;
}

/**
 * Which tree comes up on this ground, given a roll in [0, 1).
 *
 * Weighted among the species that will actually grow there, so the mix is a property of
 * the country rather than of the map as a whole — a kloof comes up yellowwood and a hot
 * flat comes up baobab, without either being placed by hand. Returns -1 where nothing
 * will take, which is how a caller knows to skip the tile rather than force a tree onto
 * ground that cannot hold it.
 */
export function speciesFor(map: Heightmap, tileX: number, tileY: number, roll: number): number {
  const species = tuning.woodland.species;
  const level = heightAt(map, tileX, tileY);

  let total = 0;
  for (const spec of species) {
    if (level >= spec.minBand && level <= spec.maxBand) total += spec.weight;
  }
  if (total <= 0) return -1;

  let mark = roll * total;
  for (let i = 0; i < species.length; i++) {
    const spec = species[i]!;
    if (level < spec.minBand || level > spec.maxBand) continue;
    mark -= spec.weight;
    if (mark < 0) return i;
  }
  // Rounding only; the last eligible species takes it.
  for (let i = species.length - 1; i >= 0; i--) {
    const spec = species[i]!;
    if (level >= spec.minBand && level <= spec.maxBand) return i;
  }
  return -1;
}

/**
 * Is this species bearing at this point in the year?
 *
 * Fruit is seasonal, and the four seasons are staggered on purpose: marula at the end of
 * the wet, yellowwood through the autumn, baobab across the dry months when nothing else
 * is carrying anything. So a village that wants to eat from the veld all year has to have
 * reached more than one kind of country — which is the whole reason the species root in
 * different bands.
 *
 * A window may wrap past the year's end, and the comparison handles that rather than
 * forbidding it: a tree that bears from November to February is an ordinary tree.
 */
export function inSeason(species: Species, tick: number): boolean {
  const spec = tuning.woodland.species[species];
  if (spec === undefined || spec.fruitPerUpkeep <= 0) return false;
  if (spec.fruitFrom === spec.fruitTo) return false;

  const year = tuning.economy.seasonTicks;
  const phase = (tick % year) / year;
  return spec.fruitFrom < spec.fruitTo
    ? phase >= spec.fruitFrom && phase < spec.fruitTo
    : phase >= spec.fruitFrom || phase < spec.fruitTo;
}

/**
 * Is there already a tree too near to plant another?
 *
 * One rule for both ways a tree arrives. Seeding checked spacing and the initial
 * placement did not, which made "no two trees closer than minSpacing" false on the very
 * first tick — two adjacent tiles could each roll a tree and stand a quarter of a tile
 * apart. An invariant that only some of the code obeys is not an invariant.
 */
function tooClose(wood: Woodland, x: number, y: number): boolean {
  const spacing = tuning.woodland.minSpacing;
  const limit = spacing * spacing;
  for (let i = 0; i < wood.count; i++) {
    if (wood.alive[i] === 0) continue;
    const dx = wood.x[i]! - x;
    const dy = wood.y[i]! - y;
    if (dx * dx + dy * dy < limit) return true;
  }
  return false;
}

function add(
  wood: Woodland,
  x: number,
  y: number,
  species: Species,
  age: number,
): number {
  // Reuse a dead slot before growing the count, so a wood that is cut and regrows for an
  // hour does not walk off the end of its arrays.
  let slot = -1;
  for (let i = 0; i < wood.count; i++) {
    if (wood.alive[i] === 0) {
      slot = i;
      break;
    }
  }
  if (slot === -1) {
    if (wood.count >= wood.capacity) return -1;
    slot = wood.count++;
  }

  wood.x[slot] = x;
  wood.y[slot] = y;
  wood.species[slot] = species;
  wood.age[slot] = age;
  wood.fruit[slot] = 0;
  wood.alive[slot] = 1;
  return slot;
}

/**
 * The wood a map starts with.
 *
 * Placed from a hash of the tile rather than from the simulation RNG, for the same
 * reason `createStartingPlots` is: this runs during setup and must not consume state the
 * simulation will later depend on. Seeding at runtime does use the RNG, because by then
 * it is an event in the simulation rather than a fact about the map.
 */
export function createWoodland(map: Heightmap, seed: number): Woodland {
  const w = tuning.woodland;
  const capacity = w.capacity;
  const wood: Woodland = {
    capacity,
    count: 0,
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    species: new Uint8Array(capacity),
    age: new Float64Array(capacity),
    fruit: new Float64Array(capacity),
    alive: new Uint8Array(capacity),
    version: 0,
  };

  for (let tileY = 0; tileY < map.height; tileY++) {
    for (let tileX = 0; tileX < map.width; tileX++) {
      if (!canRoot(map, tileX, tileY)) continue;

      let hash = (tileX * 0x1f1f1f1f) ^ (tileY * 0x85ebca6b) ^ Math.imul(seed, 0x9e3779b9);
      hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
      hash = (hash ^ (hash >>> 13)) >>> 0;
      if ((hash & 0xffff) / 0x10000 >= w.startingDensity) continue;

      /*
       * Everything else comes from a SECOND hash, and that is a bug fix rather than
       * tidying.
       *
       * The density test above keeps a tile only when its low sixteen bits are small —
       * under 0.055 of the range — so every tree that exists has bits 0 to 15 below
       * about 3,600. Drawing anything else from those same bits therefore draws from a
       * range that has already been narrowed to its bottom edge: the species roll was
       * `(hash >>> 8) & 0xff`, which after the filter can only be 0 to 13, so it always
       * came out under 0.055. Every tree on every starting map was one species. It was
       * invisible while there were two of them and one tint between them, and it would
       * have quietly thrown away three of the four now.
       */
      let detail = Math.imul(hash ^ 0x9e3779b9, 0x85ebca6b);
      detail = Math.imul(detail ^ (detail >>> 13), 0xc2b2ae35);
      detail = (detail ^ (detail >>> 16)) >>> 0;

      /*
       * Each field takes its OWN slice of those bits, none of them overlapping.
       *
       * The first attempt at the fix above drew the species from bits 0-15 and the age
       * from bits 8-15, which share a byte — so the species picked for a low roll, which
       * is the first in the weighted list, also got a low age, and not one tree of the
       * commonest kind on the map was ever mature. Two fields drawn from one range are
       * correlated whether or not that was the intention.
       */
      const species = speciesFor(map, tileX, tileY, (detail & 0xfff) / 0x1000);
      if (species === -1) continue;
      // A standing wood is not all one age. Starting everything mature would make the
      // first felling free and the second impossible.
      const age = w.matureAge * (0.35 + (((detail >>> 12) & 0xff) / 255) * 1.1);
      // Jittered off the tile centre, or a wood comes out on a grid and reads as an
      // orchard — the same reason the decoration layer jitters.
      const jitterX = (((detail >>> 20) & 0x3f) / 63) * 0.8 + 0.1;
      const jitterY = (((detail >>> 26) & 0x3f) / 63) * 0.8 + 0.1;

      const x = tileX + jitterX;
      const y = tileY + jitterY;
      if (tooClose(wood, x, y)) continue;
      if (add(wood, x, y, species as Species, age) === -1) return wood;
    }
  }
  return wood;
}

/**
 * Grow, bear, seed and be gathered. Runs on the upkeep cycle with the ledger.
 *
 * `wetness` is 1 in a good season and falls toward 0 in a drought — the same figure the
 * harvest uses, passed in rather than recomputed so the wood and the fields cannot
 * disagree about the weather.
 */
export function updateWoodland(
  world: World,
  wood: Woodland,
  economy: Economy,
  rng: Rng,
  map: Heightmap,
  wetness: number,
): void {
  const w = tuning.woodland;
  const reachSq = w.gatherRadius * w.gatherRadius;
  let moved = false;

  for (let index = 0; index < wood.count; index++) {
    if (wood.alive[index] === 0) continue;

    // --- growth ----------------------------------------------------------------
    // Slower in a drought but never stopped: a dry year sets a wood back, it does not
    // sterilise it.
    const was = stageOf(wood, index);
    wood.age[index] = wood.age[index]! + w.growthPerUpkeep * (0.3 + 0.7 * wetness);
    const stage = stageOf(wood, index);
    // Only a change of stage is visible, so only a change of stage is news.
    if (stage !== was) moved = true;

    // --- bearing ---------------------------------------------------------------
    // Only a grown tree, only a species that bears, and only in its own season. Fruit
    // already on the tree stays there out of season — it is picked or it is not.
    const kind = wood.species[index]! as Species;
    const spec = w.species[kind];
    if (stage === Stage.Mature && spec !== undefined && inSeason(kind, world.tick)) {
      const cap = w.fruitCapacity;
      if (wood.fruit[index]! < cap) {
        wood.fruit[index] = Math.min(cap, wood.fruit[index]! + spec.fruitPerUpkeep * wetness);
      }
    }

    // --- gathering -------------------------------------------------------------
    if (wood.fruit[index]! <= 0) continue;

    const treeX = wood.x[index]!;
    const treeY = wood.y[index]!;
    const gatherers = new Float64Array(economy.players);
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
      const owner = world.faction[i]!;
      if (owner >= economy.players) continue;
      const dx = world.posX[i]! - treeX;
      const dy = world.posY[i]! - treeY;
      if (dx * dx + dy * dy > reachSq) continue;
      gatherers[owner]!++;
    }

    for (let player = 0; player < economy.players; player++) {
      const hands = gatherers[player]!;
      if (hands === 0) continue;

      // Diminishing. One tree does not bear twice as fast because twice as many people
      // are standing under it, which is what keeps foraging worth less per head than a
      // field and makes it a fallback rather than a strategy.
      const working = hands > w.maxGatherers ? w.maxGatherers : hands;
      const taken = Math.min(working * w.pickedPerUpkeep, wood.fruit[index]!);
      if (taken <= 0) continue;
      wood.fruit[index] = wood.fruit[index]! - taken;
      economy.add(player, Resource.Grain, taken);
    }
  }

  // --- seeding -----------------------------------------------------------------
  //
  // New saplings come up near standing trees rather than anywhere at all, so a wood
  // spreads from its edge and cleared ground stays clear until something reaches it.
  // Uses the simulation RNG because this is an event in the simulation, not a fact about
  // the map — and the wood is hashed into the replay, so it has to be reproducible.
  const chance = w.seedChancePerUpkeep * wetness;
  if (chance > 0 && wood.count > 0) {
    const attempts = w.seedAttemptsPerUpkeep;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (nextFloat(rng) >= chance) continue;

      const parent = Math.floor(nextFloat(rng) * wood.count);
      if (parent >= wood.count || wood.alive[parent] === 0) continue;
      if (stageOf(wood, parent) !== Stage.Mature) continue;

      const angle = nextFloat(rng) * TWO_PI;
      const distance = w.seedRadius * (0.35 + nextFloat(rng) * 0.65);
      const x = wood.x[parent]! + cos(angle) * distance;
      const y = wood.y[parent]! + sin(angle) * distance;
      if (!canRoot(map, Math.floor(x), Math.floor(y))) continue;

      // A seedling is its parent's kind, and only takes where that kind will grow: a
      // marula seeded uphill into the yellowwood band simply does not come up. That is
      // what keeps each species in its own country as a wood spreads.
      const seedling = wood.species[parent]! as Species;
      if (!canRootSpecies(map, seedling, Math.floor(x), Math.floor(y))) continue;

      // Not into a thicket. A wood that seeds without limit becomes a solid mat and the
      // ground under it stops being worth walking to.
      if (tooClose(wood, x, y)) continue;

      if (add(wood, x, y, seedling, 0) !== -1) moved = true;
    }
  }

  if (moved) wood.version++;
}

/**
 * Cut a tree down for its timber. Returns the wood taken, or 0.
 *
 * Felling is a command rather than something that happens by standing nearby, which is
 * the opposite of how fruit is gathered and deliberately so: picking is reversible and
 * cutting is not. A player should not level a wood by walking through it.
 */
export function fell(
  world: World,
  wood: Woodland,
  economy: Economy,
  player: number,
  index: number,
): number {
  const w = tuning.woodland;
  if (index < 0 || index >= wood.count || wood.alive[index] === 0) return 0;

  // Somebody has to be standing there with an axe. Without this a village could clear a
  // wood it had never walked to, which makes distance free and the map flat.
  const reach = w.gatherRadius * 2;
  const reachSq = reach * reach;
  let hasHands = false;
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
    if (world.faction[i] !== player) continue;
    const dx = world.posX[i]! - wood.x[index]!;
    const dy = world.posY[i]! - wood.y[index]!;
    if (dx * dx + dy * dy <= reachSq) {
      hasHands = true;
      break;
    }
  }
  if (!hasHands) return 0;

  const stage = stageOf(wood, index);
  const spec = w.species[wood.species[index]!];
  // A sapling is not worth the axe. Cutting one is allowed — clearing ground is a
  // legitimate thing to want — but it yields nothing, so nobody does it for timber.
  //
  // Neither is a baobab, at any age: its wood is fibrous and useless, so the species
  // table gives it nothing to yield. Felling one is still permitted, because forbidding
  // it would need a refusal the player cannot see coming; it simply buys nothing.
  const yielded =
    spec === undefined ? 0 : stage === Stage.Mature ? spec.timberMature : stage === Stage.Young ? spec.timberYoung : 0;

  wood.alive[index] = 0;
  wood.fruit[index] = 0;
  wood.version++;
  if (yielded > 0) economy.add(player, Resource.Wood, yielded);
  return yielded;
}

// The wire format lives in shared/woodland.ts — see the note there about why.

/**
 * The standing wood, flattened for the renderer.
 *
 * Packed rather than sent as objects for the same reason snapshots are: it crosses a
 * thread boundary, and a transferable Float32Array costs nothing to hand over while an
 * array of fourteen hundred objects is a structured clone every time a tree grows.
 *
 * Dead slots are dropped here rather than at the far end, so the renderer never has to
 * know that the woodland recycles.
 */
export function packWoodland(wood: Woodland): Float32Array {
  let living = 0;
  for (let i = 0; i < wood.count; i++) living += wood.alive[i]!;

  const out = new Float32Array(living * WOODLAND_STRIDE);
  let at = 0;
  for (let i = 0; i < wood.count; i++) {
    if (wood.alive[i] === 0) continue;
    out[at] = wood.x[i]!;
    out[at + 1] = wood.y[i]!;
    // species * 4 + stage. Both are tiny and a float holds them exactly.
    out[at + 2] = wood.species[i]! * 4 + stageOf(wood, i);
    out[at + 3] = i;
    at += WOODLAND_STRIDE;
  }
  return out;
}
