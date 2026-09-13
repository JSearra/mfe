import { describe, expect, it } from 'vitest';
import { heightmapFrom, type Heightmap } from '../src/shared/heightmap.js';
import { createIntHeap } from '../src/sim/pathing/heap.js';
import { createSpatialGrid } from '../src/sim/spatial/grid.js';
import {
  buildCostLayer,
  CLASS_PROFILES,
  IMPASSABLE,
  MovementClass,
  blockTile,
} from '../src/sim/pathing/costs.js';
import { buildFlowField, isReachable, UNREACHABLE } from '../src/sim/pathing/flowField.js';
import { createAStarScratch, findPath, PathStatus } from '../src/sim/pathing/astar.js';
import { createPathingService } from '../src/sim/pathing/service.js';
import { NO_DIRECTION } from '../src/sim/pathing/directions.js';
import { createMovementSystem } from '../src/sim/movement.js';
import { createWorld, spawn } from '../src/sim/world.js';
import { flatMap } from './simHarness.js';

const FLAT = flatMap(24);

function scratchFor(map: Heightmap) {
  return createAStarScratch(map.width * map.height);
}

describe('int heap', () => {
  it('orders by priority, then secondary, then node index', () => {
    const heap = createIntHeap(8);
    heap.push(5, 10, 2);
    heap.push(3, 10, 1);
    heap.push(9, 9, 99);
    heap.push(1, 10, 1);

    expect(heap.pop()).toBe(9); // lowest priority
    expect(heap.pop()).toBe(1); // priority 10, secondary 1, lower node
    expect(heap.pop()).toBe(3);
    expect(heap.pop()).toBe(5);
    expect(heap.pop()).toBe(-1);
  });

  it('stays correct while growing past its initial capacity', () => {
    const heap = createIntHeap(2);
    const inserted = [17, 3, 42, 8, 99, 1, 56, 23, 4];
    for (const value of inserted) heap.push(value, value);

    const popped: number[] = [];
    for (let i = 0; i < inserted.length; i++) popped.push(heap.pop());
    expect(popped).toEqual([...inserted].sort((a, b) => a - b));
  });
});

describe('spatial grid', () => {
  it('returns candidates sorted by entity index regardless of insertion order', () => {
    const forward = createSpatialGrid(16, 16, 2);
    const backward = createSpatialGrid(16, 16, 2);
    const entities = [[7, 1.5, 1.5], [2, 2.5, 1.2], [9, 0.5, 2.5], [4, 3.1, 3.1]] as const;

    for (const [index, x, y] of entities) forward.insert(index, x, y);
    for (const [index, x, y] of [...entities].reverse()) backward.insert(index, x, y);

    const a: number[] = [];
    const b: number[] = [];
    forward.query(2, 2, 3, a);
    backward.query(2, 2, 3, b);

    expect(a).toEqual([...a].sort((x, y) => x - y));
    expect(b).toEqual(a);
  });

  it('finds neighbours within the radius and clamps out-of-bounds queries', () => {
    const grid = createSpatialGrid(16, 16, 2);
    grid.insert(1, 1, 1);
    grid.insert(2, 14, 14);

    const out: number[] = [];
    expect(grid.query(1, 1, 2, out)).toBeGreaterThanOrEqual(1);
    expect(out).toContain(1);

    grid.query(-50, -50, 1, out);
    expect(out).toContain(1);
  });
});

describe('cost layers', () => {
  it('differs per movement class', () => {
    const infantry = buildCostLayer(FLAT, MovementClass.Infantry);
    const mounted = buildCostLayer(FLAT, MovementClass.Mounted);
    expect(infantry.tileCost[0]).toBe(CLASS_PROFILES[MovementClass.Infantry].baseCost);
    expect(mounted.tileCost[0]).toBe(CLASS_PROFILES[MovementClass.Mounted].baseCost);
    expect(infantry.tileCost[0]).not.toBe(mounted.tileCost[0]);
  });

  it('closes edges across a cliff', () => {
    const map = heightmapFrom(
      [
        [0, 0, 0],
        [0, 7, 0],
        [0, 0, 0],
      ],
      8,
    );
    const layer = buildCostLayer(map, MovementClass.Infantry);
    // The centre tile is sheer on every side.
    expect(layer.edges[1 * 3 + 1]).toBe(0);
  });
});

describe('flow field', () => {
  it('leads every reachable tile to the goal', () => {
    const layer = buildCostLayer(FLAT, MovementClass.Infantry);
    const field = buildFlowField(layer, 20, 20);

    for (let y = 0; y < FLAT.height; y++) {
      for (let x = 0; x < FLAT.width; x++) {
        if (x === 20 && y === 20) continue;
        expect(field.flow[y * FLAT.width + x]).not.toBe(NO_DIRECTION);
        expect(field.integration[y * FLAT.width + x]).toBeLessThan(UNREACHABLE);
      }
    }
  });

  it('marks an enclosed pocket unreachable rather than guessing', () => {
    // A single tile ringed by cliffs.
    const rows = Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => 0));
    for (let i = 2; i <= 4; i++) {
      rows[2]![i] = 7;
      rows[4]![i] = 7;
      rows[i]![2] = 7;
      rows[i]![4] = 7;
    }
    const map = heightmapFrom(rows, 8);
    const layer = buildCostLayer(map, MovementClass.Infantry);
    const field = buildFlowField(layer, 0, 0);

    expect(isReachable(field, 3, 3)).toBe(false);
    expect(isReachable(field, 0, 6)).toBe(true);
  });

  // The Uint8 the brief specified is right for the cost field and wrong for this one.
  it('clamps rather than wrapping on a pathologically expensive map', () => {
    // A serpentine corridor: the only route snakes the full width of every row, so the
    // accumulated cost to the far end is ~500 tiles at the maximum legal per-tile cost.
    const size = 32;
    const rows = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
    for (let y = 1; y < size; y += 2) {
      for (let x = 0; x < size; x++) rows[y]![x] = 7;
      const gap = Math.floor(y / 2) % 2 === 0 ? size - 1 : 0;
      rows[y]![gap] = 0;
    }
    const map = heightmapFrom(rows, 8);

    // Maximum legal per-tile cost, to drive the accumulated total as high as possible.
    // Injected as a profile rather than written into tileCost, because the edge-cost
    // table is derived at construction and would not follow.
    const layer = buildCostLayer(map, MovementClass.Infantry, {
      maxClimb: 1,
      slopeCost: 2,
      baseCost: IMPASSABLE - 1,
    });
    const field = buildFlowField(layer, 0, 0);

    let maxSeen = 0;
    for (const value of field.integration) {
      if (value === UNREACHABLE) continue;
      maxSeen = Math.max(maxSeen, value);
      expect(value).toBeLessThan(UNREACHABLE);
    }

    // Costs really did saturate, and nothing wrapped around to a small value.
    expect(field.clampedTiles).toBeGreaterThan(0);
    expect(maxSeen).toBe(UNREACHABLE - 1);
  });
});

describe('A*', () => {
  it('finds a path across open ground', () => {
    const layer = buildCostLayer(FLAT, MovementClass.Infantry);
    const result = findPath(layer, scratchFor(FLAT), 0, 23 * 24 + 23, 100000);

    expect(result.status).toBe(PathStatus.Found);
    expect(result.path[0]).toBe(0);
    expect(result.path[result.path.length - 1]).toBe(23 * 24 + 23);
    // Diagonals allowed, so a corner-to-corner run is about the grid's diagonal.
    expect(result.path.length).toBeLessThanOrEqual(25);
  });

  it('routes around a wall rather than through it', () => {
    const size = 12;
    const rows = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
    for (let y = 0; y < size - 2; y++) rows[y]![6] = 7;
    const map = heightmapFrom(rows, 8);
    const layer = buildCostLayer(map, MovementClass.Infantry);

    const result = findPath(layer, scratchFor(map), 0, 11, 100000);
    expect(result.status).toBe(PathStatus.Found);
    for (const tile of result.path) expect(map.data[tile]).toBe(0);
    // It had to detour south past the wall's end.
    expect(result.path.some((tile) => ((tile / size) | 0) >= size - 2)).toBe(true);
  });

  it('reports an unreachable goal', () => {
    const rows = Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => 0));
    for (let i = 2; i <= 4; i++) {
      rows[2]![i] = 7;
      rows[4]![i] = 7;
      rows[i]![2] = 7;
      rows[i]![4] = 7;
    }
    const map = heightmapFrom(rows, 8);
    const layer = buildCostLayer(map, MovementClass.Infantry);
    const result = findPath(layer, scratchFor(map), 0, 3 * 7 + 3, 100000);
    expect(result.status).toBe(PathStatus.Unreachable);
  });

  it('respects a hard expansion budget instead of hanging', () => {
    const layer = buildCostLayer(FLAT, MovementClass.Infantry);
    const result = findPath(layer, scratchFor(FLAT), 0, 23 * 24 + 23, 3);
    expect(result.status).toBe(PathStatus.Exhausted);
    expect(result.expansions).toBeLessThanOrEqual(4);
  });

  it('will not cut the corner between two cliffs', () => {
    // A diagonal gap: (1,0) and (0,1) are sheer, so (0,0) must not slip to (1,1).
    const map = heightmapFrom(
      [
        [0, 7, 0],
        [7, 0, 0],
        [0, 0, 0],
      ],
      8,
    );
    const layer = buildCostLayer(map, MovementClass.Infantry);
    const result = findPath(layer, scratchFor(map), 0, 4, 100000);
    expect(result.status).toBe(PathStatus.Unreachable);
  });

  it('refuses to enter a blocked tile', () => {
    const layer = buildCostLayer(FLAT, MovementClass.Infantry);
    for (let y = 0; y < FLAT.height; y++) blockTile(layer, 12, y);

    const result = findPath(layer, scratchFor(FLAT), 0, 23, 100000);
    expect(result.status).toBe(PathStatus.Unreachable);
  });

  // Determinism is the property the replay hash and any future lockstep depend on.
  it('produces an identical node sequence across repeated runs of a tie-heavy search', () => {
    // Wide open ground: every route of equal length ties, so only the tie-break rules
    // decide the answer.
    const layer = buildCostLayer(FLAT, MovementClass.Infantry);
    const shared = scratchFor(FLAT);
    const reference = findPath(layer, shared, 0, 23 * 24 + 23, 100000).path;

    expect(reference.length).toBeGreaterThan(5);

    for (let run = 0; run < 1000; run++) {
      // Alternate a reused scratch with a fresh one: the generation stamping must not
      // let one search leak into the next.
      const scratch = run % 2 === 0 ? shared : scratchFor(FLAT);
      const again = findPath(layer, scratch, 0, 23 * 24 + 23, 100000).path;
      expect(again).toEqual(reference);
    }
  });
});

describe('path request queue', () => {
  it('is asynchronous by interface: a ticket now, a result later', () => {
    const service = createPathingService(FLAT);
    const handle = service.requestPath(0, 23 * 24 + 23, MovementClass.Infantry);

    expect(handle).toBeGreaterThan(0);
    expect(service.consumePath(handle)).toBeNull();

    service.process();
    const result = service.consumePath(handle);
    expect(result?.status).toBe(PathStatus.Found);

    // Results are taken once.
    expect(service.consumePath(handle)).toBeNull();
  });

  it('serves within a per-tick budget and leaves the rest queued', () => {
    const service = createPathingService(FLAT);
    const handles: number[] = [];
    for (let i = 0; i < 30; i++) handles.push(service.requestPath(0, 100 + i, MovementClass.Infantry));

    service.process();
    expect(service.stats.servedThisTick).toBeLessThanOrEqual(8);
    expect(service.stats.pending).toBeGreaterThan(0);

    for (let i = 0; i < 10; i++) service.process();
    expect(service.stats.pending).toBe(0);
  });

  it('caches a flow field per goal and movement class', () => {
    const service = createPathingService(FLAT);
    service.flowField(50, MovementClass.Infantry);
    service.flowField(50, MovementClass.Infantry);
    service.flowField(50, MovementClass.Cattle);

    expect(service.stats.flowFieldMisses).toBe(2);
    expect(service.stats.flowFieldHits).toBe(1);
  });
});

describe('unit movement under load', () => {
  /** A wall down the middle with a two-tile gap. */
  function chokepointMap(size: number): Heightmap {
    const rows = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
    const mid = size >> 1;
    for (let y = 0; y < size; y++) rows[y]![mid] = 7;
    rows[mid]![mid] = 0;
    rows[mid + 1]![mid] = 0;
    return heightmapFrom(rows, 8);
  }

  it('moves two columns through a two-tile gap without deadlocking', () => {
    const size = 32;
    const map = chokepointMap(size);
    const world = createWorld(256, 7);
    const movement = createMovementSystem(map);
    const mid = size >> 1;

    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < 40; i++) {
      left.push(spawn(world, 2 + (i % 5) * 0.9, 8 + Math.floor(i / 5) * 0.9, 0));
      right.push(spawn(world, size - 3 - (i % 5) * 0.9, 8 + Math.floor(i / 5) * 0.9, 1));
    }
    for (const handle of left) movement.order(world, handle, size - 4, mid + 0.5);
    for (const handle of right) movement.order(world, handle, 3, mid + 0.5);

    for (let tick = 0; tick < 1500; tick++) {
      movement.update(world);
      world.tick++;
    }

    let crossedLeft = 0;
    let crossedRight = 0;
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] !== 1) continue;
      if (world.faction[i] === 0 && world.posX[i]! > mid) crossedLeft++;
      if (world.faction[i] === 1 && world.posX[i]! < mid) crossedRight++;
    }

    // Both columns have to interleave through the same two tiles in opposite
    // directions. Deadlock would leave these near zero.
    expect(crossedLeft).toBeGreaterThan(30);
    expect(crossedRight).toBeGreaterThan(30);
  });

  it('never leaves a unit inside impassable terrain', () => {
    const size = 32;
    const map = chokepointMap(size);
    const world = createWorld(256, 11);
    const movement = createMovementSystem(map);
    const mid = size >> 1;

    for (let i = 0; i < 60; i++) {
      const handle = spawn(world, 2 + (i % 6) * 0.7, 6 + Math.floor(i / 6) * 0.7, 0);
      movement.order(world, handle, size - 4, mid + 0.5);
    }

    for (let tick = 0; tick < 900; tick++) {
      movement.update(world);
      world.tick++;

      for (let i = 0; i < world.capacity; i++) {
        if (world.alive[i] !== 1) continue;
        const tileX = Math.floor(world.posX[i]!);
        const tileY = Math.floor(world.posY[i]!);
        expect(tileX).toBeGreaterThanOrEqual(0);
        expect(tileY).toBeGreaterThanOrEqual(0);
        expect(tileX).toBeLessThan(size);
        expect(tileY).toBeLessThan(size);
        // The wall is height 7 against ground 0 — never walkable.
        expect(map.data[tileY * size + tileX]).toBe(0);
      }
    }
  });

  it('uses one shared field for a group and individual searches for stragglers', () => {
    const map = flatMap(24);
    const world = createWorld(64, 3);
    const movement = createMovementSystem(map);

    const group = Array.from({ length: 8 }, (_, i) => spawn(world, 2 + i * 0.6, 2, 0));
    for (const handle of group) movement.order(world, handle, 20, 20);
    movement.update(world);
    world.tick++;
    expect(movement.stats.flowFieldGroups).toBe(1);
    expect(movement.stats.singlePaths).toBe(0);

    const loner = spawn(world, 5, 18, 0);
    movement.order(world, loner, 21, 3);
    movement.update(world);
    expect(movement.stats.singlePaths).toBe(1);
  });
});
