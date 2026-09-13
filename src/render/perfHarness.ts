import type { Application } from 'pixi.js';
import { clampZoom, type Camera } from './camera.js';
import type { RenderStats } from './stats.js';
import type { TerrainRenderer } from './scene/terrain.js';

/**
 * Scripted camera sweep used by `npm run perf:terrain`.
 *
 * Lives in the app rather than in the driving script because it needs the camera and
 * the stats counters. The node script only starts it and reads the result, so the
 * thing being measured is the real render loop, not a reconstruction of it.
 *
 * Installed only when the page is loaded with ?perf, so it costs nothing normally.
 */

export interface PerfResult {
  frames: number;
  /** Main-thread work per frame: our update plus Pixi's render submission. */
  meanCpuMs: number;
  p99CpuMs: number;
  maxCpuMs: number;
  /** Wall time between frames. Pinned near 16.67ms by vsync, so only useful for drops. */
  p99IntervalMs: number;
  droppedFrames: number;
  longTasks: number;
  maxDrawCalls: number;
  maxVisibleChunks: number;
  heapGrowthBytes: number | null;
}

interface PerfApi {
  run(durationMs: number): Promise<PerfResult>;
}

declare global {
  interface Window {
    __perf?: PerfApi;
  }
}

const TAU = Math.PI * 2;

interface MemoryCapable {
  memory?: { usedJSHeapSize: number };
}

function heapUsed(): number | null {
  const memory = (performance as unknown as MemoryCapable).memory;
  return memory ? memory.usedJSHeapSize : null;
}

export function installPerfHarness(
  app: Application,
  camera: Camera,
  stats: RenderStats,
  terrain: TerrainRenderer,
  mapSize: number,
): void {
  window.__perf = {
    run(durationMs: number): Promise<PerfResult> {
      return new Promise<PerfResult>((resolve) => {
        // Sweep the whole map, cycling zoom, so both the culling path and the
        // many-visible-chunks path are exercised.
        const spanX = mapSize * 26;
        const centreY = mapSize * 16;
        const spanY = mapSize * 12;

        let elapsed = 0;
        let frames = 0;
        let totalCpu = 0;
        let maxCpu = 0;
        let maxDrawCalls = 0;
        let maxVisibleChunks = 0;

        stats.reset();
        const heapBefore = heapUsed();

        const sweep = (ticker: { deltaMS: number }): void => {
          elapsed += ticker.deltaMS;
          const t = elapsed / durationMs;

          camera.x = Math.sin(t * TAU * 3) * spanX;
          camera.y = centreY + Math.cos(t * TAU * 2) * spanY;
          camera.zoom = clampZoom(1.25 + Math.sin(t * TAU * 5) * 0.75);

          // Skip the first frames: they carry shader compilation and first upload,
          // which are startup cost rather than steady-state frame cost.
          if (elapsed > 500) {
            frames++;
            const cpu = stats.lastCpuMs;
            totalCpu += cpu;
            if (cpu > maxCpu) maxCpu = cpu;
            if (stats.drawCalls > maxDrawCalls) maxDrawCalls = stats.drawCalls;
            if (terrain.visibleChunks > maxVisibleChunks) maxVisibleChunks = terrain.visibleChunks;
          }

          if (elapsed < durationMs) return;

          app.ticker.remove(sweep);
          const heapAfter = heapUsed();

          resolve({
            frames,
            meanCpuMs: frames === 0 ? 0 : totalCpu / frames,
            p99CpuMs: stats.p99(),
            maxCpuMs: maxCpu,
            p99IntervalMs: stats.p99Interval(),
            droppedFrames: stats.droppedFrames,
            longTasks: stats.longTasks,
            maxDrawCalls,
            maxVisibleChunks,
            heapGrowthBytes:
              heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore,
          });
        };

        app.ticker.add(sweep);
      });
    },
  };
}
