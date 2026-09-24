import { heightAt, inBounds, isWater, type Heightmap } from '../../shared/heightmap.js';
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
export function edgeSeams(
  map: Heightmap,
  ground: Uint8Array,
  tileX: number,
  tileY: number,
  out: number[],
): number {
  const own = ground[tileY * map.width + tileX]!;
  let found = 0;

  for (let bit = 0; bit < 4; bit++) {
    const x = tileX + EDGE_DX[bit]!;
    const y = tileY + EDGE_DY[bit]!;
    if (!inBounds(map, x, y)) continue;
    const neighbour = ground[y * map.width + x]!;
    if (neighbour <= own) continue;
    // Only where the two grounds actually meet. Across a cliff they do not: there is a
    // face between them, the upper surface is metres above and behind, and bleeding its
    // texture onto the floor below reads as a smear down the drop rather than as a
    // transition. A cliff is meant to be a hard edge — that is the whole of ADR-0006 —
    // and softening it would undo the one boundary that should be legible at a glance.
    // A cliff is still a cliff. Ground no longer tracks height, so the two can now
    // disagree — but where a real face stands between two grounds the upper surface is
    // metres above and behind, and bleeding its texture down the drop reads as a smear
    // rather than a transition. That is ADR-0006 and it is unchanged; what changed is
    // that the test now has to ask the HEIGHTS, because the bands no longer are them.
    if (isCliff(heightAt(map, x, y), heightAt(map, tileX, tileY))) continue;
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
  ground: Uint8Array,
  tileX: number,
  tileY: number,
  out: Int8Array,
): number {
  const own = ground[tileY * map.width + tileX]!;
  let found = 0;

  /** A neighbour's ground, or -1 off the map. */
  const at = (dx: number, dy: number): number => {
    const x = tileX + dx;
    const y = tileY + dy;
    return inBounds(map, x, y) ? ground[y * map.width + x]! : -1;
  };

  for (let corner = 0; corner < SEAM_CORNERS; corner++) {
    out[corner] = -1;

    const dx = CORNER_DX[corner]!;
    const dy = CORNER_DY[corner]!;
    const neighbour = at(dx, dy);
    if (neighbour <= own) continue;
    if (isCliff(heightAt(map, tileX + dx, tileY + dy), heightAt(map, tileX, tileY))) continue;

    // The two edges this corner sits between. Either one carrying a blend of its own
    // covers the corner already.
    const before = corner;
    const after = (corner + 1) % 4;
    if (
      at(EDGE_DX[before]!, EDGE_DY[before]!) > own ||
      at(EDGE_DX[after]!, EDGE_DY[after]!) > own
    ) {
      continue;
    }

    out[corner] = neighbour;
    found++;
  }
  return found;
}

/** The eight neighbours, for counting how enclosed a tile is. */
const AROUND_DX = [0, 1, 0, -1, 1, 1, -1, -1] as const;
const AROUND_DY = [-1, 0, 1, 0, -1, 1, 1, -1] as const;

/**
 * Which of a dry tile's edges face water, as the same four bits the band blends use.
 *
 * Water is painted rather than textured, so until this existed a river or a coast was a
 * hard staircase of blue diamonds with a 90-degree notch at every step — the most
 * literal instance left on the map of ground ending at a right angle. A bank drawn on
 * the LAND side, fading inland, is what turns that edge into a shore.
 *
 * Zero for a water tile: water has no bank of its own, and giving it one would draw
 * sand over the river.
 */
export function waterEdgeMask(map: Heightmap, tileX: number, tileY: number): number {
  if (isWater(map, tileX, tileY)) return 0;

  let mask = 0;
  for (let bit = 0; bit < 4; bit++) {
    if (isWater(map, tileX + EDGE_DX[bit]!, tileY + EDGE_DY[bit]!)) mask |= 1 << bit;
  }
  return mask;
}

/**
 * Corners where water touches a dry tile only diagonally.
 *
 * The same rule as `cornerSeams`, and for the same reason: where an edge beside the
 * corner is already wet, the bank drawn along that edge reaches the corner, and a
 * second wedge over it would double the sand exactly where two banks meet. Bends in a
 * river are made of this case, so without it every bend keeps its notch.
 *
 * Writes 1 or -1 into all four slots every call. Returns how many were found.
 */
export function waterCornerSeams(
  map: Heightmap,
  tileX: number,
  tileY: number,
  out: Int8Array,
): number {
  let found = 0;

  for (let corner = 0; corner < SEAM_CORNERS; corner++) {
    out[corner] = -1;
    if (isWater(map, tileX, tileY)) continue;
    if (!isWater(map, tileX + CORNER_DX[corner]!, tileY + CORNER_DY[corner]!)) continue;

    const before = corner;
    const after = (corner + 1) % 4;
    if (
      isWater(map, tileX + EDGE_DX[before]!, tileY + EDGE_DY[before]!) ||
      isWater(map, tileX + EDGE_DX[after]!, tileY + EDGE_DY[after]!)
    ) {
      continue;
    }

    out[corner] = 1;
    found++;
  }
  return found;
}

/**
 * How enclosed by water a water tile is: 0 at a bank, 8 in the open.
 *
 * It was a boolean — "are all four square neighbours wet" — and on a river a tile or
 * two wide NO tile satisfies it, so every tile in the river drew as a margin and the
 * water read as a strip of alternating light and dark diamonds rather than as a river.
 * Eight ways rather than four, and a count rather than a test, so the colour can run
 * from the bank into the channel instead of switching.
 */
export function waterDepth(map: Heightmap, tileX: number, tileY: number): number {
  let count = 0;
  for (let i = 0; i < 8; i++) {
    if (isWater(map, tileX + AROUND_DX[i]!, tileY + AROUND_DY[i]!)) count++;
  }
  return count;
}

/**
 * For a WATER tile: which land grounds bleed over its edges, indexed by band.
 *
 * The waterline was hard on both sides and softened on only one. A dry tile beside
 * water gets a bank drawn on it — `waterEdgeMask` above — so the land dissolved into
 * the shore nicely, and nothing was ever drawn on the water itself. Its own edge stayed
 * a dead diamond, and a river read as a staircase of blue lozenges however good the
 * bank on the far side of it was. A shore is two grounds meeting and it needs both
 * halves.
 *
 * Indexed by the neighbour's own ground rather than by a single shore colour, so the
 * bank that creeps into the water matches the country standing behind it: a river
 * through the sourveld carries sourveld into its margin, one through a donga carries
 * red earth.
 *
 * Written into a sparse array like `edgeSeams`, and returns how many bands were found.
 */
export function landSeams(
  map: Heightmap,
  ground: Uint8Array,
  tileX: number,
  tileY: number,
  out: number[],
): number {
  if (!isWater(map, tileX, tileY)) return 0;

  let found = 0;
  for (let bit = 0; bit < 4; bit++) {
    const x = tileX + EDGE_DX[bit]!;
    const y = tileY + EDGE_DY[bit]!;
    if (!inBounds(map, x, y) || isWater(map, x, y)) continue;

    const band = ground[y * map.width + x]!;
    if (out[band] === undefined) {
      out[band] = 0;
      found++;
    }
    out[band]! |= 1 << bit;
  }
  return found;
}

/**
 * How enclosed by water a tile is, averaged with its neighbours.
 *
 * `waterDepth` counts eight neighbours, so it steps by whole numbers between adjacent
 * tiles — and a water tile is filled with ONE flat colour, so those steps drew a
 * patchwork of visibly different blue lozenges across every river on the map. The
 * colour has to vary as slowly as a body of water does.
 *
 * Averaged over the four orthogonal neighbours and itself, counting only the wet ones:
 * letting dry neighbours contribute zero would drag every margin tile toward the
 * shallow end twice, once through its own count and once through theirs.
 */
export function smoothWaterDepth(map: Heightmap, tileX: number, tileY: number): number {
  let sum = waterDepth(map, tileX, tileY);
  let count = 1;

  for (let bit = 0; bit < 4; bit++) {
    const x = tileX + EDGE_DX[bit]!;
    const y = tileY + EDGE_DY[bit]!;
    if (!isWater(map, x, y)) continue;
    sum += waterDepth(map, x, y);
    count++;
  }
  return sum / count;
}
