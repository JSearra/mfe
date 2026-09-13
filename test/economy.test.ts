import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import {
  FACTIONS,
  FactionId,
  validateAllFactions,
  validateFaction,
} from '../src/shared/factions/index.js';
import { createEconomy, Resource, type GrainPlot } from '../src/sim/economy/ledger.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, spawn, type World } from '../src/sim/world.js';

const E = tuning.economy;
const PLAYERS = [FactionId.Zulu, FactionId.Sotho] as const;

function worldWithTroops(units: number, faction = 0): World {
  const world = createWorld(256, 5);
  for (let i = 0; i < units; i++) spawn(world, i, 0, faction);
  return world;
}

describe('factions', () => {
  it('ships four valid configurations', () => {
    expect(Object.keys(FACTIONS)).toHaveLength(4);
    expect(validateAllFactions()).toEqual([]);
  });

  it('uses correct orthography for the display names', () => {
    // docs/CONTENT.md section 3: noun-class prefixes are lowercase mid-sentence and
    // Basotho has no internal capital. Getting this wrong is the most visible marker
    // of a carelessly researched game.
    expect(FACTIONS[FactionId.Zulu].nameKey).toBe('faction.zulu');
    expect(FACTIONS[FactionId.Ndebele].nameKey).toBe('faction.ndebele');
  });

  // A malformed config must fail a test, not a match already in progress.
  it('rejects malformed configurations field by field', () => {
    const problems = validateFaction({
      id: FactionId.Zulu,
      nameKey: '',
      startingCattle: Number.NaN,
      startingGrain: -5,
      startingAmmunition: 0,
      upkeepMultiplier: 0,
      herdGrowthMultiplier: 1,
      herdingSkill: 1,
      lineMovementClass: 0,
    });

    const fields = problems.map((p) => p.field);
    expect(fields).toContain('nameKey');
    expect(fields).toContain('startingCattle');
    expect(fields).toContain('startingGrain');
    expect(fields).toContain('upkeepMultiplier');
  });

  it('rejects an unknown id', () => {
    const problems = validateFaction({ ...FACTIONS[FactionId.Zulu], id: 'xhosa' as FactionId });
    expect(problems.map((p) => p.field)).toContain('id');
  });

  it('gives each faction a distinct economic shape', () => {
    // Griqua trade for powder and hold fewer cattle; amaNdebele are the reverse.
    expect(FACTIONS[FactionId.Griqua].startingAmmunition).toBeGreaterThan(
      FACTIONS[FactionId.Zulu].startingAmmunition,
    );
    expect(FACTIONS[FactionId.Ndebele].startingCattle).toBeGreaterThan(
      FACTIONS[FactionId.Griqua].startingCattle,
    );
  });
});

describe('ledger', () => {
  it('starts each player from their faction configuration', () => {
    const economy = createEconomy(PLAYERS, 1);
    expect(economy.balance(0, Resource.Cattle)).toBe(FACTIONS[FactionId.Zulu].startingCattle);
    expect(economy.balance(1, Resource.Grain)).toBe(FACTIONS[FactionId.Sotho].startingGrain);
  });

  it('spends only what is held', () => {
    const economy = createEconomy(PLAYERS, 1);
    expect(economy.spend(0, Resource.Grain, 1e9)).toBe(false);
    expect(economy.spend(0, Resource.Grain, 10)).toBe(true);
    expect(economy.balance(0, Resource.Grain)).toBe(
      FACTIONS[FactionId.Zulu].startingGrain - 10,
    );
  });

  it('never goes negative', () => {
    const economy = createEconomy(PLAYERS, 1);
    economy.add(0, Resource.Grain, -1e9);
    expect(economy.balance(0, Resource.Grain)).toBe(0);
  });
});

describe('upkeep timing', () => {
  // Driven by the tick counter, never a wall clock, so it cannot drift.
  it('fires on exact tick multiples across a long run', () => {
    const economy = createEconomy(PLAYERS, 1);
    const world = worldWithTroops(4);
    const events: SimEvent[] = [];
    const firedAt: number[] = [];

    for (let tick = 0; tick <= 10_000; tick++) {
      world.tick = tick;
      const before = economy.upkeepCount;
      economy.update(world, events);
      if (economy.upkeepCount !== before) firedAt.push(tick);
    }

    expect(firedAt).toHaveLength(10_000 / E.upkeepIntervalTicks);
    for (let i = 0; i < firedAt.length; i++) {
      expect(firedAt[i]).toBe((i + 1) * E.upkeepIntervalTicks);
    }
  });

  it('does not fire on tick zero', () => {
    const economy = createEconomy(PLAYERS, 1);
    const world = worldWithTroops(1);
    world.tick = 0;
    economy.update(world, []);
    expect(economy.upkeepCount).toBe(0);
  });
});

describe('drought', () => {
  it('is a pure function of the tick', () => {
    const economy = createEconomy(PLAYERS, 99);
    for (const tick of [0, 137, 2400, 4800, 12345]) {
      expect(economy.drought(tick)).toBe(economy.drought(tick));
    }
  });

  it('stays in range and peaks mid-season', () => {
    const economy = createEconomy(PLAYERS, 99);
    let peakTick = 0;
    let peak = -1;

    for (let tick = 0; tick < E.seasonTicks; tick++) {
      const value = economy.drought(tick);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      if (value > peak) {
        peak = value;
        peakTick = tick;
      }
    }
    expect(peakTick).toBeGreaterThan(E.seasonTicks * 0.4);
    expect(peakTick).toBeLessThan(E.seasonTicks * 0.6);
  });

  it('varies year to year without touching the simulation RNG', () => {
    const economy = createEconomy(PLAYERS, 7);
    const mid = Math.floor(E.seasonTicks / 2);
    const severities = [0, 1, 2, 3, 4].map((year) => economy.drought(year * E.seasonTicks + mid));
    expect(new Set(severities).size).toBeGreaterThan(1);

    // A different seed gives a different sequence of years.
    const other = createEconomy(PLAYERS, 8);
    expect(other.drought(mid)).not.toBe(economy.drought(mid));
  });

  it('zeroes open plots at the threshold and spares sheltered ones', () => {
    const plots: GrainPlot[] = [
      { tileX: 1, tileY: 1, owner: 0, sheltered: false },
      { tileX: 2, tileY: 2, owner: 0, sheltered: true },
    ];

    // Find a tick where the drought has crossed the threshold.
    const probe = createEconomy(PLAYERS, 3, plots);
    let parchedTick = -1;
    for (let tick = E.upkeepIntervalTicks; tick < E.seasonTicks * 4; tick += E.upkeepIntervalTicks) {
      if (probe.drought(tick) >= E.droughtThreshold) {
        parchedTick = tick;
        break;
      }
    }
    expect(parchedTick).toBeGreaterThan(0);

    // Three economies differing only in their plots, so upkeep — which draws grain
    // whatever the plots do — cancels out and the harvest is isolated.
    const noPlots = createEconomy(PLAYERS, 3, []);
    const openOnly = createEconomy(PLAYERS, 3, [plots[0]!]);
    const shelteredOnly = createEconomy(PLAYERS, 3, [plots[1]!]);
    const world = worldWithTroops(0);
    world.tick = parchedTick;

    for (const economy of [noPlots, openOnly, shelteredOnly]) economy.update(world, []);

    const control = noPlots.balance(0, Resource.Grain);
    // Open savanna yields exactly nothing past the threshold...
    expect(openOnly.balance(0, Resource.Grain)).toBe(control);
    // ...while a river bottom or a kloof keeps producing, which is the counterplay.
    expect(shelteredOnly.balance(0, Resource.Grain)).toBeGreaterThan(control);
  });
});

describe('starvation', () => {
  it('costs grain per unit and per beast, scaled by the faction', () => {
    const economy = createEconomy(PLAYERS, 1);
    const world = worldWithTroops(10);
    world.tick = E.upkeepIntervalTicks;

    const before = economy.balance(0, Resource.Grain);
    economy.update(world, []);
    const spent = before - economy.balance(0, Resource.Grain);

    const expected =
      (10 * E.grainPerUnit + FACTIONS[FactionId.Zulu].startingCattle * E.grainPerCattle) *
      FACTIONS[FactionId.Zulu].upkeepMultiplier;
    expect(spent).toBeCloseTo(expected, 6);
  });

  it('damages troops and reports it when grain runs out', () => {
    const economy = createEconomy(PLAYERS, 1);
    const world = worldWithTroops(6);
    const events: SimEvent[] = [];

    economy.spend(0, Resource.Grain, economy.balance(0, Resource.Grain));
    world.tick = E.upkeepIntervalTicks;

    const hpBefore = world.hp[0]!;
    economy.update(world, events);

    expect(world.hp[0]!).toBeLessThan(hpBefore);
    expect(economy.shortfall[0]!).toBeGreaterThan(0);
    expect(events.some((e) => e.type === EventType.Starved)).toBe(true);
  });

  it('starves troops, not the herd — eating the herd is a player decision', () => {
    const economy = createEconomy(PLAYERS, 1);
    const world = createWorld(64, 5);
    spawn(world, 0, 0, 0);
    const cow = spawn(world, 1, 0, 0, 1, 1);

    economy.spend(0, Resource.Grain, economy.balance(0, Resource.Grain));
    world.tick = E.upkeepIntervalTicks;

    const cowHp = world.hp[cow & 0xffffff]!;
    economy.update(world, []);
    expect(world.hp[cow & 0xffffff]).toBe(cowHp);
  });

  it('grows a fed herd and barely grows a parched one', () => {
    const fed = createEconomy(PLAYERS, 1);
    const world = worldWithTroops(0);
    world.tick = E.upkeepIntervalTicks;

    const before = fed.balance(0, Resource.Cattle);
    fed.update(world, []);
    expect(fed.balance(0, Resource.Cattle)).toBeGreaterThan(before);
  });
});
