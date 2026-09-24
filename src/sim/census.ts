import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import { tuning } from './tuning.js';
import { EntityKind, type World } from './world.js';

/**
 * Who is still living in each village.
 *
 * This was `victory.ts`, which ran a race: settle sixty households, hold them fed for
 * half a year, and win. ADR-0020 retired the race. The game is an open-ended builder
 * now, and nothing ends it: a village that starves shrinks and can grow back. What is
 * left is a count of households for the HUD, and a record of whether a village has
 * emptied completely, so that its player can be told.
 *
 * An emptied village is NOT the end of a game, and nothing here stops the simulation.
 * Knowing it is empty is simply information the player needs and cannot easily read off
 * a map full of empty huts.
 */

export interface Census {
  readonly players: number;
  /** Households standing at the last count. */
  readonly households: Float64Array;
  /** 1 once a village has had nobody in it for the whole grace period. */
  readonly emptied: Uint8Array;
  /** Ticks each village has been empty, before it is announced as emptied. */
  readonly graceTicks: Float64Array;

  /** `offMap` names villages not on the map, which have nobody to count and never empty. */
  update(world: World, events: SimEvent[], offMap?: Uint8Array): void;
}

export function createCensus(players: number): Census {
  const census: Census = {
    players,
    households: new Float64Array(players),
    emptied: new Uint8Array(players),
    graceTicks: new Float64Array(players),

    update(world, events, offMap): void {
      const units = new Float64Array(players);

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1) continue;
        // Cattle belong to nobody's headcount. They are food and wealth, counted by the
        // ledger and eaten by the upkeep; a village's size is the people in it.
        if (world.kind[index] !== EntityKind.Unit) continue;
        const owner = world.faction[index]!;
        if (owner < players) units[owner]!++;
      }

      for (let player = 0; player < players; player++) {
        census.households[player] = units[player]!;
        // A village that is not on the map has nobody on it to count, and has not emptied
        // for it (ADR-0021). Its books live in the ledger.
        if (offMap?.[player] === 1) continue;

        // The grace period is longer than it takes to raise somebody, so a village that
        // loses its last person while a homestead is finishing a new one is not
        // announced. A village that empties and later has people again (a save edited,
        // a household raised from a store that outlived everyone) stops being emptied.
        if (units[player] === 0) {
          if (census.emptied[player] === 1) continue;
          census.graceTicks[player]!++;
          if (census.graceTicks[player]! >= tuning.census.emptiedGraceTicks) {
            census.emptied[player] = 1;
            events.push(makeEvent(world.tick, EventType.VillageEmptied, 0, 0, 0, player));
          }
        } else {
          census.graceTicks[player] = 0;
          census.emptied[player] = 0;
        }
      }
    },
  };

  return census;
}
