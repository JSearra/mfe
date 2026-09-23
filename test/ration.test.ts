import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { FactionId } from '../src/shared/factions/index.js';
import { createEconomy, Resource, Ration } from '../src/sim/economy/ledger.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, spawn, type World } from '../src/sim/world.js';

/**
 * Cutting the ration.
 *
 * A bad year had exactly one outcome and no move in it: the granary ran out and
 * everybody took damage at once. The only decision that mattered was the one taken ten
 * minutes earlier. A short ration is the move a village actually has — eat less, work
 * slower, and come out the other side — and it is a real decision because the work it
 * costs is the work that would have dug you out.
 */

const E = tuning.economy;
const PLAYERS = [FactionId.Zulu, FactionId.Sotho] as const;

function villageOf(units: number): World {
  const world = createWorld(256, 5);
  for (let i = 0; i < units; i++) spawn(world, i, 0, 0);
  return world;
}

function bare() {
  const economy = createEconomy(PLAYERS, 1);
  economy.spend(0, Resource.Grain, economy.balance(0, Resource.Grain));
  economy.spend(0, Resource.Cattle, economy.balance(0, Resource.Cattle));
  return economy;
}

/** Run `cycles` upkeeps at a ration and report what happened. */
function run(units: number, grain: number, ration: Ration, cycles: number) {
  const world = villageOf(units);
  const economy = bare();
  economy.setRation(0, ration);
  economy.add(0, Resource.Grain, grain);
  const events: SimEvent[] = [];
  let starved = 0;
  let lastUpkeep = 0;

  for (let cycle = 1; cycle <= cycles; cycle++) {
    world.tick = cycle * E.upkeepIntervalTicks;
    events.length = 0;
    economy.update(world, events);
    starved += events.filter((e) => e.type === EventType.Starved).length;
    lastUpkeep = economy.upkeep[0]!;
  }
  return { starved, upkeep: lastUpkeep, grain: economy.balance(0, Resource.Grain) };
}

describe('the ration', () => {
  it('starts full', () => {
    const economy = bare();
    expect(economy.ration[0]).toBe(Ration.Full);
    expect(economy.labourFactor(0)).toBe(1);
  });

  it('cuts what a village eats', () => {
    const full = run(20, 2000, Ration.Full, 1);
    const short = run(20, 2000, Ration.Short, 1);
    expect(short.upkeep).toBeLessThan(full.upkeep);
    expect(short.upkeep).toBeCloseTo(full.upkeep * E.rationShortFactor, 6);
  });

  it('carries a village through a shortage that starves one on full rations', () => {
    // The same grain, the same mouths, the same number of seasons.
    const full = run(20, 200, Ration.Full, 14);
    const short = run(20, 200, Ration.Short, 14);
    expect(full.starved).toBeGreaterThan(0);
    expect(short.starved).toBeLessThan(full.starved);
  });

  it('costs work, which is the reason not to live on it', () => {
    // Without this a short ration is strictly better than a full one and no village
    // would ever choose otherwise, which is not a decision.
    const economy = bare();
    expect(economy.labourFactor(0)).toBe(1);
    economy.setRation(0, Ration.Short);
    expect(economy.labourFactor(0)).toBeLessThan(1);
    expect(economy.labourFactor(0)).toBeCloseTo(E.rationShortLabour, 6);
  });

  it('goes back', () => {
    const economy = bare();
    economy.setRation(0, Ration.Short);
    economy.setRation(0, Ration.Full);
    expect(economy.ration[0]).toBe(Ration.Full);
    expect(economy.labourFactor(0)).toBe(1);
  });

  it('is one village s business and not its neighbour s', () => {
    const economy = bare();
    economy.setRation(0, Ration.Short);
    expect(economy.ration[1]).toBe(Ration.Full);
    expect(economy.labourFactor(1)).toBe(1);
  });

  it('does not stop a village starving outright when there is nothing at all', () => {
    // A ration is a way of making grain last, not a way of eating none.
    expect(run(20, 0, Ration.Short, 3).starved).toBeGreaterThan(0);
  });
});
