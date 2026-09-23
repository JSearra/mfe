import { type Heightmap } from '../../shared/heightmap.js';
import { nextFloat, nextInt, type Rng } from '../math/rng.js';
import { cos, sin, TWO_PI } from '../math/trig.js';

/**
 * Rivers and coastlines: where the water is.
 *
 * The existing maps already cut rivers as sunken channels, which blocks and channels
 * movement through the same height rule everything else uses. That stays. What is added
 * here is the MARK — a tile that is not merely low but wet — because fishing has to know
 * where the water is, and because "low ground" is everywhere on an open map while a
 * river is somewhere particular.
 *
 * **A river must never cut the map in two.** Water is impassable, so a channel carved
 * bank to bank divides the land into two components: the herds on the far side become
 * unreachable and the neighbouring village cannot be walked to, which is the exact
 * failure `terrain/placement.ts` exists to work around and should not be manufactured
 * here. Every course laid down leaves DRIFTS — shallow crossings at intervals, dry tiles
 * spanning the channel — so the two banks are always joined.
 */

/** Tiles of dry crossing left standing between stretches of water. */
const DRIFT_WIDTH = 2;

/**
 * Grade the ground down toward every waterline, one level per tile of distance.
 *
 * `MAX_CLIMB` is 1 and a channel floor is 0, so ground that rises no faster than a
 * level a tile as it leaves the water has no edge in it a unit cannot walk, and
 * therefore no part of it draws as a face. A tile `d` tiles from water is held to
 * height `d`, which is exactly that condition written down.
 *
 * SELF-LIMITING, which is what keeps it from flattening the map: at distance `d` it
 * only lowers ground standing above `d`, so it reaches as far inland as the terrain is
 * steep and stops the moment the natural ground is already low enough. Beside a river
 * on the flats it touches nothing; under an escarpment it cuts a ramp down to the
 * water. That is also why it runs as a distance transform rather than a sweep along
 * each row: the bank of a meander faces every direction in turn, and grading only
 * across the channel left the walls standing wherever it ran the other way. Measured on
 * the shipped seed, cliff edges within three tiles of water went 859 -> 378 grading one
 * axis, and 378 -> a handful grading all of them.
 *
 * Deterministic: a fixed-order breadth-first sweep over integers, no floating point and
 * nothing from the banned list. It runs once at generation.
 *
 * A terrain change rather than a drawing one, deliberately. The comment in `carveRiver`
 * has always said the banks must fall toward the channel "or the river becomes a canyon
 * nothing can approach". It graded one tile, so it did not do what it said.
 */
export function gradeBanks(map: Heightmap): void {
  const { width, height, data, water } = map;
  if (water.length === 0) return;

  // Distance to the nearest water tile, capped at the tallest ground there can be:
  // past that the clamp can never bite, so there is nothing to learn by walking further.
  const reach = map.levels;
  const distance = new Uint8Array(width * height).fill(0xff);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  for (let at = 0; at < water.length; at++) {
    if (water[at] !== 1) continue;
    distance[at] = 0;
    queue[tail++] = at;
  }

  const stepX = [1, -1, 0, 0];
  const stepY = [0, 0, 1, -1];

  while (head < tail) {
    const at = queue[head++]!;
    const next = distance[at]! + 1;
    if (next > reach) continue;

    const tileX = at % width;
    const tileY = (at - tileX) / width;

    for (let side = 0; side < 4; side++) {
      const x = tileX + stepX[side]!;
      const y = tileY + stepY[side]!;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;

      const to = y * width + x;
      if (distance[to]! <= next) continue;
      distance[to] = next;
      if (data[to]! > next) data[to] = next;
      queue[tail++] = to;
    }
  }
}

/**
 * Cut a meandering watercourse across the map, top to bottom, and mark it wet.
 *
 * Carves the channel floor down as it goes, so the river sits in a valley rather than
 * lying on the surface like a painted line — the banks read as banks from the side, at
 * the isometric angle the game is actually seen from.
 */
export function carveRiver(map: Heightmap, rng: Rng, driftEvery: number): void {
  const { width, height, data, water } = map;
  if (water.length === 0) return;

  // A wandering centre line. Amplitude is a fraction of the width so a river crosses a
  // small map as readily as a large one.
  const phase = nextFloat(rng) * TWO_PI;
  const amplitude = width * (0.14 + nextFloat(rng) * 0.10);
  const wobble = 0.045 + nextFloat(rng) * 0.03;
  const centre = width * (0.35 + nextFloat(rng) * 0.3);
  const halfWidth = 1 + nextInt(rng, 2);
  const driftAt = nextInt(rng, driftEvery);

  for (let tileY = 0; tileY < height; tileY++) {
    // Left dry: the crossing. Two rows of it, so a drift is walkable rather than a
    // single-tile seam a unit has to find exactly.
    if ((tileY + driftAt) % driftEvery < DRIFT_WIDTH) continue;

    const course = centre + sin(tileY * wobble + phase) * amplitude;
    const from = Math.floor(course - halfWidth);
    const to = Math.floor(course + halfWidth);

    for (let tileX = from; tileX <= to; tileX++) {
      if (tileX < 0 || tileX >= width) continue;
      const at = tileY * width + tileX;
      data[at] = 0;
      water[at] = 1;
    }
    // Banks fall toward the channel rather than standing over it as a cliff, or the
    // river becomes a canyon nothing can approach — and a shore nobody can stand on is
    // no use to anybody fishing. Graded over BANK_GRADE tiles, one level a tile, so
    // every edge in the bank is walkable and none of it draws as a face.

  }
}

/**
 * Flood one edge of the map to make a coast.
 *
 * An edge rather than a corner or a lake: a coastline is a boundary of the world, and
 * bounding one side of the map with water costs no connectivity — everything inland
 * stays joined to everything else, which is the property a river has to work for.
 */
export function carveCoast(map: Heightmap, rng: Rng, depth: number): void {
  const { width, height, data, water } = map;
  if (water.length === 0) return;

  const phase = nextFloat(rng) * TWO_PI;
  const roll = 0.06 + nextFloat(rng) * 0.05;
  const ragged = 2 + nextInt(rng, 3);

  for (let tileY = 0; tileY < height; tileY++) {
    // An irregular shoreline. A straight edge of water reads as the map running out
    // rather than as a coast.
    const reach = depth + Math.round(sin(tileY * roll + phase) * ragged + cos(tileY * roll * 2.3) * 1.5);
    for (let tileX = 0; tileX < reach && tileX < width; tileX++) {
      const at = tileY * width + tileX;
      data[at] = 0;
      water[at] = 1;
    }

  }
}
