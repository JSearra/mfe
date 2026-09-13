import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import { Modifier, TECHS, TECH_IDS, type TechId } from '../shared/tech/index.js';
import { Resource, type Economy } from './economy/ledger.js';

/**
 * Per-player research.
 *
 * The modifiers are read by combat, vision, movement and the herd, so this is the one
 * place in the simulation where a number used by a system is not simply the tuning value.
 * `modifier()` returns 1 for anything unresearched, which means a system that forgets to
 * consult it behaves exactly as it did before — the failure mode is "the upgrade does
 * nothing", not "the simulation breaks".
 *
 * State is a flat typed array per player so it saves and hashes like everything else.
 */

const TECH_COUNT = TECH_IDS.length;

export interface TechState {
  readonly players: number;
  /** players x techs: 0 unresearched, 1 in progress, 2 complete. */
  readonly status: Uint8Array;
  /** Ticks of research accumulated, players x techs. */
  readonly progress: Float64Array;
  /** Cached multipliers, players x modifier count. Recomputed on completion. */
  readonly multipliers: Float64Array;

  index(id: TechId): number;
  isComplete(player: number, id: TechId): boolean;
  canResearch(player: number, id: TechId): boolean;
  begin(player: number, id: TechId, economy: Economy): boolean;
  modifier(player: number, modifier: Modifier): number;
  update(tick: number, events: SimEvent[]): void;
  /** Recompute every player's multipliers from status. Used after loading a save. */
  rebuild(): void;
}

const MODIFIERS: readonly Modifier[] = Object.values(Modifier);

export function createTechState(players: number): TechState {
  const status = new Uint8Array(players * TECH_COUNT);
  const progress = new Float64Array(players * TECH_COUNT);
  const multipliers = new Float64Array(players * MODIFIERS.length).fill(1);

  const indexOf = (id: TechId): number => TECH_IDS.indexOf(id);

  function recompute(player: number): void {
    for (let m = 0; m < MODIFIERS.length; m++) multipliers[player * MODIFIERS.length + m] = 1;

    for (let t = 0; t < TECH_COUNT; t++) {
      if (status[player * TECH_COUNT + t] !== 2) continue;
      const spec = TECHS[TECH_IDS[t]!]!;
      for (const [key, value] of Object.entries(spec.effects)) {
        const slot = MODIFIERS.indexOf(key as Modifier);
        if (slot === -1) continue;
        // Multiplicative, so two advances touching the same number compound rather than
        // the later one silently replacing the earlier.
        multipliers[player * MODIFIERS.length + slot]! *= value;
      }
    }
  }

  const state: TechState = {
    players,
    status,
    progress,
    multipliers,

    index: indexOf,

    isComplete(player, id) {
      return status[player * TECH_COUNT + indexOf(id)] === 2;
    },

    canResearch(player, id) {
      const at = player * TECH_COUNT + indexOf(id);
      if (status[at] !== 0) return false;
      return TECHS[id].requires.every((requirement) => state.isComplete(player, requirement));
    },

    begin(player, id, economy) {
      if (!state.canResearch(player, id)) return false;
      const spec = TECHS[id];
      if (
        economy.balance(player, Resource.Grain) < spec.grainCost ||
        economy.balance(player, Resource.Cattle) < spec.cattleCost
      ) {
        return false;
      }

      economy.spend(player, Resource.Grain, spec.grainCost);
      economy.spend(player, Resource.Cattle, spec.cattleCost);
      status[player * TECH_COUNT + indexOf(id)] = 1;
      return true;
    },

    modifier(player, modifier) {
      const slot = MODIFIERS.indexOf(modifier);
      if (slot === -1 || player >= players) return 1;
      return multipliers[player * MODIFIERS.length + slot] ?? 1;
    },

    rebuild() {
      for (let player = 0; player < players; player++) recompute(player);
    },

    update(tick, events) {
      for (let player = 0; player < players; player++) {
        for (let t = 0; t < TECH_COUNT; t++) {
          const at = player * TECH_COUNT + t;
          if (status[at] !== 1) continue;

          progress[at]!++;
          const spec = TECHS[TECH_IDS[t]!]!;
          if (progress[at]! < spec.researchTicks) continue;

          status[at] = 2;
          recompute(player);
          events.push(makeEvent(tick, EventType.TechCompleted, 0, 0, 0, t));
        }
      }
    },
  };

  return state;
}
