import { heightAt, inBounds, type Heightmap } from './heightmap.js';
import { screenToWorldX, screenToWorldY } from './iso.js';

/**
 * Resolve which tile a point in isometric screen space is over.
 *
 * The inverse projection in iso.ts needs a height, and the whole point is that we do
 * not know it — that is the ambiguity elevation introduces. A screen point maps to a
 * different tile for every candidate height, so we walk the candidates.
 *
 * Walking from the highest level down means tall terrain wins over the low ground
 * behind it, which is what occlusion looks like on screen. Without this, every click
 * on hilly ground lands on the wrong tile.
 */

export const NO_TILE = -1;

export function tileX(map: Heightmap, index: number): number {
  return index % map.width;
}

export function tileY(map: Heightmap, index: number): number {
  return (index / map.width) | 0;
}

/** Row-major tile index, or NO_TILE when the point is off the map entirely. */
export function pickTileIndex(map: Heightmap, isoX: number, isoY: number): number {
  let groundX = 0;
  let groundY = 0;

  for (let level = map.levels - 1; level >= 0; level--) {
    const worldX = screenToWorldX(isoX, isoY, level);
    const worldY = screenToWorldY(isoX, isoY, level);
    const candidateX = Math.floor(worldX);
    const candidateY = Math.floor(worldY);

    if (level === 0) {
      groundX = candidateX;
      groundY = candidateY;
    }

    if (heightAt(map, candidateX, candidateY) === level) {
      return candidateY * map.width + candidateX;
    }
  }

  // No exact hit: the point is over a vertical cliff face rather than a tile surface.
  // Resolving to the ground-level candidate picks the low tile in front of the face,
  // which is the conventional and less surprising answer.
  if (!inBounds(map, groundX, groundY)) return NO_TILE;
  return groundY * map.width + groundX;
}
