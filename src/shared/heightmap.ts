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
  /**
   * 1 where a tile is standing water: a river course, a pan, the sea.
   *
   * A MARK rather than a height threshold, and that is the whole of the decision. The
   * existing rivers are sunken channels that block movement through the same height
   * rule as everything else (see umfolozi in terrain/maps.ts), which is elegant and
   * stays — but "low ground" and "water" are not the same claim. Low ground is
   * everywhere on an open map; a river is somewhere particular, and whoever draws the
   * map has to be able to say where. Deriving it from height would flood every hollow
   * on the veld the moment fishing made water worth standing next to.
   *
   * Length width * height, or empty on a map with no water on it at all — callers go
   * through `isWater`, which reads an absent array as dry land.
   */
  readonly water: Uint8Array;
}

/** Is this tile standing water? False outside the map, and on any map without any. */
export function isWater(map: Heightmap, tileX: number, tileY: number): boolean {
  if (map.water.length === 0 || !inBounds(map, tileX, tileY)) return false;
  return map.water[tileY * map.width + tileX] === 1;
}

/**
 * Is this tile dry land with water next to it — a bank, a shore?
 *
 * The four square neighbours only. A tile touching water at the corner is not somewhere
 * you can put a line in, and diagonal reach would make every bend in a river fishable
 * from twice as much ground as it should be.
 */
export function isShore(map: Heightmap, tileX: number, tileY: number): boolean {
  if (map.water.length === 0 || isWater(map, tileX, tileY)) return false;
  if (!inBounds(map, tileX, tileY)) return false;
  return (
    isWater(map, tileX + 1, tileY) ||
    isWater(map, tileX - 1, tileY) ||
    isWater(map, tileX, tileY + 1) ||
    isWater(map, tileX, tileY - 1)
  );
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
  return { width, height, levels, data, water: new Uint8Array(0) };
}

/** The same, with a matching grid of 1s marking standing water. */
export function heightmapWithWater(
  rows: readonly (readonly number[])[],
  levels: number,
  wet: readonly (readonly number[])[],
): Heightmap {
  const map = heightmapFrom(rows, levels);
  const water = new Uint8Array(map.width * map.height);
  for (let tileY = 0; tileY < map.height; tileY++) {
    for (let tileX = 0; tileX < map.width; tileX++) {
      water[tileY * map.width + tileX] = wet[tileY]?.[tileX] === 1 ? 1 : 0;
    }
  }
  return { ...map, water };
}
