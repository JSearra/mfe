import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { FactionId } from '../src/shared/factions/index.js';
import { alliedWith, AllyResult, createAlliance, hasOffered, propose } from '../src/sim/alliance.js';
import { createCensus } from '../src/sim/census.js';
import { createEconomy, Resource, type Economy } from '../src/sim/economy/ledger.js';
import { updateNeighbours } from '../src/sim/neighbours.js';
import { quote } from '../src/sim/trade.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld } from '../src/sim/world.js';

/**
 * The neighbours, off the map (ADR-0021, roadmap Phase B4).
 *
 * A neighbour is a ledger now: no huts, no people, a season run on its books. What it has
 * to keep doing is what it was on the map for — price its trades from its own scarcity,
 * go short in the same bad years as the player, and answer and ask for ties.
 */

const SEASON = tuning.economy.upkeepIntervalTicks;
const N = tuning.neighbours;

function setup(): { economy: Economy; alliance: ReturnType<typeof createAlliance> } {
  const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], 0x5eedcafe);
  economy.offMap[1] = 1;
  return { economy, alliance: createAlliance(2) };
}

/** Run the neighbour's seasons from `from` to `to` ticks, returning its grain each season. */
function seasons(economy: Economy, alliance: ReturnType<typeof createAlliance>, from: number, to: number) {
  const grain: number[] = [];
  const events: SimEvent[] = [];
  for (let tick = from; tick <= to; tick += SEASON) {
    updateNeighbours(economy, alliance, events, tick);
    grain.push(economy.balance(1, Resource.Grain));
  }
  return { grain, events };
}

describe('a neighbour off the map', () => {
  it('draws its granary down in a dry season and fills it in a wet one', () => {
    const { economy, alliance } = setup();
    // Find a wet tick and a dry one in the same year, and compare what a season of each
    // does to the granary from the same starting point.
    let wet = -1;
    let dry = -1;
    for (let t = SEASON; t < tuning.economy.seasonTicks * 3; t += SEASON) {
      const d = economy.drought(t);
      if (wet < 0 && d < 0.1) wet = t;
      if (dry < 0 && d > 0.6) dry = t;
    }
    expect(wet).toBeGreaterThan(0);
    expect(dry).toBeGreaterThan(0);

    const held = N.grainHeld;
    const reset = (): void => {
      economy.spend(1, Resource.Grain, economy.balance(1, Resource.Grain));
      economy.add(1, Resource.Grain, held);
    };
    reset();
    updateNeighbours(economy, alliance, [], wet);
    const afterWet = economy.balance(1, Resource.Grain);
    reset();
    updateNeighbours(economy, alliance, [], dry);
    const afterDry = economy.balance(1, Resource.Grain);

    expect(afterWet).toBeGreaterThan(held);
    expect(afterDry).toBeLessThan(held);
  });

  it('stays near what a village like it keeps, rather than wandering off', () => {
    const { economy, alliance } = setup();
    const { grain } = seasons(economy, alliance, SEASON, tuning.economy.seasonTicks * 5);
    const late = grain.slice(grain.length / 2);
    const mean = late.reduce((a, b) => a + b, 0) / late.length;
    expect(mean).toBeGreaterThan(N.grainHeld * 0.4);
    expect(mean).toBeLessThan(N.grainHeld * 1.8);
  });

  it('prices grain dearer when its own granary is low', () => {
    // The whole reason it is kept: trade prices from the neighbour's books (trade.ts).
    const { economy } = setup();
    economy.spend(1, Resource.Grain, economy.balance(1, Resource.Grain));
    economy.add(1, Resource.Grain, 900);
    const plenty = quote(economy, 1, Resource.Cattle, Resource.Grain, 8);
    economy.spend(1, Resource.Grain, 700);
    const lean = quote(economy, 1, Resource.Cattle, Resource.Grain, 8);
    // Eight head buy less grain from a neighbour that has little of it.
    expect(lean).toBeLessThan(plenty);
  });

  it('goes hungry when its granary cannot cover a bad season', () => {
    const { economy, alliance } = setup();
    economy.spend(1, Resource.Grain, economy.balance(1, Resource.Grain));
    // The worst season in five years: a full-severity drought, which is when a
    // neighbour's granary is supposed to give out — and only then.
    let dry = SEASON;
    for (let t = SEASON; t < tuning.economy.seasonTicks * 5; t += SEASON) {
      if (economy.drought(t) > economy.drought(dry)) dry = t;
    }
    expect(economy.drought(dry)).toBeGreaterThan(0.8);
    updateNeighbours(economy, alliance, [], dry);
    expect(economy.shortfall[1]).toBeGreaterThan(0);
  });

  it('takes up an offered tie from somebody it thinks well of', () => {
    const { economy, alliance } = setup();
    expect(propose(alliance, 0, 1)).toBe(AllyResult.Offered);
    const { events } = seasons(economy, alliance, SEASON, SEASON);
    expect(alliedWith(alliance, 0, 1)).toBe(true);
    expect(events.some((e) => e.type === EventType.AllianceFormed)).toBe(true);
  });

  it('asks for a tie itself when it has gone hungry with nobody to turn to', () => {
    const { economy, alliance } = setup();
    economy.spend(1, Resource.Grain, economy.balance(1, Resource.Grain));
    const events: SimEvent[] = [];
    // Hungry, on a season that is an asking season.
    for (let t = SEASON; t < tuning.economy.seasonTicks * 5; t += SEASON) {
      economy.spend(1, Resource.Grain, economy.balance(1, Resource.Grain));
      updateNeighbours(economy, alliance, events, t);
      if (hasOffered(alliance, 1, 0)) break;
    }
    expect(hasOffered(alliance, 1, 0)).toBe(true);
    expect(events.some((e) => e.type === EventType.AllianceOffered && e.y === 0)).toBe(true);
  });

  it('is not charged an upkeep by the ledger, and is never announced as emptied', () => {
    const { economy } = setup();
    const world = createWorld(64, 1);
    const cattle = economy.balance(1, Resource.Cattle);
    const grain = economy.balance(1, Resource.Grain);
    const events: SimEvent[] = [];
    world.tick = SEASON;
    economy.update(world, events);
    // Spoilage is the one thing the ledger still does to its grain; no upkeep beside it.
    expect(economy.balance(1, Resource.Grain)).toBeGreaterThan(grain * 0.98);
    expect(economy.balance(1, Resource.Cattle)).toBe(cattle);
    expect(economy.shortfall[1]).toBe(0);

    const census = createCensus(2);
    for (let t = 0; t < tuning.census.emptiedGraceTicks + 5; t++) {
      census.update(world, events, economy.offMap);
    }
    expect(census.emptied[1]).toBe(0);
    expect(events.some((e) => e.type === EventType.VillageEmptied && e.payload === 1)).toBe(false);
  });
});
