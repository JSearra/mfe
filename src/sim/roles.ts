import { buildingSpec, BuildingType } from '../shared/buildings/index.js';
import { isEstablished, type Farmland } from './economy/farmland.js';
import { tuning } from './tuning.js';
import { Work } from './labour.js';
import { EntityKind, handleIndex, isAlive, NULL_HANDLE, type World } from './world.js';

/**
 * What each villager is doing, so that it can be drawn doing it.
 *
 * A village of sixty that all look like spearmen is a barracks. This decides nothing and
 * changes nothing about the simulation — it reads state the simulation already keeps and
 * writes one nibble that only the renderer consumes. A villager who walks to a field
 * becomes a field-hand because she is standing in a field, not because anyone assigned
 * her a class: there are no job slots to manage, and the picture follows the work.
 *
 * It rides in the HIGH NIBBLE of `world.flags`, which was allocated, spawned, saved,
 * hashed and transmitted since the beginning without a single system ever writing to it
 * — one byte per entity carrying nothing, documented as such in three places. The
 * snapshot already packs `(flags & 0xf0) | (herdState & 0x0f)` and the renderer already
 * receives it, so this needed no new world array, no new snapshot field and no change to
 * the wire format.
 *
 * Recomputed on an interval rather than every tick. A role is a description of what
 * somebody has been doing for a moment, not an event, and sixty units against thirty
 * fields every tick would be real work for a picture that changes on the scale of
 * seconds.
 */

export const Role = {
  /** Nothing in particular. Drawn as the default figure. */
  None: 0,
  /** Holding a tether. */
  Herder: 1,
  /** Standing in one of this village's established fields. */
  FieldHand: 2,
  /** At the grain store, where things are carried to and from. */
  Carrier: 3,
  /** At the great house, where standing and decision sit. */
  Elder: 4,
} as const;

export type Role = (typeof Role)[keyof typeof Role];

const ROLE_SHIFT = 4;
const ROLE_MASK = 0xf0;

/** The role last recorded for an entity. */
export function roleOf(world: World, index: number): Role {
  return ((world.flags[index]! & ROLE_MASK) >> ROLE_SHIFT) as Role;
}

/**
 * Look at what everyone is standing near, and record it.
 *
 * Order of precedence matters where a villager could answer to two descriptions at once,
 * and it runs most-specific first: holding a tether beats standing near a building,
 * because driving cattle is a thing you are visibly doing and being near a hut is not.
 */
export function updateRoles(world: World, land: Farmland, tick: number): void {
  const r = tuning.roles;
  if (tick % r.intervalTicks !== 0) return;

  const tendSq = tuning.farmland.tendRadius * tuning.farmland.tendRadius;
  const nearSq = r.buildingRadius * r.buildingRadius;

  // Anyone holding a tether, gathered in one pass over the cattle rather than by asking
  // each villager whether some beast is looking at them.
  const herding = new Set<number>();
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Cattle) continue;
    const tether = world.tetheredTo[i]!;
    if (tether === NULL_HANDLE || !isAlive(world, tether)) continue;
    herding.add(handleIndex(tether));
  }

  for (let index = 0; index < world.capacity; index++) {
    if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Unit) continue;

    let role: Role = Role.None;
    // Keeping a kraal is herding too, and it should look like it (Phase B2).
    if (herding.has(index) || world.workKind[index] === Work.Kraal) {
      role = Role.Herder;
    } else {
      const posX = world.posX[index]!;
      const posY = world.posY[index]!;
      const owner = world.faction[index]!;

      for (let f = 0; f < land.count && role === Role.None; f++) {
        if (land.alive[f] === 0 || land.owner[f] !== owner) continue;
        if (!isEstablished(land, f)) continue;
        const dx = land.tileX[f]! + 0.5 - posX;
        const dy = land.tileY[f]! + 0.5 - posY;
        if (dx * dx + dy * dy <= tendSq) role = Role.FieldHand;
      }

      for (let other = 0; other < world.capacity && role === Role.None; other++) {
        if (world.alive[other] !== 1 || world.kind[other] !== EntityKind.Building) continue;
        if (world.faction[other] !== owner) continue;
        const spec = buildingSpec(world.buildingType[other]!);
        // An unfinished site is a building site, not a place of work.
        if (world.buildProgress[other]! < spec.work) continue;
        const dx = world.posX[other]! - posX;
        const dy = world.posY[other]! - posY;
        if (dx * dx + dy * dy > nearSq) continue;

        if (world.buildingType[other] === BuildingType.GrainStore) role = Role.Carrier;
        else if (world.buildingType[other] === BuildingType.Indlunkulu) role = Role.Elder;
      }
    }

    world.flags[index] = (world.flags[index]! & ~ROLE_MASK) | ((role << ROLE_SHIFT) & ROLE_MASK);
  }
}
