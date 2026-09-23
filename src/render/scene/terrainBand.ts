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
