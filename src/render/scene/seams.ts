import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import { isCliff } from '../../shared/iso.js';

/**
 * Which neighbouring grounds bleed onto a tile, and from where.
 *
 * Separated from the renderer because it is the rule that decides how every boundary on
 * the map reads, and a rule that important should be legible and testable without a
 * GPU in the room.
 *
 * Two halves, and they are different shapes rather than the same idea twice. An EDGE
 * seam is where two grounds share a whole tile side: the blend is a wide band running
 * parallel to that side, and the four of them combine into fifteen masks. A CORNER seam
 * is where they meet at a single point, diagonally: the blend is a small wedge, and it
 * only exists at all when neither side beside it is already blending, or the two would
 * stack their alpha exactly where they overlap.
 *
 * The corner half is why this file exists. Diagonal neighbours contributed nothing at
 * all, so every diagonal boundary on the map ended in a sharp notch.
 */

/** The four diamond corners a diagonal neighbour can arrive at. */
export const SEAM_CORNERS = 4;

/**
 * The four orthogonal neighbours, clockwise from the upper right.
 *
 * Isometric puts tile +x down-RIGHT and tile +y down-LEFT, so the tile-space neighbour
 * (x, y-1) is the diamond's upper-right EDGE rather than its top corner. The order here
 * is the bit order the transition masks were baked with; changing one without the other
 * paints the blend on the wrong side.
 */
const EDGE_DX = [0, 1, 0, -1] as const;
const EDGE_DY = [-1, 0, 1, 0] as const;

/**
 * The four diagonal neighbours, in the order of the diamond corners they arrive at:
 * east, south, west, north.
 *
 * Corner `i` sits between edges `i` and `(i + 1) % 4`, which is what makes the
 * "already covered by an edge" test below a lookup rather than a special case each.
 */
const CORNER_DX = [1, 1, -1, -1] as const;
const CORNER_DY = [-1, 1, 1, -1] as const;

/**
 * Masks of the higher grounds bleeding over this tile's edges, indexed by band.
 *
 * The higher band always spills onto the lower, never the reverse, so each seam is
 * drawn exactly once — from the uphill side — and two tiles never both try to blend
 * into each other and double the alpha along the join.
 *
 * Written into a sparse array so the common case, a tile with no boundary at all, costs
 * four height lookups and no allocation beyond it. Returns how many bands were found.
 */
export function edgeSeams(map: Heightmap, tileX: number, tileY: number, out: number[]): number {
  const own = map.data[tileY * map.width + tileX]!;
  let found = 0;

  for (let bit = 0; bit < 4; bit++) {
    const neighbour = heightAt(map, tileX + EDGE_DX[bit]!, tileY + EDGE_DY[bit]!);
    if (neighbour <= own) continue;
    // Only where the two grounds actually meet. Across a cliff they do not: there is a
    // face between them, the upper surface is metres above and behind, and bleeding its
    // texture onto the floor below reads as a smear down the drop rather than as a
    // transition. A cliff is meant to be a hard edge — that is the whole of ADR-0006 —
    // and softening it would undo the one boundary that should be legible at a glance.
    if (isCliff(neighbour, own)) continue;
    if (out[neighbour] === undefined) {
      out[neighbour] = 0;
      found++;
    }
    out[neighbour]! |= 1 << bit;
  }
  return found;
}

/**
 * The band bleeding into each diamond corner, or -1 where nothing does.
 *
 * A corner seam is the diagonal case and only the diagonal case. Where an orthogonal
 * neighbour beside the corner is also higher, its edge blend already reaches into that
 * corner — `edge_falloff` takes two edges at their maximum precisely so a shared corner
 * reads as a corner — and laying a wedge over it would stack a second alpha ramp on the
 * one place two seams already overlap.
 *
 * `out` is written for all four corners every call, so a caller can reuse one buffer
 * without clearing it. Returns how many corners were found.
 */
export function cornerSeams(
  map: Heightmap,
  tileX: number,
  tileY: number,
  out: Int8Array,
): number {
  const own = map.data[tileY * map.width + tileX]!;
  let found = 0;

  for (let corner = 0; corner < SEAM_CORNERS; corner++) {
    out[corner] = -1;

    const neighbour = heightAt(map, tileX + CORNER_DX[corner]!, tileY + CORNER_DY[corner]!);
    if (neighbour <= own || isCliff(neighbour, own)) continue;

    // The two edges this corner sits between. Either one carrying a blend of its own
    // covers the corner already.
    const before = corner;
    const after = (corner + 1) % 4;
    if (
      heightAt(map, tileX + EDGE_DX[before]!, tileY + EDGE_DY[before]!) > own ||
      heightAt(map, tileX + EDGE_DX[after]!, tileY + EDGE_DY[after]!) > own
    ) {
      continue;
    }

    out[corner] = neighbour;
    found++;
  }
  return found;
}
