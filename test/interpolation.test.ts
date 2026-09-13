import { describe, expect, it } from 'vitest';
import { createInterpolator, INTERPOLATION_DELAY_TICKS } from '../src/render/interpolation.js';
import { createSnapshotWriter, encodeFacing } from '../src/shared/snapshot.js';
import { TICK_MS } from '../src/shared/timing.js';
import { createLoop, step } from '../src/sim/loop.js';
import { buildSnapshot } from '../src/sim/snapshot.js';
import { createWorld, orderMove, spawn } from '../src/sim/world.js';

const FRAME_MS = 1000 / 60;

/** One entity, at a position and facing, as a snapshot buffer. */
function snapshotOf(tick: number, x: number, y: number, facing = 0, handle = 1): ArrayBuffer {
  const writer = createSnapshotWriter(1, tick, 0);
  writer.handle[0] = handle;
  writer.x[0] = x;
  writer.y[0] = y;
  writer.facing[0] = encodeFacing(facing);
  writer.animStartTick[0] = 0;
  return writer.buffer;
}

describe('extrapolation guard', () => {
  // The guard the whole design rests on. Extrapolating past the newest snapshot makes a
  // unit that stops overshoot and spring back, which is what rubber-banding is.
  it('never renders a decelerating unit past its target', () => {
    const world = createWorld(8, 1);
    const handle = spawn(world, 0, 0, 0);
    orderMove(world, handle, 10, 0);

    const loop = createLoop(world);
    const interpolator = createInterpolator();

    let maxRenderedX = -Infinity;

    for (let tick = 0; tick < 200; tick++) {
      step(loop);
      interpolator.push(buildSnapshot(world, 0));

      // Several render frames per simulation tick.
      for (let frame = 0; frame < 3; frame++) {
        const view = interpolator.sample(TICK_MS / 3);
        if (view === null || view.count === 0) continue;
        maxRenderedX = Math.max(maxRenderedX, view.x[0]!);
      }
    }

    expect(world.posX[0]).toBeCloseTo(10, 6);
    // A tiny epsilon covers f32 quantisation in the snapshot, nothing more.
    expect(maxRenderedX).toBeLessThanOrEqual(10 + 1e-4);
  });

  it('clamps the blend rather than running past the newest snapshot', () => {
    const interpolator = createInterpolator();
    interpolator.push(snapshotOf(10, 0, 0));
    interpolator.push(snapshotOf(11, 1, 0));

    // Starve it of new snapshots and keep rendering.
    let last = 0;
    for (let frame = 0; frame < 120; frame++) {
      const view = interpolator.sample(FRAME_MS);
      last = view!.x[0]!;
      expect(last).toBeLessThanOrEqual(1 + 1e-6);
    }
    expect(last).toBeCloseTo(1, 5);
  });
});

describe('render clock', () => {
  it('turns jittery snapshot arrivals into smooth motion', () => {
    // Constant-velocity entity, snapshots produced on a regular tick schedule but
    // *delivered* with jitter, as GC and scheduling do in practice.
    const interpolator = createInterpolator();
    const speed = 2; // units per tick

    const arrivals: { atMs: number; buffer: ArrayBuffer }[] = [];
    const jitter = [0, 9, -6, 14, -3, 7, -11, 2, 5, -8];
    for (let tick = 0; tick <= 60; tick++) {
      arrivals.push({
        atMs: tick * TICK_MS + (jitter[tick % jitter.length] ?? 0),
        buffer: snapshotOf(tick, tick * speed, 0),
      });
    }

    const rendered: number[] = [];
    let clock = 0;
    let next = 0;

    for (let frame = 0; frame < 180; frame++) {
      clock += FRAME_MS;
      while (next < arrivals.length && arrivals[next]!.atMs <= clock) {
        interpolator.push(arrivals[next]!.buffer);
        next++;
      }
      const view = interpolator.sample(FRAME_MS);
      if (view !== null && view.count > 0) rendered.push(view.x[0]!);
    }

    expect(rendered.length).toBeGreaterThan(100);

    // Motion must never reverse, and per-frame steps must not spike. At 2 units/tick
    // and 60fps the expected step is about 0.67; the clock correction is bounded, so
    // nothing should come near double that.
    const expectedStep = (speed * FRAME_MS) / TICK_MS;
    for (let i = 1; i < rendered.length; i++) {
      const delta = rendered[i]! - rendered[i - 1]!;
      expect(delta).toBeGreaterThanOrEqual(-1e-6);
      expect(delta).toBeLessThan(expectedStep * 2);
    }
  });

  it('renders behind the newest tick by the interpolation delay', () => {
    const interpolator = createInterpolator();
    interpolator.push(snapshotOf(100, 0, 0));
    interpolator.sample(FRAME_MS);
    // Within a frame's advance of the target: the clock steps forward first, then eases.
    expect(interpolator.renderTick).toBeGreaterThan(100 - INTERPOLATION_DELAY_TICKS - 0.01);
    expect(interpolator.renderTick).toBeLessThan(100 - INTERPOLATION_DELAY_TICKS + 0.5);
  });

  it('eases small drift instead of snapping', () => {
    const interpolator = createInterpolator();
    interpolator.push(snapshotOf(0, 0, 0));
    interpolator.sample(FRAME_MS);

    // Jump the source forward by 3 ticks while the render clock stays put.
    interpolator.push(snapshotOf(3, 0, 0));
    const before = interpolator.renderTick;
    interpolator.sample(FRAME_MS);
    const step = interpolator.renderTick - before;

    // One frame of real time plus at most one bounded correction — not a 3-tick jump.
    expect(step).toBeLessThan(FRAME_MS / TICK_MS + 1 / TICK_MS + 1e-9);
    expect(interpolator.resyncs).toBe(0);
  });

  it('resyncs rather than crawling after a long stall', () => {
    const interpolator = createInterpolator();
    interpolator.push(snapshotOf(0, 0, 0));
    interpolator.sample(FRAME_MS);

    // As if the tab were backgrounded for a minute.
    interpolator.push(snapshotOf(1200, 0, 0));
    interpolator.sample(FRAME_MS);

    expect(interpolator.resyncs).toBe(1);
    expect(interpolator.renderTick).toBeCloseTo(1200 - INTERPOLATION_DELAY_TICKS, 3);
  });
});

describe('facing', () => {
  it('takes the shortest arc across the wrap instead of spinning', () => {
    const interpolator = createInterpolator();
    const nearTwoPi = Math.PI * 2 - 0.1;
    interpolator.push(snapshotOf(0, 0, 0, nearTwoPi));
    interpolator.push(snapshotOf(1, 0, 0, 0.1));

    let maxExcursion = 0;
    for (let frame = 0; frame < 60; frame++) {
      const view = interpolator.sample(FRAME_MS);
      const facing = view!.facing[0]!;
      // Distance from the short path, which stays within 0.1 of the wrap point.
      let offset = facing - Math.PI * 2;
      offset -= Math.floor(offset / (Math.PI * 2) + 0.5) * (Math.PI * 2);
      maxExcursion = Math.max(maxExcursion, Math.abs(offset));
    }
    // Spinning the long way round would pass through PI.
    expect(maxExcursion).toBeLessThan(0.2);
  });
});

describe('entity lifecycle across snapshots', () => {
  it('renders a newly spawned entity at its own position, not blended from nothing', () => {
    const interpolator = createInterpolator();
    interpolator.push(snapshotOf(0, 0, 0, 0, 1));

    const writer = createSnapshotWriter(2, 1, 0);
    writer.handle[0] = 1;
    writer.x[0] = 1;
    writer.handle[1] = 99;
    writer.x[1] = 50;
    interpolator.push(writer.buffer);

    const view = interpolator.sample(FRAME_MS)!;
    expect(view.count).toBe(2);
    const spawned = view.handle.indexOf(99);
    expect(view.x[spawned]).toBeCloseTo(50, 5);
  });

  it('drops an entity once it leaves the snapshot', () => {
    const interpolator = createInterpolator();
    const writer = createSnapshotWriter(2, 0, 0);
    writer.handle[0] = 1;
    writer.handle[1] = 2;
    interpolator.push(writer.buffer);
    interpolator.push(snapshotOf(1, 0, 0, 0, 1));

    const view = interpolator.sample(FRAME_MS)!;
    expect(view.count).toBe(1);
    expect(view.handle[0]).toBe(1);
  });

  it('ignores an out-of-order snapshot', () => {
    const interpolator = createInterpolator();
    interpolator.push(snapshotOf(10, 10, 0));
    interpolator.push(snapshotOf(11, 11, 0));
    interpolator.push(snapshotOf(5, 999, 0));

    for (let frame = 0; frame < 30; frame++) {
      const view = interpolator.sample(FRAME_MS)!;
      expect(view.x[0]).toBeLessThanOrEqual(11 + 1e-6);
    }
  });

  it('reports animation phase in ticks since the animation began', () => {
    const interpolator = createInterpolator();
    const writer = createSnapshotWriter(1, 100, 0);
    writer.handle[0] = 1;
    writer.animStartTick[0] = 90;
    interpolator.push(writer.buffer);

    const view = interpolator.sample(FRAME_MS)!;
    // Rendering ~1.5 ticks behind tick 100, so ~8.5 ticks since the animation started.
    expect(view.animPhase[0]).toBeGreaterThan(8.4);
    expect(view.animPhase[0]).toBeLessThan(9.1);
  });
});
