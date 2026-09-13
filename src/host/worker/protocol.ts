import type { CommandKind } from '../../sim/commands.js';
import type { SimEvent } from '../../shared/events.js';
import type { FactionId } from '../../shared/factions/index.js';
import type { PlayerState } from '../directHost.js';

/**
 * Messages between the main thread and the simulation worker.
 *
 * Note what `Init` does NOT contain: the map. Terrain generation is deterministic from a
 * seed, so both sides build the same heightmap independently rather than transferring
 * 16KB and trusting it to match. That is the determinism work from Phase 0 paying a
 * dividend it was not designed for.
 */

export interface InitMessage {
  readonly type: 'init';
  readonly mapSize: number;
  readonly mapSeed: number;
  readonly worldSeed: number;
  readonly capacity: number;
  readonly viewerId: number;
  readonly playerId: number;
  readonly factions: readonly FactionId[];
  readonly aiPlayers: readonly number[];
}

export interface CommandMessage {
  readonly type: 'command';
  readonly kind: CommandKind;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

export interface AckMessage {
  readonly type: 'ack';
  readonly tick: number;
}

export interface StopMessage {
  readonly type: 'stop';
}

export type ToWorker = InitMessage | CommandMessage | AckMessage | StopMessage;

export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly tick: number;
  readonly snapshot: ArrayBuffer;
  readonly events: readonly SimEvent[];
  readonly droppedEvents: number;
  readonly player: PlayerState;
  readonly fog: Uint8Array | null;
}

export type FromWorker = SnapshotMessage;
