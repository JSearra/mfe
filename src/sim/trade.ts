import { tuning } from './tuning.js';
import { Resource, type Economy } from './economy/ledger.js';

/**
 * Trade with a neighbouring village.
 *
 * The third loop of the village game (ADR-0019, roadmap Phase V4), and the first that
 * involves anybody else. A neighbour is somebody who has what you lack and lacks what
 * you have; the whole mechanic is that both of those are true at once and neither side
 * knows it about the other.
 *
 * **Rates come from the OTHER side's books, never from yours.** That is the phase's
 * whole requirement and it is what makes trade feel like dealing with somebody rather
 * than with a shop. A neighbour whose granary is empty will pay a great deal of cattle
 * for grain — and will part with grain cheaply once the harvest is in, whatever your own
 * position. You cannot see their books either, which is why the quote exists: it is the
 * answer they would give, and asking is free.
 *
 * Value is marginal and falls as stock rises: `weight * reference / (reference + held)`.
 * The last bag of grain in an empty store is worth far more than the thousandth in a
 * full one, which is the only property this needs to make scarcity move a price. A
 * linear valuation would make trade a constant exchange rate and there would be nothing
 * to think about.
 */

export const TradeResult = {
  Traded: 0,
  /** The neighbour would be worse off, so it says no. */
  Refused: 1,
  /** Nothing to give, or nothing they can give back. */
  Empty: 2,
  /** A village cannot trade with itself. */
  SameVillage: 3,
} as const;

export type TradeResult = (typeof TradeResult)[keyof typeof TradeResult];

function weightOf(resource: Resource): number {
  const t = tuning.trade;
  if (resource === Resource.Grain) return t.weightGrain;
  if (resource === Resource.Wood) return t.weightWood;
  return t.weightCattle;
}

function referenceOf(resource: Resource): number {
  const t = tuning.trade;
  if (resource === Resource.Grain) return t.referenceGrain;
  if (resource === Resource.Wood) return t.referenceWood;
  return t.referenceCattle;
}

/**
 * What one more unit of a resource is worth to this village, right now.
 *
 * Marginal, so it rises as the store empties. Ammunition has no weight of its own and
 * falls through to the cattle weight, which is harmless because nothing trades it — it
 * is a combat resource and combat is on its way out (roadmap V6).
 */
export function marginalValue(economy: Economy, player: number, resource: Resource): number {
  const reference = referenceOf(resource);
  const held = economy.balance(player, resource);
  return (weightOf(resource) * reference) / (reference + (held < 0 ? 0 : held));
}

/**
 * How much of `wanted` a neighbour will give for `amount` of `offered`, or 0.
 *
 * Asking costs nothing and changes nothing, which matters: a player has no other way to
 * learn what a neighbour is short of, and a trade screen that could only be used by
 * trying it would be a screen nobody used.
 *
 * The neighbour keeps a reserve of whatever is being asked for — nobody trades away the
 * last of anything — and will not accept an offer so large it is really a gift, because
 * a village that would swallow any quantity at the same rate is a shop again.
 */
export function quote(
  economy: Economy,
  partner: number,
  offered: Resource,
  wanted: Resource,
  amount: number,
): number {
  const t = tuning.trade;
  if (amount <= 0 || offered === wanted) return 0;

  const theirs = economy.balance(partner, wanted);
  const reserve = theirs * t.reserveFraction;
  const available = theirs - reserve;
  if (available <= 0) return 0;

  // Valued entirely from the neighbour's side. What they gain is what they think the
  // offer is worth; what they give is what they think they are losing.
  const gainPerUnit = marginalValue(economy, partner, offered);
  const lossPerUnit = marginalValue(economy, partner, wanted);
  if (lossPerUnit <= 0) return 0;

  const affordable = (amount * gainPerUnit) / (lossPerUnit * (1 + t.margin));
  const capped = Math.min(affordable, available, theirs * t.maxOfferFraction);
  return capped > 0 ? capped : 0;
}

/**
 * Offer `amount` of `offered` to `partner` for whatever `wanted` they will give.
 *
 * Executes at the quoted rate or not at all. There is no haggling and no partial fill:
 * a trade that half happens leaves both sides unsure what they agreed to, and the
 * command that carries this is fire-and-forget across a tick boundary.
 */
export function trade(
  economy: Economy,
  player: number,
  partner: number,
  offered: Resource,
  wanted: Resource,
  amount: number,
): TradeResult {
  if (player === partner) return TradeResult.SameVillage;
  if (player >= economy.players || partner >= economy.players) return TradeResult.SameVillage;
  if (amount <= 0 || offered === wanted) return TradeResult.Empty;
  if (economy.balance(player, offered) < amount) return TradeResult.Empty;

  const returned = quote(economy, partner, offered, wanted, amount);
  if (returned <= 0) return TradeResult.Refused;

  // Both sides move together or neither does.
  if (!economy.spend(player, offered, amount)) return TradeResult.Empty;
  if (!economy.spend(partner, wanted, returned)) {
    economy.add(player, offered, amount);
    return TradeResult.Refused;
  }
  economy.add(partner, offered, amount);
  economy.add(player, wanted, returned);
  return TradeResult.Traded;
}

/**
 * The trade this village would most like to make with a neighbour, or null.
 *
 * Used by the AI, and it is the same valuation the player's offers are judged by — so a
 * neighbour asks for what it is short of for the same reason it charges dearly for it.
 * Deliberately not clever: it looks for its own scarcest resource and offers its most
 * plentiful, which is what a village would do and is legible when it happens.
 */
export function wantedTrade(
  economy: Economy,
  player: number,
  partner: number,
): { offered: Resource; wanted: Resource; amount: number } | null {
  const t = tuning.trade;
  const kinds: Resource[] = [Resource.Cattle, Resource.Grain, Resource.Wood];

  let scarcest = kinds[0]!;
  let plentiful = kinds[0]!;
  let highest = -Infinity;
  let lowest = Infinity;

  for (const kind of kinds) {
    const value = marginalValue(economy, player, kind);
    // Ties break on the resource order, so two villages in identical positions make
    // identical decisions and a replay reproduces.
    if (value > highest) {
      highest = value;
      scarcest = kind;
    }
    if (value < lowest) {
      lowest = value;
      plentiful = kind;
    }
  }
  if (scarcest === plentiful) return null;

  const spare = economy.balance(player, plentiful) * (1 - t.reserveFraction);
  const amount = spare * t.maxOfferFraction;
  if (amount <= 0) return null;
  if (quote(economy, partner, plentiful, scarcest, amount) <= 0) return null;

  return { offered: plentiful, wanted: scarcest, amount };
}

/** How much of a resource a single offer moves. A trade is a parcel, not a haggle. */
export function parcelOf(resource: Resource): number {
  const t = tuning.trade;
  if (resource === Resource.Grain) return t.parcelGrain;
  if (resource === Resource.Wood) return t.parcelWood;
  return t.parcelCattle;
}

export interface TradeOffer {
  readonly partner: number;
  readonly offered: Resource;
  readonly wanted: Resource;
  readonly give: number;
  readonly get: number;
}

/**
 * Every trade this village could make right now, with what each would return.
 *
 * This is the "asking is free" half of the design made concrete. A player cannot see a
 * neighbour's books and has no other way to learn what they are short of, so the
 * simulation answers the question on their behalf and the answer crosses with the
 * snapshot. Nothing here changes any state.
 *
 * Offers the village cannot afford, and ones the neighbour would refuse, are left out
 * rather than shown greyed: a list of six things of which four are impossible is worse
 * than a list of two that work.
 */
export function offersFor(economy: Economy, player: number): TradeOffer[] {
  const kinds: Resource[] = [Resource.Cattle, Resource.Grain, Resource.Wood];
  const out: TradeOffer[] = [];

  for (let partner = 0; partner < economy.players; partner++) {
    if (partner === player) continue;
    for (const offered of kinds) {
      const give = parcelOf(offered);
      if (economy.balance(player, offered) < give) continue;
      for (const wanted of kinds) {
        if (wanted === offered) continue;
        const get = quote(economy, partner, offered, wanted, give);
        if (get <= 0) continue;
        out.push({ partner, offered, wanted, give, get });
      }
    }
  }
  return out;
}
