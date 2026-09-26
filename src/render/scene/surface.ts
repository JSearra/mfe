import { heightAt, inBounds, isWater, type Heightmap } from '../../shared/heightmap.js';
import { MAX_CLIMB } from '../../shared/iso.js';

/**
 * The surface the ground is drawn on: a height per tile CORNER rather than per tile.
 *
 * The simulation keeps integer heights per tile and that is not changing — movement
 * cost, pathing, line of sight and ADR-0006 all rest on it. This is a render-side
 * reading of the same data, and it exists because drawing that data literally is what
 * made the map look the way it did.
 *
 * Flat diamonds cannot express a slope, so every height change however small became a
 * vertical face: `MAX_CLIMB` is 1 and `ELEV_STEP` is 8px against a 32px tile, so every
 * one-level contour — walkable ground, and the commonest feature on a rolling map — was
 * drawn as a quarter-tile wall with a lit lip on top of it. The contours are everywhere,
 * so the walls were. Averaging the corners turns exactly those into ramps.
 *
 * **A cliff is exempt and that is the point.** ADR-0006 settled that a cliff is not a
 * tile type but a derived edge, legible at a glance because it is hard. Smoothing one
 * would turn the map's only unambiguous boundary into a steep slope, so a corner that
 * touches a cliff takes its tile's own height and the face between the two grounds
 * survives untouched.
 */

/** North, east, south, west — the diamond's corners, matching the draw order. */
export const CORNER_COUNT = 4;

/**
 * Corner offsets in TILE space, in the order the diamond is drawn.
 *
 * Corner (cx, cy) is the world lattice point; tile (tx, ty) owns the square whose
 * corners are (tx,ty), (tx+1,ty), (tx+1,ty+1), (tx,ty+1).
 */
const CORNER_DX = [0, 1, 1, 0] as const;
const CORNER_DY = [0, 0, 1, 1] as const;

/** The four tiles meeting at a corner, relative to the corner's lattice point. */
const TOUCHING_DX = [-1, 0, -1, 0] as const;
const TOUCHING_DY = [-1, -1, 0, 0] as const;

/**
 * Height at one lattice corner, given the tile that is asking.
 *
 * Out-of-bounds neighbours are skipped rather than counted. `heightAt` answers -1
 * outside the map, and averaging that sentinel in would pull every border tile down
 * toward it and hang the whole map off a lip — a bug that would look like the map
 * curling at the edges and would be hard to read back to this line.
 */
function heightAtCorner(
  map: Heightmap,
  cornerX: number,
  cornerY: number,
  own: number,
  ownX: number,
  ownY: number,
): number {
  let sum = 0;
  let count = 0;
  const ownIsWater = isWater(map, ownX, ownY);

  for (let i = 0; i < 4; i++) {
    const tileX = cornerX + TOUCHING_DX[i]!;
    const tileY = cornerY + TOUCHING_DY[i]!;
    if (!inBounds(map, tileX, tileY)) continue;
    const height = heightAt(map, tileX, tileY);

    /*
     * A cliff across an EDGE snaps the corner; a diagonal does not.
     *
     * Tested against the ASKING tile rather than pairwise between neighbours: what
     * matters is whether this tile's ground breaks away here, not whether two other
     * grounds do. But only where the two actually share a side — a cliff is an
     * orthogonal fact in this project, which is how `isCliff` is used against adjacent
     * heights and how `derivePassability` blocks an edge.
     *
     * Testing the diagonal as well is a defect that shipped and was visible: on the
     * standard map there are ZERO orthogonal cliffs and 491 diagonal jumps past
     * MAX_CLIMB, so 491 saddles snapped their corners flat, each leaving a small shaded
     * face across ground nothing is blocked by. On screen it was a diamond lattice of
     * dark lines over every slope with relief in it — the tile grid, drawn back on top
     * of the mesh that exists to hide it.
     */
    const sharesAnEdge = tileX === ownX || tileY === ownY;
    /*
     * Except for water, which snaps to a cliff across the diagonal too.
     *
     * A water tile has no faces of its own, so nothing covers a difference between it
     * and the water beside it. One that touched a sea cliff only at a corner averaged
     * the cliff into that corner and tilted up toward it, while its neighbour across the
     * edge snapped and stayed down — two water surfaces meeting at different heights,
     * and the page background showing through the crack as a black wedge at the foot of
     * every step of the cliff. A gentle bank still averages in, so a river keeps its
     * soft margin; only a cliff, which the water cannot be sloping up to, is refused.
     */
    const snaps = sharesAnEdge || ownIsWater;
    if (snaps && (height - own > MAX_CLIMB || own - height > MAX_CLIMB)) return own;
    sum += height;
    count++;
  }

  return count === 0 ? own : sum / count;
}

/**
 * The four corner heights of a tile, written into `out` as north, east, south, west.
 *
 * Writes into a caller-owned buffer rather than returning an array: this runs once per
 * tile per chunk build, 16,384 times on a standard map, and a four-element allocation
 * each time is 16,384 of them for a number that is thrown away immediately.
 */
export function tileCorners(map: Heightmap, tileX: number, tileY: number, out: Float64Array): void {
  const own = heightAt(map, tileX, tileY);

  for (let corner = 0; corner < CORNER_COUNT; corner++) {
    out[corner] = heightAtCorner(
      map,
      tileX + CORNER_DX[corner]!,
      tileY + CORNER_DY[corner]!,
      own,
      tileX,
      tileY,
    );
  }
}

/**
 * Does this tile sit flat — every corner at its own height?
 *
 * Most of a map does, and the mesh builder uses this to keep the common case on the
 * cheap path rather than computing a warped quad for ground that is not warped.
 */
export function isFlat(out: Float64Array, own: number): boolean {
  return out[0] === own && out[1] === own && out[2] === own && out[3] === own;
}
