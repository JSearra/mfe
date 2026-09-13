import { EDGE_DX, EDGE_DY } from '../../shared/passability.js';
import { DIR8_DX, DIR8_DY, NO_DIRECTION } from './directions.js';
import { maxStepCost, type CostLayer } from './costs.js';

/**
 * Flow field: one shared field that answers "which way from here" for every tile at
 * once.
 *
 * Built first, and used for group movement, because it covers the dominant RTS case —
 * many units heading to one place — and is easier to make deterministic than N
 * independent searches. A 300-unit army is 6 to 20 groups, not 300 path requests; the
 * brief's "300 paths in 10ms" benchmark optimised a workload that never occurs.
 * See ADR-0003.
 *
 * The integration field is Uint16Array. The brief's Uint8 is correct for the *cost*
 * field, where 255 is the impassable sentinel, but the integration field accumulates
 * cost-to-goal and overflows a byte immediately. It is bounded here by construction:
 * orthogonal Dijkstra with integer step costs of at most 254 * slopeCost, over a
 * 128x128 map, stays well inside 16 bits for any path a unit would actually walk, and
 * anything longer clamps rather than wraps.
 */

export const UNREACHABLE = 0xffff;
const MAX_INTEGRATION = UNREACHABLE - 1;

export interface FlowField {
  readonly width: number;
  readonly height: number;
  readonly goalIndex: number;
  readonly movementClass: number;
  /** Accumulated cost to the goal. UNREACHABLE where no path exists. */
  readonly integration: Uint16Array;
  /** Direction index 0-7 toward the goal, or NO_DIRECTION. */
  readonly flow: Uint8Array;
  /** Tiles whose true cost exceeded the 16-bit range and were clamped. */
  readonly clampedTiles: number;
}

/**
 * Dijkstra outward from the goal over orthogonal edges.
 *
 * Orthogonal rather than eight-way on purpose: it keeps every accumulated value an
 * integer with a small bound, which is what lets the field stay 16-bit. The eight-way
 * choice happens afterwards, when reading the gradient, where diagonals cost nothing
 * extra to consider.
 */
export function buildFlowField(
  layer: CostLayer,
  goalX: number,
  goalY: number,
): FlowField {
  const width = layer.width;
  const height = layer.height;
  const size = width * height;

  const integration = new Uint16Array(size).fill(UNREACHABLE);
  const flow = new Uint8Array(size).fill(NO_DIRECTION);
  let clampedTiles = 0;

  const goalIndex = goalY * width + goalX;
  if (goalX < 0 || goalY < 0 || goalX >= width || goalY >= height) {
    return { width, height, goalIndex: -1, movementClass: layer.movementClass, integration, flow, clampedTiles };
  }

  const edgeCost = layer.edgeCost;

  /**
   * Dial's bucket queue rather than a binary heap.
   *
   * Step costs are bounded small integers, which is exactly the case a bucket queue is
   * for: it makes the search O(V + E + maxCost) instead of O(E log V). The heap was
   * costing more than the relaxations it scheduled — most of a 4.8ms field build was
   * sift-up and sift-down.
   *
   * Bucket order does not affect the result. Entries sharing a bucket share a cost, and
   * the integration field is the unique shortest-cost solution regardless of the order
   * equal-cost nodes are expanded in; the flow directions derive from those values with
   * an explicit tie-break on direction index.
   */
  const bucketCount = maxStepCost(layer) + 1;
  const buckets: number[][] = Array.from({ length: bucketCount }, () => []);
  const closed = new Uint8Array(size);

  integration[goalIndex] = 0;
  buckets[0]!.push(goalIndex);

  let queued = 1;
  let cursor = 0;

  while (queued > 0) {
    let bucket = buckets[cursor % bucketCount]!;
    while (bucket.length === 0) {
      cursor++;
      bucket = buckets[cursor % bucketCount]!;
    }

    const current = bucket.pop()!;
    queued--;
    if (closed[current] === 1) continue;
    closed[current] = 1;

    const currentCost = integration[current]!;
    const currentX = current % width;
    const currentY = (current / width) | 0;

    for (let dir = 0; dir < 4; dir++) {
      const nx = currentX + EDGE_DX[dir]!;
      const ny = currentY + EDGE_DY[dir]!;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

      const neighbour = ny * width + nx;
      if (closed[neighbour] === 1) continue;

      // Walking outward from the goal, so the step under test is neighbour -> current.
      const cost = edgeCost[neighbour * 4 + ((dir + 2) & 3)]!;
      if (cost === 0) continue;

      const next = currentCost + cost;

      // Saturation is tested BEFORE the improvement test. The field starts at
      // UNREACHABLE (0xffff), so a cost that overflows the range always compares as
      // "no improvement" and the clamp branch below would never be reached.
      if (next > MAX_INTEGRATION) {
        // A route this expensive saturates the field. Record the saturated value but do
        // not expand through it: the bucket queue's cursor only moves forward, and a
        // clamped value would land in a bucket already passed. Anything reachable only
        // beyond this frontier stays marked unreachable, which is the honest answer —
        // the alternative is a wrapped cost that reads as a shortcut.
        if (integration[neighbour] === UNREACHABLE) {
          integration[neighbour] = MAX_INTEGRATION;
          clampedTiles++;
        }
        continue;
      }

      if (next >= integration[neighbour]!) continue;
      integration[neighbour] = next;
      buckets[next % bucketCount]!.push(neighbour);
      queued++;
    }
  }

  // Gradient descent, eight-way, with no corner cutting.
  for (let tileY = 0; tileY < height; tileY++) {
    for (let tileX = 0; tileX < width; tileX++) {
      const index = tileY * width + tileX;
      if (integration[index] === UNREACHABLE) continue;
      if (index === goalIndex) continue;

      let bestDirection = NO_DIRECTION;
      let bestCost = integration[index]!;
      const dirs = layer.dirs8[index]!;

      for (let dir = 0; dir < 8; dir++) {
        if ((dirs & (1 << dir)) === 0) continue;

        const nx = tileX + DIR8_DX[dir]!;
        const ny = tileY + DIR8_DY[dir]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

        const neighbour = ny * width + nx;
        const cost = integration[neighbour]!;
        // Strict improvement, and ties settle on the lower direction index, so the
        // field is a pure function of the map.
        if (cost < bestCost) {
          bestCost = cost;
          bestDirection = dir;
        }
      }
      flow[index] = bestDirection;
    }
  }

  return { width, height, goalIndex, movementClass: layer.movementClass, integration, flow, clampedTiles };
}

export function flowAt(field: FlowField, tileX: number, tileY: number): number {
  if (tileX < 0 || tileY < 0 || tileX >= field.width || tileY >= field.height) return NO_DIRECTION;
  return field.flow[tileY * field.width + tileX]!;
}

export function isReachable(field: FlowField, tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= field.width || tileY >= field.height) return false;
  return field.integration[tileY * field.width + tileX] !== UNREACHABLE;
}
