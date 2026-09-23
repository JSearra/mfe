import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { FactionId } from '../src/shared/factions/index.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, spawn, type World } from '../src/sim/world.js';

/**
 * Hunger in proportion to what was missing.
 *
 * Open in `tasks/plan.md` section F since September: being five grain short did the
 * same damage, to every unit the player owned, as being five hundred short. That is not
 * only harsh, it makes the whole of Part II's counterplay worthless — a pit and a cut
 * ration both exist to turn a catastrophic shortfall into a small one, and if a small
 * one is just as lethal then neither of them buys anything at all.
 *
 * A village one grain short of its upkeep has not had a famine. It has had a thin week.
 */

const E = tuning.economy;
const PLAYERS = [FactionId.Zulu, FactionId.Sotho] as const;

function villageOf(units: number): World {
  const world = createWorld(256, 5);
  for (let i = 0; i < units; i++) spawn(world, i, 0, 0);
  return world;
}

/** One upkeep with a granary holding `grain`, and what the hunger cost. */
function season(units: number, grain: number) {
  const world = villageOf(units);
  const economy = createEconomy(PLAYERS, 1);
  economy.spend(0, Resource.Grain, economy.balance(0, Resource.Grain));
  economy.spend(0, Resource.Cattle, economy.balance(0, Resource.Cattle));
  economy.add(0, Resource.Grain, grain);

  const before = new Float64Array(world.capacity);
  for (let i = 0; i < world.capacity; i++) before[i] = world.hp[i]!;

  const events: SimEvent[] = [];
  world.tick = E.upkeepIntervalTicks;
  economy.update(world, events);

  let lost = 0;
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1) continue;
    lost += before[i]! - world.hp[i]!;
  }
  const starved = events.filter((e) => e.type === EventType.Starved);
  return {
    lost,
    events: starved.length,
    shortfall: economy.shortfall[0]!,
    // What one villager lost, which is the number the rule is actually about.
    damage: starved[0]?.payload ?? 0,
    // Read back rather than assumed. Upkeep is per unit AND per beast, scaled by the
    // faction, and spoilage comes out of the granary before any of it — a first pass
    // at these tests worked the figure out by hand and was wrong by threefold.
    upkeep: economy.upkeep[0]!,
  };
}

describe('starvation', () => {
  it('costs nothing at all when the granary covers the upkeep', () => {
    const fed = season(20, 500);
    expect(fed.shortfall).toBe(0);
    expect(fed.events).toBe(0);
    expect(fed.lost).toBe(0);
  });

  it('hurts in proportion to what was missing', () => {
    // A village a hair short against one with an empty granary. The second has missed
    // its whole upkeep and must cost far more than the first.
    const full = season(20, 500);
    const nearly = season(20, Math.floor(full.upkeep) - 1);
    const nothing = season(20, 0);

    expect(nearly.shortfall).toBeLessThan(full.upkeep * 0.2);
    expect(nothing.shortfall).toBeCloseTo(full.upkeep, 4);
    expect(nearly.lost).toBeGreaterThan(0);
    expect(nothing.lost).toBeGreaterThan(nearly.lost * 4);
  });

  it('never exceeds what a total failure costs', () => {
    // The old flat figure is the ceiling, so a complete famine is exactly as bad as it
    // always was and nothing here makes the game harsher than it was.
    expect(season(20, 0).damage).toBeCloseTo(E.starvationDamage, 6);
  });

  it('still says so out loud, however small', () => {
    // A thin week is news. The alert bar is the only thing that tells a player their
    // village is going short at all, and it must not go quiet just because the miss
    // was a small one.
    const full = season(20, 500);
    expect(season(20, Math.floor(full.upkeep) - 1).events).toBe(20);
  });

  it('makes a pit and a cut ration worth having', () => {
    // The whole reason this matters. Part II's counterplay turns a large shortfall into
    // a small one; if the two cost the same, neither bought anything.
    const full = season(20, 500);
    const bad = season(20, Math.floor(full.upkeep * 0.2));
    const softened = season(20, Math.floor(full.upkeep * 0.8));
    expect(softened.lost).toBeLessThan(bad.lost);
  });
});
