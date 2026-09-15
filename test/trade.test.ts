import { describe, expect, it } from 'vitest';
import { marginalValue, quote, trade, TradeResult, wantedTrade } from '../src/sim/trade.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { FactionId } from '../src/shared/factions/index.js';
import { tuning } from '../src/sim/tuning.js';

const T = tuning.trade;
const two = () => createEconomy([FactionId.Zulu, FactionId.Sotho], 1);

/** Set a player's books to exactly these figures. */
function books(
  economy: ReturnType<typeof two>,
  player: number,
  holdings: { cattle?: number; grain?: number; wood?: number },
) {
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

describe('what a village thinks a thing is worth', () => {
  it('values the last of something far above the thousandth', () => {
    const economy = two();
    books(economy, 0, { grain: 10 });
    const scarce = marginalValue(economy, 0, Resource.Grain);
    books(economy, 0, { grain: 5000 });
    const plentiful = marginalValue(economy, 0, Resource.Grain);

    expect(scarce).toBeGreaterThan(plentiful * 5);
  });

  it('falls as the store fills, and never to nothing', () => {
    const economy = two();
    let previous = Infinity;
    for (const grain of [0, 50, 200, 800, 4000]) {
      books(economy, 0, { grain });
      const value = marginalValue(economy, 0, Resource.Grain);
      expect(value).toBeLessThan(previous);
      expect(value).toBeGreaterThan(0);
      previous = value;
    }
  });
});

describe('a rate that moves with the other side\'s scarcity', () => {
  /**
   * The requirement of the phase. A neighbour whose granary is empty pays dearly for
   * grain; one who has just harvested parts with it cheaply. Neither depends on what the
   * asking village holds — the books being read are the neighbour's.
   */
  it('pays more for what the neighbour is short of', () => {
    const hungry = two();
    books(hungry, 1, { grain: 20, cattle: 400 });
    const whenShort = quote(hungry, 1, Resource.Grain, Resource.Cattle, 50);

    const fed = two();
    books(fed, 1, { grain: 3000, cattle: 400 });
    const whenFull = quote(fed, 1, Resource.Grain, Resource.Cattle, 50);

    expect(whenShort).toBeGreaterThan(whenFull);
  });

  it('does not depend on what the asking village holds', () => {
    const poor = two();
    books(poor, 0, { grain: 1, cattle: 1, wood: 1 });
    books(poor, 1, { grain: 200, cattle: 300, wood: 100 });

    const rich = two();
    books(rich, 0, { grain: 9000, cattle: 9000, wood: 9000 });
    books(rich, 1, { grain: 200, cattle: 300, wood: 100 });

    expect(quote(poor, 1, Resource.Wood, Resource.Grain, 30)).toBeCloseTo(
      quote(rich, 1, Resource.Wood, Resource.Grain, 30),
      6,
    );
  });

  it('keeps a reserve, and will not be bought out', () => {
    const economy = two();
    books(economy, 1, { grain: 100, cattle: 0 });
    // An enormous offer still cannot take more than the neighbour will part with.
    const returned = quote(economy, 1, Resource.Cattle, Resource.Grain, 100_000);
    expect(returned).toBeLessThanOrEqual(100 * T.maxOfferFraction + 1e-9);
  });

  it('offers nothing it has not got', () => {
    const economy = two();
    books(economy, 1, { wood: 0 });
    expect(quote(economy, 1, Resource.Grain, Resource.Wood, 50)).toBe(0);
  });
});

describe('making the trade', () => {
  it('moves both sides together', () => {
    const economy = two();
    books(economy, 0, { wood: 300, grain: 0 });
    books(economy, 1, { wood: 0, grain: 600 });

    const expected = quote(economy, 1, Resource.Wood, Resource.Grain, 100);
    expect(expected).toBeGreaterThan(0);

    expect(trade(economy, 0, 1, Resource.Wood, Resource.Grain, 100)).toBe(TradeResult.Traded);
    expect(economy.balance(0, Resource.Wood)).toBe(200);
    expect(economy.balance(0, Resource.Grain)).toBeCloseTo(expected, 6);
    expect(economy.balance(1, Resource.Wood)).toBe(100);
    expect(economy.balance(1, Resource.Grain)).toBeCloseTo(600 - expected, 6);
  });

  it('can be refused, and changes nothing when it is', () => {
    const economy = two();
    // The neighbour has no grain to give, so there is no trade to be had.
    books(economy, 0, { cattle: 500 });
    books(economy, 1, { grain: 0 });
    const before = economy.balance(0, Resource.Cattle);

    expect(trade(economy, 0, 1, Resource.Cattle, Resource.Grain, 50)).toBe(TradeResult.Refused);
    expect(economy.balance(0, Resource.Cattle)).toBe(before);
  });

  it('refuses what the asking village cannot pay', () => {
    const economy = two();
    books(economy, 0, { wood: 5 });
    books(economy, 1, { grain: 900 });
    expect(trade(economy, 0, 1, Resource.Wood, Resource.Grain, 400)).toBe(TradeResult.Empty);
  });

  it('will not let a village trade with itself', () => {
    const economy = two();
    expect(trade(economy, 0, 0, Resource.Wood, Resource.Grain, 10)).toBe(TradeResult.SameVillage);
  });

  it('leaves the two sides no worse off by their own reckoning', () => {
    // Both sides gain by their OWN valuation, which is what makes this a trade rather
    // than a transfer — and is true even though neither can see the other's books.
    const economy = two();
    books(economy, 0, { wood: 400, grain: 30 });
    books(economy, 1, { wood: 20, grain: 800 });

    const worth = (player: number) =>
      economy.balance(player, Resource.Wood) * marginalValue(economy, player, Resource.Wood) +
      economy.balance(player, Resource.Grain) * marginalValue(economy, player, Resource.Grain);

    const before = [worth(0), worth(1)];
    expect(trade(economy, 0, 1, Resource.Wood, Resource.Grain, 120)).toBe(TradeResult.Traded);

    expect(worth(0)).toBeGreaterThan(before[0]!);
    expect(worth(1)).toBeGreaterThan(before[1]!);
  });
});

describe('what a neighbour asks for', () => {
  it('asks for what it is short of and offers what it has most of', () => {
    const economy = two();
    books(economy, 0, { cattle: 900, grain: 15, wood: 400 });
    books(economy, 1, { cattle: 100, grain: 900, wood: 100 });

    const deal = wantedTrade(economy, 0, 1);
    expect(deal).not.toBeNull();
    expect(deal!.wanted).toBe(Resource.Grain);
    expect(deal!.offered).not.toBe(Resource.Grain);
  });

  it('asks for nothing when the neighbour has nothing it needs', () => {
    const economy = two();
    books(economy, 0, { cattle: 500, grain: 500, wood: 500 });
    books(economy, 1, { cattle: 0, grain: 0, wood: 0 });
    expect(wantedTrade(economy, 0, 1)).toBeNull();
  });

  it('decides the same way twice, so a replay reproduces', () => {
    const a = two();
    const b = two();
    for (const economy of [a, b]) {
      books(economy, 0, { cattle: 700, grain: 40, wood: 300 });
      books(economy, 1, { cattle: 150, grain: 800, wood: 90 });
    }
    expect(wantedTrade(a, 0, 1)).toEqual(wantedTrade(b, 0, 1));
  });
});
