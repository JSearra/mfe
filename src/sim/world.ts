import { createRng, type Rng } from './math/rng.js';
import { tuning } from './tuning.js';

/**
 * Entity storage: struct-of-arrays, no ECS. See docs/adr/0005-struct-of-arrays-not-ecs.md.
 *
 * A handle is (generation: u8, index: u24) packed into a u32. The generation is the
 * point: without it, a free-list allocator is a use-after-free factory. A unit dies,
 * its index is recycled on the next tick, and a command queued from the UI 75ms
 * earlier — which is one and a half ticks of interpolation delay — silently retargets
 * whatever now occupies that slot.
 *
 * Generations start at 1 and skip 0 on wrap, so a zeroed handle is never valid.
 */

export type Handle = number;

export const NULL_HANDLE: Handle = 0;

const INDEX_BITS = 24;
const INDEX_MASK = 0xffffff;
export const MAX_CAPACITY = 1 << INDEX_BITS;

export function packHandle(index: number, generation: number): Handle {
  return (((generation & 0xff) << INDEX_BITS) | (index & INDEX_MASK)) >>> 0;
}

export function handleIndex(handle: Handle): number {
  return handle & INDEX_MASK;
}

export function handleGeneration(handle: Handle): number {
  return (handle >>> INDEX_BITS) & 0xff;
}

export interface World {
  readonly capacity: number;

  /** 1 when the slot holds a live entity. */
  readonly alive: Uint8Array;
  /** 1 when destruction is queued but not yet flushed; the entity is still alive this tick. */
  readonly destroyPending: Uint8Array;
  readonly generation: Uint8Array;

  readonly posX: Float64Array;
  readonly posY: Float64Array;
  readonly velX: Float64Array;
  readonly velY: Float64Array;

  /** Radians. Kept at full precision here; quantised only when it crosses the boundary. */
  readonly facing: Float64Array;
  readonly targetX: Float64Array;
  readonly targetY: Float64Array;
  readonly hasTarget: Uint8Array;

  readonly faction: Uint8Array;
  readonly hp: Uint16Array;
  readonly movementClass: Uint8Array;
  readonly kind: Uint8Array;

  // --- cattle ---------------------------------------------------------------
  readonly herdState: Uint8Array;
  /** 0..stressMax. Saturation triggers a stampede. */
  readonly stress: Float64Array;
  /** Handle of the herder holding the tether, or NULL_HANDLE. */
  readonly tetheredTo: Uint32Array;
  /** Ticks remaining in the current stampede. */
  readonly stampedeTicks: Uint16Array;
  /** Position at the start of the tick, for swept collision. */
  readonly prevX: Float64Array;
  readonly prevY: Float64Array;

  /** Destination tile index, or -1. */
  readonly goalIndex: Int32Array;
  /** 1 when following a shared flow field rather than an individual path. */
  readonly useFlowField: Uint8Array;
  /** Outstanding path request ticket, or -1. */
  readonly pathRequest: Int32Array;
  /** Waypoint index into the unit's path, or -1. */
  readonly pathCursor: Int32Array;

  /** Chokepoint deadlock detection: ticks without meaningful progress. */
  // --- buildings ------------------------------------------------------------
  readonly buildingType: Uint8Array;
  /** Builder-ticks accumulated. Complete when it reaches the type's work value. */
  readonly buildProgress: Float64Array;
  /** Troops queued at this building. */
  readonly trainQueue: Uint8Array;
  /** Movement class of each queued troop, packed two bits per slot. */
  readonly trainKinds: Uint16Array;
  readonly trainProgress: Float64Array;
  /** Where finished troops are sent. Defaults to just outside the footprint. */
  readonly rallyX: Float64Array;
  readonly rallyY: Float64Array;

  // --- combat ---------------------------------------------------------------
  /** Handle of the current target, or NULL_HANDLE. */
  /** One of OrderMode. Plain move unless the order said otherwise. */
  readonly orderMode: Uint8Array;
  /** One of Stance. */
  readonly stance: Uint8Array;
  /** The far end of a patrol: the point a patrolling unit turns back toward. */
  readonly patrolX: Float64Array;
  readonly patrolY: Float64Array;
  /** Where a defensive unit returns to, and what its leash is measured from. */
  readonly postX: Float64Array;
  readonly postY: Float64Array;
  /**
   * Queued orders, ORDER_QUEUE_MAX per unit, as a ring starting at queueHead.
   *
   * Fixed-size and flat rather than an array of arrays: the world is struct-of-arrays so
   * that it can be hashed, saved and sent as typed buffers without a bespoke codec per
   * field, and a per-unit list would need exactly that. Eight waypoints is more than a
   * player queues in practice, and an order arriving at a full queue drops rather than
   * growing anything.
   */
  readonly queueX: Float64Array;
  readonly queueY: Float64Array;
  readonly queueMode: Uint8Array;
  readonly queueHead: Uint8Array;
  readonly queueCount: Uint8Array;
  readonly attackTarget: Uint32Array;
  /** Ticks until this unit may strike again. */
  readonly attackCooldown: Uint16Array;

  readonly stuckTicks: Uint16Array;
  readonly lastProgressX: Float64Array;
  readonly lastProgressY: Float64Array;
  readonly animState: Uint8Array;
  /**
   * Tick the current animation began. Sent across the boundary because a renderer
   * running at 60fps against 20Hz snapshots has no other way to know a walk cycle's
   * phase, and without it looping animations visibly restart every tick.
   */
  readonly animStartTick: Uint32Array;
  readonly flags: Uint8Array;

  readonly freeStack: Uint32Array;
  freeCount: number;

  readonly pendingDestroy: Uint32Array;
  pendingDestroyCount: number;

  liveCount: number;
  tick: number;
  readonly rng: Rng;
}

export function createWorld(capacity: number, seed: number): World {
  if (capacity <= 0 || capacity > MAX_CAPACITY) {
    throw new RangeError(`capacity must be in 1..${MAX_CAPACITY}, got ${capacity}`);
  }

  const generation = new Uint8Array(capacity).fill(1);

  // Descending, so the first allocation is index 0 and the order is predictable.
  const freeStack = new Uint32Array(capacity);
  for (let i = 0; i < capacity; i++) freeStack[i] = capacity - 1 - i;

  return {
    capacity,
    alive: new Uint8Array(capacity),
    destroyPending: new Uint8Array(capacity),
    generation,
    posX: new Float64Array(capacity),
    posY: new Float64Array(capacity),
    velX: new Float64Array(capacity),
    velY: new Float64Array(capacity),
    facing: new Float64Array(capacity),
    targetX: new Float64Array(capacity),
    targetY: new Float64Array(capacity),
    hasTarget: new Uint8Array(capacity),
    faction: new Uint8Array(capacity),
    hp: new Uint16Array(capacity),
    movementClass: new Uint8Array(capacity),
    kind: new Uint8Array(capacity),
    herdState: new Uint8Array(capacity),
    stress: new Float64Array(capacity),
    tetheredTo: new Uint32Array(capacity),
    stampedeTicks: new Uint16Array(capacity),
    prevX: new Float64Array(capacity),
    prevY: new Float64Array(capacity),
    goalIndex: new Int32Array(capacity).fill(-1),
    useFlowField: new Uint8Array(capacity),
    pathRequest: new Int32Array(capacity).fill(-1),
    pathCursor: new Int32Array(capacity).fill(-1),
    buildingType: new Uint8Array(capacity),
    buildProgress: new Float64Array(capacity),
    trainQueue: new Uint8Array(capacity),
    trainKinds: new Uint16Array(capacity),
    trainProgress: new Float64Array(capacity),
    rallyX: new Float64Array(capacity),
    rallyY: new Float64Array(capacity),
    orderMode: new Uint8Array(capacity),
    stance: new Uint8Array(capacity),
    patrolX: new Float64Array(capacity),
    patrolY: new Float64Array(capacity),
    postX: new Float64Array(capacity),
    postY: new Float64Array(capacity),
    queueX: new Float64Array(capacity * ORDER_QUEUE_MAX),
    queueY: new Float64Array(capacity * ORDER_QUEUE_MAX),
    queueMode: new Uint8Array(capacity * ORDER_QUEUE_MAX),
    queueHead: new Uint8Array(capacity),
    queueCount: new Uint8Array(capacity),
    attackTarget: new Uint32Array(capacity),
    attackCooldown: new Uint16Array(capacity),
    stuckTicks: new Uint16Array(capacity),
    lastProgressX: new Float64Array(capacity),
    lastProgressY: new Float64Array(capacity),
    animState: new Uint8Array(capacity),
    animStartTick: new Uint32Array(capacity),
    flags: new Uint8Array(capacity),
    freeStack,
    freeCount: capacity,
    pendingDestroy: new Uint32Array(capacity),
    pendingDestroyCount: 0,
    liveCount: 0,
    tick: 0,
    rng: createRng(seed),
  };
}

export function isAlive(world: World, handle: Handle): boolean {
  const index = handleIndex(handle);
  if (index >= world.capacity) return false;
  return world.alive[index] === 1 && world.generation[index] === handleGeneration(handle);
}

/**
 * How a unit treats what it meets on the way to its destination.
 *
 * A plain move walks past a fight; an attack-move stops and takes it. The distinction
 * lives on the unit rather than on the order because the order is consumed by the
 * pathing service, which has no business knowing about combat.
 */
export const OrderMode = {
  Move: 0,
  AttackMove: 1,
  /**
   * Walk between two points until told otherwise, engaging on the way.
   *
   * Implemented as an attack-move that refuses to finish: on arrival the unit swaps its
   * goal with the point it set out from, which it keeps in patrolX/patrolY. That reuses
   * the whole of attack-move rather than growing a second kind of standing order.
   */
  Patrol: 2,
} as const;

export type OrderMode = (typeof OrderMode)[keyof typeof OrderMode];

/**
 * How far a unit will go to fight.
 *
 * Pursuit did not exist before this: `attack` set a target and nothing ever closed with
 * it, so a unit ordered onto an enemy stood still unless the enemy happened to walk into
 * reach. Adding pursuit without a policy would be worse than not having it — a line of
 * defenders that all chase the first scout they see has abandoned the thing it was
 * defending, which is the oldest complaint in the genre.
 */
/** Waypoints a single unit may have queued behind its current order. */
export const ORDER_QUEUE_MAX = 8;

/** Append an order. False if the queue is full, which drops the order rather than growing. */
export function enqueueOrder(
  world: World,
  index: number,
  x: number,
  y: number,
  mode: number,
): boolean {
  const count = world.queueCount[index]!;
  if (count >= ORDER_QUEUE_MAX) return false;
  const slot = (world.queueHead[index]! + count) % ORDER_QUEUE_MAX;
  const at = index * ORDER_QUEUE_MAX + slot;
  world.queueX[at] = x;
  world.queueY[at] = y;
  world.queueMode[at] = mode;
  world.queueCount[index] = count + 1;
  return true;
}

/** Take the next queued order, or null. */
export function dequeueOrder(
  world: World,
  index: number,
): { x: number; y: number; mode: number } | null {
  const count = world.queueCount[index]!;
  if (count === 0) return null;
  const head = world.queueHead[index]!;
  const at = index * ORDER_QUEUE_MAX + head;
  world.queueHead[index] = (head + 1) % ORDER_QUEUE_MAX;
  world.queueCount[index] = count - 1;
  return { x: world.queueX[at]!, y: world.queueY[at]!, mode: world.queueMode[at]! };
}

export function clearOrderQueue(world: World, index: number): void {
  world.queueCount[index] = 0;
  world.queueHead[index] = 0;
}

export const Stance = {
  /** Chase what it acquires, as far as the chase range allows. */
  Aggressive: 0,
  /** Fight what comes near, then return to where it was posted. */
  Defensive: 1,
  /** Never leave the spot. Fights only what comes into reach. */
  HoldGround: 2,
} as const;

export type Stance = (typeof Stance)[keyof typeof Stance];

export const ANIM_IDLE = 0;
export const ANIM_WALK = 1;
export const ANIM_STAMPEDE = 2;

/**
 * Entity kinds share one store.
 *
 * ARCHITECTURE section 2 anticipates a store per kind. Cattle turned out to share almost
 * every field a unit has — position, velocity, facing, health, animation — so a separate
 * store would have duplicated all of them to add four. One discriminator plus four cattle
 * columns is less code and less to keep in step. Split them when the shapes genuinely
 * diverge, not before.
 */
export const EntityKind = {
  Unit: 0,
  Cattle: 1,
  Building: 2,
} as const;

export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

/** Cattle behaviour state. */
export const HerdState = {
  /** Free-roaming: flocking with a slow wander. */
  Grazing: 0,
  /** Tethered to a herder, following it. */
  Leashed: 1,
  /** Stressed but still controllable. */
  Alarmed: 2,
  /** Stress saturated: running from the threat and crushing what it meets. */
  Stampeding: 3,
} as const;

export type HerdState = (typeof HerdState)[keyof typeof HerdState];

export function spawn(
  world: World,
  x: number,
  y: number,
  faction: number,
  movementClass = 0,
  kind: EntityKind = EntityKind.Unit,
): Handle {
  if (world.freeCount === 0) return NULL_HANDLE;

  const index = world.freeStack[--world.freeCount]!;
  world.alive[index] = 1;
  world.destroyPending[index] = 0;
  world.posX[index] = x;
  world.posY[index] = y;
  world.velX[index] = 0;
  world.velY[index] = 0;
  world.facing[index] = 0;
  world.targetX[index] = x;
  world.targetY[index] = y;
  world.hasTarget[index] = 0;
  world.faction[index] = faction;
  world.hp[index] = tuning.unit.maxHp;
  world.animState[index] = ANIM_IDLE;
  world.animStartTick[index] = world.tick;
  world.flags[index] = 0;
  world.movementClass[index] = movementClass;
  world.kind[index] = kind;
  world.herdState[index] = HerdState.Grazing;
  world.stress[index] = 0;
  world.tetheredTo[index] = NULL_HANDLE;
  world.stampedeTicks[index] = 0;
  world.prevX[index] = x;
  world.prevY[index] = y;
  world.goalIndex[index] = -1;
  world.useFlowField[index] = 0;
  world.pathRequest[index] = -1;
  world.pathCursor[index] = -1;
  world.buildingType[index] = 0;
  world.buildProgress[index] = 0;
  world.trainQueue[index] = 0;
  world.trainKinds[index] = 0;
  world.trainProgress[index] = 0;
  world.rallyX[index] = x;
  world.rallyY[index] = y;
  world.orderMode[index] = OrderMode.Move;
  world.stance[index] = Stance.Aggressive;
  clearOrderQueue(world, index);
  world.postX[index] = x;
  world.postY[index] = y;
  world.attackTarget[index] = NULL_HANDLE;
  world.attackCooldown[index] = 0;
  world.stuckTicks[index] = 0;
  world.lastProgressX[index] = x;
  world.lastProgressY[index] = y;
  world.liveCount++;

  return packHandle(index, world.generation[index]!);
}

/**
 * Queue destruction. The entity stays alive for the remainder of the tick, because
 * removing it mid-iteration would make system results depend on iteration position.
 */
export function destroy(world: World, handle: Handle): boolean {
  if (!isAlive(world, handle)) return false;

  const index = handleIndex(handle);
  if (world.destroyPending[index] === 1) return false;

  world.destroyPending[index] = 1;
  world.pendingDestroy[world.pendingDestroyCount++] = index;
  return true;
}

/**
 * Apply queued destructions in ascending index order.
 *
 * The sort is not cosmetic. Free-stack order determines which index the next spawn
 * receives; if that order followed the order things happened to die, and that in turn
 * followed iteration order, divergence would cascade through every subsequent entity
 * id. Sorting pins it.
 */
export function flushDestroys(world: World): number {
  const count = world.pendingDestroyCount;
  if (count === 0) return 0;

  world.pendingDestroy.subarray(0, count).sort();

  for (let i = 0; i < count; i++) {
    const index = world.pendingDestroy[i]!;
    world.alive[index] = 0;
    world.destroyPending[index] = 0;

    // Skip 0 on wrap so a zeroed handle can never match a live generation.
    const next = (world.generation[index]! + 1) & 0xff;
    world.generation[index] = next === 0 ? 1 : next;

    world.freeStack[world.freeCount++] = index;
    world.liveCount--;
  }

  world.pendingDestroyCount = 0;
  return count;
}
