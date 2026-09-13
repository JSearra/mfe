/**
 * Isometric projection: 2:1 diamond, 64x32 tile footprint, with elevation.
 *
 * Lives in shared/ because both the simulation (line of sight, picking validation)
 * and the renderer need it, and it must stay free of renderer types. It obeys the
 * simulation determinism rules: only + - * / here.
 */

export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_TILE_W = TILE_W / 2;
export const HALF_TILE_H = TILE_H / 2;

/** Screen pixels of vertical lift per unit of tile height. */
export const ELEV_STEP = 8;

/**
 * Largest height difference a unit can walk between adjacent tiles. A larger delta
 * is a cliff — which is why cliffs are not a tile type. See ADR-0006.
 */
export const MAX_CLIMB = 1;

// Scalar in, scalar out, deliberately: returning {x, y} would allocate per call,
// and these sit inside per-frame and per-tick loops.

export function worldToScreenX(worldX: number, worldY: number): number {
  return (worldX - worldY) * HALF_TILE_W;
}

export function worldToScreenY(worldX: number, worldY: number, height: number): number {
  return (worldX + worldY) * HALF_TILE_H - height * ELEV_STEP;
}

/**
 * Inverse projection at a known height.
 *
 * Height is a parameter because the true inverse is ambiguous without it: a screen
 * point maps to different tiles depending on the terrain under it. Resolving that
 * ambiguity is a search over candidate heights, and it belongs to the tilemap in
 * Phase 2. This is the exact inverse once the height is known.
 */
export function screenToWorldX(screenX: number, screenY: number, height: number): number {
  const a = screenX / HALF_TILE_W;
  const b = (screenY + height * ELEV_STEP) / HALF_TILE_H;
  return (a + b) / 2;
}

export function screenToWorldY(screenX: number, screenY: number, height: number): number {
  const a = screenX / HALF_TILE_W;
  const b = (screenY + height * ELEV_STEP) / HALF_TILE_H;
  return (b - a) / 2;
}

/** Depth-sort key. Ties must be broken on entity id by the caller. See ARCHITECTURE.md section 4. */
export function depthKey(worldX: number, worldY: number): number {
  return worldX + worldY;
}

/** True when the step between two adjacent tile heights is a cliff rather than a slope. */
export function isCliff(heightA: number, heightB: number): boolean {
  const delta = heightA - heightB;
  return (delta < 0 ? -delta : delta) > MAX_CLIMB;
}
