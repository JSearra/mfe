/**
 * Terrain heightmap.
 *
 * Height drives slope movement cost, which tile edges are cliffs, line of sight and
 * high-ground vision — so the simulation owns it. But the renderer needs it too, to
 * draw terrain and to resolve which tile the cursor is over, and its boundary rule
 * allows only type imports from src/sim. So the data structure and the pure functions
 * over it live here, in shared; generation, which needs the seeded RNG, lives in
 * src/sim/terrain/generate.ts.
 *
 * The renderer receives the map once when it loads, not per tick — terrain is static.
 *
 * See docs/adr/0006-per-tile-elevation.md.
 */

export interface Heightmap {
  readonly width: number;
  readonly height: number;
  /** Heights run 0..levels-1. */
  readonly levels: number;
  /** Row-major, length width * height. */
  readonly data: Uint8Array;
}

export function inBounds(map: Heightmap, tileX: number, tileY: number): boolean {
  return tileX >= 0 && tileY >= 0 && tileX < map.width && tileY < map.height;
}

/** Height at a tile, or -1 outside the map. */
export function heightAt(map: Heightmap, tileX: number, tileY: number): number {
  if (!inBounds(map, tileX, tileY)) return -1;
  return map.data[tileY * map.width + tileX]!;
}

/** Build a heightmap from a literal grid. Used by tests and hand-authored fixtures. */
export function heightmapFrom(rows: readonly (readonly number[])[], levels: number): Heightmap {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const data = new Uint8Array(width * height);

  for (let tileY = 0; tileY < height; tileY++) {
    const row = rows[tileY]!;
    if (row.length !== width) throw new RangeError('heightmapFrom requires rectangular rows');
    for (let tileX = 0; tileX < width; tileX++) data[tileY * width + tileX] = row[tileX]!;
  }
  return { width, height, levels, data };
}
