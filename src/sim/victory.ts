import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import type { Economy } from './economy/ledger.js';
import { tuning } from './tuning.js';
import { EntityKind, type World } from './world.js';

/**
 * How a match ends.
 *
 * A village is judged by whether it stands, not by what it has taken. The objective is
 * to settle a given number of households and keep them fed long enough that the village
 * is established rather than briefly crowded — see ADR-0019.
 *
 * This used to be measured in cattle: hold two hundred head and win. That put the herd
 * at the centre of the game, which was right, but it made the herd an end rather than a
 * means, and it meant a village could win by accumulating and never by enduring. Worse,
 * upkeep scales with cattle, so the objective actively worked against the economy that
 * had to sustain it.
 *
 * Holding is still what counts, and for a stronger reason than before. Population is
 * trivially spiked — train until the granary is empty — and a village that doubles in a
 * minute and starves in the next has not settled anything. The hold is what separates a
 * village from a crowd.
 */

export const Outcome = {
  Ongoing: 0,
  /** A village reached its full size and kept it there. */
  Settled: 1,
  /** Everyone else is gone. */
  LastStanding: 2,
} as const;

export type Outcome = (typeof Outcome)[keyof typeof Outcome];

export interface VictoryState {
  readonly players: number;
  outcome: Outcome;
  /** -1 while the match is undecided. */
  winner: number;
  /** Consecutive ticks each player has been at or above the threshold. */
  readonly holdTicks: Float64Array;
  /** Households standing at the last check, for the UI. */
  readonly households: Float64Array;
  readonly eliminated: Uint8Array;
  /** Ticks each player has been without means, before being counted out. */
  readonly graceTicks: Float64Array;

  update(world: World, economy: Economy, events: SimEvent[]): void;
}

export function createVictoryState(players: number): VictoryState {
  const state: VictoryState = {
    players,
    outcome: Outcome.Ongoing,
    winner: -1,
    holdTicks: new Float64Array(players),
    households: new Float64Array(players),
    eliminated: new Uint8Array(players),
    graceTicks: new Float64Array(players),

    update(world, economy, events): void {
      if (state.outcome !== Outcome.Ongoing) return;

      const v = tuning.victory;
      const units = new Float64Array(players);
      const buildings = new Float64Array(players);

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1) continue;
        // Cattle belong to nobody's headcount. They are food and wealth, counted by the
        // ledger and eaten by the upkeep; a village's size is the people in it.
        if (world.kind[index] === EntityKind.Cattle) continue;

        const owner = world.faction[index]!;
        if (owner >= players) continue;
        if (world.kind[index] === EntityKind.Unit) units[owner]!++;
        else if (world.kind[index] === EntityKind.Building) buildings[owner]!++;
      }

      for (let player = 0; player < players; player++) state.households[player] = units[player]!;

      for (let player = 0; player < players; player++) {
        if (state.eliminated[player] === 1) continue;

        // --- elimination ---------------------------------------------------
        // No troops and nothing that could raise any. The grace period covers the gap
        // between a last soldier dying and a homestead finishing a replacement, so a
        // player is not counted out for being briefly empty-handed.
        const helpless = units[player] === 0 && buildings[player] === 0;
        if (helpless) {
          state.graceTicks[player]!++;
          if (state.graceTicks[player]! >= v.eliminationGraceTicks) {
            state.eliminated[player] = 1;
            events.push(makeEvent(world.tick, EventType.PlayerEliminated, 0, 0, 0, player));
          }
        } else {
          state.graceTicks[player] = 0;
        }

        // --- settled ---------------------------------------------------------
        //
        // At full size AND feeding itself. A village holding forty households on a
        // granary that cannot cover the upkeep is not settled, it is a fortnight from
        // empty — and without this clause the objective would reward exactly the spike
        // the hold timer exists to prevent: train to the target, win before the next
        // upkeep collects. `shortfall` is what the last upkeep failed to pay.
        const fed = (economy.shortfall[player] ?? 0) <= 0;
        if (fed && state.households[player]! >= v.householdsToSettle) {
          state.holdTicks[player]!++;
          if (state.holdTicks[player]! >= v.holdTicks) {
            state.outcome = Outcome.Settled;
            state.winner = player;
            events.push(makeEvent(world.tick, EventType.VictoryDeclared, 0, 0, 0, player));
            return;
          }
        } else {
          // Reset rather than decay. Holding is the requirement, so a village that falls
          // below its full size for one tick starts the count again — which is what a
          // hard winter is supposed to cost.
          state.holdTicks[player] = 0;
        }
      }

      // --- last standing ------------------------------------------------------
      let survivors = 0;
      let survivor = -1;
      for (let player = 0; player < players; player++) {
        if (state.eliminated[player] === 1) continue;
        survivors++;
        survivor = player;
      }
      if (survivors === 1 && players > 1) {
        state.outcome = Outcome.LastStanding;
        state.winner = survivor;
        events.push(makeEvent(world.tick, EventType.VictoryDeclared, 0, 0, 0, survivor));
      }
    },
  };

  return state;
}
