import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import type { Economy } from './economy/ledger.js';
import { Resource } from './economy/ledger.js';
import { tuning } from './tuning.js';
import { EntityKind, HerdState, handleIndex, isAlive, type World } from './world.js';

/**
 * How a match ends.
 *
 * Victory is measured in cattle, not in corpses. In this setting cattle are wealth,
 * standing and the reason to fight, so making the herd the objective puts the game's
 * distinctive mechanic at the centre of it rather than beside it — a player who ignores
 * herding cannot win by being good at everything else.
 *
 * Holding is what counts, not touching: the threshold has to be held for a stretch, so
 * a raid that takes the herd and immediately loses it takes nothing. That gives the
 * losing side a window to answer, which is the difference between a climax and a
 * cutscene.
 */

export const Outcome = {
  Ongoing: 0,
  /** Somebody held the herd long enough. */
  CattleVictory: 1,
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
  /** Cattle each player held at the last check, for the UI. */
  readonly cattleHeld: Float64Array;
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
    cattleHeld: new Float64Array(players),
    eliminated: new Uint8Array(players),
    graceTicks: new Float64Array(players),

    update(world, economy, events): void {
      if (state.outcome !== Outcome.Ongoing) return;

      const v = tuning.victory;
      const units = new Float64Array(players);
      const buildings = new Float64Array(players);

      state.cattleHeld.fill(0);
      for (let player = 0; player < players; player++) {
        state.cattleHeld[player] = economy.balance(player, Resource.Cattle);
      }

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1) continue;

        if (world.kind[index] === EntityKind.Cattle) {
          // Cattle on the map count for whoever holds the tether. That is what makes a
          // raid worth mounting: the herd changes hands by being driven off, not by
          // being killed.
          if (world.herdState[index] !== HerdState.Leashed) continue;
          const tether = world.tetheredTo[index]!;
          if (!isAlive(world, tether)) continue;
          const owner = world.faction[handleIndex(tether)]!;
          if (owner < players) state.cattleHeld[owner]!++;
          continue;
        }

        const owner = world.faction[index]!;
        if (owner >= players) continue;
        if (world.kind[index] === EntityKind.Unit) units[owner]!++;
        else if (world.kind[index] === EntityKind.Building) buildings[owner]!++;
      }

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

        // --- cattle ----------------------------------------------------------
        if (state.cattleHeld[player]! >= v.cattleToWin) {
          state.holdTicks[player]!++;
          if (state.holdTicks[player]! >= v.holdTicks) {
            state.outcome = Outcome.CattleVictory;
            state.winner = player;
            events.push(makeEvent(world.tick, EventType.VictoryDeclared, 0, 0, 0, player));
            return;
          }
        } else {
          // Reset rather than decay. Holding is the requirement, so dropping below the
          // threshold for one tick means starting the count again.
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
