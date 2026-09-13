import { inBounds, type Heightmap } from '../../shared/heightmap.js';
import { EDGE_DX, EDGE_DY } from '../../shared/passability.js';
import { DIR8_DX, DIR8_DY } from './directions.js';

/** Orthogonal edge bits each diagonal needs, indexed NE, SE, SW, NW. */
const DIAGONAL_FLANKS = [
  0b0011, // NE -> north + east
  0b0110, // SE -> east + south
  0b1100, // SW -> south + west
  0b1001, // NW -> west + north
] as const;

/**
 * Movement cost, keyed by movement class.
 *
 * Cost is NOT one grid. Infantry, cattle and mounted Griqua do not share a cost
 * function over slope, river drifts and acacia thornveld, and a single 0-255 grid cannot
 * express that — it was also what made the brief's JPS+ proposal unworkable, since any
 * precomputation would have to be built and stored per class. See ADR-0003.
 *
 * Two arrays per class:
 *   tileCost  — cost of entering a tile. IMPASSABLE means never.
 *   edges     — per-tile bitmask of walkable neighbours, derived from height deltas.
 *
 * Passability lives on edges rather than tiles because a cliff is a property of the step
 * between two tiles, not of either tile. See ADR-0006.
 */

export const IMPASSABLE = 255;

export const MovementClass = {
  Infantry: 0,
  Cattle: 1,
  Mounted: 2,
} as const;

export type MovementClass = (typeof MovementClass)[keyof typeof MovementClass];

export interface ClassProfile {
  /** Largest height step this class can walk. */
  readonly maxClimb: number;
  /** Cost multiplier applied to a step that changes height. */
  readonly slopeCost: number;
  /** Cost of flat ground. */
  readonly baseCost: number;
}

/**
 * Cattle will not climb what infantry will; horses are faster on the flat and worse on
 * a slope. These are the numbers the four map scripts act through.
 */
export const CLASS_PROFILES: Readonly<Record<MovementClass, ClassProfile>> = {
  [MovementClass.Infantry]: { maxClimb: 1, slopeCost: 2, baseCost: 4 },
  [MovementClass.Cattle]: { maxClimb: 1, slopeCost: 3, baseCost: 5 },
  [MovementClass.Mounted]: { maxClimb: 1, slopeCost: 4, baseCost: 3 },
};

export interface CostLayer {
  readonly width: number;
  readonly height: number;
  readonly movementClass: MovementClass;
  readonly profile: ClassProfile;
  /** Cost of entering each tile. */
  readonly tileCost: Uint8Array;
  /** Bitmask of walkable orthogonal neighbours, in N/E/S/W bit order. */
  readonly edges: Uint8Array;
  /**
   * Bitmask of walkable neighbours in all eight directions, N/NE/E/SE/S/SW/W/NW.
   *
   * The single source of truth for "may a unit step this way", consulted by A*, the
   * flow field and local steering alike. Deriving it in three places is how a diagonal
   * came to be judged solely by its two orthogonal components, which says nothing about
   * whether the destination itself is a cliff.
   */
  readonly dirs8: Uint8Array;
  /**
   * Precomputed cost of each orthogonal step, indexed `tile * 4 + direction`. Zero means
   * blocked.
   *
   * Computed once rather than derived per relaxation. Recomputing tile coordinates and
   * looking up two heights inside Dijkstra's innermost loop was costing roughly 100ns per
   * edge, which put a single flow field at 6.5ms — well over the whole tick budget.
   */
  readonly edgeCost: Uint16Array;
  /** Smallest non-impassable tile cost, for an admissible heuristic. */
  readonly minCost: number;
}

/**
 * Build the cost layer for a movement class.
 *
 * `tileCost`, `edges`, `dirs8` and `edgeCost` are all derived from each other, so none
 * of them may be written directly after construction — mutating `tileCost` alone leaves
 * the edge table describing the old world. Go through `blockTile`, or rebuild.
 *
 * The profile is injectable so callers can model modifiers — a faction that fords rivers
 * more easily, terrain tech — without inventing a new movement class.
 */
export function buildCostLayer(
  map: Heightmap,
  movementClass: MovementClass,
  profile: ClassProfile = CLASS_PROFILES[movementClass],
): CostLayer {
  const size = map.width * map.height;
  const tileCost = new Uint8Array(size);
  const edges = new Uint8Array(size);
  const dirs8 = new Uint8Array(size);
  const edgeCost = new Uint16Array(size * 4);

  for (let tileY = 0; tileY < map.height; tileY++) {
    for (let tileX = 0; tileX < map.width; tileX++) {
      const index = tileY * map.width + tileX;
      const here = map.data[index]!;

      tileCost[index] = profile.baseCost;

      let mask = 0;
      for (let dir = 0; dir < 4; dir++) {
        const nx = tileX + EDGE_DX[dir]!;
        const ny = tileY + EDGE_DY[dir]!;
        if (!inBounds(map, nx, ny)) continue;

        const there = map.data[ny * map.width + nx]!;
        const delta = here - there;
        const rise = delta < 0 ? -delta : delta;
        if (rise <= profile.maxClimb) mask |= 1 << dir;
      }
      edges[index] = mask;
    }
  }

  // Orthogonal step costs, one pass.
  for (let tileY = 0; tileY < map.height; tileY++) {
    for (let tileX = 0; tileX < map.width; tileX++) {
      const index = tileY * map.width + tileX;
      const here = map.data[index]!;
      const mask = edges[index]!;

      for (let dir = 0; dir < 4; dir++) {
        if ((mask & (1 << dir)) === 0) continue;
        const nx = tileX + EDGE_DX[dir]!;
        const ny = tileY + EDGE_DY[dir]!;
        const neighbour = ny * map.width + nx;

        const cost = tileCost[neighbour]!;
        if (cost === IMPASSABLE) continue;
        edgeCost[index * 4 + dir] = here === map.data[neighbour]! ? cost : cost * profile.slopeCost;
      }
    }
  }

  // Eight-way mask, derived once from the orthogonal edges plus a direct height test.
  for (let tileY = 0; tileY < map.height; tileY++) {
    for (let tileX = 0; tileX < map.width; tileX++) {
      const index = tileY * map.width + tileX;
      const orthogonal = edges[index]!;
      let mask = 0;

      for (let dir = 0; dir < 8; dir++) {
        const nx = tileX + DIR8_DX[dir]!;
        const ny = tileY + DIR8_DY[dir]!;
        if (!inBounds(map, nx, ny)) continue;
        if (tileCost[ny * map.width + nx] === IMPASSABLE) continue;

        if ((dir & 1) === 0) {
          // Orthogonal: already decided above.
          if ((orthogonal & (1 << (dir >> 1))) !== 0) mask |= 1 << dir;
          continue;
        }

        // Diagonal: both flanking orthogonals must be open, so nobody slips through
        // the corner between two cliffs — AND the destination must itself be within
        // climbing range, which the flanking pair does not imply.
        const required = DIAGONAL_FLANKS[(dir - 1) >> 1]!;
        if ((orthogonal & required) !== required) continue;

        const rise = map.data[ny * map.width + nx]! - map.data[index]!;
        if ((rise < 0 ? -rise : rise) > profile.maxClimb) continue;
        mask |= 1 << dir;
      }
      dirs8[index] = mask;
    }
  }

  return {
    width: map.width,
    height: map.height,
    movementClass,
    profile,
    tileCost,
    edges,
    dirs8,
    edgeCost,
    minCost: profile.baseCost,
  };
}

/**
 * Mark a tile permanently unwalkable — buildings, water, a kraal wall.
 *
 * Updates the derived tables too. Precomputing edge costs bought a large speedup and
 * introduced this obligation: setting tileCost alone leaves the table saying the tile is
 * still enterable, and searches walk straight through the new building.
 */
export function blockTile(layer: CostLayer, tileX: number, tileY: number): void {
  const { width, height } = layer;
  if (tileX < 0 || tileY < 0 || tileX >= width || tileY >= height) return;

  const index = tileY * width + tileX;
  layer.tileCost[index] = IMPASSABLE;
  layer.dirs8[index] = 0;
  for (let dir = 0; dir < 4; dir++) layer.edgeCost[index * 4 + dir] = 0;

  for (let dir = 0; dir < 8; dir++) {
    const nx = tileX + DIR8_DX[dir]!;
    const ny = tileY + DIR8_DY[dir]!;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

    const neighbour = ny * width + nx;
    // Clear the neighbour's route back into the blocked tile.
    layer.dirs8[neighbour] = layer.dirs8[neighbour]! & ~(1 << ((dir + 4) & 7));
    if ((dir & 1) === 0) layer.edgeCost[neighbour * 4 + (((dir + 4) & 7) >> 1)] = 0;
  }
}

export function isBlocked(layer: CostLayer, index: number): boolean {
  return layer.tileCost[index] === IMPASSABLE;
}

/**
 * Cost of stepping from one tile to an orthogonally adjacent one, or 0 if blocked.
 *
 * Returning 0 rather than Infinity keeps every cost an integer, which is what lets the
 * integration field stay a Uint16Array with a provable bound.
 */
export function stepCost(layer: CostLayer, fromIndex: number, direction: number): number {
  return layer.edgeCost[fromIndex * 4 + direction]!;
}

/** Largest cost any single step can have. Bounds the integration field. */
export function maxStepCost(layer: CostLayer): number {
  return (IMPASSABLE - 1) * layer.profile.slopeCost;
}
