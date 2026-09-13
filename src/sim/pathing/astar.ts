import { DIAG_STEP, DIR8_DX, DIR8_DY, ORTHO_STEP, isDiagonal } from './directions.js';
import { createIntHeap } from './heap.js';
import type { CostLayer } from './costs.js';

/**
 * Weighted A*, eight-way, for a single unit.
 *
 * Not Jump Point Search. JPS's pruning rules are only valid on uniform-cost grids, and
 * this one is weighted by terrain and slope; its speedup also comes from expanding few
 * nodes on a *static* grid, and every construction invalidates that. See ADR-0003.
 *
 * Costs are integers throughout, scaled 70:99 for orthogonal:diagonal. Integers keep the
 * comparisons exact, which matters because these results feed the replay hash.
 */

export const PathStatus = {
  Found: 0,
  Unreachable: 1,
  /** Ran out of expansion budget. The caller may retry or fall back. */
  Exhausted: 2,
} as const;

export type PathStatus = (typeof PathStatus)[keyof typeof PathStatus];

export interface PathResult {
  status: PathStatus;
  /** Tile indices from start to goal inclusive. Empty unless Found. */
  path: number[];
  expansions: number;
}

export interface AStarScratch {
  readonly gScore: Int32Array;
  readonly cameFrom: Int32Array;
  readonly visitMark: Int32Array;
  readonly closed: Uint8Array;
  generation: number;
}

export function createAStarScratch(size: number): AStarScratch {
  return {
    gScore: new Int32Array(size),
    cameFrom: new Int32Array(size),
    visitMark: new Int32Array(size),
    closed: new Uint8Array(size),
    generation: 0,
  };
}

/**
 * Octile distance scaled by the cheapest possible tile.
 *
 * Admissible by construction: no real step can cost less than minCost per unit of
 * octile distance, so this never overestimates and A* stays optimal.
 */
function heuristic(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  minCost: number,
): number {
  const dx = fromX > toX ? fromX - toX : toX - fromX;
  const dy = fromY > toY ? fromY - toY : toY - fromY;
  const low = dx < dy ? dx : dy;
  const high = dx < dy ? dy : dx;
  return minCost * (ORTHO_STEP * (high - low) + DIAG_STEP * low);
}

export function findPath(
  layer: CostLayer,
  scratch: AStarScratch,
  startIndex: number,
  goalIndex: number,
  maxExpansions: number,
): PathResult {
  const width = layer.width;
  const size = width * layer.height;

  if (startIndex < 0 || goalIndex < 0 || startIndex >= size || goalIndex >= size) {
    return { status: PathStatus.Unreachable, path: [], expansions: 0 };
  }
  if (startIndex === goalIndex) {
    return { status: PathStatus.Found, path: [startIndex], expansions: 0 };
  }

  // A generation stamp avoids clearing three arrays of 16k entries per request.
  const generation = ++scratch.generation;
  const { gScore, cameFrom, visitMark, closed } = scratch;

  const goalX = goalIndex % width;
  const goalY = (goalIndex / width) | 0;
  const minCost = layer.minCost;

  const heap = createIntHeap(1024);
  visitMark[startIndex] = generation;
  gScore[startIndex] = 0;
  cameFrom[startIndex] = -1;
  closed[startIndex] = 0;

  const startX = startIndex % width;
  const startY = (startIndex / width) | 0;
  heap.push(startIndex, heuristic(startX, startY, goalX, goalY, minCost), 0);

  let expansions = 0;

  while (heap.size > 0) {
    const current = heap.pop();
    if (visitMark[current] === generation && closed[current] === 1) continue;
    closed[current] = 1;

    if (current === goalIndex) {
      const path: number[] = [];
      for (let node = current; node !== -1; node = cameFrom[node]!) path.push(node);
      path.reverse();
      return { status: PathStatus.Found, path, expansions };
    }

    if (++expansions > maxExpansions) {
      return { status: PathStatus.Exhausted, path: [], expansions };
    }

    const currentX = current % width;
    const currentY = (current / width) | 0;
    const dirs = layer.dirs8[current]!;
    const currentG = gScore[current]!;

    for (let dir = 0; dir < 8; dir++) {
      if ((dirs & (1 << dir)) === 0) continue;

      const nx = currentX + DIR8_DX[dir]!;
      const ny = currentY + DIR8_DY[dir]!;
      if (nx < 0 || ny < 0 || nx >= width || ny >= layer.height) continue;

      const neighbour = ny * width + nx;
      // Diagonals are validated through their two orthogonal components, which is also
      // what stops a unit slipping through the corner between two cliffs.
      const base = isDiagonal(dir)
        ? diagonalCost(layer, current, neighbour)
        : layer.edgeCost[current * 4 + (dir >> 1)]! * ORTHO_STEP;
      if (base === 0) continue;

      const tentative = currentG + base;
      if (visitMark[neighbour] === generation) {
        if (closed[neighbour] === 1) continue;
        if (tentative >= gScore[neighbour]!) continue;
      } else {
        visitMark[neighbour] = generation;
        closed[neighbour] = 0;
      }

      gScore[neighbour] = tentative;
      cameFrom[neighbour] = current;
      const h = heuristic(nx, ny, goalX, goalY, minCost);
      heap.push(neighbour, tentative + h, h);
    }
  }

  return { status: PathStatus.Unreachable, path: [], expansions };
}

/** Diagonal step cost: the destination tile's cost, slope-adjusted, scaled for distance. */
function diagonalCost(layer: CostLayer, fromIndex: number, toIndex: number): number {
  const width = layer.width;
  const fromX = fromIndex % width;
  const fromY = (fromIndex / width) | 0;
  const toX = toIndex % width;
  const toY = (toIndex / width) | 0;

  // Route through the horizontal neighbour to reuse the slope-aware step cost.
  const midIndex = fromY * width + toX;
  const horizontal = toX > fromX ? 1 : 3;
  if (layer.edgeCost[fromIndex * 4 + horizontal] === 0) return 0;

  const vertical = toY > fromY ? 2 : 0;
  const second = layer.edgeCost[midIndex * 4 + vertical]!;
  if (second === 0) return 0;

  return second * DIAG_STEP;
}
