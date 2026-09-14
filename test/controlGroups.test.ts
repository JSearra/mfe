import { describe, expect, it } from 'vitest';
import { createSelection } from '../src/render/selection.js';
import type { InterpolatedView } from '../src/render/interpolation.js';
import {
  createWorld,
  destroy,
  flushDestroys,
  handleGeneration,
  spawn,
} from '../src/sim/world.js';

/**
 * Control groups are selection, and `CLAUDE.md` is explicit that selection never enters
 * the simulation. So there is no command, no world field, and nothing here that could
 * move a state hash — the interesting properties are all about handles outliving units.
 */

function viewOf(handles: readonly number[]): InterpolatedView {
  return { count: handles.length, handle: new Uint32Array(handles) } as unknown as InterpolatedView;
}

describe('control groups', () => {
  it('round-trips a selection', () => {
    const selection = createSelection();
    selection.handles.add(101);
    selection.handles.add(102);
    selection.assignGroup(4);

    selection.clear();
    expect(selection.recallGroup(4, viewOf([101, 102]))).toBe(true);
    expect([...selection.handles].sort()).toEqual([101, 102]);
  });

  it('is a snapshot, not a live alias', () => {
    const selection = createSelection();
    selection.handles.add(101);
    selection.assignGroup(4);
    selection.handles.add(999);

    selection.recallGroup(4, viewOf([101, 999]));
    // Adding to the current selection after assigning must not join the group.
    expect([...selection.handles]).toEqual([101]);
  });

  it('drops members that are no longer in the view', () => {
    const selection = createSelection();
    selection.handles.add(101);
    selection.handles.add(102);
    selection.assignGroup(4);
    selection.clear();

    // 102 died. Its slot may since have been recycled under a new generation, so the
    // handle no longer matches anything — recalling it would otherwise hand the player
    // whoever now occupies that slot, quite possibly an enemy.
    expect(selection.recallGroup(4, viewOf([101]))).toBe(true);
    expect([...selection.handles]).toEqual([101]);

    // And the group is pruned, so the dead member does not come back if the slot is
    // later reused under a handle that happens to collide.
    expect(selection.recallGroup(4, viewOf([101, 102]))).toBe(true);
    expect([...selection.handles]).toEqual([101]);
  });

  it('reports an empty or unknown group rather than clearing the selection', () => {
    const selection = createSelection();
    selection.handles.add(101);

    expect(selection.recallGroup(7, viewOf([101]))).toBe(false);
    // Pressing a digit you never assigned must not disarm you mid-fight.
    expect([...selection.handles]).toEqual([101]);
  });

  it('ignores digits outside 1..9', () => {
    const selection = createSelection();
    selection.handles.add(101);
    selection.assignGroup(0);
    selection.assignGroup(10);
    expect(selection.recallGroup(0, viewOf([101]))).toBe(false);
    expect(selection.recallGroup(10, viewOf([101]))).toBe(false);
  });
});

describe('scenery keys', () => {
  /**
   * The entity layer sorts vegetation alongside entities and needs a key per prop that
   * no live handle can hold. The range it uses is generation zero, which the allocator
   * refuses to issue — so this pins the invariant that makes that safe, from the render
   * side, where the assumption is actually being relied on.
   */
  it('generation zero is never issued, so a zero-generation key is free', () => {
    const world = createWorld(4, 1);
    for (let i = 0; i < 2000; i++) {
      const handle = spawn(world, 0, 0, 0);
      expect(handleGeneration(handle)).not.toBe(0);
      destroy(world, handle);
      flushDestroys(world);
    }
  });

  it('a real handle CAN have its top bit set, which is why that range is not free', () => {
    // The bug this replaced: prop keys were tagged with the high bit on the claim that
    // no handle uses it. A handle's generation occupies bits 24-31, so every generation
    // from 128 up sets it.
    const world = createWorld(1, 1);
    let sawTopBit = false;
    for (let i = 0; i < 400; i++) {
      const handle = spawn(world, 0, 0, 0);
      if ((handle & 0x80000000) !== 0) sawTopBit = true;
      destroy(world, handle);
      flushDestroys(world);
    }
    expect(sawTopBit).toBe(true);
  });
});
