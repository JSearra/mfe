import { tuning } from './tuning.js';
import { Resource, type Economy } from './economy/ledger.js';
import { EntityKind, handleIndex, isAlive, NULL_HANDLE, type World } from './world.js';

/**
 * Slaughtering from the standing herd.
 *
 * The lever the game was missing. Cattle grow on their own when the village is fed and
 * eat grain every season whether it wants them to or not, and until this there was no
 * way to refuse: trade moved eight head a parcel at a rate set by a neighbour who was
 * usually as hungry as you. Measured in play, a village went from 120 head to 160 while
 * its people starved to the last one.
 *
 * Killing cattle for the meat is what a village actually does in a bad year, and it is a
 * real decision rather than a free out — the herd is the wealth, the victory condition
 * counts it, and it does not come back quickly at a growth rate of 0.4 per hundred a
 * season. Spending it to eat is meant to hurt.
 */

/** Head a slaughter would take right now. 0 when there is nothing to take. */
export function cullHead(economy: Economy, player: number): number {
  const held = economy.balance(player, Resource.Cattle);
  const size = tuning.herd.cullSize;
  const taken = held < size ? held : size;
  return taken > 0 ? Math.floor(taken) : 0;
}

/** Slaughter, returning the head taken. Zero means nothing happened. */
export function cull(economy: Economy, player: number): number {
  const taken = cullHead(economy, player);
  if (taken <= 0) return 0;
  if (!economy.spend(player, Resource.Cattle, taken)) return 0;
  // Meat and hides, as a slaughter actually yields — not grain, which it used to be
  // paid in because grain was the only food the ledger knew (ADR-0022).
  economy.add(player, Resource.Meat, taken * tuning.herd.meatPerBeast);
  economy.add(player, Resource.Skins, taken * tuning.herd.skinsPerBeast);
  return taken;
}

/**
 * Cattle this village currently has a hand on.
 *
 * Counted through the tether, which is how the ledger and the victory condition both
 * count a herd — cattle are neutral and belong to whoever is driving them, not to a
 * faction. Crosses the boundary so the player can see that taking a herd worked: the
 * only feedback before was a line in the debug overlay.
 */
export function drivenBy(world: World, player: number): number {
  let driven = 0;
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Cattle) continue;
    const tether = world.tetheredTo[i]!;
    if (tether === NULL_HANDLE || !isAlive(world, tether)) continue;
    if (world.faction[handleIndex(tether)] === player) driven++;
  }
  return driven;
}
