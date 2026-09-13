import { MAX_CLIMB } from './iso.js';
import { heightAt, inBounds, type Heightmap } from './heightmap.js';

/**
 * Which tile edges can be walked.
 *
 * A cliff is not a tile type — it is any edge where the height step exceeds
 * MAX_CLIMB. Mesas, koppies, poorts and dongas all fall out of that one rule, which
 * is why the map generators are height functions rather than bespoke tile placement.
 * See docs/adr/0006-per-tile-elevation.md.
 *
 * A set bit means passable. Off-map edges are always impassable.
 */

export const EDGE_NORTH = 1;
export const EDGE_EAST = 2;
export const EDGE_SOUTH = 4;
export const EDGE_WEST = 8;
export const EDGE_ALL = EDGE_NORTH | EDGE_EAST | EDGE_SOUTH | EDGE_WEST;

/** Tile-space deltas, in bit order: N, E, S, W. */
export const EDGE_DX = [0, 1, 0, -1] as const;
export const EDGE_DY = [-1, 0, 1, 0] as const;

export function derivePassability(map: Heightmap): Uint8Array {
  const flags = new Uint8Array(map.width * map.height);

  for (let tileY = 0; tileY < map.height; tileY++) {
    for (let tileX = 0; tileX < map.width; tileX++) {
      const here = map.data[tileY * map.width + tileX]!;
      let mask = 0;

      for (let dir = 0; dir < 4; dir++) {
        const neighbourX = tileX + EDGE_DX[dir]!;
        const neighbourY = tileY + EDGE_DY[dir]!;
        if (!inBounds(map, neighbourX, neighbourY)) continue;

        const there = map.data[neighbourY * map.width + neighbourX]!;
        const delta = here - there;
        if ((delta < 0 ? -delta : delta) <= MAX_CLIMB) mask |= 1 << dir;
      }

      flags[tileY * map.width + tileX] = mask;
    }
  }
  return flags;
}

export function isPassable(
  map: Heightmap,
  flags: Uint8Array,
  tileX: number,
  tileY: number,
  direction: number,
): boolean {
  if (!inBounds(map, tileX, tileY)) return false;
  return (flags[tileY * map.width + tileX]! & (1 << direction)) !== 0;
}

/**
 * Slope cost multiplier for a step. Flat is 1; a climbable step costs more.
 * Returns 0 for an impassable step, which callers must treat as blocked.
 */
export function stepCost(map: Heightmap, tileX: number, tileY: number, direction: number): number {
  const here = heightAt(map, tileX, tileY);
  const there = heightAt(map, tileX + EDGE_DX[direction]!, tileY + EDGE_DY[direction]!);
  if (here < 0 || there < 0) return 0;

  const delta = here - there;
  const rise = delta < 0 ? -delta : delta;
  if (rise > MAX_CLIMB) return 0;
  return rise === 0 ? 1 : 2;
}
