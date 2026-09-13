import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  createSnapshotWriter,
  decodeFacing,
  decodeSnapshot,
  encodeFacing,
  encodeHpPct,
  SNAPSHOT_FIELDS,
  SNAPSHOT_VERSION,
  SnapshotVersionError,
} from '../src/shared/snapshot.js';
import { buildSnapshot } from '../src/sim/snapshot.js';
import { createWorld, packHandle, spawn } from '../src/sim/world.js';
import { makeSim } from './simHarness.js';

describe('snapshot layout', () => {
  it('derives offsets that are aligned and never overlap', () => {
    for (const count of [0, 1, 3, 7, 64, 511]) {
      const layout = computeLayout(count);
      expect(layout.offsets).toHaveLength(SNAPSHOT_FIELDS.length);

      let previousEnd = 16; // header
      for (let i = 0; i < SNAPSHOT_FIELDS.length; i++) {
        const offset = layout.offsets[i]!;
        expect(offset % 4).toBe(0);
        expect(offset).toBeGreaterThanOrEqual(previousEnd);
        const width = SNAPSHOT_FIELDS[i]!.type === 'u8' ? 1 : 4;
        previousEnd = offset + width * count;
      }
      expect(layout.byteLength).toBeGreaterThanOrEqual(previousEnd);
    }
  });
});

describe('snapshot codec', () => {
  it('round-trips every field', () => {
    const count = 5;
    const writer = createSnapshotWriter(count, 1234, 7);

    for (let i = 0; i < count; i++) {
      writer.handle[i] = packHandle(i * 3, (i % 255) + 1);
      writer.animStartTick[i] = 1000 + i;
      writer.x[i] = i * 1.5 - 3;
      writer.y[i] = i * -2.25 + 7;
      writer.facing[i] = (i * 37) & 255;
      writer.animState[i] = i % 2;
      writer.faction[i] = i % 4;
      writer.flags[i] = (i * 11) & 255;
      writer.hpPct[i] = (i * 51) & 255;
    }

    const view = decodeSnapshot(writer.buffer);

    expect(view.version).toBe(SNAPSHOT_VERSION);
    expect(view.tick).toBe(1234);
    expect(view.viewerId).toBe(7);
    expect(view.count).toBe(count);

    for (let i = 0; i < count; i++) {
      expect(view.handle[i]).toBe(writer.handle[i]);
      expect(view.animStartTick[i]).toBe(writer.animStartTick[i]);
      expect(view.x[i]).toBe(writer.x[i]);
      expect(view.y[i]).toBe(writer.y[i]);
      expect(view.facing[i]).toBe(writer.facing[i]);
      expect(view.animState[i]).toBe(writer.animState[i]);
      expect(view.faction[i]).toBe(writer.faction[i]);
      expect(view.flags[i]).toBe(writer.flags[i]);
      expect(view.hpPct[i]).toBe(writer.hpPct[i]);
    }
  });

  it('handles an empty snapshot', () => {
    const view = decodeSnapshot(createSnapshotWriter(0, 0, 0).buffer);
    expect(view.count).toBe(0);
    expect(view.handle).toHaveLength(0);
  });

  it('rejects a version mismatch clearly instead of misreading', () => {
    const writer = createSnapshotWriter(3, 1, 0);
    new Uint32Array(writer.buffer, 0, 1)[0] = SNAPSHOT_VERSION + 1;

    expect(() => decodeSnapshot(writer.buffer)).toThrow(SnapshotVersionError);
    try {
      decodeSnapshot(writer.buffer);
    } catch (error) {
      expect((error as Error).message).toContain(String(SNAPSHOT_VERSION + 1));
      expect((error as Error).message).toContain('cannot be read by this build');
    }
  });

  it('rejects a truncated buffer', () => {
    expect(() => decodeSnapshot(new ArrayBuffer(8))).toThrow(RangeError);

    const writer = createSnapshotWriter(4, 1, 0);
    const truncated = writer.buffer.slice(0, writer.buffer.byteLength - 8);
    new Uint32Array(truncated, 0, 4)[2] = 4;
    expect(() => decodeSnapshot(truncated)).toThrow(RangeError);
  });

  it('quantises facing finely enough to interpolate', () => {
    for (let i = 0; i < 360; i++) {
      const radians = (i / 360) * Math.PI * 2;
      const restored = decodeFacing(encodeFacing(radians));
      let delta = restored - radians;
      delta -= Math.floor(delta / (Math.PI * 2) + 0.5) * (Math.PI * 2);
      // 256 steps over the circle: under 0.75 degrees of error.
      expect(Math.abs(delta)).toBeLessThan(0.0123);
    }
  });

  it('wraps negative and large angles', () => {
    expect(encodeFacing(-0.0001)).toBeGreaterThanOrEqual(0);
    expect(encodeFacing(-0.0001)).toBeLessThan(256);
    expect(encodeFacing(Math.PI * 20)).toBeGreaterThanOrEqual(0);
    expect(encodeFacing(Math.PI * 20)).toBeLessThan(256);
  });

  it('clamps hp percentage', () => {
    expect(encodeHpPct(100, 100)).toBe(255);
    expect(encodeHpPct(0, 100)).toBe(0);
    expect(encodeHpPct(50, 100)).toBe(128);
    expect(encodeHpPct(-5, 100)).toBe(0);
    expect(encodeHpPct(200, 100)).toBe(255);
    expect(encodeHpPct(5, 0)).toBe(0);
  });
});

describe('buildSnapshot', () => {
  it('carries only living entities, with their handles', () => {
    const world = createWorld(16, 1);
    const a = spawn(world, 3, 4, 1);
    const b = spawn(world, -2, 9, 2);
    world.tick = 42;

    const view = decodeSnapshot(buildSnapshot(world, 0));
    expect(view.tick).toBe(42);
    expect(view.count).toBe(2);
    expect(Array.from(view.handle)).toEqual([a, b]);
    expect(view.x[0]).toBeCloseTo(3, 5);
    expect(view.y[1]).toBeCloseTo(9, 5);
    expect(view.faction[1]).toBe(2);
    expect(view.hpPct[0]).toBe(255);
  });

  it('takes a viewerId from the start, so fog of war does not change the signature', () => {
    const world = createWorld(4, 1);
    spawn(world, 0, 0, 0);
    expect(decodeSnapshot(buildSnapshot(world, 3)).viewerId).toBe(3);
  });

  it('reflects an order in the movement state it sends', () => {
    const { world, movement } = makeSim(4);
    const handle = spawn(world, 1, 1, 0);
    movement.order(world, handle, 10, 1);
    const view = decodeSnapshot(buildSnapshot(world, 0));
    expect(view.count).toBe(1);
    expect(view.animState[0]).toBe(0); // still idle until the next tick runs
  });
});
