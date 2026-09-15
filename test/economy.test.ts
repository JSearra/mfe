import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import {
  FACTIONS,
  FactionId,
  validateAllFactions,
  validateFaction,
} from '../src/shared/factions/index.js';
import { createEconomy, Resource, type GrainPlot } from '../src/sim/economy/ledger.js';
import { createStartingPlots } from '../src/sim/economy/plots.js';
import { heightmapFrom } from '../src/shared/heightmap.js';
import { flatMap } from './simHarness.js';
import { tuning } from '../src/sim/tuning.js';
import {
  createWorld,
  EntityKind,
  handleIndex,
  HerdState,
  packHandle,
  spawn,
  type World,
} from '../src/sim/world.js';
import { NEUTRAL_FACTION } from '../src/sim/commands.js';
import { TICK_MS } from '../src/shared/timing.js';

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

  it('dries open plots out gradually and keeps sheltered ones above a floor', () => {
    const plots: GrainPlot[] = [
      { tileX: 1, tileY: 1, owner: 0, sheltered: false },
      { tileX: 2, tileY: 2, owner: 0, sheltered: true },
    ];

    // Find a tick deep enough into a bad year that open ground has dried well below
    // the sheltered floor. There is no threshold to cross any more — yield falls with
    // the drought rather than off a cliff — so this looks for severity instead.
    const probe = createEconomy(PLAYERS, 3, plots);
    let parchedTick = -1;
    for (let tick = E.upkeepIntervalTicks; tick < E.seasonTicks * 4; tick += E.upkeepIntervalTicks) {
      const drought = probe.drought(tick);
      if (1 - drought * drought < E.shelteredYieldFactor) {
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
    const open = openOnly.balance(0, Resource.Grain) - control;
    const shelteredYield = shelteredOnly.balance(0, Resource.Grain) - control;

    // Open savanna is nearly spent, but not switched off: the player watching the
    // number fall can still see it falling, which is what makes it plannable.
    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThan(E.plotBaseYield * E.shelteredYieldFactor);
    // A river bottom or a kloof holds its floor, which is the counterplay.
    expect(shelteredYield).toBeGreaterThan(open);
    expect(shelteredYield).toBeCloseTo(E.plotBaseYield * E.shelteredYieldFactor, 6);
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

describe('arable land', () => {
  // Nothing created plots until this existed, and the consequence only showed up in a
  // long AI-vs-AI match: grain income was zero, every player starved by tick 1000, and
  // the drought withered a harvest that was not there.
  it('lays plots around each start, some sheltered', () => {
    const map = flatMap(48);
    const plots = createStartingPlots(map, [{ x: 10, y: 10 }, { x: 38, y: 38 }], 7);

    expect(plots.filter((p) => p.owner === 0)).toHaveLength(E.plotsPerPlayer);
    expect(plots.filter((p) => p.owner === 1)).toHaveLength(E.plotsPerPlayer);
    expect(plots.filter((p) => p.owner === 0 && p.sheltered)).toHaveLength(E.shelteredPerPlayer);
  });

  it('keeps them near their owner and clear of the start itself', () => {
    const map = flatMap(48);
    for (const plot of createStartingPlots(map, [{ x: 10, y: 10 }], 7)) {
      const dx = plot.tileX - 10;
      const dy = plot.tileY - 10;
      expect(Math.abs(dx)).toBeLessThanOrEqual(E.plotSearchRadius);
      expect(Math.abs(dy)).toBeLessThanOrEqual(E.plotSearchRadius);
      // Ground is left clear around the start for the force to stand on.
      expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(9);
    }
  });

  it('is deterministic, and does not consume simulation RNG state', () => {
    const map = flatMap(48);
    const a = createStartingPlots(map, [{ x: 10, y: 10 }], 3);
    const b = createStartingPlots(map, [{ x: 10, y: 10 }], 3);
    expect(b).toEqual(a);
    expect(createStartingPlots(map, [{ x: 10, y: 10 }], 4)).not.toEqual(a);
  });

  it('prefers low ground, which is where a field belongs', () => {
    const rows = Array.from({ length: 24 }, (_, y) =>
      Array.from({ length: 24 }, () => (y < 12 ? 5 : 0)),
    );
    const map = heightmapFrom(rows, 8);
    const plots = createStartingPlots(map, [{ x: 12, y: 12 }], 1);
    for (const plot of plots) expect(map.data[plot.tileY * 24 + plot.tileX]).toBe(0);
  });

  it('turns a harvest into an income that can carry an army', () => {
    const map = flatMap(48);
    const plots = createStartingPlots(map, [{ x: 10, y: 10 }], 1);
    const withPlots = createEconomy(PLAYERS, 1, plots);
    const barren = createEconomy(PLAYERS, 1, []);
    const world = worldWithTroops(10);
    world.tick = E.upkeepIntervalTicks;

    withPlots.update(world, []);
    barren.update(world, []);

    expect(withPlots.balance(0, Resource.Grain)).toBeGreaterThan(
      barren.balance(0, Resource.Grain),
    );
  });
});

describe('can a player survive their own opening position', () => {
  /**
   * The test that was missing, and the reason a completed playthrough ended in Defeat
   * four minutes in without meeting an enemy.
   *
   * The shipped economy was net -7.1 grain per upkeep at tick zero in perfect weather —
   * income 60 against upkeep 67.1 for the army and herd every player starts with. The
   * 400 starting grain was not a buffer, it was a countdown, and the first drought
   * turned it into a short one. Worse, upkeep scales with cattle held, so closing on the
   * 200-cattle victory condition took the deficit to -21.4: the objective accelerated
   * your own starvation.
   *
   * Nothing in the suite looked at whether the numbers add up, because every economy
   * test asserted a mechanism — upkeep is charged, drought scales yield — and none
   * asserted that a player can live.
   */
  function opening(seed: number) {
    const map = flatMap(48);
    const world = createWorld(128, seed);
    // What a match actually starts with: a Zulu impi and the herd around it.
    for (let i = 0; i < 24; i++) spawn(world, 20 + (i % 6) * 0.5, 20 + (i / 6 | 0) * 0.5, 0);
    for (let i = 0; i < 28; i++) {
      spawn(world, 26 + (i % 7) * 0.5, 26 + (i / 7 | 0) * 0.5, NEUTRAL_FACTION, 1, EntityKind.Cattle);
    }
    const economy = createEconomy(
      [FactionId.Zulu, FactionId.Sotho],
      seed,
      createStartingPlots(map, [{ x: 20, y: 20 }, { x: 40, y: 40 }], seed),
    );
    return { world, economy };
  }

  it('does not starve standing still through a whole year', () => {
    // Every seed is a different drought severity, so this covers mild years and ruinous
    // ones alike.
    for (const seed of [1, 7, 42, 0x51ee, 0xbeef]) {
      const { world, economy } = opening(seed);
      const events: SimEvent[] = [];
      let lowest = Infinity;

      for (let tick = 1; tick <= tuning.economy.seasonTicks; tick++) {
        world.tick = tick;
        economy.update(world, events);
        lowest = Math.min(lowest, economy.balance(0, Resource.Grain));
      }

      expect(lowest, `seed ${seed} ran out of grain doing nothing`).toBeGreaterThan(0);
      expect(
        events.filter((e) => e.type === EventType.Starved).length,
        `seed ${seed} starved its own troops`,
      ).toBe(0);
    }
  });

  it('still makes the dry season hurt', () => {
    // The opposite failure: an economy so generous the mechanic stops mattering. At the
    // height of a bad year the harvest must not cover upkeep, or there is nothing to
    // plan around and sheltered ground is worth nothing.
    const { economy } = opening(0xbeef);
    const season = tuning.economy.seasonTicks;

    let worst = Infinity;
    for (let tick = 0; tick < season; tick += 50) worst = Math.min(worst, -economy.drought(tick));
    const peak = -worst;
    expect(peak).toBeGreaterThan(0.5);

    const open = 1 - peak * peak;
    const income =
      tuning.economy.plotBaseYield *
      (7 * open + 3 * Math.max(open, tuning.economy.shelteredYieldFactor));
    const upkeep = (24 * tuning.economy.grainPerUnit + 148 * tuning.economy.grainPerCattle) * 1.1;
    expect(income, 'the worst of a bad year should not pay for itself').toBeLessThan(upkeep);
  });
});

describe('the herd does not grow into a victory on its own', () => {
  /**
   * A played match was won at tick 10211 without a single order being issued. The ledger
   * herd compounded at 1.5% an upkeep, which carried the Zulu's starting 120 cattle past
   * the 200 needed to win in about eight minutes — so raiding, the mechanic the whole
   * game is built around, was optional.
   *
   * Growth still has to be worth something, or holding a herd stops mattering and the
   * cattle are just a score. These two pin both sides of that.
   */
  function idleHerd(seed: number, cattle = 120) {
    const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], seed, []);
    economy.add(0, Resource.Cattle, cattle - economy.balance(0, Resource.Cattle));
    // Grain enough that upkeep is always paid: this isolates growth from starvation.
    economy.add(0, Resource.Grain, 1_000_000);
    return economy;
  }

  /** Upkeeps in `minutes` of real time. */
  const upkeeps = (minutes: number) =>
    Math.floor((minutes * 60 * 1000) / (TICK_MS * tuning.economy.upkeepIntervalTicks));

  it('does not compound into a herd nobody husbanded', () => {
    // This guard was written when cattle WERE the victory condition and an idle herd
    // reached the winning two hundred in eight minutes. The objective is the village now
    // (ADR-0019), so a runaway herd no longer wins — but it still matters, and the reason
    // inverted rather than went away: every beast eats, so growth the player did not earn
    // is upkeep the player did not plan for. Wealth that accrues on its own is not
    // wealth, it is weather.
    //
    // Twenty-five minutes is already a long match; the last playthrough took eight.
    for (const seed of [1, 7, 0xbeef]) {
      const economy = idleHerd(seed);
      const world = worldWithTroops(0);
      const before = economy.balance(0, Resource.Cattle);

      for (let i = 1; i <= upkeeps(25); i++) {
        world.tick = i * tuning.economy.upkeepIntervalTicks;
        economy.update(world, []);
      }

      // Not doubling in twenty-five minutes is the property; the measured figure is
      // about 1.64, and a bound set at the measurement would be a knife edge rather
      // than a statement.
      const grown = economy.balance(0, Resource.Cattle) / before;
      expect(grown, `seed ${seed}: an idle herd ran away with itself`).toBeLessThan(2);
    }
  });

  it('still rewards holding a herd', () => {
    // The opposite failure: growth nerfed into irrelevance, so cattle become a score
    // rather than wealth and there is no reason to keep what you take.
    const economy = idleHerd(1);
    const world = worldWithTroops(0);
    const before = economy.balance(0, Resource.Cattle);

    for (let i = 1; i <= upkeeps(15); i++) {
      world.tick = i * tuning.economy.upkeepIntervalTicks;
      economy.update(world, []);
    }

    const grown = economy.balance(0, Resource.Cattle);
    expect(grown / before, 'a herd held for fifteen minutes barely grew').toBeGreaterThan(1.15);
  });
});

describe('who pays for a driven herd', () => {
  /**
   * The ledger says "Cattle on the ledger are the standing herd; cattle on the map are
   * the ones being driven. Both eat." Only the first half was true.
   *
   * The headcount charged a cow to `world.faction[i]`, and a cow's faction is set once,
   * at spawn, to NEUTRAL — leashing one changes `tetheredTo` and `herdState` and nothing
   * else. So `herds[]` was always zero and a driven herd cost its owner nothing at all,
   * while still counting toward the cattle victory. Raiding was pure profit, which is
   * not the bargain this game is about: cattle are wealth and a burden together.
   */
  it('charges a driven herd to whoever is driving it', () => {
    const economy = createEconomy(PLAYERS, 1);
    const world = worldWithTroops(4);
    world.tick = E.upkeepIntervalTicks;

    const before = economy.balance(0, Resource.Grain);
    economy.update(world, []);
    const withoutCattle = before - economy.balance(0, Resource.Grain);

    // Same again, but this time the troops are driving a herd.
    const driving = createEconomy(PLAYERS, 1);
    const herded = worldWithTroops(4);
    const herder = packHandle(0, herded.generation[0]!);
    for (let i = 0; i < 8; i++) {
      const cow = spawn(herded, 5 + i * 0.4, 5, NEUTRAL_FACTION, 1, EntityKind.Cattle);
      herded.tetheredTo[handleIndex(cow)] = herder;
      herded.herdState[handleIndex(cow)] = HerdState.Leashed;
    }
    herded.tick = E.upkeepIntervalTicks;

    const startGrain = driving.balance(0, Resource.Grain);
    driving.update(herded, []);
    const withCattle = startGrain - driving.balance(0, Resource.Grain);

    expect(withCattle).toBeGreaterThan(withoutCattle);
    expect(withCattle - withoutCattle).toBeCloseTo(8 * E.grainPerCattle * 1.1, 6);
  });

  it('leaves a wild herd costing nobody anything', () => {
    // Untethered cattle belong to no one and eat no one's grain.
    const economy = createEconomy(PLAYERS, 1);
    const world = worldWithTroops(4);
    for (let i = 0; i < 8; i++) {
      spawn(world, 5 + i * 0.4, 5, NEUTRAL_FACTION, 1, EntityKind.Cattle);
    }
    world.tick = E.upkeepIntervalTicks;

    const bare = createEconomy(PLAYERS, 1);
    const bareWorld = worldWithTroops(4);
    bareWorld.tick = E.upkeepIntervalTicks;

    const a = economy.balance(0, Resource.Grain);
    const b = bare.balance(0, Resource.Grain);
    economy.update(world, []);
    bare.update(bareWorld, []);

    expect(a - economy.balance(0, Resource.Grain)).toBeCloseTo(
      b - bare.balance(0, Resource.Grain),
      6,
    );
  });
});
