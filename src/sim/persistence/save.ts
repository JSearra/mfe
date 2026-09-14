import type { Command } from '../commands.js';
import type { SimLoop } from '../loop.js';
import type { World } from '../world.js';

/**
 * Saving and restoring a game in progress.
 *
 * ARCHITECTURE section 6 calls this the same problem as determinism, and it is: if every
 * piece of mutable state lives in a typed array or a serialisable structure, a save is a
 * copy of those; if state has leaked into closures or object graphs, it is a rewrite.
 *
 * The round-trip test saves a running game, restores it into a *fresh* simulation, and
 * runs both forward comparing state hashes. That catches a great deal — the RNG state or
 * a unit's path cursor left behind shows up as divergence within a few hundred ticks.
 *
 * It is not the whole guarantee, though it read like one for a long time. `hashWorld`
 * covers ten of the world's fifty-three arrays, so anything outside those ten can go
 * missing from a save and diverge from nothing at all. That is exactly what happened,
 * for nine fields including every building's type. The completeness of a save is pinned
 * by asserting the fields directly, in `test/save.test.ts`; the hash comparison proves
 * the *dynamics* survive, not the inventory.
 */

/**
 * 2 adds the nine world arrays version 1 silently dropped. A version 1 save cannot be
 * restored correctly — it has no building types in it — so it is rejected rather than
 * loaded into a game that would look subtly wrong.
 */
export const SAVE_VERSION = 2;

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

/**
 * Every typed array the world holds, derived from the world itself.
 *
 * This was a hand-written list, and it had drifted nine fields behind the world it
 * describes: buildingType, buildProgress, the three training-queue arrays, both rally
 * coordinates, attackTarget and attackCooldown. A saved game restored with every
 * building reduced to an unfinished site of the wrong type, no production queued and
 * nobody fighting anyone.
 *
 * Nothing caught it because the round-trip test compares `hashWorld`, which covers ten
 * of the world's fifty-three arrays — so a save that dropped all nine diverged from
 * nothing. Two hand-maintained lists of the same thing, neither complete.
 *
 * Deriving it means a field added to the world is saved without anyone remembering to
 * come here. A scratch buffer added to the world would be saved too, which is wasted
 * bytes rather than a wrong answer — the safe direction to err in.
 */
let cachedFields: readonly string[] | null = null;

function worldFields(world: World): readonly string[] {
  // Every world has the same shape, so this is computed once.
  if (cachedFields === null) {
    const all = world as unknown as Record<string, unknown>;
    cachedFields = Object.keys(all)
      .filter((key) => ArrayBuffer.isView(all[key] as object))
      .sort();
  }
  return cachedFields;
}

function fieldOf(world: World, name: string): ArrayBufferView {
  return (world as unknown as Record<string, ArrayBufferView>)[name]!;
}

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
  for (const name of worldFields(world)) {
    fields[name] = toBase64(fieldOf(world, name));
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

  for (const name of worldFields(world)) {
    const encoded = save.world[name];
    if (encoded === undefined) throw new RangeError(`save is missing world field "${name}"`);
    fromBase64(encoded, fieldOf(world, name));
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
