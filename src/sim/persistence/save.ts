import type { Command } from '../commands.js';
import type { SimLoop } from '../loop.js';
import { worldStateField, worldStateFields } from '../world.js';

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
 *
 * 5 adds the standing ties' pending offers, which became state when a tie started
 * needing both sides to ask for it.
 *
 * 3 adds the standing ties (src/sim/alliance.ts). A version 2 save has no record of who
 * was allied with whom or what the neighbours made of anyone, and restoring it would
 * silently dissolve every tie and reset every reputation, so it is refused too.
 *
 * 4 is Phase V6 retiring combat: five world arrays went (stance, both post coordinates,
 * attackTarget, attackCooldown) and the ledger lost its ammunition column, so a version
 * 3 save is the wrong length in two places at once. `fromBase64` would catch that as a
 * RangeError, which is a worse way to find out than being told the save is too old.
 */
/*
 * 6 adds the fields, the woodland, the census and which villages are off the map — the
 * state a builder game is made of (ADR-0020), none of which lives in the world arrays,
 * all of which a version 5 save silently dropped while only tests ever called this.
 */
export const SAVE_VERSION = 6;

export interface SaveGame {
  readonly version: number;
  readonly tick: number;
  readonly world: Readonly<Record<string, string>>;
  readonly worldScalars: { liveCount: number; freeCount: number; pendingDestroyCount: number };
  readonly economy: string;
  readonly economyScalars: { upkeepCount: number };
  readonly economyShortfall: string;
  /**
   * Grain in the pits. Simulation state, so it has to come back with the rest of it —
   * a village reloaded without its reserve has had a season's foresight deleted.
   *
   * Optional on the way IN so a save written before pits existed still loads, and
   * always written on the way out.
   */
  readonly economyReserve?: string;
  /**
   * What each village is eating. Optional on the way in, like the reserve beside it,
   * so a save written before rationing existed loads as a village on full commons —
   * which is what it was.
   */
  readonly economyRation?: string;
  /** Who is tied to whom, and what each village thinks of the others. */
  readonly allianceBond: string;
  readonly allianceStanding: string;
  readonly allianceOffered: string;
  readonly allianceVersion: number;
  readonly fog: string;
  readonly fogVersion: number;
  readonly techStatus: string;
  readonly techProgress: string;
  /** The fields: every array, and how many slots are in use. */
  readonly farmland: { readonly count: number; readonly arrays: Readonly<Record<string, string>> };
  /** The standing wood, the same way. */
  readonly woodland: { readonly count: number; readonly arrays: Readonly<Record<string, string>> };
  readonly censusEmptied: string;
  readonly censusGrace: string;
  /** Which villages live off the map (ADR-0021). */
  readonly economyOffMap: string;
  /**
   * Last season's harvest, upkeep and what the land feeds. Readings, but read back by
   * the simulation too — the autoplayer decides whether to raise a household on `feeds`
   * — and by the HUD, which otherwise shows nothing until the next season comes round.
   */
  readonly economyHarvested: string;
  readonly economyUpkeep: string;
  readonly economyFeeds: string;
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

/**
 * The fields' and the wood's state arrays, by name. Listed rather than derived, unlike
 * the world's, because both structures also hold readings (hands wanted and present)
 * and a capacity that are not state — and the save test pins every one of these.
 */
const FARMLAND_ARRAYS = ['tileX', 'tileY', 'owner', 'sheltered', 'work', 'condition', 'alive', 'fallow'] as const;
const WOODLAND_ARRAYS = ['x', 'y', 'species', 'age', 'fruit', 'alive'] as const;

function encodeArrays(source: object, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) out[name] = toBase64((source as Record<string, ArrayBufferView>)[name]!);
  return out;
}

function decodeArrays(encoded: Readonly<Record<string, string>>, target: object, names: readonly string[]): void {
  for (const name of names) {
    const text = encoded[name];
    if (text === undefined) throw new RangeError(`save is missing field "${name}"`);
    fromBase64(text, (target as Record<string, ArrayBufferView>)[name]!);
  }
}

export function captureState(loop: SimLoop): SaveGame {
  const { world, economy, fog, movement, alliance } = loop;

  const fields: Record<string, string> = {};
  for (const name of worldStateFields(world)) {
    fields[name] = toBase64(worldStateField(world, name));
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
    economyReserve: toBase64(economy.reserve),
    economyRation: toBase64(economy.ration),
    allianceBond: toBase64(alliance.bond),
    allianceStanding: toBase64(alliance.standing),
    allianceOffered: toBase64(alliance.offered),
    allianceVersion: alliance.version,
    fog: toBase64(fog.tiles),
    fogVersion: fog.version,
    techStatus: toBase64(loop.tech.status),
    techProgress: toBase64(loop.tech.progress),
    farmland: { count: loop.farmland.count, arrays: encodeArrays(loop.farmland, FARMLAND_ARRAYS) },
    woodland: { count: loop.woodland.count, arrays: encodeArrays(loop.woodland, WOODLAND_ARRAYS) },
    censusEmptied: toBase64(loop.census.emptied),
    censusGrace: toBase64(loop.census.graceTicks),
    economyOffMap: toBase64(economy.offMap),
    economyHarvested: toBase64(economy.harvested),
    economyUpkeep: toBase64(economy.upkeep),
    economyFeeds: toBase64(economy.feeds),
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

  const { world, economy, fog, movement, alliance } = loop;

  for (const name of worldStateFields(world)) {
    const encoded = save.world[name];
    if (encoded === undefined) throw new RangeError(`save is missing world field "${name}"`);
    fromBase64(encoded, worldStateField(world, name));
  }
  fromBase64(save.world.rng!, world.rng.state);

  world.tick = save.tick;
  world.liveCount = save.worldScalars.liveCount;
  world.freeCount = save.worldScalars.freeCount;
  world.pendingDestroyCount = save.worldScalars.pendingDestroyCount;

  fromBase64(save.economy, economy.amounts);
  fromBase64(save.economyShortfall, economy.shortfall);
  // A save from before the pits existed has none, which is the same as empty ones.
  if (save.economyReserve === undefined) economy.reserve.fill(0);
  else fromBase64(save.economyReserve, economy.reserve);
  if (save.economyRation === undefined) economy.ration.fill(0);
  else fromBase64(save.economyRation, economy.ration);
  economy.upkeepCount = save.economyScalars.upkeepCount;

  fromBase64(save.allianceBond, alliance.bond);
  fromBase64(save.allianceStanding, alliance.standing);
  fromBase64(save.allianceOffered, alliance.offered);
  alliance.version = save.allianceVersion;

  fromBase64(save.fog, fog.tiles);
  fog.version = save.fogVersion;

  fromBase64(save.techStatus, loop.tech.status);
  fromBase64(save.techProgress, loop.tech.progress);
  // Multipliers are derived from status, so they are recomputed rather than stored —
  // one source of truth survives the round trip, two would be free to disagree.
  loop.tech.rebuild();

  decodeArrays(save.farmland.arrays, loop.farmland, FARMLAND_ARRAYS);
  loop.farmland.count = save.farmland.count;
  loop.farmland.version++;
  decodeArrays(save.woodland.arrays, loop.woodland, WOODLAND_ARRAYS);
  loop.woodland.count = save.woodland.count;
  loop.woodland.version++;
  fromBase64(save.censusEmptied, loop.census.emptied);
  fromBase64(save.censusGrace, loop.census.graceTicks);
  fromBase64(save.economyOffMap, economy.offMap);
  fromBase64(save.economyHarvested, economy.harvested);
  fromBase64(save.economyUpkeep, economy.upkeep);
  fromBase64(save.economyFeeds, economy.feeds);

  // The ground under every building, which lives in the pathing layers rather than in
  // any array a save copies. Without it the buildings come back and their footprints do
  // not, and people walk through huts.
  loop.construction.restoreFootprints(world);

  movement.importPaths(save.paths);

  loop.pending.length = 0;
  for (const command of save.commands) loop.pending.push(command);
  loop.cursor = save.commandCursor;
  loop.dirty = true;
  loop.lateCommands = 0;
  loop.events.length = 0;
}
