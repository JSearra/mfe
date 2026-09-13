import { TICK_MS } from '../shared/timing.js';
import { decodeFacing, decodeSnapshot, type SnapshotView } from '../shared/snapshot.js';

/**
 * Renders 20Hz simulation state at display framerate.
 *
 * Four decisions here are load-bearing, and each has a failure mode that looks like a
 * different bug entirely. See docs/ARCHITECTURE.md section 5.
 *
 * 1. Render behind the newest snapshot by 1.5 ticks, and NEVER extrapolate. Blending
 *    between two known states always has both endpoints. Extrapolation guesses past
 *    the newest state, so a unit that stops overshoots its target and is then yanked
 *    back — which is exactly what "rubber-banding" is.
 *
 * 1b. Keep a short history and pick the pair that BRACKETS the render clock, rather
 *    than always blending the two most recent snapshots. Those are the same thing only
 *    while delivery is even. Under jitter, two snapshots can arrive between one pair of
 *    frames, and a two-slot buffer then discards the snapshot currently being blended
 *    from — the rendered position lurches forward by a whole tick of movement. A test
 *    measuring per-frame smoothness catches this; nothing else does.
 *
 * 2. Slave the clock to tick numbers, not to snapshot arrival times. Arrival is jittery
 *    under GC and scheduling; timing from it turns that jitter into visible stutter.
 *
 * 3. Correct clock drift at a clamped rate rather than snapping. A snap teleports every
 *    unit on screen simultaneously.
 *
 * 4. Interpolate facing along the shortest arc, or every unit spins a full revolution
 *    at the 359deg -> 0deg wrap.
 */

/** How far behind the newest snapshot to render. 1.5 ticks is 75ms — imperceptible. */
export const INTERPOLATION_DELAY_TICKS = 1.5;

/** Drift correction ceiling, in ticks per frame. 1ms per frame at 60fps. */
const MAX_DRIFT_CORRECTION = 1 / TICK_MS;

/**
 * Divergence beyond which the clock resyncs instead of easing.
 *
 * Easing never snaps during normal play, which is the point. But a tab resumed after
 * minutes in the background is not jitter, and easing a 10,000-tick gap at 1ms/frame
 * would leave the player watching a slow-motion replay for hours. One second of
 * divergence is far outside anything scheduling noise produces.
 */
const RESYNC_THRESHOLD_TICKS = 20;

const TAU = Math.PI * 2;

export interface InterpolatedView {
  count: number;
  handle: Uint32Array;
  x: Float32Array;
  y: Float32Array;
  /** Radians, shortest-arc blended. */
  facing: Float32Array;
  animState: Uint8Array;
  /** Ticks elapsed since the current animation began, for cycle phase. */
  animPhase: Float32Array;
  faction: Uint8Array;
  hpPct: Uint8Array;
  flags: Uint8Array;
  kind: Uint8Array;
  stressPct: Uint8Array;
  progressPct: Uint8Array;
}

export interface Interpolator {
  push(buffer: ArrayBuffer): void;
  /** Advance the render clock by real elapsed time and blend. Null until data arrives. */
  sample(elapsedMs: number): InterpolatedView | null;
  readonly renderTick: number;
  readonly resyncs: number;
}

function shortestArc(from: number, to: number): number {
  let delta = to - from;
  delta -= Math.floor(delta / TAU + 0.5) * TAU;
  return delta;
}

function grow(view: InterpolatedView, capacity: number): void {
  if (view.handle.length >= capacity) return;
  const size = Math.max(capacity, view.handle.length * 2, 64);
  view.handle = new Uint32Array(size);
  view.x = new Float32Array(size);
  view.y = new Float32Array(size);
  view.facing = new Float32Array(size);
  view.animState = new Uint8Array(size);
  view.animPhase = new Float32Array(size);
  view.faction = new Uint8Array(size);
  view.hpPct = new Uint8Array(size);
  view.flags = new Uint8Array(size);
  view.kind = new Uint8Array(size);
  view.stressPct = new Uint8Array(size);
  view.progressPct = new Uint8Array(size);
}

interface HistoryEntry {
  readonly view: SnapshotView;
  /** handle -> slot. Built on arrival, not per frame. */
  readonly slots: Map<number, number>;
}

/** 400ms of history at 20Hz — far more delivery jitter than anything realistic. */
const HISTORY_CAPACITY = 8;

export function createInterpolator(): Interpolator {
  const history: HistoryEntry[] = [];

  let renderTick = 0;
  let started = false;
  let resyncs = 0;

  const view: InterpolatedView = {
    count: 0,
    handle: new Uint32Array(0),
    x: new Float32Array(0),
    y: new Float32Array(0),
    facing: new Float32Array(0),
    animState: new Uint8Array(0),
    animPhase: new Float32Array(0),
    faction: new Uint8Array(0),
    hpPct: new Uint8Array(0),
    flags: new Uint8Array(0),
    kind: new Uint8Array(0),
    stressPct: new Uint8Array(0),
    progressPct: new Uint8Array(0),
  };

  const interpolator: Interpolator = {
    get renderTick(): number {
      return renderTick;
    },
    get resyncs(): number {
      return resyncs;
    },

    push(buffer: ArrayBuffer): void {
      const decoded = decodeSnapshot(buffer);

      const newest = history[history.length - 1];
      // Out-of-order or duplicate delivery: keep what we have.
      if (newest !== undefined && decoded.tick <= newest.view.tick) return;

      const slots = new Map<number, number>();
      for (let i = 0; i < decoded.count; i++) slots.set(decoded.handle[i]!, i);
      history.push({ view: decoded, slots });

      if (history.length > HISTORY_CAPACITY) history.shift();

      if (!started) {
        renderTick = decoded.tick - INTERPOLATION_DELAY_TICKS;
        started = true;
      }
    },

    sample(elapsedMs: number): InterpolatedView | null {
      const newest = history[history.length - 1];
      if (newest === undefined) return null;

      renderTick += elapsedMs / TICK_MS;

      const target = newest.view.tick - INTERPOLATION_DELAY_TICKS;
      const drift = target - renderTick;

      if (drift > RESYNC_THRESHOLD_TICKS || drift < -RESYNC_THRESHOLD_TICKS) {
        renderTick = target;
        resyncs++;
      } else if (drift > MAX_DRIFT_CORRECTION) {
        renderTick += MAX_DRIFT_CORRECTION;
      } else if (drift < -MAX_DRIFT_CORRECTION) {
        renderTick -= MAX_DRIFT_CORRECTION;
      } else {
        renderTick = target;
      }

      // Pick the pair bracketing the render clock, newest-first so the common case
      // (clock near the newest pair) exits immediately.
      let toIndex = history.length - 1;
      for (let i = history.length - 1; i >= 1; i--) {
        toIndex = i;
        if (history[i - 1]!.view.tick <= renderTick) break;
      }
      const to = history[toIndex]!;
      const from = history[toIndex - 1] ?? to;

      const latest = to.view;
      const previous = from.view;
      const previousSlots = from.slots;

      const count = latest.count;
      grow(view, count);
      view.count = count;

      const span = latest.tick - previous.tick;
      let blend = span <= 0 ? 1 : (renderTick - previous.tick) / span;
      // Clamped, never extended: this is the extrapolation guard.
      if (blend < 0) blend = 0;
      if (blend > 1) blend = 1;

      for (let i = 0; i < count; i++) {
        const handle = latest.handle[i]!;
        view.handle[i] = handle;
        view.animState[i] = latest.animState[i]!;
        view.faction[i] = latest.faction[i]!;
        view.hpPct[i] = latest.hpPct[i]!;
        view.flags[i] = latest.flags[i]!;
        view.kind[i] = latest.kind[i]!;
        view.stressPct[i] = latest.stressPct[i]!;
        view.progressPct[i] = latest.progressPct[i]!;
        view.animPhase[i] = renderTick - latest.animStartTick[i]!;

        const facing = decodeFacing(latest.facing[i]!);
        const slot = previousSlots.get(handle);

        if (slot === undefined) {
          // Spawned since the last snapshot: no history to blend from.
          view.x[i] = latest.x[i]!;
          view.y[i] = latest.y[i]!;
          view.facing[i] = facing;
          continue;
        }

        const fromX = previous.x[slot]!;
        const fromY = previous.y[slot]!;
        view.x[i] = fromX + (latest.x[i]! - fromX) * blend;
        view.y[i] = fromY + (latest.y[i]! - fromY) * blend;

        const fromFacing = decodeFacing(previous.facing[slot]!);
        view.facing[i] = fromFacing + shortestArc(fromFacing, facing) * blend;
      }

      return view;
    },
  };

  return interpolator;
}
