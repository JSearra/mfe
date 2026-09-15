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

export const Species = {
  /** Umbrella thorn. Timber, no fruit. */
  Acacia: 0,
  /** Marula. Bears heavily in the wet, and the reason to leave one standing. */
  Marula: 1,
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

/** Ground a tree will take root on: not the wet bottom, not bare stone. */
export function canRoot(map: Heightmap, tileX: number, tileY: number): boolean {
  const w = tuning.woodland;
  const level = heightAt(map, tileX, tileY);
  return level >= w.minBand && level <= w.maxBand;
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

      // Jittered off the tile centre, or a wood comes out on a grid and reads as an
      // orchard — the same reason the decoration layer jitters.
      const jitterX = (((hash >>> 16) & 0xff) / 255) * 0.8 + 0.1;
      const jitterY = (((hash >>> 24) & 0xff) / 255) * 0.8 + 0.1;
      const species = ((hash >>> 8) & 0xff) / 255 < w.marulaShare ? Species.Marula : Species.Acacia;
      // A standing wood is not all one age. Starting everything mature would make the
      // first felling free and the second impossible.
      const age = w.matureAge * (0.35 + (((hash >>> 4) & 0xf) / 15) * 1.1);

      const x = tileX + jitterX;
      const y = tileY + jitterY;
      if (tooClose(wood, x, y)) continue;
      if (add(wood, x, y, species, age) === -1) return wood;
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
    if (stage === Stage.Mature && wood.species[index] === Species.Marula) {
      const cap = w.fruitCapacity;
      if (wood.fruit[index]! < cap) {
        wood.fruit[index] = Math.min(cap, wood.fruit[index]! + w.fruitPerUpkeep * wetness);
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

      // Not into a thicket. A wood that seeds without limit becomes a solid mat and the
      // ground under it stops being worth walking to.
      if (tooClose(wood, x, y)) continue;

      const species = nextFloat(rng) < w.marulaShare ? Species.Marula : Species.Acacia;
      if (add(wood, x, y, species, 0) !== -1) moved = true;
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
  // A sapling is not worth the axe. Cutting one is allowed — clearing ground is a
  // legitimate thing to want — but it yields nothing, so nobody does it for timber.
  const yielded = stage === Stage.Mature ? w.timberMature : stage === Stage.Young ? w.timberYoung : 0;

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
