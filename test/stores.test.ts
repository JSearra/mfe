import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { FactionId } from '../src/shared/factions/index.js';
import { FOODS, RESOURCES, RESOURCE_COUNT, RESOURCE_NAMES, TRADED } from '../src/shared/resources.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { offersFor, parcelOf, wantedTrade } from '../src/sim/trade.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, spawn, type World } from '../src/sim/world.js';

/**
 * Meat, skins and ivory, kept apart from grain (ADR-0022).
 *
 * Meat is not grain. It feeds the people, it does not keep, and it does not trade; grain
 * does all three. Skins and ivory feed nobody and are worth a great deal to a neighbour.
 */

const E = tuning.economy;
const PLAYERS = [FactionId.Zulu, FactionId.Sotho] as const;

function villageOf(units: number): World {
  const world = createWorld(256, 5);
  for (let i = 0; i < units; i++) spawn(world, i, 0, 0);
  return world;
}

/** A village with nothing in it: no grain, no herd, so upkeep is people alone. */
function bare() {
  const economy = createEconomy(PLAYERS, 1);
  for (const resource of RESOURCES) economy.spend(0, resource, economy.balance(0, resource));
  return economy;
}

function upkeep(world: World, economy: ReturnType<typeof bare>, cycle: number): SimEvent[] {
  const events: SimEvent[] = [];
  world.tick = cycle * E.upkeepIntervalTicks;
  economy.update(world, events);
  return events;
}

describe('the catalogue', () => {
  it('names every resource, in index order', () => {
    expect(RESOURCES).toHaveLength(RESOURCE_COUNT);
    RESOURCES.forEach((resource, index) => expect(resource).toBe(index));
    for (const resource of RESOURCES) expect(RESOURCE_NAMES[resource]).toMatch(/^[a-z]+$/);
  });

  it('keeps the three old indices where saves and replays expect them', () => {
    expect([Resource.Cattle, Resource.Grain, Resource.Wood]).toEqual([0, 1, 2]);
  });

  it('prices every traded good, and does not trade meat', () => {
    const goods = tuning.trade.goods as Record<string, unknown>;
    for (const resource of TRADED) expect(goods[RESOURCE_NAMES[resource]]).toBeDefined();
    expect(TRADED).not.toContain(Resource.Meat);
  });

  it('feeds people meat before grain', () => {
    expect(FOODS).toEqual([Resource.Meat, Resource.Grain]);
  });
});

describe('meat', () => {
  it('is eaten before grain', () => {
    const world = villageOf(10);
    const economy = bare();
    economy.add(0, Resource.Meat, 100);
    economy.add(0, Resource.Grain, 100);
    upkeep(world, economy, 1);

    // The meat pays the whole bill, less what spoiled first. The bill is the ledger's own
    // figure, which carries the people's upkeep multiplier.
    const spoiled = 100 * tuning.stores.meatSpoilPerCycle;
    expect(economy.upkeep[0]).toBeGreaterThan(0);
    expect(economy.balance(0, Resource.Meat)).toBeCloseTo(100 - spoiled - economy.upkeep[0]!, 5);
    // Grain loses only its own, much slower, spoilage.
    expect(economy.balance(0, Resource.Grain)).toBeCloseTo(100 * (1 - E.grainSpoilPerCycle), 5);
  });

  it('runs out onto grain without anybody going hungry', () => {
    const world = villageOf(10);
    const economy = bare();
    economy.add(0, Resource.Meat, 4);
    economy.add(0, Resource.Grain, 100);
    const events = upkeep(world, economy, 1);

    expect(economy.balance(0, Resource.Meat)).toBe(0);
    expect(events.filter((e) => e.type === EventType.Starved)).toHaveLength(0);
    expect(economy.shortfall[0]).toBe(0);
  });

  it('feeds a village with no grain at all', () => {
    const world = villageOf(10);
    const economy = bare();
    economy.add(0, Resource.Meat, 200);
    const events = upkeep(world, economy, 1);
    expect(events.filter((e) => e.type === EventType.Starved)).toHaveLength(0);
  });

  it('goes off far faster than grain', () => {
    const world = villageOf(0);
    const economy = bare();
    economy.add(0, Resource.Meat, 100);
    economy.add(0, Resource.Grain, 100);
    for (let cycle = 1; cycle <= 15; cycle++) upkeep(world, economy, cycle);
    // Half of it gone in fifteen cycles — a quarter of a year — while grain barely moves.
    expect(economy.balance(0, Resource.Meat)).toBeLessThan(50);
    expect(economy.balance(0, Resource.Grain)).toBeGreaterThan(90);
  });

  it('is never fed to the herd', () => {
    // Nobody to feed, a herd to fodder, and only meat in the store: the meat stays.
    const world = villageOf(0);
    const economy = bare();
    economy.add(0, Resource.Cattle, 40);
    economy.add(0, Resource.Meat, 100);
    upkeep(world, economy, 1);
    expect(economy.balance(0, Resource.Meat)).toBeCloseTo(100 * (1 - tuning.stores.meatSpoilPerCycle), 5);
  });
});

describe('skins and ivory', () => {
  it('can be sold to a neighbour', () => {
    const economy = createEconomy(PLAYERS, 1);
    economy.add(0, Resource.Skins, parcelOf(Resource.Skins));
    economy.add(0, Resource.Ivory, parcelOf(Resource.Ivory));
    const offers = offersFor(economy, 0);
    expect(offers.some((offer) => offer.offered === Resource.Skins)).toBe(true);
    expect(offers.some((offer) => offer.offered === Resource.Ivory)).toBe(true);
  });

  it('are worth more a unit than grain to a neighbour who has none', () => {
    const economy = createEconomy(PLAYERS, 1);
    economy.add(0, Resource.Ivory, parcelOf(Resource.Ivory));
    const ivory = offersFor(economy, 0).find(
      (offer) => offer.offered === Resource.Ivory && offer.wanted === Resource.Grain,
    );
    expect(ivory).toBeDefined();
    expect(ivory!.get / ivory!.give).toBeGreaterThan(1);
  });

  it('are never asked for by a village whose partner has none', () => {
    const economy = createEconomy(PLAYERS, 1);
    const wanted = wantedTrade(economy, 1, 0);
    if (wanted !== null) {
      expect(wanted.wanted).not.toBe(Resource.Ivory);
      expect(wanted.wanted).not.toBe(Resource.Skins);
    }
  });
});
