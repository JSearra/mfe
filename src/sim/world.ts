import { atan2, angleDelta } from './math/trig.js';
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

export function spawn(world: World, x: number, y: number, faction: number): Handle {
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
  world.liveCount++;

  return packHandle(index, world.generation[index]!);
}

export function orderMove(world: World, handle: Handle, x: number, y: number): boolean {
  if (!isAlive(world, handle)) return false;
  const index = handleIndex(handle);
  world.targetX[index] = x;
  world.targetY[index] = y;
  world.hasTarget[index] = 1;
  return true;
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

/**
 * Move each unit toward its order target.
 *
 * Not pathfinding — that is Phase 4. A straight approach with arrival deceleration is
 * enough to exercise the boundary, and it establishes the property the renderer's
 * extrapolation guard depends on: a unit must never step past its target. Speed is
 * therefore clamped by distance/dt as well as by maxSpeed, so the final step lands
 * exactly on the target rather than overshooting and springing back.
 */
export function moveUnits(world: World): void {
  const { dt, maxSpeed, arriveRadius, decel, turnRate } = tuning.movement;
  const { alive, posX, posY, velX, velY, facing, targetX, targetY, hasTarget, capacity } = world;

  for (let i = 0; i < capacity; i++) {
    if (alive[i] !== 1) continue;

    if (hasTarget[i] !== 1) {
      velX[i] = 0;
      velY[i] = 0;
      setAnim(world, i, ANIM_IDLE);
      continue;
    }

    const dx = targetX[i]! - posX[i]!;
    const dy = targetY[i]! - posY[i]!;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance <= arriveRadius) {
      posX[i] = targetX[i]!;
      posY[i] = targetY[i]!;
      velX[i] = 0;
      velY[i] = 0;
      hasTarget[i] = 0;
      setAnim(world, i, ANIM_IDLE);
      continue;
    }

    // Decelerate on approach, and never travel further than the target is away.
    let speed = distance * decel;
    if (speed > maxSpeed) speed = maxSpeed;
    const stepLimit = distance / dt;
    if (speed > stepLimit) speed = stepLimit;

    const inverse = 1 / distance;
    const vx = dx * inverse * speed;
    const vy = dy * inverse * speed;

    velX[i] = vx;
    velY[i] = vy;
    posX[i] = posX[i]! + vx * dt;
    posY[i] = posY[i]! + vy * dt;

    // Turn toward travel the short way round, at a bounded rate.
    const desired = atan2(dy, dx);
    const delta = angleDelta(facing[i]!, desired);
    const maxTurn = turnRate * dt;
    facing[i] = facing[i]! + (delta > maxTurn ? maxTurn : delta < -maxTurn ? -maxTurn : delta);

    setAnim(world, i, ANIM_WALK);
  }
}

/** Stamp the start tick only when the state actually changes, so phase is stable. */
function setAnim(world: World, index: number, state: number): void {
  if (world.animState[index] === state) return;
  world.animState[index] = state;
  world.animStartTick[index] = world.tick;
}
