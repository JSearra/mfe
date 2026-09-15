import { describe, expect, it } from 'vitest';
import {
  alliedWith,
  alliesOf,
  AllyResult,
  hasOffered,
  breakBond,
  createAlliance,
  propose,
  relationsFor,
  standingOf,
  updateAlliance,
} from '../src/sim/alliance.js';
import { quote } from '../src/sim/trade.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { FactionId } from '../src/shared/factions/index.js';
import type { SimEvent } from '../src/shared/events.js';
import { EventType } from '../src/shared/events.js';
import { tuning } from '../src/sim/tuning.js';
import { CommandKind, makeCommand } from '../src/sim/commands.js';
import { enqueueCommand, step } from '../src/sim/loop.js';
import { makeSim, type Harness } from './simHarness.js';

const A = tuning.alliance;

/** Both sides ask, which is what a tie now takes. */
function ally(alliance: ReturnType<typeof createAlliance>, x: number, y: number): AllyResult {
  propose(alliance, x, y);
  return propose(alliance, y, x);
}
const three = () => createEconomy([FactionId.Zulu, FactionId.Sotho, FactionId.Griqua], 1);

/** Set a player's books to exactly these figures. */
function books(
  economy: ReturnType<typeof three>,
  player: number,
  holdings: { cattle?: number; grain?: number; wood?: number },
): void {
  for (const [resource, amount] of [
    [Resource.Cattle, holdings.cattle],
    [Resource.Grain, holdings.grain],
    [Resource.Wood, holdings.wood],
  ] as const) {
    if (amount === undefined) continue;
    economy.spend(player, resource, economy.balance(player, resource));
    economy.add(player, resource, amount);
  }
}

describe('entering a standing tie', () => {
  it('is mutual, or it is not an alliance', () => {
    const alliance = createAlliance(3);
    expect(ally(alliance, 0, 1)).toBe(AllyResult.Allied);
    expect(alliedWith(alliance, 0, 1)).toBe(true);
    expect(alliedWith(alliance, 1, 0)).toBe(true);
    // The third village is nobody's ally and did not become one.
    expect(alliesOf(alliance, 2)).toEqual([]);
  });

  it('is refused by a neighbour who does not think enough of you', () => {
    const alliance = createAlliance(3);
    // Drag 1's regard for 0 below the bar without touching 0's regard for 1.
    alliance.standing[1 * 3 + 0] = A.minStandingToAlly - 0.01;

    // 0 asks and 1 will not take it, because 1 is the one deciding.
    expect(propose(alliance, 0, 1)).toBe(AllyResult.Offered);
    expect(propose(alliance, 1, 0)).toBe(AllyResult.Refused);
    expect(alliedWith(alliance, 0, 1)).toBe(false);
    // Asking and being refused costs nothing but the asking.
    expect(standingOf(alliance, 1, 0)).toBeCloseTo(A.minStandingToAlly - 0.01);
  });

  it('cannot be made with yourself or with a village that is not there', () => {
    const alliance = createAlliance(2);
    expect(propose(alliance, 0, 0)).toBe(AllyResult.NoSuchVillage);
    expect(propose(alliance, 0, 7)).toBe(AllyResult.NoSuchVillage);
  });
});

describe('what a tie costs and what it returns', () => {
  it('sends the same fraction both ways, so the larger herd pays the larger tithe', () => {
    const economy = three();
    const alliance = createAlliance(3);
    books(economy, 0, { cattle: 1000, grain: 500 });
    books(economy, 1, { cattle: 100, grain: 500 });
    ally(alliance, 0, 1);

    updateAlliance(alliance, economy, [], 200);

    // 0 sent 4 and received 0.4; 1 sent 0.4 and received 4.
    expect(economy.balance(0, Resource.Cattle)).toBeCloseTo(1000 - 4 + 0.4);
    expect(economy.balance(1, Resource.Cattle)).toBeCloseTo(100 - 0.4 + 4);
  });

  it('sends nothing to an ally who ate', () => {
    const economy = three();
    const alliance = createAlliance(3);
    books(economy, 0, { cattle: 0, grain: 900 });
    books(economy, 1, { cattle: 0, grain: 10 });
    ally(alliance, 0, 1);
    economy.shortfall[1] = 0;

    updateAlliance(alliance, economy, [], 200);

    expect(economy.balance(0, Resource.Grain)).toBe(900);
    expect(economy.balance(1, Resource.Grain)).toBe(10);
  });

  it('sends grain to an ally who went short, and only as much as covers it', () => {
    const economy = three();
    const alliance = createAlliance(3);
    books(economy, 0, { cattle: 0, grain: 900 });
    books(economy, 1, { cattle: 0, grain: 10 });
    ally(alliance, 0, 1);
    economy.shortfall[1] = 30;
    const events: SimEvent[] = [];

    updateAlliance(alliance, economy, events, 200);

    // 10% of 900 is 90, capped at the shortfall of 30.
    expect(economy.balance(1, Resource.Grain)).toBeCloseTo(40);
    expect(economy.balance(0, Resource.Grain)).toBeCloseTo(870);
    const relief = events.find((e) => e.type === EventType.AllianceRelief);
    expect(relief?.x).toBe(0);
    expect(relief?.y).toBe(1);
    expect(relief?.payload).toBeCloseTo(30);
  });

  it('gives a share rather than the whole granary when the shortfall is ruinous', () => {
    const economy = three();
    const alliance = createAlliance(3);
    books(economy, 0, { cattle: 0, grain: 600 });
    books(economy, 1, { cattle: 0, grain: 0 });
    ally(alliance, 0, 1);
    economy.shortfall[1] = 5000;

    updateAlliance(alliance, economy, [], 200);

    // 10% of 600, well under the cap and far under the need. Nobody beggars themselves.
    expect(economy.balance(1, Resource.Grain)).toBeCloseTo(60);
    expect(economy.balance(0, Resource.Grain)).toBeCloseTo(540);
  });

  it('costs a village that is not tied to anyone nothing at all', () => {
    const economy = three();
    const alliance = createAlliance(3);
    books(economy, 2, { cattle: 400, grain: 400 });
    economy.shortfall[2] = 90;

    updateAlliance(alliance, economy, [], 200);

    expect(economy.balance(2, Resource.Cattle)).toBe(400);
    expect(economy.balance(2, Resource.Grain)).toBe(400);
  });
});

describe('walking away', () => {
  it('costs the partner’s regard and a share of everybody else’s', () => {
    const alliance = createAlliance(3);
    ally(alliance, 0, 1);
    const events: SimEvent[] = [];

    expect(breakBond(alliance, 0, 1, events, 300)).toBe(true);

    expect(alliedWith(alliance, 0, 1)).toBe(false);
    expect(standingOf(alliance, 1, 0)).toBeCloseTo(A.startingStanding - A.standingLossOnBreak);
    expect(standingOf(alliance, 2, 0)).toBeCloseTo(
      A.startingStanding - A.standingLossOnBreak * A.gossipFraction,
    );
    // The one who was left loses nothing. Standing is what a village thinks of you.
    expect(standingOf(alliance, 0, 1)).toBeCloseTo(A.startingStanding);
    expect(standingOf(alliance, 2, 1)).toBeCloseTo(A.startingStanding);
    expect(events.at(-1)?.type).toBe(EventType.AllianceBroken);
  });

  it('shuts the door on allying again until the regard comes back', () => {
    const alliance = createAlliance(3);
    ally(alliance, 0, 1);
    breakBond(alliance, 0, 1, [], 300);

    // 0 broke faith, so it is 1 who now refuses 0 — standing is not symmetric.
    expect(propose(alliance, 0, 1)).toBe(AllyResult.Offered);
    expect(propose(alliance, 1, 0)).toBe(AllyResult.Refused);

    const economy = three();
    const seasons = Math.ceil(
      (A.minStandingToAlly - (A.startingStanding - A.standingLossOnBreak)) /
        A.standingRecoveryPerUpkeep,
    );
    for (let i = 0; i < seasons; i++) updateAlliance(alliance, economy, [], 200 * (i + 1));

    expect(ally(alliance, 0, 1)).toBe(AllyResult.Allied);
  });

  it('is not a thing you can do to a village you were never tied to', () => {
    const alliance = createAlliance(3);
    expect(breakBond(alliance, 0, 1, [], 300)).toBe(false);
    expect(standingOf(alliance, 1, 0)).toBeCloseTo(A.startingStanding);
  });
});

describe('what standing does to a price', () => {
  const rate = (alliance: ReturnType<typeof createAlliance>, asker: number): number => {
    const economy = three();
    books(economy, 1, { cattle: 600, grain: 600, wood: 600 });
    books(economy, asker, { cattle: 600, grain: 600, wood: 600 });
    return quote(economy, 1, Resource.Wood, Resource.Grain, 40, { alliance, asker });
  };

  it('pays an ally better than a stranger and a stranger better than an oath-breaker', () => {
    const stranger = createAlliance(3);
    const strangerRate = rate(stranger, 0);

    const allied = createAlliance(3);
    ally(allied, 0, 1);
    const alliedRate = rate(allied, 0);

    const broken = createAlliance(3);
    ally(broken, 0, 1);
    breakBond(broken, 0, 1, [], 300);
    const brokenRate = rate(broken, 0);

    expect(alliedRate).toBeGreaterThan(strangerRate);
    expect(strangerRate).toBeGreaterThan(brokenRate);
  });

  it('is felt by villages you never dealt with, because word gets around', () => {
    const broken = createAlliance(3);
    ally(broken, 0, 1);
    breakBond(broken, 0, 1, [], 300);

    const economy = three();
    books(economy, 2, { cattle: 600, grain: 600, wood: 600 });
    books(economy, 0, { cattle: 600, grain: 600, wood: 600 });

    const fromThirdParty = quote(economy, 2, Resource.Wood, Resource.Grain, 40, {
      alliance: broken,
      asker: 0,
    });
    const asStranger = quote(economy, 2, Resource.Wood, Resource.Grain, 40, {
      alliance: createAlliance(3),
      asker: 0,
    });

    expect(fromThirdParty).toBeLessThan(asStranger);
  });

  it('quotes a stranger exactly what it quotes nobody in particular', () => {
    const economy = three();
    books(economy, 1, { cattle: 600, grain: 600, wood: 600 });
    const withRegard = quote(economy, 1, Resource.Wood, Resource.Grain, 40, {
      alliance: createAlliance(3),
      asker: 0,
    });
    const without = quote(economy, 1, Resource.Wood, Resource.Grain, 40);

    // A fresh alliance is the neutral case, so the two must agree — otherwise every
    // existing trade test, and the AI soak, would be measuring a different game from
    // the one the player plays.
    expect(withRegard).toBeCloseTo(without);
  });
});

describe('what the player is told', () => {
  it('reports every neighbour, tied or not, with the neighbour’s own regard', () => {
    const alliance = createAlliance(3);
    ally(alliance, 0, 1);
    alliance.standing[2 * 3 + 0] = 0.2;

    const rows = relationsFor(alliance, 0);

    expect(rows.map((r) => r.partner)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ allied: true, wouldAlly: false });
    expect(rows[1]).toMatchObject({ allied: false, wouldAlly: false });
    expect(rows[1]!.standing).toBeCloseTo(0.2);
  });
});

describe('a tie inside a running game', () => {
  /** Empty the books and set them to exactly these figures. */
  function setBooks(sim: Harness, player: number, cattle: number, grain: number): void {
    for (const [resource, amount] of [
      [Resource.Cattle, cattle],
      [Resource.Grain, grain],
    ] as const) {
      sim.economy.spend(player, resource, sim.economy.balance(player, resource));
      sim.economy.add(player, resource, amount);
    }
  }

  it('is made by command, and the tithe leaves on the next upkeep', () => {
    const sim = makeSim();
    // Both sides ask. One command leaves an offer standing and nothing else.
    enqueueCommand(sim.loop, makeCommand(0, 0, 0, CommandKind.Ally, 1));
    step(sim.loop);
    expect(alliedWith(sim.alliance, 0, 1)).toBe(false);
    enqueueCommand(sim.loop, makeCommand(sim.world.tick, 1, 0, CommandKind.Ally, 0));
    step(sim.loop);

    expect(alliedWith(sim.alliance, 0, 1)).toBe(true);
    // The event names whoever closed the tie, which is the side that answered.
    const formed = sim.loop.events.find((e) => e.type === EventType.AllianceFormed);
    expect(formed).toMatchObject({ x: 1, y: 0 });

    setBooks(sim, 0, 500, 5000);
    setBooks(sim, 1, 0, 5000);
    // Up to and including the tick the upkeep lands on: the cycle fires inside the step
    // that starts with world.tick already at the interval.
    const upkeep = tuning.economy.upkeepIntervalTicks;
    while (sim.world.tick <= upkeep) step(sim.loop);

    // Two cattle out of five hundred, and nobody else had any to send back. A range
    // rather than a figure because the ledger's own herd growth runs afterwards on the
    // same cycle, and that is not what this is measuring.
    expect(sim.economy.balance(1, Resource.Cattle)).toBeGreaterThan(1.9);
    expect(sim.economy.balance(1, Resource.Cattle)).toBeLessThan(2.5);
  });

  it('relieves an ally in time for them to eat, not a season later', () => {
    const sim = makeSim();
    enqueueCommand(sim.loop, makeCommand(0, 0, 0, CommandKind.Ally, 1));
    enqueueCommand(sim.loop, makeCommand(0, 1, 0, CommandKind.Ally, 0));
    step(sim.loop);

    // 1 goes into the cycle owing grain it has not got; 0 has plenty.
    setBooks(sim, 0, 0, 4000);
    setBooks(sim, 1, 0, 0);
    sim.economy.shortfall[1] = 50;

    const upkeep = tuning.economy.upkeepIntervalTicks;
    while (sim.world.tick <= upkeep) step(sim.loop);

    // The relief was in the granary before the ledger charged upkeep against it, which
    // is the whole reason updateAlliance runs ahead of economy.update.
    const relief = sim.loop.events.find((e) => e.type === EventType.AllianceRelief);
    expect(relief?.y).toBe(1);
    expect(relief?.payload).toBeCloseTo(50);
  });

  it('refuses an offer from a village it has no reason to trust', () => {
    const sim = makeSim();
    // 1 asks. 0 thinks too little of 1 to take it, and 0 is the one deciding.
    sim.alliance.standing[0 * sim.alliance.players + 1] = 0.1;
    enqueueCommand(sim.loop, makeCommand(0, 1, 0, CommandKind.Ally, 0));
    step(sim.loop);
    enqueueCommand(sim.loop, makeCommand(sim.world.tick, 0, 0, CommandKind.Ally, 1));
    step(sim.loop);

    expect(alliedWith(sim.alliance, 0, 1)).toBe(false);
    expect(sim.loop.events.some((e) => e.type === EventType.AllianceRefused)).toBe(true);
  });

  it('never ties a village in without it having asked', () => {
    const sim = makeSim();
    // The neighbour asks and nobody answers. This is the whole of the bug that play
    // found: the computer village used to tie itself to a human who never touched the
    // panel, and leaving cost that human half their standing with everybody.
    enqueueCommand(sim.loop, makeCommand(0, 1, 0, CommandKind.Ally, 0));
    for (let i = 0; i < 600; i++) step(sim.loop);

    expect(alliedWith(sim.alliance, 0, 1)).toBe(false);
    expect(hasOffered(sim.alliance, 1, 0)).toBe(true);
    // And the player is told, rather than finding out from their cattle count.
    const asked = sim.loop.events.find((e) => e.type === EventType.AllianceOffered);
    expect(asked).toMatchObject({ x: 1, y: 0 });
  });

  it('lets an offer be turned down at no cost, unlike breaking a tie', () => {
    const sim = makeSim();
    enqueueCommand(sim.loop, makeCommand(0, 1, 0, CommandKind.Ally, 0));
    step(sim.loop);
    enqueueCommand(sim.loop, makeCommand(sim.world.tick, 0, 0, CommandKind.Break, 1));
    step(sim.loop);

    expect(hasOffered(sim.alliance, 1, 0)).toBe(false);
    expect(alliedWith(sim.alliance, 0, 1)).toBe(false);
    // No tie was made, so nothing was broken and no regard was spent.
    expect(standingOf(sim.alliance, 1, 0)).toBeCloseTo(A.startingStanding);
  });

  it('is broken by command, and the cost lands on the one who broke it', () => {
    const sim = makeSim();
    enqueueCommand(sim.loop, makeCommand(0, 0, 0, CommandKind.Ally, 1));
    enqueueCommand(sim.loop, makeCommand(0, 1, 0, CommandKind.Ally, 0));
    step(sim.loop);
    expect(alliedWith(sim.alliance, 0, 1)).toBe(true);
    enqueueCommand(sim.loop, makeCommand(sim.world.tick, 0, 1, CommandKind.Break, 1));
    step(sim.loop);

    expect(alliedWith(sim.alliance, 0, 1)).toBe(false);
    expect(standingOf(sim.alliance, 1, 0)).toBeCloseTo(
      A.startingStanding - A.standingLossOnBreak,
    );
    expect(standingOf(sim.alliance, 0, 1)).toBeCloseTo(A.startingStanding);
  });
});
