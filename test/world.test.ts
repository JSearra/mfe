import { describe, expect, it } from 'vitest';
import {
  createWorld,
  destroy,
  flushDestroys,
  handleGeneration,
  handleIndex,
  isAlive,
  NULL_HANDLE,
  packHandle,
  spawn,
} from '../src/sim/world.js';

describe('world', () => {
  it('packs and unpacks handles across the full index range', () => {
    for (const index of [0, 1, 255, 4096, 0xffffff]) {
      for (const generation of [1, 2, 128, 255]) {
        const handle = packHandle(index, generation);
        expect(handleIndex(handle)).toBe(index);
        expect(handleGeneration(handle)).toBe(generation);
        expect(handle).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('treats a zeroed handle as invalid', () => {
    const world = createWorld(8, 1);
    spawn(world, 0, 0, 0, 0);
    expect(isAlive(world, NULL_HANDLE)).toBe(false);
  });

  // The headline safety property: this is the bug generation counters exist to stop.
  it('rejects a stale handle after the index is recycled', () => {
    const world = createWorld(4, 1);

    const first = spawn(world, 1, 2, 0, 0);
    expect(isAlive(world, first)).toBe(true);

    destroy(world, first);
    expect(isAlive(world, first)).toBe(true); // still alive until the flush
    flushDestroys(world);
    expect(isAlive(world, first)).toBe(false);

    const second = spawn(world, 9, 9, 0, 0);
    expect(handleIndex(second)).toBe(handleIndex(first)); // same slot reused
    expect(second).not.toBe(first); // different handle
    expect(isAlive(world, second)).toBe(true);
    expect(isAlive(world, first)).toBe(false); // the stale handle must not resolve
  });

  it('ignores a destroy naming a stale handle', () => {
    const world = createWorld(4, 1);
    const first = spawn(world, 0, 0, 0, 0);
    destroy(world, first);
    flushDestroys(world);

    const second = spawn(world, 0, 0, 0, 0);
    expect(destroy(world, first)).toBe(false);
    flushDestroys(world);
    expect(isAlive(world, second)).toBe(true);
  });

  it('does not double-queue a repeated destroy', () => {
    const world = createWorld(4, 1);
    const handle = spawn(world, 0, 0, 0, 0);
    expect(destroy(world, handle)).toBe(true);
    expect(destroy(world, handle)).toBe(false);
    expect(flushDestroys(world)).toBe(1);
    expect(world.freeCount).toBe(4);
  });

  it('flushes destroys in ascending index order regardless of destroy order', () => {
    const build = (order: number[]) => {
      const world = createWorld(16, 1);
      const handles = Array.from({ length: 8 }, (_, i) => spawn(world, i, i, 0, 0));
      for (const i of order) destroy(world, handles[i]!);
      flushDestroys(world);
      return Array.from(world.freeStack.subarray(0, world.freeCount));
    };

    // Same set destroyed, opposite orders: the free stack must come out identical,
    // or entity ids diverge for the rest of the run.
    expect(build([5, 1, 7, 3])).toEqual(build([3, 7, 1, 5]));
  });

  it('allocates predictably and reports exhaustion', () => {
    const world = createWorld(3, 1);
    expect(handleIndex(spawn(world, 0, 0, 0, 0))).toBe(0);
    expect(handleIndex(spawn(world, 0, 0, 0, 0))).toBe(1);
    expect(handleIndex(spawn(world, 0, 0, 0, 0))).toBe(2);
    expect(spawn(world, 0, 0, 0, 0)).toBe(NULL_HANDLE);
    expect(world.liveCount).toBe(3);
  });

  it('never issues generation 0, even across a full wrap', () => {
    const world = createWorld(1, 1);
    for (let i = 0; i < 600; i++) {
      const handle = spawn(world, 0, 0, 0, 0);
      expect(handleGeneration(handle)).not.toBe(0);
      expect(isAlive(world, handle)).toBe(true);
      destroy(world, handle);
      flushDestroys(world);
    }
  });
});
