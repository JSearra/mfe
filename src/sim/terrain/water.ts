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
    // no use to anybody fishing.
    for (const side of [from - 1, to + 1]) {
      if (side < 0 || side >= width) continue;
      const at = tileY * width + side;
      if (water[at] === 1) continue;
      if (data[at]! > 1) data[at] = 1;
    }
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
    // The strand: one tile of low ground above the waterline, to stand and fish from.
    const shore = Math.max(0, Math.min(width - 1, reach));
    if (water[tileY * width + shore] !== 1) data[tileY * width + shore] = 1;
  }
}
