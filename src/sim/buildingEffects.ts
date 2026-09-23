import { buildingSpec, type EffectKind } from '../shared/buildings/index.js';
import { EntityKind, type World } from './world.js';

/**
 * What this player's finished buildings are doing to the ground around them.
 *
 * The catalogue can now say that a building DOES something (see `BuildingEffect`); this
 * is how the systems ask. Two queries, because effects come in two shapes and
 * pretending otherwise would mean one of them carrying a sentinel radius:
 *
 *   `effectAt`    — for an effect with reach. A weir shelters the fields near it.
 *   `effectTotal` — for one that belongs to the village. A pit holds grain for whoever
 *                   is hungry, and where it was dug is not the point.
 *
 * Deliberately a scan rather than an index. A village has tens of buildings, not
 * thousands; these are called once per upkeep cycle, which is every two hundred ticks;
 * and an index would be a second copy of the truth that has to be kept in step with
 * construction, demolition and loading a save. The spatial grid exists for the queries
 * that are actually hot, and this is not one of them.
 */

/** Finished, this player's, and carrying an effect of this kind. */
function contributes(world: World, index: number, owner: number, kind: EffectKind): number {
  if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Building) return 0;
  if (world.faction[index] !== owner) return 0;

  const spec = buildingSpec(world.buildingType[index]!);
  if (spec.effect === null || spec.effect.kind !== kind) return 0;
  // A site is not a building. Half a weir holds back no water at all, and paying out on
  // one would make placing the site the whole of the decision.
  if (world.buildProgress[index]! < spec.work) return 0;
  return 1;
}

/**
 * The summed strength of this kind reaching a tile.
 *
 * Summed rather than taken at its maximum: two weirs on the same stretch of field are
 * more work and should be worth more than one, and every effect that wants a ceiling
 * can impose its own at the point of use, where the units are known. Distance is
 * measured on the tile grid with `dx*dx + dy*dy` against the squared radius — no square
 * root, and nothing from the banned list.
 */
export function effectAt(
  world: World,
  owner: number,
  kind: EffectKind,
  tileX: number,
  tileY: number,
): number {
  let total = 0;

  for (let index = 0; index < world.capacity; index++) {
    if (contributes(world, index, owner, kind) === 0) continue;

    const spec = buildingSpec(world.buildingType[index]!);
    const effect = spec.effect!;
    const dx = world.posX[index]! - tileX;
    const dy = world.posY[index]! - tileY;
    if (dx * dx + dy * dy > effect.radius * effect.radius) continue;
    total += effect.strength;
  }
  return total;
}

/** The summed strength of this kind anywhere in the village, ignoring where it stands. */
export function effectTotal(world: World, owner: number, kind: EffectKind): number {
  let total = 0;

  for (let index = 0; index < world.capacity; index++) {
    if (contributes(world, index, owner, kind) === 0) continue;
    total += buildingSpec(world.buildingType[index]!).effect!.strength;
  }
  return total;
}
