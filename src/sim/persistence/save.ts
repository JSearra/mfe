import type { Command } from '../commands.js';
import type { SimLoop } from '../loop.js';

/**
 * Saving and restoring a game in progress.
 *
 * ARCHITECTURE section 6 calls this the same problem as determinism, and it is: if every
 * piece of mutable state lives in a typed array or a serialisable structure, a save is a
 * copy of those; if state has leaked into closures or object graphs, it is a rewrite.
 *
 * That claim is checkable rather than hopeful. The round-trip test saves a running game,
 * restores it into a *fresh* simulation, and runs both forward comparing state hashes.
 * Anything the save missed shows up as divergence within a few hundred ticks — which is
 * the only way to find out that, say, the RNG state or a unit's path cursor was left
 * behind.
 */

export const SAVE_VERSION = 1;

export interface SaveGame {
  readonly version: number;
  readonly tick: number;
  readonly world: Readonly<Record<string, string>>;
  readonly worldScalars: { liveCount: number; freeCount: number; pendingDestroyCount: number };
  readonly economy: string;
  readonly economyScalars: { upkeepCount: number };
  readonly economyShortfall: string;
  readonly fog: string;
  readonly fogVersion: number;
  readonly techStatus: string;
  readonly techProgress: string;
  /** Per-unit routes, keyed by packed handle. */
  readonly paths: readonly (readonly [number, readonly number[]])[];
  readonly commands: readonly Command[];
  readonly commandCursor: number;
}

/** Typed array fields of the world that make up its state. */
const WORLD_FIELDS = [
  'alive',
  'destroyPending',
  'generation',
  'posX',
  'posY',
  'velX',
  'velY',
  'facing',
  'targetX',
  'targetY',
  'hasTarget',
  'faction',
  'hp',
  'animState',
  'animStartTick',
  'flags',
  'movementClass',
  'kind',
  'herdState',
  'stress',
  'tetheredTo',
  'stampedeTicks',
  'prevX',
  'prevY',
  'goalIndex',
  'useFlowField',
  'pathRequest',
  'pathCursor',
  'stuckTicks',
  'lastProgressX',
  'lastProgressY',
  'freeStack',
  'pendingDestroy',
] as const;

function toBase64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = '';
  // Chunked: spreading a large array into String.fromCharCode blows the call stack.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text: string, target: ArrayBufferView): void {
  const binary = atob(text);
  const bytes = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
  if (binary.length !== bytes.length) {
    throw new RangeError(
      `save field is ${binary.length} bytes, expected ${bytes.length} — capacity or schema changed`,
    );
  }
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
}

export function captureState(loop: SimLoop): SaveGame {
  const { world, economy, fog, movement } = loop;

  const fields: Record<string, string> = {};
  for (const name of WORLD_FIELDS) {
    fields[name] = toBase64(world[name]);
  }
  // The RNG is state, not configuration. Leaving it out is the classic save bug: the
  // game reloads and every subsequent random draw differs.
  fields.rng = toBase64(world.rng.state);

  return {
    version: SAVE_VERSION,
    tick: world.tick,
    world: fields,
    worldScalars: {
      liveCount: world.liveCount,
      freeCount: world.freeCount,
      pendingDestroyCount: world.pendingDestroyCount,
    },
    economy: toBase64(economy.amounts),
    economyScalars: { upkeepCount: economy.upkeepCount },
    economyShortfall: toBase64(economy.shortfall),
    fog: toBase64(fog.tiles),
    fogVersion: fog.version,
    techStatus: toBase64(loop.tech.status),
    techProgress: toBase64(loop.tech.progress),
    paths: movement.exportPaths(),
    commands: loop.pending.slice(loop.cursor),
    commandCursor: 0,
  };
}

export class SaveVersionError extends Error {
  constructor(found: number) {
    super(`save version ${found} cannot be read by this build, which writes version ${SAVE_VERSION}`);
    this.name = 'SaveVersionError';
  }
}

export function restoreState(loop: SimLoop, save: SaveGame): void {
  if (save.version !== SAVE_VERSION) throw new SaveVersionError(save.version);

  const { world, economy, fog, movement } = loop;

  for (const name of WORLD_FIELDS) {
    const encoded = save.world[name];
    if (encoded === undefined) throw new RangeError(`save is missing world field "${name}"`);
    fromBase64(encoded, world[name]);
  }
  fromBase64(save.world.rng!, world.rng.state);

  world.tick = save.tick;
  world.liveCount = save.worldScalars.liveCount;
  world.freeCount = save.worldScalars.freeCount;
  world.pendingDestroyCount = save.worldScalars.pendingDestroyCount;

  fromBase64(save.economy, economy.amounts);
  fromBase64(save.economyShortfall, economy.shortfall);
  economy.upkeepCount = save.economyScalars.upkeepCount;

  fromBase64(save.fog, fog.tiles);
  fog.version = save.fogVersion;

  fromBase64(save.techStatus, loop.tech.status);
  fromBase64(save.techProgress, loop.tech.progress);
  // Multipliers are derived from status, so they are recomputed rather than stored —
  // one source of truth survives the round trip, two would be free to disagree.
  loop.tech.rebuild();

  movement.importPaths(save.paths);

  loop.pending.length = 0;
  for (const command of save.commands) loop.pending.push(command);
  loop.cursor = save.commandCursor;
  loop.dirty = true;
  loop.lateCommands = 0;
  loop.events.length = 0;
}
