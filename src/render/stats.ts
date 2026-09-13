/**
 * Render statistics for the debug overlay and the performance gate.
 *
 * Two things here are deliberate and easy to get wrong.
 *
 * 1. Draw calls are counted by patching the WebGL context *prototypes*, not an
 *    instance. Pixi v8 exposes no public per-frame counter and no stable public
 *    handle on its GL context, and the number matters: the budget in
 *    ARCHITECTURE.md section 4 is stated in draw calls because batch breaks, not GC,
 *    dominate frame cost in a sorted isometric scene.
 *
 * 2. Frame *interval* and frame *cost* are tracked separately. Under vsync the
 *    interval is pinned near 16.67ms no matter how little work the frame did, so an
 *    interval-based budget measures the display, not the renderer. Interval is used
 *    only to count dropped frames; cost is what carries the headroom budget.
 *
 * Debug-only. Nothing here runs in the simulation.
 */

const FRAME_WINDOW = 600;

/** An interval beyond this means the frame missed its vsync slot. */
const DROPPED_FRAME_MS = 25;

export interface RenderStats {
  /** Draw calls issued during the most recently completed frame. */
  drawCalls: number;
  /** 99th percentile of per-frame CPU cost, ms, over a rolling 600-frame window. */
  p99(): number;
  /** 99th percentile of frame interval, ms. Reflects vsync, not work done. */
  p99Interval(): number;
  droppedFrames: number;
  longTasks: number;
  /** CPU cost of the most recently completed frame, ms. */
  lastCpuMs: number;
  beginFrame(): void;
  endFrame(intervalMs: number, cpuMs: number): void;
  reset(): void;
}

const DRAW_METHODS = [
  'drawArrays',
  'drawElements',
  'drawArraysInstanced',
  'drawElementsInstanced',
] as const;

let liveCounter = { calls: 0 };
let patched = false;

/** Patch once, globally. Repeated calls reuse the same counter. */
function patchDrawCounting(): void {
  if (patched) return;
  patched = true;

  const prototypes = [
    typeof WebGL2RenderingContext === 'undefined' ? null : WebGL2RenderingContext.prototype,
    typeof WebGLRenderingContext === 'undefined' ? null : WebGLRenderingContext.prototype,
  ];

  for (const prototype of prototypes) {
    if (prototype === null) continue;
    const holder = prototype as unknown as Record<string, unknown>;

    for (const method of DRAW_METHODS) {
      const original = holder[method];
      if (typeof original !== 'function') continue;
      const wrapped = original as (...args: unknown[]) => void;
      holder[method] = function patchedDraw(this: unknown, ...args: unknown[]): void {
        liveCounter.calls++;
        wrapped.apply(this, args);
      };
    }
  }
}

function percentile(samples: Float32Array, count: number, fraction: number): number {
  if (count === 0) return 0;
  const sorted = Float32Array.prototype.slice.call(samples, 0, count).sort();
  return sorted[Math.min(count - 1, Math.floor(count * fraction))] ?? 0;
}

export function createRenderStats(): RenderStats {
  patchDrawCounting();
  liveCounter = { calls: 0 };

  const cost = new Float32Array(FRAME_WINDOW);
  const interval = new Float32Array(FRAME_WINDOW);
  let frameCount = 0;
  let writeIndex = 0;

  const stats: RenderStats = {
    drawCalls: 0,
    droppedFrames: 0,
    longTasks: 0,
    lastCpuMs: 0,
    p99: () => percentile(cost, Math.min(frameCount, FRAME_WINDOW), 0.99),
    p99Interval: () => percentile(interval, Math.min(frameCount, FRAME_WINDOW), 0.99),

    beginFrame(): void {
      liveCounter.calls = 0;
    },

    endFrame(intervalMs: number, cpuMs: number): void {
      stats.drawCalls = liveCounter.calls;
      stats.lastCpuMs = cpuMs;

      cost[writeIndex] = cpuMs;
      interval[writeIndex] = intervalMs;
      writeIndex = (writeIndex + 1) % FRAME_WINDOW;
      frameCount++;

      if (intervalMs > DROPPED_FRAME_MS) stats.droppedFrames++;
      if (cpuMs > 50) stats.longTasks++;
    },

    reset(): void {
      frameCount = 0;
      writeIndex = 0;
      stats.droppedFrames = 0;
      stats.longTasks = 0;
    },
  };

  return stats;
}
