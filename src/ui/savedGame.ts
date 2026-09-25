import type { SaveGame } from '../sim/persistence/save.js';
import type { SetupChoice } from './setup.js';

/**
 * The one saved village, kept in the browser.
 *
 * The game has no end since ADR-0020 — a village is built over many sittings — so it has
 * to survive closing the tab. One slot, because a village is the thing being played and
 * a list of them is a management screen nobody asked for yet.
 *
 * The match's setup travels with the simulation state: restoring needs the same map,
 * peoples and seed the save was taken from, and those are choices, not state.
 *
 * Every access is guarded. Storage can be full, blocked, or absent in a private window,
 * and failing to save must say so rather than throw out of a key handler.
 */

const KEY = 'mfe.village';

export interface StoredGame {
  readonly kind: 'mfe-village';
  readonly options: SetupChoice;
  readonly save: SaveGame;
  /** Wall-clock milliseconds, for telling the player when they last saved. */
  readonly savedAt: number;
}

/** Keep a village. False when the browser refused it. */
export function storeGame(options: SetupChoice, save: SaveGame): boolean {
  const stored: StoredGame = { kind: 'mfe-village', options, save, savedAt: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/** The kept village, or null if there is none or it cannot be read. */
export function loadStoredGame(): StoredGame | null {
  try {
    const text = localStorage.getItem(KEY);
    if (text === null) return null;
    const parsed = JSON.parse(text) as StoredGame;
    return parsed.kind === 'mfe-village' && parsed.save !== undefined ? parsed : null;
  } catch {
    return null;
  }
}
