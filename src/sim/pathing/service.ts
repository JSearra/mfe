import type { Heightmap } from '../../shared/heightmap.js';
import { buildCostLayer, MovementClass, type CostLayer } from './costs.js';
import { buildFlowField, type FlowField } from './flowField.js';
import { createAStarScratch, findPath, PathStatus, type PathResult } from './astar.js';
import { tuning } from '../tuning.js';

/**
 * Everything the movement system needs to answer "which way".
 *
 * The request API is ASYNCHRONOUS BY INTERFACE even though A* currently returns inside
 * the same tick. `requestPath` hands back a ticket and `consumePath` collects the result
 * later. That shape is the point: moving the search to a budgeted queue, or eventually
 * to a second worker, is then not a caller-side change anywhere. See ARCHITECTURE
 * section 11 on what gets rewritten and how to make it cheap.
 */

export const NO_REQUEST = -1;

export interface PathingStats {
  pending: number;
  servedThisTick: number;
  flowFieldHits: number;
  flowFieldMisses: number;
  flowFieldsQueued: number;
  flowFieldsBuiltThisTick: number;
  expansionsThisTick: number;
}

interface Request {
  readonly handle: number;
  readonly startIndex: number;
  readonly goalIndex: number;
  readonly movementClass: MovementClass;
}

export interface PathingService {
  readonly stats: PathingStats;
  layer(movementClass: MovementClass): CostLayer;
  /** Cached per (goal tile, movement class). Ordering 100 units to one tile builds one field. */
  flowField(goalIndex: number, movementClass: MovementClass): FlowField;
  /**
   * Cached field, or null with a build scheduled.
   *
   * Building is budgeted for the same reason path searches are: a full Dijkstra over the
   * map costs milliseconds, and several landing in one tick is what turns a redirected
   * army into a visible hitch. Callers steer straight at the goal for the tick or two
   * before the field arrives.
   */
  ensureFlowField(goalIndex: number, movementClass: MovementClass): FlowField | null;
  requestPath(startIndex: number, goalIndex: number, movementClass: MovementClass): number;
  consumePath(handle: number): PathResult | null;
  /** Serve queued requests within this tick's budget. */
  process(): void;
  invalidate(): void;
}

export function createPathingService(map: Heightmap): PathingService {
  const { maxRequestsPerTick, maxExpansionsPerRequest, flowFieldCacheSize, maxFlowFieldsPerTick } =
    tuning.pathing;

  const layers = new Map<MovementClass, CostLayer>();
  const fields = new Map<number, FlowField>();
  /**
   * Least-recently-USED order, not insertion order.
   *
   * Evicting by insertion looks equivalent and is not: with more active destinations
   * than cache slots, every field is evicted while still in use and gets rebuilt from
   * scratch — a full Dijkstra over the map, inside the tick. LRU keeps the fields that
   * units are actually following.
   */
  const fieldOrder: number[] = [];

  const scratch = createAStarScratch(map.width * map.height);
  const queue: Request[] = [];
  const fieldQueue: { key: number; goalIndex: number; movementClass: MovementClass }[] = [];
  const results = new Map<number, PathResult>();
  let nextHandle = 1;

  const stats: PathingStats = {
    pending: 0,
    servedThisTick: 0,
    flowFieldHits: 0,
    flowFieldMisses: 0,
    flowFieldsQueued: 0,
    flowFieldsBuiltThisTick: 0,
    expansionsThisTick: 0,
  };

  function layerFor(movementClass: MovementClass): CostLayer {
    let layer = layers.get(movementClass);
    if (layer === undefined) {
      layer = buildCostLayer(map, movementClass);
      layers.set(movementClass, layer);
    }
    return layer;
  }

  return {
    stats,
    layer: layerFor,

    flowField(goalIndex: number, movementClass: MovementClass): FlowField {
      // Numeric key: a template string would allocate on every lookup.
      const key = movementClass * map.width * map.height + goalIndex;
      const cached = fields.get(key);
      if (cached !== undefined) {
        stats.flowFieldHits++;
        const at = fieldOrder.indexOf(key);
        if (at !== -1 && at !== fieldOrder.length - 1) {
          fieldOrder.splice(at, 1);
          fieldOrder.push(key);
        }
        return cached;
      }

      stats.flowFieldMisses++;
      const layer = layerFor(movementClass);
      const field = buildFlowField(layer, goalIndex % map.width, (goalIndex / map.width) | 0);

      fields.set(key, field);
      fieldOrder.push(key);
      while (fieldOrder.length > flowFieldCacheSize) {
        const evicted = fieldOrder.shift()!;
        fields.delete(evicted);
      }
      return field;
    },

    ensureFlowField(goalIndex, movementClass): FlowField | null {
      const key = movementClass * map.width * map.height + goalIndex;
      const cached = fields.get(key);
      if (cached !== undefined) {
        stats.flowFieldHits++;
        const at = fieldOrder.indexOf(key);
        if (at !== -1 && at !== fieldOrder.length - 1) {
          fieldOrder.splice(at, 1);
          fieldOrder.push(key);
        }
        return cached;
      }

      if (!fieldQueue.some((entry) => entry.key === key)) {
        fieldQueue.push({ key, goalIndex, movementClass });
        stats.flowFieldsQueued = fieldQueue.length;
      }
      return null;
    },

    requestPath(startIndex, goalIndex, movementClass): number {
      const handle = nextHandle++;
      queue.push({ handle, startIndex, goalIndex, movementClass });
      stats.pending = queue.length;
      return handle;
    },

    consumePath(handle: number): PathResult | null {
      const result = results.get(handle);
      if (result === undefined) return null;
      results.delete(handle);
      return result;
    },

    process(): void {
      stats.servedThisTick = 0;
      stats.expansionsThisTick = 0;
      stats.flowFieldsBuiltThisTick = 0;

      let built = 0;
      while (fieldQueue.length > 0 && built < maxFlowFieldsPerTick) {
        const entry = fieldQueue.shift()!;
        this.flowField(entry.goalIndex, entry.movementClass);
        built++;
      }
      stats.flowFieldsBuiltThisTick = built;
      stats.flowFieldsQueued = fieldQueue.length;

      // Amortised across ticks: the budget is what keeps a burst of orders from
      // blowing the simulation's frame. The real steady-state load is a handful of
      // requests per tick, not the brief's imagined 300. See ADR-0003.
      let served = 0;
      while (queue.length > 0 && served < maxRequestsPerTick) {
        const request = queue.shift()!;
        const result = findPath(
          layerFor(request.movementClass),
          scratch,
          request.startIndex,
          request.goalIndex,
          maxExpansionsPerRequest,
        );
        results.set(request.handle, result);
        stats.expansionsThisTick += result.expansions;
        served++;
      }

      stats.servedThisTick = served;
      stats.pending = queue.length;
    },

    invalidate(): void {
      // Construction changes the grid, so every cached field is stale.
      fields.clear();
      fieldOrder.length = 0;
      fieldQueue.length = 0;
      layers.clear();
    },
  };
}

export { PathStatus };
