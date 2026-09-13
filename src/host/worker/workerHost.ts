import type { CommandKind } from '../../sim/commands.js';
import type { SimEvent } from '../../shared/events.js';
import type { FactionId } from '../../shared/factions/index.js';
import type { PlayerState } from '../directHost.js';
import type { SimHost, SimMessage } from '../directHost.js';
import type { FromWorker, ToWorker } from './protocol.js';

/**
 * SimHost backed by a dedicated worker.
 *
 * The flip ADR-0004 said would be cheap if the boundary discipline held. It was: this
 * file is the whole of it, and nothing in src/render changed. What made that possible
 * was never the plumbing — it was that the renderer has only ever read snapshots and
 * events, enforced by lint rather than by intention.
 *
 * `pump` is a no-op. The worker ticks itself on its own clock, so the render loop no
 * longer drives simulation time; that is the one behavioural difference, and it is why
 * pump stayed on the interface rather than being removed.
 */

const IDLE_PLAYER: PlayerState = {
  cattle: 0,
  grain: 0,
  ammunition: 0,
  shortfall: 0,
  drought: 0,
  droughtSevere: false,
};

export interface WorkerSimHostOptions {
  mapSize: number;
  mapSeed: number;
  worldSeed: number;
  capacity: number;
  viewerId?: number;
  playerId?: number;
  factions: readonly FactionId[];
  aiPlayers?: readonly number[];
}

export function createWorkerSimHost(options: WorkerSimHostOptions): SimHost {
  const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });

  let tick = 0;
  // Coalesced on arrival as well as at the source: the worker withholds when unacked
  // snapshots pile up, and anything that still arrives while the renderer is behind
  // replaces rather than queues.
  let pendingSnapshot: ArrayBuffer | null = null;
  let pendingFog: Uint8Array | null = null;
  let pendingPlayer: PlayerState = IDLE_PLAYER;
  let pendingEvents: SimEvent[] = [];
  let droppedEvents = 0;

  worker.onmessage = (event: MessageEvent<FromWorker>): void => {
    const message = event.data;
    if (message.type !== 'snapshot') return;

    tick = message.tick;
    pendingSnapshot = message.snapshot;
    pendingPlayer = message.player;
    // Fog arrives only when it changes, so a newer message with none must not erase a
    // fog we have not handed over yet.
    if (message.fog !== null) pendingFog = message.fog;
    pendingEvents = pendingEvents.concat(message.events);
    droppedEvents += message.droppedEvents;
  };

  const send = (message: ToWorker): void => worker.postMessage(message);

  send({
    type: 'init',
    mapSize: options.mapSize,
    mapSeed: options.mapSeed,
    worldSeed: options.worldSeed,
    capacity: options.capacity,
    viewerId: options.viewerId ?? 0,
    playerId: options.playerId ?? 0,
    factions: options.factions,
    aiPlayers: options.aiPlayers ?? [],
  });

  return {
    get tick(): number {
      return tick;
    },

    sendCommand(kind: CommandKind, a = 0, b = 0, c = 0, d = 0): void {
      send({ type: 'command', kind, a, b, c, d });
    },

    pump(): void {
      // The worker keeps its own time.
    },

    receive(): SimMessage | null {
      if (pendingSnapshot === null) return null;

      const message: SimMessage = {
        snapshot: pendingSnapshot,
        events: pendingEvents,
        droppedEvents,
        player: pendingPlayer,
        fog: pendingFog,
      };

      pendingSnapshot = null;
      pendingFog = null;
      pendingEvents = [];
      droppedEvents = 0;

      // Acknowledge only on consumption. That is what makes the worker's backpressure
      // track the renderer rather than the message queue.
      send({ type: 'ack', tick });
      return message;
    },

    dispose(): void {
      send({ type: 'stop' });
      worker.terminate();
    },
  };
}
