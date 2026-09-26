import { isFreshShore, type Heightmap } from '../shared/heightmap.js';
import { BuildingType } from '../shared/buildings/index.js';
import { Resource, type Economy } from './economy/ledger.js';
import { Work } from './labour.js';
import { tuning } from './tuning.js';
import { EntityKind, type World } from './world.js';

/**
 * Water carried from the river (ADR-0023).
 *
 * Carriers stand at a bank labour chose for them and bring back water each upkeep. What
 * one carrier brings falls with the distance from that bank to the nearest dwelling —
 * a long walk is fewer trips, `carryPerUpkeep / (1 + distance / carryHalfDistance)` —
 * and with the drought, which lowers the river but never below `riverDroughtFloor`.
 * Wells, the rain and the weir are the ledger's business; this is only the carrying.
 *
 * A bank is drawn by at most `maxCarriers`: a crowd at one spot is a crowd, not more
 * water. Everything is walked in index order and paid in player order, so the ledger is
 * written in the same sequence on every machine.
 */
export function updateWaterCarrying(world: World, map: Heightmap, economy: Economy, tick: number): void {
  const w = tuning.water;
  if (tick === 0 || tick % tuning.economy.upkeepIntervalTicks !== 0) return;
  if (map.water.length === 0) return;

  const flow = Math.max(w.riverDroughtFloor, 1 - economy.drought(tick));
  const perBank = new Map<number, number>();
  const carried = new Float64Array(economy.players);

  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
    if (world.workKind[i] !== Work.Water || world.injured[i]! > 0) continue;
    const owner = world.faction[i]!;
    if (owner >= economy.players) continue;
    const tileX = Math.floor(world.posX[i]!);
    const tileY = Math.floor(world.posY[i]!);
    // At the bank, not on the way to it.
    if (!isFreshShore(map, tileX, tileY)) continue;
    const bank = tileY * map.width + tileX;
    const key = bank * 8 + owner;
    const already = perBank.get(key) ?? 0;
    if (already >= w.maxCarriers) continue;
    perBank.set(key, already + 1);

    const home = nearestDwelling(world, owner, tileX + 0.5, tileY + 0.5);
    const factor = 1 / (1 + home / w.carryHalfDistance);
    carried[owner] = carried[owner]! + w.carryPerUpkeep * factor * flow;
  }

  for (let player = 0; player < economy.players; player++) {
    if (carried[player]! > 0) economy.add(player, Resource.Water, carried[player]!);
  }
}

/** Distance to this village's nearest finished dwelling, or the carrying half-distance ×4 if it has none. */
function nearestDwelling(world: World, owner: number, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Building || world.faction[i] !== owner) continue;
    const type = world.buildingType[i];
    if (type !== BuildingType.Umuzi && type !== BuildingType.Indlunkulu) continue;
    const dx = world.posX[i]! - x;
    const dy = world.posY[i]! - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < best) best = distance;
  }
  return best === Infinity ? tuning.water.carryHalfDistance * 4 : best;
}
