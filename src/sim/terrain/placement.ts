import type { Heightmap } from '../../shared/heightmap.js';
import { buildCostLayer, MovementClass } from '../pathing/costs.js';
import { DIR8_DX, DIR8_DY } from '../pathing/directions.js';

/**
 * Where a match may put things.
 *
 * A generated map is not one walkable surface. Ridge flanks, mesa tops and the far bank
 * of a river are all ground you can stand on and cannot walk off, so a spawn point
 * chosen by arithmetic — "the centre of the map", "nine tiles east of that" — lands
 * wherever the terrain happens to put it.
 *
 * It had. Measured across the four named scripts: the Magaliesberg's valleys form a
 * single connected 89% of the map, and the player's start was dropped on a ridge flank
 * in a 0.5% contour ribbon it could never leave — it could not walk the eleven tiles to
 * the one herd in the game, so that map could never be won. Umfolozi's braided river
 * genuinely cuts the map in three, 53/42/5, and the start sat in the 5%.
 *
 * The maps are not the problem and are not changed here; every mesa, ridge and river
 * survives exactly as generated. What changes is that anything a match places is first
 * pulled onto the largest piece of walkable ground, so the players, their enemies and
 * the cattle are always on the same side of the water.
 */

/**
 * Mask of the largest mutually-walkable region, 1 per tile.
 *
 * Deterministic: components are discovered in tile-index order and ties on size are
 * broken by the lower index, so two machines building the same map agree on which
 * region is "the" region even when two are exactly the same size.
 */
export function largestRegion(
  map: Heightmap,
  movementClass: MovementClass = MovementClass.Infantry,
): Uint8Array {
  const width = map.width;
  const size = width * map.height;
  const layer = buildCostLayer(map, movementClass);

  const label = new Int32Array(size).fill(-1);
  const stack = new Int32Array(size);
  let best = -1;
  let bestSize = 0;

  for (let seed = 0; seed < size; seed++) {
    if (label[seed] !== -1) continue;

    const id = seed;
    let top = 0;
    stack[top++] = seed;
    label[seed] = id;
    let count = 0;

    while (top > 0) {
      const at = stack[--top]!;
      count++;
      const x = at % width;
      const y = (at / width) | 0;
      const dirs = layer.dirs8[at]!;

      for (let direction = 0; direction < 8; direction++) {
        if ((dirs & (1 << direction)) === 0) continue;
        const nx = x + DIR8_DX[direction]!;
        const ny = y + DIR8_DY[direction]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= map.height) continue;
        const next = ny * width + nx;
        if (label[next] !== -1) continue;
        label[next] = id;
        stack[top++] = next;
      }
    }

    // Strictly greater, so an earlier region of equal size wins. That is the tie-break.
    if (count > bestSize) {
      bestSize = count;
      best = id;
    }
  }

  const region = new Uint8Array(size);
  for (let i = 0; i < size; i++) region[i] = label[i] === best ? 1 : 0;
  return region;
}

/**
 * The nearest tile inside `region` to a wanted point, as tile coordinates.
 *
 * Returns the point unchanged when it is already inside, which is the common case and
 * the whole of it on an unbroken map. Otherwise it searches outward in rings, scanning
 * each ring in a fixed order so the answer does not depend on iteration luck.
 */
export function snapToRegion(
  map: Heightmap,
  region: Uint8Array,
  wantX: number,
  wantY: number,
): { x: number; y: number } {
  const width = map.width;
  const height = map.height;

  const clampX = wantX < 0 ? 0 : wantX >= width ? width - 1 : Math.floor(wantX);
  const clampY = wantY < 0 ? 0 : wantY >= height ? height - 1 : Math.floor(wantY);
  if (region[clampY * width + clampX] === 1) return { x: wantX, y: wantY };

  const reach = width > height ? width : height;
  for (let ring = 1; ring < reach; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      const y = clampY + dy;
      if (y < 0 || y >= height) continue;
      const edge = dy === -ring || dy === ring;

      for (let dx = -ring; dx <= ring; dx++) {
        // Only the ring itself, not its interior — that was covered by earlier rings.
        if (!edge && dx !== -ring && dx !== ring) continue;
        const x = clampX + dx;
        if (x < 0 || x >= width) continue;
        if (region[y * width + x] !== 1) continue;
        // Centre of the tile: a spawn on a tile boundary is ambiguous to round.
        return { x: x + 0.5, y: y + 0.5 };
      }
    }
  }
  // No walkable ground anywhere. Nothing sensible to return but what was asked for.
  return { x: wantX, y: wantY };
}
