import { isShore, type Heightmap } from '../shared/heightmap.js';
import { tuning } from './tuning.js';
import { Work } from './labour.js';
import { type Economy } from './economy/ledger.js';
import { MeatSource } from '../shared/resources.js';
import { EntityKind, type World } from './world.js';

/**
 * Fishing: the food the weather cannot take away.
 *
 * Every other source in this game answers to the season. Fields fall off as `1 - d²`,
 * the veld stops bearing, the herd grows slower on dry grazing, and a bad year is meant
 * to hurt. A river does not care. That is the whole reason fishing is here and it is why
 * it pays a flat rate: it is not a better field, it is a DIFFERENT SHAPE of income —
 * small, steady, and immune to the one pressure the rest of the economy is built around.
 *
 * Which makes where a village sits matter in a way it did not before. Ground by the
 * water is worth holding through a drought that would empty a village on the open veld,
 * and ground away from it is not. A player who sees that has read the map.
 *
 * Balanced to be a floor rather than a living: a handful of people at the water's edge
 * keep a village from starving and will never feed it to sixty. Two anglers a stretch,
 * because a river bank is not an assembly line — the same diminishing rule the fruit
 * trees use, and for the same reason.
 */

export function updateFishing(
  world: World,
  map: Heightmap,
  economy: Economy,
  tick: number,
): void {
  const f = tuning.fishing;
  if (tick === 0 || tick % tuning.economy.upkeepIntervalTicks !== 0) return;
  if (map.water.length === 0) return;

  /*
   * Counted per tile, not per player, so that crowding is local.
   *
   * Keyed on the tile index with the owner folded in, because two villages fishing the
   * same stretch are not competing for the same hands — each side's people work their
   * own line. Grouping by tile alone would have one village's anglers crowd out the
   * other's, which is a rule about rivalry nobody asked for.
   */
  const caught = new Map<number, number>();

  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
    const owner = world.faction[i]!;
    if (owner >= economy.players) continue;
    // A water carrier at the bank is carrying water, not fishing (ADR-0023).
    if (world.workKind[i] === Work.Water) continue;

    const tileX = Math.floor(world.posX[i]!);
    const tileY = Math.floor(world.posY[i]!);
    if (!isShore(map, tileX, tileY)) continue;

    const key = (tileY * map.width + tileX) * 8 + owner;
    caught.set(key, (caught.get(key) ?? 0) + 1);
  }

  // Walked in key order so the ledger is written in the same sequence on every machine.
  // A Map iterates in insertion order, which depends on entity scan order — which is
  // itself stable, but sorting says so rather than relying on it.
  const keys = [...caught.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    const hands = caught.get(key)!;
    const owner = key % 8;
    const working = hands > f.maxAnglers ? f.maxAnglers : hands;
    // Fish is meat (it spoils and is eaten before grain), recorded as fish so it can be
    // split out into a store of its own if the game ever wants one.
    economy.addMeat(owner, working * f.catchPerUpkeep, MeatSource.Fish);
  }
}
