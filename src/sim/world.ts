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
  // --- combat ---------------------------------------------------------------
  /** Handle of the current target, or NULL_HANDLE. */
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
