import type { CommandKind } from '../../sim/commands.js';
import type { SimEvent } from '../../shared/events.js';
import type { FactionId } from '../../shared/factions/index.js';
import type { MapScript } from '../../sim/terrain/maps.js';
import type { PlayerState } from '../directHost.js';
import type { SaveGame } from '../../sim/persistence/save.js';

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
  /** Named landscape, or null for generic savanna. */
  readonly mapScript: MapScript | null;
  readonly worldSeed: number;
  readonly capacity: number;
  readonly viewerId: number;
  readonly playerId: number;
  readonly factions: readonly FactionId[];
  readonly aiPlayers: readonly number[];
  /** Villages kept off the map (ADR-0021). */
  readonly neighbours: readonly number[];
  readonly starts: readonly { readonly x: number; readonly y: number }[];
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

/**
 * How fast real time is fed to the simulation. 0 pauses, 1 is real time.
 *
 * Crosses the boundary because the worker owns its own clock. The tick stays a fixed
 * 50ms on both sides of the wire — this changes how many ticks a second buys, never
 * what a tick computes.
 */
export interface SpeedMessage {
  readonly type: 'speed';
  readonly speed: number;
}

/** Ask for the simulation as a save. Answered by a SavedMessage with the same id. */
export interface SaveRequestMessage {
  readonly type: 'save';
  readonly id: number;
}

/** Replace the simulation's state with a save, straight after init. */
export interface RestoreMessage {
  readonly type: 'restore';
  readonly save: SaveGame;
}

export type ToWorker =
  | InitMessage
  | CommandMessage
  | AckMessage
  | StopMessage
  | SpeedMessage
  | SaveRequestMessage
  | RestoreMessage;

export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly tick: number;
  readonly snapshot: ArrayBuffer;
  readonly events: readonly SimEvent[];
  readonly droppedEvents: number;
  readonly player: PlayerState;
  readonly fog: Uint8Array | null;
  /** The standing wood, or null when unchanged. See SimMessage. */
  readonly woodland: Float32Array | null;
  /** The fields, or null when unchanged. See SimMessage. */
  readonly farmland: Float32Array | null;
}

export interface SavedMessage {
  readonly type: 'saved';
  readonly id: number;
  readonly save: SaveGame;
}

export type FromWorker = SnapshotMessage | SavedMessage;
