import { worldToScreenX, worldToScreenY } from '../../shared/iso.js';

/**
 * The arithmetic a terrain chunk's mesh is built from.
 *
 * Separated from the renderer so it can be tested without a GPU. Every rendering defect
 * this project has shipped passed every gate it had, and a UV off by a frame or a
 * corner off by a level is exactly that kind of defect — invisible to types, invisible
 * to output size, and obvious the moment anyone looks at the screen.
 */

/** A tile is a quad: four corners, two floats each. */
export const QUAD_CORNERS = 4;
export const QUAD_FLOATS = QUAD_CORNERS * 2;

/**
 * Corner offsets in tile space, north/east/south/west, matching `surface.tileCorners`.
 *
 * "North" is the diamond's top corner, which is the tile's own (x, y) lattice point —
 * its western column in tile space. The projection turns +x into down-right and +y into
 * down-left, so the compass here is the SCREEN's, not the grid's.
 */
const CORNER_DX = [0, 1, 1, 0] as const;
const CORNER_DY = [0, 0, 1, 1] as const;

/**
 * Screen positions of a tile's four corners, as x,y pairs.
 *
 * Each corner is projected at its OWN height, which is what lets a tile be a slope
 * rather than a flat diamond lifted whole.
 */
export function cornerPositions(
  tileX: number,
  tileY: number,
  corners: Float64Array,
  out: Float32Array,
): void {
  for (let corner = 0; corner < QUAD_CORNERS; corner++) {
    const worldX = tileX + CORNER_DX[corner]!;
    const worldY = tileY + CORNER_DY[corner]!;
    out[corner * 2] = worldToScreenX(worldX, worldY);
    out[corner * 2 + 1] = worldToScreenY(worldX, worldY, corners[corner]!);
  }
}

/**
 * How far inside the frame the diamond's corners are sampled, in texels.
 *
 * Not zero, and the measurement is the reason. The mask that cuts the diamond out of
 * the art is `nx + ny <= 1` evaluated at pixel centres, so the opaque region is a
 * staircase — and at the tile's widest row it runs from column 1 to column 62 of 64,
 * a texel short of the frame edge at BOTH ends. Sampling the corner at the edge
 * midpoint exactly therefore lands on a transparent texel, and the quad draws a dark
 * hairline along every tile edge on the map: a visible lattice over the whole ground.
 *
 * The sprite path never showed it because each sprite drew its full rectangle, so the
 * transparent margins overlapped the neighbours' opaque staircases. A mesh quad ends at
 * the ideal edge and has no margin to lend.
 *
 * Inset in the frame's own proportions — twice as far across as down, for a 2:1 diamond
 * — so the sampled shape stays a diamond rather than being squashed. One and a half
 * texels clears the staircase's worst deviation with room over; the cost is that the
 * art is drawn about 5% enlarged, which at 64x32 nobody can see.
 */
const UV_INSET_X = 1.5;
const UV_INSET_Y = UV_INSET_X / 2;

/**
 * The DIAMOND's corners inside a frame, normalised against the whole page.
 *
 * The frame is a rectangle whose corners are transparent; the art fills the 2:1 diamond
 * inscribed in it. Mapping the rectangle onto the quad instead would drag those
 * transparent corners over the neighbouring tiles, and would not survive a slope: the
 * four edge midpoints of a rectangle cannot all be made to land on the corners of a
 * warped diamond, because that needs `north + south === east + west` and a sloped tile
 * does not satisfy it. Mapping the inscribed diamond is exact at any slope.
 *
 * Normalised against the page rather than the frame because the mesh is given the whole
 * terrain page as its texture: one texture for every tile on the map is what keeps a
 * chunk to a single draw call.
 */
export function diamondUvs(
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
  pageWidth: number,
  pageHeight: number,
  out: Float32Array,
): void {
  const midX = (frameX + frameWidth / 2) / pageWidth;
  const midY = (frameY + frameHeight / 2) / pageHeight;
  const left = (frameX + UV_INSET_X) / pageWidth;
  const right = (frameX + frameWidth - UV_INSET_X) / pageWidth;
  const top = (frameY + UV_INSET_Y) / pageHeight;
  const bottom = (frameY + frameHeight - UV_INSET_Y) / pageHeight;

  out[0] = midX;
  out[1] = top;
  out[2] = right;
  out[3] = midY;
  out[4] = midX;
  out[5] = bottom;
  out[6] = left;
  out[7] = midY;
}

/**
 * Is there a gap to fill between a tile's edge and its neighbour's?
 *
 * Faces are derived from the SURFACE rather than from the tile heights, and that is a
 * deliberate correction rather than a flourish. Corners that touch a cliff snap to
 * their own tile's height while corners a step away are averaged, so two tiles one
 * walkable level apart can still disagree about the corner they share — heights 0, 1
 * and 4 in a row leave the middle tile snapped flat at 1 against a western neighbour
 * that averaged the shared corner to 0.5. Nothing about the two HEIGHTS says there is a
 * gap. The surface does, and a face derived from the surface cannot disagree with it.
 *
 * One-sided: only a tile standing ABOVE its neighbour shows a face. The other side of
 * the same edge is turned away from the camera and hidden behind the higher ground.
 */
export function faceTrapezoid(
  ownNear: number,
  ownFar: number,
  neighbourNear: number,
  neighbourFar: number,
): boolean {
  return ownNear > neighbourNear || ownFar > neighbourFar;
}
