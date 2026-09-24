import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import { alliesOf, AllyResult, hasOffered, propose, standingOf, type Alliance } from './alliance.js';
import { Resource, type Economy } from './economy/ledger.js';
import { tuning } from './tuning.js';

/**
 * The neighbours, off the map (ADR-0021, roadmap Phase B4).
 *
 * A neighbour used to be a second village simulated on the map, run by the AI in
 * src/sim/ai/opponent.ts: its own huts, fields and herds, its own starving people. With
 * no race left there was nothing for it to do there but trade and ally, and both of those
 * happen on its BOOKS. So the books are all that is left of it. What its stores are
 * when nobody simulates its village is this file.
 *
 * **Its seasons follow the same weather as the player's.** Its harvest falls off with
 * the drought on the same `1 - d²` curve as an open field, and it eats the year's mean
 * whatever the weather. So in a dry year its granary runs down, grain gets dear on the
 * trade screen, and it may go hungry — the same year the player's does.
 * Scarcity that arrives for everyone at once is the whole reason trade is worth
 * anything; a neighbour whose stores ignored the season would be a shop.
 *
 * **Its herd and its wood recover toward what a village like it would hold.** Trade
 * takes from them and ties tithe them, and a neighbour that never recovered would be
 * stripped in a year and then worthless. It recovers a share of the gap each season,
 * not all of it, so a player who has just bought all its timber pays for the next load.
 *
 * **It answers ties the way the AI did.** It takes an offer from anybody it thinks well
 * enough of while it has no ally, and asks for one itself when it has gone hungry and
 * has nobody. It never breaks one: that is a player's move, and costs reputation the
 * mechanic exists to charge.
 *
 * It never initiates a trade. A trade takes from the other side's stores, and the
 * consent gap that let the on-map neighbour empty a player's woodpile while they looked
 * elsewhere is closed by only the asker trading (see the note in the AI's trade branch).
 */

/**
 * Run one season for each village that is not on the map.
 *
 * On the upkeep cycle, before the alliances settle, so a neighbour that went hungry this
 * season is one an ally can send grain to — the same order the on-map villages use.
 */
export function updateNeighbours(
  economy: Economy,
  alliance: Alliance,
  events: SimEvent[],
  tick: number,
): void {
  const n = tuning.neighbours;
  if (tick === 0 || tick % tuning.economy.upkeepIntervalTicks !== 0) return;

  const drought = economy.drought(tick);
  const open = 1 - drought * drought;
  const season = Math.round(tick / tuning.economy.upkeepIntervalTicks);

  for (let player = 0; player < economy.players; player++) {
    if (economy.offMap[player] !== 1) continue;

    // --- grain: back toward a full granary, pushed about by the weather ----------
    //
    // Two terms. A pull toward what a village like it keeps in store, so it never
    // wanders off to a granary that cannot be short of anything or one that is always
    // empty. And the season: above the year's mean harvest it puts grain by, below it it
    // eats into its store — hard, in the years the drought is at full spread, which is
    // when its granary runs out and grain becomes the dearest thing on the trade screen.
    const before = economy.balance(player, Resource.Grain);
    const weather = n.harvestSwing * (open - n.meanHarvest);
    const next = before + (n.grainHeld - before) * n.recoveryShare + weather;
    economy.harvested[player] = n.harvestSwing * open;
    economy.upkeep[player] = n.harvestSwing * n.meanHarvest;
    if (next >= 0) {
      economy.add(player, Resource.Grain, next - before);
      economy.shortfall[player] = 0;
    } else {
      economy.spend(player, Resource.Grain, before);
      // Gone hungry: this is what an ally's relief answers, and what makes it ask.
      economy.shortfall[player] = -next;
    }

    // --- herd and wood: back toward what a village like it would hold -------------
    recover(economy, player, Resource.Cattle, n.cattleHeld, n.recoveryShare);
    recover(economy, player, Resource.Wood, n.woodHeld, n.recoveryShare);

    // --- ties ------------------------------------------------------------------
    if (alliesOf(alliance, player).length > 0) continue;
    let answered = false;
    for (let other = 0; other < economy.players; other++) {
      if (other === player || !hasOffered(alliance, other, player)) continue;
      // Judged by what IT thinks of them, which is the direction consent runs in.
      if (standingOf(alliance, player, other) < tuning.alliance.minStandingToAlly) continue;
      if (propose(alliance, player, other) === AllyResult.Allied) {
        events.push(makeEvent(tick, EventType.AllianceFormed, 0, player, other));
      }
      answered = true;
      break;
    }
    // Asking is slow: a village that offered a tie every season would be begging.
    if (answered || economy.shortfall[player]! <= 0 || season % n.askEverySeasons !== 0) continue;
    let best = -1;
    let bestStanding = -Infinity;
    for (let other = 0; other < economy.players; other++) {
      if (other === player || economy.offMap[other] === 1) continue;
      if (hasOffered(alliance, player, other)) continue;
      const regard = standingOf(alliance, other, player);
      // Strictly better, so a tie keeps the lower index.
      if (regard > bestStanding) {
        bestStanding = regard;
        best = other;
      }
    }
    if (best !== -1 && propose(alliance, player, best) === AllyResult.Offered) {
      events.push(makeEvent(tick, EventType.AllianceOffered, 0, player, best));
    }
  }
}

function recover(
  economy: Economy,
  player: number,
  resource: Resource,
  held: number,
  share: number,
): void {
  const gap = held - economy.balance(player, resource);
  if (gap > 0) economy.add(player, resource, gap * share);
}
