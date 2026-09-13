import { createRng, nextSigned, type Rng } from './math/rng.js';

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

export function spawn(
  world: World,
  x: number,
  y: number,
  vx: number,
  vy: number,
): Handle {
  if (world.freeCount === 0) return NULL_HANDLE;

  const index = world.freeStack[--world.freeCount]!;
  world.alive[index] = 1;
  world.destroyPending[index] = 0;
  world.posX[index] = x;
  world.posY[index] = y;
  world.velX[index] = vx;
  world.velY[index] = vy;
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

/**
 * Phase 0 movement: integrate velocity, apply damping, add a seeded wander.
 *
 * This exists to give the replay harness real dynamics to hash — something that
 * consumes RNG draws and accumulates floating-point state across ticks. Phase 4
 * replaces it with steering.
 */
export function integrate(
  world: World,
  dt: number,
  damping: number,
  maxSpeed: number,
  wanderStrength: number,
): void {
  const { alive, posX, posY, velX, velY, rng, capacity } = world;
  const maxSpeedSq = maxSpeed * maxSpeed;

  for (let i = 0; i < capacity; i++) {
    if (alive[i] !== 1) continue;

    let vx = velX[i]! * damping + nextSigned(rng) * wanderStrength;
    let vy = velY[i]! * damping + nextSigned(rng) * wanderStrength;

    const speedSq = vx * vx + vy * vy;
    if (speedSq > maxSpeedSq) {
      const scale = maxSpeed / Math.sqrt(speedSq);
      vx *= scale;
      vy *= scale;
    }

    velX[i] = vx;
    velY[i] = vy;
    posX[i] = posX[i]! + vx * dt;
    posY[i] = posY[i]! + vy * dt;
  }
}
