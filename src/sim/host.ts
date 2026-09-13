import type { Command, CommandKind } from './commands.js';
import { makeCommand } from './commands.js';
import { compactLoop, createLoop, enqueueCommand, step, TICK_MS, type SimLoop } from './loop.js';
import { buildSnapshot } from './snapshot.js';
import type { SimEvent } from '../shared/events.js';
import type { World } from './world.js';

/**
 * The boundary the renderer talks to.
 *
 * Two implementations are planned: this one, running on the main thread, and a worker
 * one later. Development happens against the direct host — see
 * docs/adr/0004-defer-the-simulation-worker.md — because what makes the eventual flip
 * expensive is never the message plumbing. It is the UI quietly accreting synchronous
 * reads of simulation state for hover, minimap, hit-testing and debug overlays.
 *
 * Two mechanisms exist to stop that. The import boundary is enforced by ESLint, and in
 * strict mode this host structuredClones every snapshot that crosses it, so a shared
 * reference into simulation memory fails here and now rather than at flip time.
 *
 * ADR-0004 also called for cloning commands. That turned out to be ceremony: sendCommand
 * accepts only numbers, so a command cannot carry a reference into simulation state in
 * the first place. The type signature enforces statically what the clone would have
 * checked at runtime, which is the stronger guarantee. If a command ever grows a payload
 * richer than a number, restore the clone along with it.
 */

export interface SimMessage {
  readonly snapshot: ArrayBuffer;
  readonly events: readonly SimEvent[];
  /** Non-zero when the consumer stalled long enough to lose events. */
  readonly droppedEvents: number;
}

export interface SimHost {
  readonly tick: number;
  sendCommand(kind: CommandKind, a?: number, b?: number, c?: number, d?: number): void;
  /** Advance by real elapsed time. A worker host will tick itself and ignore this. */
  pump(elapsedMs: number): void;
  /** Take the newest snapshot and the events since the last take, or null if unchanged. */
  receive(): SimMessage | null;
  dispose(): void;
}

export interface DirectSimHostOptions {
  world: World;
  viewerId?: number;
  playerId?: number;
  /**
   * Ticks between issuing a command and executing it. Zero for single-player, where
   * the latency is pure cost. Lockstep needs 3-6 to absorb network jitter; the
   * mechanism is here so enabling it is a constant, not a redesign.
   */
  commandDelayTicks?: number;
  /** structuredClone snapshots crossing the boundary. Defaults to on outside production. */
  strict?: boolean;
  /** Event backlog before the oldest are dropped. Exposed so tests can reach the cap. */
  maxPendingEvents?: number;
}

/** Beyond this the consumer is not keeping up and the oldest events are dropped. */
const DEFAULT_MAX_PENDING_EVENTS = 4096;

/**
 * Cap on catch-up ticks per pump. Without it, a long stall (a breakpoint, a background
 * tab) produces a pump asking for hundreds of ticks, which takes longer than a frame,
 * which makes the next pump larger still.
 */
const MAX_CATCHUP_TICKS = 5;

function defaultStrict(): boolean {
  try {
    return import.meta.env?.DEV !== false;
  } catch {
    return true;
  }
}

export function createDirectSimHost(options: DirectSimHostOptions): SimHost {
  const {
    world,
    viewerId = 0,
    playerId = 0,
    commandDelayTicks = 0,
    strict = defaultStrict(),
    maxPendingEvents = DEFAULT_MAX_PENDING_EVENTS,
  } = options;

  const loop: SimLoop = createLoop(world);
  let accumulator = 0;
  let sequence = 0;

  // Coalesced: only the newest undelivered snapshot is kept. A backgrounded tab stops
  // consuming while the simulation keeps running, and an uncoalesced queue would grow
  // until the tab died.
  let pendingSnapshot: ArrayBuffer | null = null;
  let pendingEvents: SimEvent[] = [];
  let droppedEvents = 0;

  function drainLoopEvents(): void {
    if (loop.events.length === 0) return;

    for (const event of loop.events) {
      if (pendingEvents.length >= maxPendingEvents) {
        pendingEvents.shift();
        droppedEvents++;
      }
      pendingEvents.push(event);
    }
    loop.events.length = 0;
  }

  const host: SimHost = {
    get tick(): number {
      return world.tick;
    },

    sendCommand(kind, a = 0, b = 0, c = 0, d = 0): void {
      const command: Command = makeCommand(
        world.tick + commandDelayTicks,
        playerId,
        sequence++,
        kind,
        a,
        b,
        c,
        d,
      );
      enqueueCommand(loop, command);
    },

    pump(elapsedMs: number): void {
      accumulator += elapsedMs;

      let ticks = 0;
      while (accumulator >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
        step(loop);
        accumulator -= TICK_MS;
        ticks++;
      }
      if (accumulator > TICK_MS * MAX_CATCHUP_TICKS) accumulator = 0;

      if (ticks === 0) return;

      drainLoopEvents();
      compactLoop(loop);
      pendingSnapshot = buildSnapshot(world, viewerId);
    },

    receive(): SimMessage | null {
      if (pendingSnapshot === null) return null;

      const snapshot = strict ? structuredClone(pendingSnapshot) : pendingSnapshot;
      const events = pendingEvents;
      const dropped = droppedEvents;

      pendingSnapshot = null;
      pendingEvents = [];
      droppedEvents = 0;

      return { snapshot, events, droppedEvents: dropped };
    },

    dispose(): void {
      pendingSnapshot = null;
      pendingEvents = [];
    },
  };

  return host;
}
