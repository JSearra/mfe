import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import { tuning } from './tuning.js';
import { Resource, type Economy } from './economy/ledger.js';

/**
 * Standing ties with the neighbours.
 *
 * The fourth loop of the village game (ADR-0019, roadmap Phase V5), and the one that
 * makes a neighbour something other than a counterparty. Trade is a transaction: it
 * settles and both sides walk away owing nothing. An alliance does not settle. It costs
 * cattle every season for as long as it stands, and what it returns arrives only if
 * something goes wrong — which means the decision to enter one is a bet on the weather
 * and on the other village, not a price comparison.
 *
 * **The tithe is symmetric in rule and asymmetric in effect.** Both sides send the same
 * *fraction* of their own herd each upkeep, so the wealthier village pays more and the
 * net flow runs from the big herd to the small one. That is what cattle clientage
 * actually was — *ukusisa*, cattle placed with a poorer household, which bought the
 * lender a claim and the borrower a living — and it falls out of one rule rather than
 * needing a patron and a client to be modelled separately.
 *
 * **What comes back is conditional.** An ally who went hungry at the last upkeep is sent
 * grain; an ally who did not is sent nothing. A season where everybody eats is a season
 * the alliance costs you cattle for no visible return, and that is correct: the return
 * is the bad year you have not had yet.
 *
 * **Breaking it costs standing, not blood.** Standing is what a village thinks of you,
 * it is not symmetric, and it prices your trades (src/sim/trade.ts): a village nobody
 * trusts pays a worse rate to everyone, including villages it never dealt with, because
 * word gets around. Standing starts at 1 — a village has no reason to distrust anyone it
 * has not dealt with, which is also what makes the no-regard path in trade.ts the
 * genuinely neutral rate rather than a slightly worse one. Breaking a tie costs half of
 * it and it comes back at 0.004 a season, so an oath-breaker is marked up for seventy-odd
 * seasons and cannot ally with anybody, including villages that only heard about it.
 * That is the cost the roadmap asked for and it is deliberately not a battle — see
 * ADR-0019 on why the war is leaving.
 *
 * Laid out as two player x player matrices rather than as a list of pairs. There are at
 * most a handful of villages, the matrices are hashed and saved whole, and a list would
 * need its own ordering rule to stay deterministic.
 */

export interface Alliance {
  readonly players: number;
  /**
   * players x players, row-major. 1 where the two are tied. Symmetric — an alliance one
   * side does not think it is in is not an alliance.
   */
  readonly bond: Uint8Array;
  /**
   * players x players, row-major: how far row trusts column, 0 to 1.
   *
   * Not symmetric, and that is the point. Walking out on a neighbour costs you their
   * regard, not yours of them.
   */
  readonly standing: Float64Array;
  /**
   * players x players, row-major. 1 where row has offered a tie to column and is still
   * waiting to hear back.
   *
   * A tie needs both sides to want it. `propose` used to form the bond on the spot if
   * the partner's regard was high enough, which meant a neighbour could tie the player
   * into an alliance the player never agreed to — measured in play: the computer
   * village allied itself to a human who had not touched the panel, and leaving cost
   * that human half their standing with everybody. Consent is not the partner's opinion
   * of you; it is the partner saying yes.
   */
  readonly offered: Uint8Array;
  /** Bumped whenever any of the above changes, so a host can skip re-sending it. */
  version: number;
}

export const AllyResult = {
  /** Both sides have now asked. The tie stands. */
  Allied: 0,
  /** Already tied. */
  Standing: 1,
  /** They do not trust you enough to take the offer. */
  Refused: 2,
  /** A village cannot ally with itself, or with somebody who is not there. */
  NoSuchVillage: 3,
  /** Asked, and waiting on them. */
  Offered: 4,
  /** Asked again while an offer of yours was already on the table. */
  AlreadyAsked: 5,
} as const;

export type AllyResult = (typeof AllyResult)[keyof typeof AllyResult];

export function createAlliance(players: number): Alliance {
  const standing = new Float64Array(players * players);
  const start = tuning.alliance.startingStanding;

  for (let row = 0; row < players; row++) {
    for (let column = 0; column < players; column++) {
      // A village trusts itself completely, which keeps the self-quote unaffected by a
      // matrix that would otherwise have a hole in its diagonal.
      standing[row * players + column] = row === column ? 1 : start;
    }
  }

  return {
    players,
    bond: new Uint8Array(players * players),
    standing,
    offered: new Uint8Array(players * players),
    version: 0,
  };
}

export function alliedWith(alliance: Alliance, x: number, y: number): boolean {
  if (x === y || x >= alliance.players || y >= alliance.players) return false;
  return alliance.bond[x * alliance.players + y] === 1;
}

/** How far `of` trusts `toward`. 1 when either is not a player, so callers need no guard. */
export function standingOf(alliance: Alliance, of: number, toward: number): number {
  if (of >= alliance.players || toward >= alliance.players) return 1;
  return alliance.standing[of * alliance.players + toward] ?? 1;
}

function setStanding(alliance: Alliance, of: number, toward: number, value: number): void {
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  alliance.standing[of * alliance.players + toward] = clamped;
}

/** Every village this one is tied to, ascending. */
export function alliesOf(alliance: Alliance, player: number): number[] {
  const out: number[] = [];
  for (let other = 0; other < alliance.players; other++) {
    if (alliedWith(alliance, player, other)) out.push(other);
  }
  return out;
}

/** Has `player` an offer outstanding to `partner`? */
export function hasOffered(alliance: Alliance, player: number, partner: number): boolean {
  if (player === partner || player >= alliance.players || partner >= alliance.players) return false;
  return alliance.offered[player * alliance.players + partner] === 1;
}

/**
 * Ask a neighbour for a standing tie, or take one they have already asked for.
 *
 * **Both sides have to ask.** The first call leaves an offer on the table; the tie forms
 * on the second, from the other direction. That is the whole of the change made after
 * play showed a computer village tying itself to a human who never touched the panel —
 * an alliance costs cattle every season and leaving it costs standing with everybody, so
 * it is not a thing a neighbour gets to decide for you.
 *
 * Standing gates the *acceptance*, not the asking: anyone may ask, and you take the offer
 * only from somebody you think well enough of. There is no negotiation and no gift that
 * buys a refusal off, because the only currency a broken tie costs is that same standing
 * — if it could be bought, breaking a tie would be free.
 */
export function propose(alliance: Alliance, player: number, partner: number): AllyResult {
  if (player === partner) return AllyResult.NoSuchVillage;
  if (player >= alliance.players || partner >= alliance.players) return AllyResult.NoSuchVillage;
  if (alliedWith(alliance, player, partner)) return AllyResult.Standing;

  // Taking an offer already on the table. Judged by what the ACCEPTOR thinks of the one
  // who asked, which is the direction that matters: you decide who you tie yourself to.
  if (hasOffered(alliance, partner, player)) {
    if (standingOf(alliance, player, partner) < tuning.alliance.minStandingToAlly) {
      return AllyResult.Refused;
    }
    alliance.offered[partner * alliance.players + player] = 0;
    alliance.offered[player * alliance.players + partner] = 0;
    alliance.bond[player * alliance.players + partner] = 1;
    alliance.bond[partner * alliance.players + player] = 1;
    alliance.version++;
    return AllyResult.Allied;
  }

  if (hasOffered(alliance, player, partner)) return AllyResult.AlreadyAsked;

  alliance.offered[player * alliance.players + partner] = 1;
  alliance.version++;
  return AllyResult.Offered;
}

/** Withdraw an offer, or turn one down. Costs nothing either way — no tie was made. */
export function withdraw(alliance: Alliance, player: number, partner: number): boolean {
  if (!hasOffered(alliance, player, partner) && !hasOffered(alliance, partner, player)) return false;
  alliance.offered[player * alliance.players + partner] = 0;
  alliance.offered[partner * alliance.players + player] = 0;
  alliance.version++;
  return true;
}

/**
 * Walk away from a tie.
 *
 * The partner's regard takes the full loss and every onlooker takes a share of it. That
 * second part is what makes this a decision rather than a free exit: the village you
 * leave can only refuse to deal with you once, but a reputation is spent against
 * everyone at once and for a long time afterwards.
 */
export function breakBond(
  alliance: Alliance,
  breaker: number,
  partner: number,
  events: SimEvent[],
  tick: number,
): boolean {
  if (!alliedWith(alliance, breaker, partner)) return false;
  const a = tuning.alliance;

  alliance.bond[breaker * alliance.players + partner] = 0;
  alliance.bond[partner * alliance.players + breaker] = 0;
  alliance.offered[breaker * alliance.players + partner] = 0;
  alliance.offered[partner * alliance.players + breaker] = 0;

  setStanding(
    alliance,
    partner,
    breaker,
    standingOf(alliance, partner, breaker) - a.standingLossOnBreak,
  );
  const gossip = a.standingLossOnBreak * a.gossipFraction;
  for (let onlooker = 0; onlooker < alliance.players; onlooker++) {
    if (onlooker === breaker || onlooker === partner) continue;
    setStanding(alliance, onlooker, breaker, standingOf(alliance, onlooker, breaker) - gossip);
  }

  alliance.version++;
  // `x`/`y` carry the two villages rather than a position. Nothing about a broken tie
  // happens anywhere on the map, and the alternative is a second payload slot.
  events.push(makeEvent(tick, EventType.AllianceBroken, 0, breaker, partner, 0));
  return true;
}

/**
 * One season of every standing tie: the tithe out, the relief in, and time passing.
 *
 * Runs on the upkeep cycle and BEFORE the ledger does, which is what makes relief worth
 * anything. Shortfall is last cycle's, so grain sent now arrives in time to be eaten by
 * the mouths that went short — an ally who only heard about the famine a season after it
 * was over would be a tax with a story attached.
 *
 * Every figure is taken from the books as they stood when the season opened, before any
 * of this moved. Settling pair by pair against live balances would mean a village that
 * happened to be settled second tithed on cattle it had just been given, so the order
 * the pairs were visited in would change what everyone paid — deterministic, and still
 * wrong.
 */
export function updateAlliance(
  alliance: Alliance,
  economy: Economy,
  events: SimEvent[],
  tick: number,
): void {
  const a = tuning.alliance;
  const cattleAtDawn = new Float64Array(alliance.players);
  const grainAtDawn = new Float64Array(alliance.players);
  for (let player = 0; player < alliance.players; player++) {
    cattleAtDawn[player] = economy.balance(player, Resource.Cattle);
    grainAtDawn[player] = economy.balance(player, Resource.Grain);
  }

  // Pairs walked as x < y with both directions settled inside, so the order depends on
  // nothing but the player indices and a replay reproduces.
  for (let x = 0; x < alliance.players; x++) {
    for (let y = x + 1; y < alliance.players; y++) {
      if (!alliedWith(alliance, x, y)) continue;
      settle(economy, events, tick, x, y, cattleAtDawn, grainAtDawn);
      settle(economy, events, tick, y, x, cattleAtDawn, grainAtDawn);
    }
  }

  // Regard returns on its own, slowly, tie or no tie. Somebody who broke faith seventy
  // seasons ago is dealt with again eventually.
  let moved = false;
  for (let of = 0; of < alliance.players; of++) {
    for (let toward = 0; toward < alliance.players; toward++) {
      if (of === toward) continue;
      const now = standingOf(alliance, of, toward);
      if (now >= 1) continue;
      setStanding(alliance, of, toward, now + a.standingRecoveryPerUpkeep);
      moved = true;
    }
  }
  if (moved) alliance.version++;
}

/** What `giver` owes `receiver` this cycle: a share of the herd, and grain if needed. */
function settle(
  economy: Economy,
  events: SimEvent[],
  tick: number,
  giver: number,
  receiver: number,
  cattleAtDawn: Float64Array,
  grainAtDawn: Float64Array,
): void {
  const a = tuning.alliance;

  const tithe = (cattleAtDawn[giver] ?? 0) * a.tithePerUpkeep;
  if (tithe > 0 && economy.spend(giver, Resource.Cattle, tithe)) {
    economy.add(receiver, Resource.Cattle, tithe);
  }

  // Conditional, and on the receiver's circumstances rather than the giver's: the point
  // of the tie is the year it pays out, not the years it does not.
  const short = economy.shortfall[receiver] ?? 0;
  if (short <= 0) return;

  const spare = (grainAtDawn[giver] ?? 0) * a.reliefFraction;
  const capped = spare > a.reliefCap ? a.reliefCap : spare;
  const relief = short < capped ? short : capped;
  if (relief <= 0) return;
  if (!economy.spend(giver, Resource.Grain, relief)) return;

  economy.add(receiver, Resource.Grain, relief);
  events.push(makeEvent(tick, EventType.AllianceRelief, 0, giver, receiver, relief));
}

/**
 * What this village's neighbours are to it, one row per neighbour.
 *
 * Crosses the boundary with the snapshot, the way trade offers do and for the same
 * reason: standing is the NEIGHBOUR's opinion, held in simulation state the renderer may
 * not touch, and a player who cannot see it has no way to know why their rates moved or
 * whether an offer of alliance would be taken. Always every neighbour, tied or not — the
 * row for a village you have no dealings with is the one that tells you whether you
 * could have some.
 */
export interface Relation {
  readonly partner: number;
  readonly allied: boolean;
  /** How far the neighbour regards this village, 0 to 1. Theirs of you, not yours of them. */
  readonly standing: number;
  /** Whether they would take an offer of alliance right now. */
  readonly wouldAlly: boolean;
  /** They have asked for a tie and are waiting on an answer. */
  readonly asking: boolean;
  /** This village has asked them, and is waiting. */
  readonly asked: boolean;
}

export function relationsFor(alliance: Alliance, player: number): Relation[] {
  const out: Relation[] = [];
  for (let partner = 0; partner < alliance.players; partner++) {
    if (partner === player) continue;
    const standing = standingOf(alliance, partner, player);
    const allied = alliedWith(alliance, player, partner);
    out.push({
      partner,
      allied,
      standing,
      // Whether a tie is possible at all, which takes both regards clearing the bar:
      // the player has to be willing to accept them, and they to accept the player.
      // `standing` above is theirs of the player, because that is the half the player
      // cannot influence and therefore the half worth showing.
      wouldAlly:
        !allied &&
        standing >= tuning.alliance.minStandingToAlly &&
        standingOf(alliance, player, partner) >= tuning.alliance.minStandingToAlly,
      asking: hasOffered(alliance, partner, player),
      asked: hasOffered(alliance, player, partner),
    });
  }
  return out;
}
