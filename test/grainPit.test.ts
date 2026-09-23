import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/shared/events.js';
import { EventType } from '../src/shared/events.js';
import { FactionId } from '../src/shared/factions/index.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, spawn, type World } from '../src/sim/world.js';

/**
 * Grain that keeps, and grain that does not.
 *
 * **A first pass at the pit was a pure buffer — it paid out in a shortfall and refilled
 * from a surplus — and these tests are what proved it was a no-op.** Grain drawn from
 * the same granary it is paid back into does not change how long a village lasts by a
 * single cycle: the total is conserved, so the pit only ever moved the same grain
 * later. There is no scenario, temporary famine or permanent one, in which it helps.
 *
 * A pit has to have a property the granary lacks, and historically it had exactly one.
 * Grain in a basket or a raised store is eaten by weevils and damp; grain in a sealed
 * underground pit keeps for years, which is why the pits were dug. So the granary
 * spoils and the pit does not, and that is the whole of what an umgodi buys.
 *
 * The rate is deliberately small against an operating balance and large against a
 * hoard: it is not a tax on running a village, it is a reason not to sit on four
 * thousand grain for a year.
 */

const E = tuning.economy;
const PLAYERS = [FactionId.Zulu, FactionId.Sotho] as const;

function villageOf(units: number): World {
  const world = createWorld(256, 5);
  for (let i = 0; i < units; i++) spawn(world, i, 0, 0);
  return world;
}

/** A village with nothing but what the test gives it: no starting herd, no starting grain. */
function bareEconomy() {
  const economy = createEconomy(PLAYERS, 1);
  economy.spend(0, Resource.Grain, economy.balance(0, Resource.Grain));
  economy.spend(0, Resource.Cattle, economy.balance(0, Resource.Cattle));
  return economy;
}

function run(
  units: number,
  capacity: number,
  grain: number,
  cycles: number,
  harvestFor = cycles,
  harvest = 0,
): { grain: number; reserve: number; starved: number; total: number } {
  const world = villageOf(units);
  const economy = bareEconomy();
  economy.add(0, Resource.Grain, grain);
  const events: SimEvent[] = [];
  let starved = 0;

  for (let cycle = 1; cycle <= cycles; cycle++) {
    if (cycle <= harvestFor) economy.add(0, Resource.Grain, harvest);
    world.tick = cycle * E.upkeepIntervalTicks;
    events.length = 0;
    economy.update(world, events, undefined, undefined, undefined, () => capacity);
    starved += events.filter((e) => e.type === EventType.Starved).length;
  }

  const held = economy.balance(0, Resource.Grain);
  return { grain: held, reserve: economy.reserve[0]!, starved, total: held + economy.reserve[0]! };
}

describe('spoilage', () => {
  it('eats into grain nobody is using', () => {
    // No units, no herd, no harvest: the only thing that can move the number is rot.
    const after = run(0, 0, 1000, 10);
    expect(after.grain).toBeLessThan(1000);
    expect(after.grain).toBeCloseTo(1000 * (1 - E.grainSpoilPerCycle) ** 10, 4);
  });

  it('is small against an operating balance and large against a hoard', () => {
    // The judgement that keeps this from being a tax on playing the game. A village
    // running on a few hundred grain loses a rounding error a cycle; one sitting on
    // thousands loses enough to notice.
    const modest = 1000 * E.grainSpoilPerCycle;
    const hoard = 4000 * E.grainSpoilPerCycle;
    expect(modest).toBeLessThan(10);
    expect(hoard).toBeGreaterThan(modest);
  });
});

describe('the grain pit', () => {
  it('fills from a surplus, and never past its capacity', () => {
    const one = run(0, 60, 400, 1);
    expect(one.reserve).toBeGreaterThan(0);
    expect(one.reserve).toBeLessThanOrEqual(60);
    expect(run(0, 60, 400, 20).reserve).toBe(60);
  });

  it('holds nothing at all when the village has dug no pit', () => {
    expect(run(0, 0, 400, 20).reserve).toBe(0);
  });

  it('takes only a share of the surplus, so digging one is not a tax', () => {
    // A village that banked everything it did not eat could never save for a building.
    const after = run(0, 10_000, 400, 1);
    expect(after.grain).toBeGreaterThan(0);
    expect(after.reserve).toBeLessThan(after.grain);
  });

  it('keeps grain the granary would have lost', () => {
    // The whole of the mechanic, in one comparison. Same village, same grain, same
    // years; one of them dug a pit.
    const withPit = run(0, 2000, 3000, 60);
    const without = run(0, 0, 3000, 60);
    expect(withPit.total).toBeGreaterThan(without.total);
  });

  it('carries a village through a famine that starves one without it', () => {
    // Twenty seasons of harvest banked against eighty-five with none. Same village,
    // same grain in, same grain out; one of them dug pits and the other left its
    // surplus in the granary to rot.
    //
    // Measured across the sweep this was chosen from: at eighty cycles the pit village
    // is holding 584 against 233, and at a hundred and five the difference is the one
    // that decides whether anybody starves at all.
    const withPit = run(20, 1500, 0, 105, 20, 120);
    const without = run(20, 0, 0, 105, 20, 120);

    expect(without.starved).toBeGreaterThan(0);
    expect(withPit.starved).toBeLessThan(without.starved);
  });

  it('empties before it lets anybody starve, and not after', () => {
    // Before rather than after is the whole of what a reserve buys: starvation falls on
    // every unit at once, so a village that dies and is THEN handed its reserve has
    // been handed nothing.
    const world = villageOf(10);
    const economy = bareEconomy();
    const events: SimEvent[] = [];

    economy.add(0, Resource.Grain, 400);
    world.tick = E.upkeepIntervalTicks;
    economy.update(world, events, undefined, undefined, undefined, () => 500);
    const banked = economy.reserve[0]!;
    expect(banked).toBeGreaterThan(0);

    // Strip the granary bare. The pit is all that stands between the village and hunger.
    economy.spend(0, Resource.Grain, economy.balance(0, Resource.Grain));
    events.length = 0;
    world.tick = 2 * E.upkeepIntervalTicks;
    economy.update(world, events, undefined, undefined, undefined, () => 500);

    expect(events.filter((e) => e.type === EventType.Starved)).toHaveLength(0);
    expect(economy.reserve[0]).toBeLessThan(banked);
  });

  it('cannot go on holding grain for a pit that is gone', () => {
    const world = villageOf(0);
    const economy = bareEconomy();
    const events: SimEvent[] = [];
    let capacity = 200;

    economy.add(0, Resource.Grain, 2000);
    world.tick = E.upkeepIntervalTicks;
    economy.update(world, events, undefined, undefined, undefined, () => capacity);
    expect(economy.reserve[0]).toBeGreaterThan(0);

    capacity = 0;
    world.tick = 2 * E.upkeepIntervalTicks;
    economy.update(world, events, undefined, undefined, undefined, () => capacity);
    expect(economy.reserve[0]).toBe(0);
  });
});
