import { MapScript } from '../../shared/maps.js';
import { presentation } from '../presentation.js';

/**
 * Which ground a tile's height is drawn with.
 *
 * The palette is a ramp from wet to dry and a tile's band is its HEIGHT, so the two
 * together say "high ground is drier". That is true of one landscape and not of five.
 * Measured across the scripts, once the palette was toned strongly enough to be read at
 * all:
 *
 *   thaba-bosiu    24% riverbed, 69% savanna-low   a sandstone mesa on wet sand
 *   karoo          72% savanna-mid                 a semi-desert in the lushest green
 *   magaliesberg   57% riverbed                    a quartzite range drawn as sand
 *
 * None of that was visible while every band came out orange: the maps read as arid by
 * accident rather than by arrangement, and correcting the tone is what exposed it.
 *
 * **The shift moves a script's ART along the ramp and touches no heights.** That is the
 * whole reason it is here and not in `src/sim/terrain/maps.ts`. Rewriting the scripts
 * to sit on the right bands would change geometry, cliffs, movement cost, pathing and
 * every reachability guarantee `tasks/plan.md` section G was won with — for a question
 * that is about colour. How dry a country is, is exactly what a heightmap was never
 * able to say.
 *
 * Presentation, therefore, and in `tuning/presentation.json` rather than the hashed
 * file: the simulation never reads it and it cannot alter an outcome. See ADR-0009.
 */

/** A script's shift along the ramp, or 0 for a map with no script. */
export function bandShiftFor(script: MapScript | null): number {
  if (script === null) return 0;
  const shifts = presentation.terrain.bandShift as Partial<Record<string, number>>;
  return shifts[script] ?? 0;
}

/**
 * The band to draw a height with, clamped to the ramp.
 *
 * Clamped rather than wrapped, and rather than allowed off the end: a band with no art
 * draws the nearest one that has some (`TerrainTiles.variants`), so an unclamped shift
 * would quietly collapse the top of a mesa into whatever band happened to be last.
 */
export function groundBand(height: number, shift: number, bands: number): number {
  const shifted = height + shift;
  if (shifted < 0) return 0;
  return shifted > bands - 1 ? bands - 1 : shifted;
}


/**
 * How many cuts of each boundary-tiling mask the pipeline produces.
 *
 * Four, which is what AoE2's blendomatic carries for each of its directional masks. One
 * cut per configuration stamps the same meander tile after tile along a straight seam,
 * and the result is a regular scalloped sawtooth — the repetition is as legible as the
 * straight edge it replaced, only at a different frequency.
 */
export const BLEND_VARIANTS = 4;

/**
 * Which cut of a mask this tile uses.
 *
 * Hashed rather than read off the low bits of x or y, which is how AoE2 does it. `x & 3`
 * repeats every four tiles along a row, an isometric boundary runs DIAGONALLY, and the
 * two line up — trading a sawtooth every tile for a sawtooth every four. The hash is the
 * one the base tile variant already uses, under its own salt, so it holds still between
 * frames and agrees between two players looking at the same ground.
 */
export function blendVariant(tileX: number, tileY: number): number {
  let hash = (tileX * 0x1f1f1f1f) ^ (tileY * 0x85ebca6b) ^ Math.imul(11, 0x9e3779b9);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
  return ((hash ^ (hash >>> 13)) >>> 0) % BLEND_VARIANTS;
}
