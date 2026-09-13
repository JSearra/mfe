import type { Heightmap } from '../shared/heightmap.js';
import { DIR8_DX, DIR8_DY, NO_DIRECTION } from './pathing/directions.js';
import { IMPASSABLE, MovementClass, type CostLayer } from './pathing/costs.js';
import { flowAt, isReachable } from './pathing/flowField.js';
import { PathStatus, createPathingService, type PathingService } from './pathing/service.js';
import { createSpatialGrid, type SpatialGrid } from './spatial/grid.js';
import { angleDelta, atan2 } from './math/trig.js';
import { tuning } from './tuning.js';
import {
  ANIM_IDLE,
  ANIM_WALK,
  EntityKind,
  handleIndex,
  isAlive,
  packHandle,
  type Handle,
  type World,
} from './world.js';

/**
 * Unit movement: route choice, local avoidance, and arrival.
 *
 * Route choice splits by group size, which is the whole reason both a flow field and an
 * A* implementation exist. Orders sharing a destination build one shared field —
 * ordering four units or four hundred to the same tile costs the same search. A lone
 * unit gets its own A* path instead, because a full field for one traveller is waste.
 *
 * Local avoidance is separation plus push-apart, NOT reciprocal velocity obstacles. RVO
 * is reciprocal by definition and the game's headline mechanic is a stampede, which is
 * definitionally not: cattle must plough through infantry while infantry fail to avoid
 * them. See ADR-0003. The failure separation actually has is deadlock at chokepoints,
 * not stacking, which is what the stuck timer and idle-yields-to-moving address.
 */

const ARRIVED = -1;

/**
 * Keep a step inside terrain the unit may actually occupy.
 *
 * Steering and push-apart both move units without consulting the grid, so without this
 * a crowd squeezed against a mesa pushes its outermost member off the cliff. Blocked
 * moves slide along the obstacle — trying each axis alone before giving up — which is
 * what stops units sticking to walls instead of following them.
 */
function constrainStep(
  layer: CostLayer,
  width: number,
  height: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  out: [number, number],
): void {
  if (canOccupy(layer, width, height, fromX, fromY, toX, toY)) {
    out[0] = toX;
    out[1] = toY;
    return;
  }
  if (canOccupy(layer, width, height, fromX, fromY, toX, fromY)) {
    out[0] = toX;
    out[1] = fromY;
    return;
  }
  if (canOccupy(layer, width, height, fromX, fromY, fromX, toY)) {
    out[0] = fromX;
    out[1] = toY;
    return;
  }
  out[0] = fromX;
  out[1] = fromY;
}

function canOccupy(
  layer: CostLayer,
  width: number,
  height: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  if (toX < 0 || toY < 0 || toX >= width || toY >= height) return false;

  const fromTileX = Math.floor(fromX);
  const fromTileY = Math.floor(fromY);
  const toTileX = Math.floor(toX);
  const toTileY = Math.floor(toY);

  if (fromTileX === toTileX && fromTileY === toTileY) return true;
  if (layer.tileCost[toTileY * width + toTileX] === IMPASSABLE) return false;

  const dx = toTileX - fromTileX;
  const dy = toTileY - fromTileY;
  if (dx < -1 || dx > 1 || dy < -1 || dy > 1) return false;

  const direction = DIRECTION_OF[(dy + 1) * 3 + (dx + 1)]!;
  return (layer.dirs8[fromTileY * width + fromTileX]! & (1 << direction)) !== 0;
}

/** (dy+1)*3 + (dx+1) -> direction index. The centre entry is never consulted. */
const DIRECTION_OF = [7, 0, 1, 6, 0, 2, 5, 4, 3] as const;

export interface MovementStats {
  flowFieldGroups: number;
  singlePaths: number;
  stuckRepaths: number;
  unreachableOrders: number;
}

export interface MovementSystem {
  readonly pathing: PathingService;
  readonly grid: SpatialGrid;
  readonly stats: MovementStats;
  /** Record an order. Routing is resolved once per tick, so groups can be detected. */
  order(world: World, handle: Handle, goalX: number, goalY: number): boolean;
  update(world: World): void;
  forget(index: number): void;
}

interface PendingOrder {
  readonly index: number;
  readonly goalIndex: number;
  readonly movementClass: MovementClass;
}

export function createMovementSystem(map: Heightmap): MovementSystem {
  const pathing = createPathingService(map);
  const grid = createSpatialGrid(map.width, map.height, tuning.spatial.cellSize);

  const stats: MovementStats = {
    flowFieldGroups: 0,
    singlePaths: 0,
    stuckRepaths: 0,
    unreachableOrders: 0,
  };

  let pending: PendingOrder[] = [];
  /** Keyed by handle, so a recycled entity index can never inherit a dead unit's path. */
  const paths = new Map<number, Int32Array>();
  const neighbours: number[] = [];

  function tileIndexOf(worldX: number, worldY: number): number {
    let tileX = Math.floor(worldX);
    let tileY = Math.floor(worldY);
    if (tileX < 0) tileX = 0;
    else if (tileX >= map.width) tileX = map.width - 1;
    if (tileY < 0) tileY = 0;
    else if (tileY >= map.height) tileY = map.height - 1;
    return tileY * map.width + tileX;
  }

  function clearRoute(world: World, index: number): void {
    paths.delete(packHandle(index, world.generation[index]!));
    world.pathCursor[index] = ARRIVED;
    world.pathRequest[index] = -1;
    world.useFlowField[index] = 0;
  }

  function resolveOrders(world: World): void {
    if (pending.length === 0) return;

    // Group by destination so a shared goal becomes one field rather than N searches.
    const groups = new Map<number, PendingOrder[]>();
    for (const order of pending) {
      const key = order.movementClass * map.width * map.height + order.goalIndex;
      const bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, [order]);
      else bucket.push(order);
    }

    for (const bucket of groups.values()) {
      const first = bucket[0]!;
      if (bucket.length >= tuning.pathing.flowFieldThreshold) {
        // Scheduled, not built here. A full Dijkstra inside the order-handling path is
        // what put a redirected army's tick over budget; reachability is checked once
        // the field lands, and until then units steer straight at the destination.
        pathing.ensureFlowField(first.goalIndex, first.movementClass);
        stats.flowFieldGroups++;

        for (const order of bucket) {
          world.useFlowField[order.index] = 1;
          world.goalIndex[order.index] = first.goalIndex;
          world.pathRequest[order.index] = -1;
        }
        continue;
      }

      for (const order of bucket) {
        stats.singlePaths++;
        const start = tileIndexOf(world.posX[order.index]!, world.posY[order.index]!);
        world.useFlowField[order.index] = 0;
        world.goalIndex[order.index] = order.goalIndex;
        world.pathRequest[order.index] = pathing.requestPath(
          start,
          order.goalIndex,
          order.movementClass,
        );
      }
    }

    pending = [];
  }

  function collectPaths(world: World): void {
    for (let index = 0; index < world.capacity; index++) {
      if (world.alive[index] !== 1) continue;
      const request = world.pathRequest[index]!;
      if (request < 0) continue;

      const result = pathing.consumePath(request);
      if (result === null) continue;
      world.pathRequest[index] = -1;

      if (result.status !== PathStatus.Found || result.path.length === 0) {
        stats.unreachableOrders++;
        world.hasTarget[index] = 0;
        clearRoute(world, index);
        continue;
      }

      paths.set(packHandle(index, world.generation[index]!), Int32Array.from(result.path));
      // Skip the tile the unit is standing on.
      world.pathCursor[index] = result.path.length > 1 ? 1 : 0;
    }
  }

  /**
   * Flow fields in use this tick, resolved once.
   *
   * Looking the field up per unit per frame is what turned a cache miss into a full
   * Dijkstra inside the movement loop. Distinct destinations are few — a 300-unit army
   * is a dozen or two groups — so resolving them up front costs one lookup each.
   */
  const activeFields = new Map<number, ReturnType<PathingService['flowField']>>();

  function resolveFields(world: World): void {
    activeFields.clear();
    const tiles = map.width * map.height;

    for (let index = 0; index < world.capacity; index++) {
      if (world.alive[index] !== 1 || world.useFlowField[index] !== 1) continue;

      const movementClass = world.movementClass[index]! as MovementClass;
      const key = movementClass * tiles + world.goalIndex[index]!;

      if (!activeFields.has(key)) {
        const field = pathing.ensureFlowField(world.goalIndex[index]!, movementClass);
        if (field !== null) activeFields.set(key, field);
      }

      // Deferred reachability. The check moved here from order handling because the
      // field may not exist yet; a unit standing somewhere it cannot leave has its
      // order cancelled rather than pressing against a cliff forever.
      const ready = activeFields.get(key);
      if (
        ready !== undefined &&
        !isReachable(ready, Math.floor(world.posX[index]!), Math.floor(world.posY[index]!))
      ) {
        stats.unreachableOrders++;
        world.hasTarget[index] = 0;
        clearRoute(world, index);
      }
    }
  }

  /** Desired travel direction, normalised, written into `out`. Returns false when none. */
  function desiredDirection(world: World, index: number, out: [number, number]): boolean {
    const posX = world.posX[index]!;
    const posY = world.posY[index]!;

    if (world.useFlowField[index] === 1) {
      const movementClass = world.movementClass[index]! as MovementClass;
      const field = activeFields.get(movementClass * map.width * map.height + world.goalIndex[index]!);
      if (field === undefined) return false;
      const direction = flowAt(field, Math.floor(posX), Math.floor(posY));
      if (direction === NO_DIRECTION) return false;

      const dx = DIR8_DX[direction]!;
      const dy = DIR8_DY[direction]!;
      const length = Math.sqrt(dx * dx + dy * dy);
      out[0] = dx / length;
      out[1] = dy / length;
      return true;
    }

    const path = paths.get(packHandle(index, world.generation[index]!));
    if (path === undefined) return false;

    let cursor = world.pathCursor[index]!;
    if (cursor < 0 || cursor >= path.length) return false;

    // Advance past waypoints already reached.
    while (cursor < path.length - 1) {
      const tile = path[cursor]!;
      const wx = (tile % map.width) + 0.5;
      const wy = ((tile / map.width) | 0) + 0.5;
      const dx = wx - posX;
      const dy = wy - posY;
      if (dx * dx + dy * dy > tuning.movement.waypointRadius * tuning.movement.waypointRadius) break;
      cursor++;
    }
    world.pathCursor[index] = cursor;

    const tile = path[cursor]!;
    const dx = (tile % map.width) + 0.5 - posX;
    const dy = ((tile / map.width) | 0) + 0.5 - posY;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1e-9) return false;
    out[0] = dx / length;
    out[1] = dy / length;
    return true;
  }

  const direction: [number, number] = [0, 0];
  const step: [number, number] = [0, 0];

  return {
    pathing,
    grid,
    stats,

    order(world, handle, goalX, goalY): boolean {
      // isAlive, not an alive[] check: the handle carries a generation, and an order
      // queued before the target died must not retarget whoever now occupies the slot.
      if (!isAlive(world, handle)) return false;
      const index = handleIndex(handle);
      if (world.kind[index] !== EntityKind.Unit) return false;

      world.targetX[index] = goalX;
      world.targetY[index] = goalY;
      world.hasTarget[index] = 1;
      world.stuckTicks[index] = 0;
      clearRoute(world, index);

      pending.push({
        index,
        goalIndex: tileIndexOf(goalX, goalY),
        movementClass: world.movementClass[index]! as MovementClass,
      });
      return true;
    },

    forget(index: number): void {
      for (const key of [...paths.keys()]) {
        if ((key & 0xffffff) === index) paths.delete(key);
      }
    },

    update(world: World): void {
      resolveOrders(world);
      pathing.process();
      collectPaths(world);
      resolveFields(world);

      const {
        dt,
        maxSpeed,
        arriveRadius,
        decel,
        turnRate,
        separationRadius,
        separationStrength,
        pushApart,
        stuckTicks,
        stuckDistance,
      } = tuning.movement;

      // Everything goes in the grid — cattle need to see units and vice versa — but
      // only units are steered here. Cattle are driven by the cattle system, which runs
      // after this and reads the same grid.
      grid.clear();
      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] === 1) grid.insert(index, world.posX[index]!, world.posY[index]!);
      }

      const maxTurn = turnRate * dt;
      // One lookup per class per tick rather than two per unit per tick.
      const layers = [
        pathing.layer(MovementClass.Infantry),
        pathing.layer(MovementClass.Cattle),
        pathing.layer(MovementClass.Mounted),
      ];

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Unit) continue;

        const posX = world.posX[index]!;
        const posY = world.posY[index]!;

        if (world.hasTarget[index] !== 1) {
          world.velX[index] = 0;
          world.velY[index] = 0;
          setAnim(world, index, ANIM_IDLE);
          continue;
        }

        const toGoalX = world.targetX[index]! - posX;
        const toGoalY = world.targetY[index]! - posY;
        const goalDistance = Math.sqrt(toGoalX * toGoalX + toGoalY * toGoalY);

        if (goalDistance <= arriveRadius) {
          const arriveLayer = layers[world.movementClass[index]!]!;
          constrainStep(
            arriveLayer,
            map.width,
            map.height,
            posX,
            posY,
            world.targetX[index]!,
            world.targetY[index]!,
            step,
          );
          world.posX[index] = step[0];
          world.posY[index] = step[1];
          world.velX[index] = 0;
          world.velY[index] = 0;
          world.hasTarget[index] = 0;
          world.stuckTicks[index] = 0;
          clearRoute(world, index);
          setAnim(world, index, ANIM_IDLE);
          continue;
        }

        let dirX: number;
        let dirY: number;

        // Inside the last tile, steer straight at the exact target so arrival is precise.
        if (goalDistance < 1.5 || !desiredDirection(world, index, direction)) {
          dirX = toGoalX / goalDistance;
          dirY = toGoalY / goalDistance;
        } else {
          dirX = direction[0];
          dirY = direction[1];
        }

        // Separation. Neighbours come back sorted by index, so the accumulated push is
        // the same on every machine regardless of insertion order.
        const count = grid.query(posX, posY, separationRadius, neighbours);
        let pushX = 0;
        let pushY = 0;
        for (let n = 0; n < count; n++) {
          const other = neighbours[n]!;
          if (other === index) continue;
          const dx = posX - world.posX[other]!;
          const dy = posY - world.posY[other]!;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq >= separationRadius * separationRadius || distanceSq < 1e-12) continue;
          const distance = Math.sqrt(distanceSq);
          const strength = (separationRadius - distance) / separationRadius;
          pushX += (dx / distance) * strength;
          pushY += (dy / distance) * strength;
        }

        let steerX = dirX + pushX * separationStrength;
        let steerY = dirY + pushY * separationStrength;
        const steerLength = Math.sqrt(steerX * steerX + steerY * steerY);
        if (steerLength < 1e-9) {
          steerX = dirX;
          steerY = dirY;
        } else {
          steerX /= steerLength;
          steerY /= steerLength;
        }

        // Decelerate on approach, and never travel further than the target is away.
        let speed = goalDistance * decel;
        if (speed > maxSpeed) speed = maxSpeed;
        const stepLimit = goalDistance / dt;
        if (speed > stepLimit) speed = stepLimit;

        const vx = steerX * speed;
        const vy = steerY * speed;
        world.velX[index] = vx;
        world.velY[index] = vy;

        const layer = layers[world.movementClass[index]!]!;
        constrainStep(layer, map.width, map.height, posX, posY, posX + vx * dt, posY + vy * dt, step);
        world.posX[index] = step[0];
        world.posY[index] = step[1];

        const desired = atan2(vy, vx);
        const delta = angleDelta(world.facing[index]!, desired);
        world.facing[index] =
          world.facing[index]! + (delta > maxTurn ? maxTurn : delta < -maxTurn ? -maxTurn : delta);

        setAnim(world, index, ANIM_WALK);

        // Stuck detection. Deadlock at a chokepoint is separation steering's real
        // failure, so a unit that has stopped making progress asks for a fresh route
        // rather than grinding against its neighbours forever.
        const progressX = world.posX[index]! - world.lastProgressX[index]!;
        const progressY = world.posY[index]! - world.lastProgressY[index]!;
        if (progressX * progressX + progressY * progressY > stuckDistance * stuckDistance) {
          world.lastProgressX[index] = world.posX[index]!;
          world.lastProgressY[index] = world.posY[index]!;
          world.stuckTicks[index] = 0;
        } else if (++world.stuckTicks[index]! >= stuckTicks) {
          world.stuckTicks[index] = 0;
          world.lastProgressX[index] = world.posX[index]!;
          world.lastProgressY[index] = world.posY[index]!;
          stats.stuckRepaths++;
          world.useFlowField[index] = 0;
          world.pathRequest[index] = pathing.requestPath(
            tileIndexOf(world.posX[index]!, world.posY[index]!),
            world.goalIndex[index]!,
            world.movementClass[index]! as MovementClass,
          );
        }
      }

      resolveOverlaps(world, grid, pushApart, layers, map.width, map.height);
    },
  };
}

/**
 * Soft push-apart after integration.
 *
 * Idle units yield to moving ones. Without that rule a stationary crowd is an immovable
 * wall, and units ordered through it grind to a halt at the edge instead of parting it.
 */
function resolveOverlaps(
  world: World,
  grid: SpatialGrid,
  pushApart: number,
  layers: readonly CostLayer[],
  width: number,
  height: number,
): void {
  if (pushApart <= 0) return;

  const neighbours: number[] = [];
  const step: [number, number] = [0, 0];
  for (let index = 0; index < world.capacity; index++) {
    if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Unit) continue;

    const posX = world.posX[index]!;
    const posY = world.posY[index]!;
    const count = grid.query(posX, posY, pushApart, neighbours);

    for (let n = 0; n < count; n++) {
      const other = neighbours[n]!;
      // Each pair is handled once, by the lower index, so the result cannot depend on
      // traversal order. Cattle are not pushed by infantry — that is the stampede's
      // whole point.
      if (other <= index || world.kind[other] !== EntityKind.Unit) continue;

      const dx = world.posX[other]! - posX;
      const dy = world.posY[other]! - posY;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq >= pushApart * pushApart || distanceSq < 1e-12) continue;

      const distance = Math.sqrt(distanceSq);
      const overlap = (pushApart - distance) / 2;
      const nx = dx / distance;
      const ny = dy / distance;

      const selfMoving = world.hasTarget[index] === 1;
      const otherMoving = world.hasTarget[other] === 1;
      const selfShare = selfMoving === otherMoving ? 0.5 : selfMoving ? 0.15 : 0.85;
      const otherShare = 1 - selfShare;

      const selfLayer = layers[world.movementClass[index]!]!;
      constrainStep(
        selfLayer,
        width,
        height,
        world.posX[index]!,
        world.posY[index]!,
        world.posX[index]! - nx * overlap * 2 * selfShare,
        world.posY[index]! - ny * overlap * 2 * selfShare,
        step,
      );
      world.posX[index] = step[0];
      world.posY[index] = step[1];

      const otherLayer = layers[world.movementClass[other]!]!;
      constrainStep(
        otherLayer,
        width,
        height,
        world.posX[other]!,
        world.posY[other]!,
        world.posX[other]! + nx * overlap * 2 * otherShare,
        world.posY[other]! + ny * overlap * 2 * otherShare,
        step,
      );
      world.posX[other] = step[0];
      world.posY[other] = step[1];
    }
  }
}

function setAnim(world: World, index: number, state: number): void {
  if (world.animState[index] === state) return;
  world.animState[index] = state;
  world.animStartTick[index] = world.tick;
}
