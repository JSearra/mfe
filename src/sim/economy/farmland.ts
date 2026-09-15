import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import { FARMLAND_STRIDE } from '../../shared/farmland.js';
import { tuning } from '../tuning.js';
import { EntityKind, type World } from '../world.js';
import { Resource, type Economy } from './ledger.js';

/**
 * Fields: ground a village has broken, and has to keep.
 *
 * Plots used to be laid out once at map generation and to yield forever, which made
 * arable land a property of the map rather than a decision. A field is now sited by
 * command, takes work to establish before it pays anything, and loses condition if
 * nobody tends it — so committing land is a bet placed a season ahead of the weather it
 * will be judged by (ADR-0019, roadmap Phase V3).
 *
 * **Cattle and crops want the same ground, and that is the point.** A beast standing in
 * a field eats and tramples it; a villager standing there brings it back. The herd is
 * the village's wealth and the fields are its food, and they cannot both have the low
 * ground near the homestead. That is the first scarcity in this game the player creates
 * rather than inherits from the season — the drought arrives on a timer and treats
 * everyone alike, but where the herd grazes is a choice.
 *
 * Structured like the woodland rather than like an entity: parallel arrays with a live
 * count, no handles, no pathing, nothing in the cost layers. Fields do not block
 * movement — that is what lets cattle wander into them.
 */

export interface Farmland {
  readonly capacity: number;
  count: number;
  readonly tileX: Float64Array;
  readonly tileY: Float64Array;
  readonly owner: Uint8Array;
  /** 1 for a river bottom or kloof, which keeps yielding when the open veld does not. */
  readonly sheltered: Uint8Array;
  /** Work put in so far. Below `establishWork` the field is broken ground, not a crop. */
  readonly work: Float64Array;
  /** 0..1. What the field will actually return of what it could. */
  readonly condition: Float64Array;
  readonly alive: Uint8Array;
  /** Bumped when the fields look different, so a host can skip re-sending them. */
  version: number;
}

export const PlantResult = {
  Planted: 0,
  OffMap: 1,
  /** Stone, or ground too high to break. */
  Unsuitable: 2,
  /** Another field is already there. */
  Occupied: 3,
  Unaffordable: 4,
  Full: 5,
} as const;

export type PlantResult = (typeof PlantResult)[keyof typeof PlantResult];

export function isEstablished(land: Farmland, index: number): boolean {
  return land.work[index]! >= tuning.farmland.establishWork;
}

export function createFarmland(capacity = tuning.farmland.capacity): Farmland {
  return {
    capacity,
    count: 0,
    tileX: new Float64Array(capacity),
    tileY: new Float64Array(capacity),
    owner: new Uint8Array(capacity),
    sheltered: new Uint8Array(capacity),
    work: new Float64Array(capacity),
    condition: new Float64Array(capacity),
    alive: new Uint8Array(capacity),
    version: 0,
  };
}

function add(
  land: Farmland,
  tileX: number,
  tileY: number,
  owner: number,
  sheltered: boolean,
  work: number,
  condition: number,
): number {
  let slot = -1;
  for (let i = 0; i < land.count; i++) {
    if (land.alive[i] === 0) {
      slot = i;
      break;
    }
  }
  if (slot === -1) {
    if (land.count >= land.capacity) return -1;
    slot = land.count++;
  }

  land.tileX[slot] = tileX;
  land.tileY[slot] = tileY;
  land.owner[slot] = owner;
  land.sheltered[slot] = sheltered ? 1 : 0;
  land.work[slot] = work;
  land.condition[slot] = condition;
  land.alive[slot] = 1;
  land.version++;
  return slot;
}

/** Ground that will take a crop: not bare stone, not the high sourveld. */
export function canPlant(map: Heightmap, tileX: number, tileY: number): boolean {
  const f = tuning.farmland;
  const level = heightAt(map, tileX, tileY);
  return level >= f.minBand && level <= f.maxBand;
}

/**
 * Break new ground. Costs seed grain, and pays nothing until it is established.
 *
 * The cost is paid at siting rather than on completion, so an abandoned field is a loss
 * rather than a free option — which is what makes committing land a decision.
 */
export function plant(
  land: Farmland,
  economy: Economy,
  map: Heightmap,
  owner: number,
  tileX: number,
  tileY: number,
): PlantResult {
  const f = tuning.farmland;
  if (heightAt(map, tileX, tileY) < 0) return PlantResult.OffMap;
  if (!canPlant(map, tileX, tileY)) return PlantResult.Unsuitable;

  for (let i = 0; i < land.count; i++) {
    if (land.alive[i] === 0) continue;
    const dx = land.tileX[i]! - tileX;
    const dy = land.tileY[i]! - tileY;
    if (dx * dx + dy * dy < f.minSpacing * f.minSpacing) return PlantResult.Occupied;
  }

  if (economy.balance(owner, Resource.Grain) < f.seedGrain) return PlantResult.Unaffordable;
  // Sheltered ground is a property of where it is, not of who broke it: a field in a
  // river bottom keeps producing in a drought whoever planted it.
  const sheltered = heightAt(map, tileX, tileY) <= f.minBand;
  if (add(land, tileX, tileY, owner, sheltered, 0, 1) === -1) return PlantResult.Full;

  economy.spend(owner, Resource.Grain, f.seedGrain);
  return PlantResult.Planted;
}

/** Abandon a field. The seed is not refunded. */
export function abandon(land: Farmland, index: number): boolean {
  if (index < 0 || index >= land.count || land.alive[index] === 0) return false;
  land.alive[index] = 0;
  land.version++;
  return true;
}

/**
 * Break, tend, graze and wither. Runs on the upkeep cycle with the ledger that pays for
 * it, and returns nothing — the harvest itself is collected by the ledger, which owns
 * the weather.
 */
export function updateFarmland(world: World, land: Farmland, players: number): void {
  const f = tuning.farmland;
  const tendSq = f.tendRadius * f.tendRadius;
  const grazeSq = f.grazeRadius * f.grazeRadius;
  let looksDifferent = false;

  for (let index = 0; index < land.count; index++) {
    if (land.alive[index] === 0) continue;
    const owner = land.owner[index]!;
    if (owner >= players) continue;

    const centreX = land.tileX[index]! + 0.5;
    const centreY = land.tileY[index]! + 0.5;

    let hands = 0;
    let beasts = 0;
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] !== 1) continue;
      const dx = world.posX[i]! - centreX;
      const dy = world.posY[i]! - centreY;

      if (world.kind[i] === EntityKind.Cattle) {
        if (dx * dx + dy * dy <= grazeSq) beasts++;
        continue;
      }
      // Only the owner's people work it. A neighbour standing in your field is not help.
      if (world.kind[i] !== EntityKind.Unit || world.faction[i] !== owner) continue;
      if (dx * dx + dy * dy <= tendSq) hands++;
    }

    const working = hands > f.maxHands ? f.maxHands : hands;

    // --- breaking the ground ---------------------------------------------------
    if (!isEstablished(land, index)) {
      if (working > 0) {
        const before = isEstablished(land, index);
        land.work[index] = land.work[index]! + working * f.workPerHandPerUpkeep;
        if (!before && isEstablished(land, index)) looksDifferent = true;
      }
      // An unbroken field still suffers: ground opened and then left is the worst of
      // both, which is what stops a village siting more fields than it can work.
    }

    // --- condition -------------------------------------------------------------
    // Cattle first, so a field that is both worked and grazed nets out rather than
    // taking the better of the two.
    const trampling = beasts > f.maxTramplers ? f.maxTramplers : beasts;
    let condition = land.condition[index]!;
    condition -= trampling * f.grazedPerBeastPerUpkeep;
    condition -= f.neglectPerUpkeep;
    condition += working * f.tendPerUpkeep;

    const clamped = condition < 0 ? 0 : condition > 1 ? 1 : condition;
    // Crossing a tenth is roughly where the art changes, so only then is it news.
    if (Math.floor(clamped * 10) !== Math.floor(land.condition[index]! * 10)) {
      looksDifferent = true;
    }
    land.condition[index] = clamped;
  }

  if (looksDifferent) land.version++;
}

/**
 * What each player's fields return this cycle.
 *
 * Shaped as a callback rather than a number so the ledger keeps owning the weather: it
 * knows the drought curve and the sheltered floor, and the fields know their own
 * condition. Neither has to learn the other's business.
 */
export function harvestOf(
  land: Farmland,
  index: number,
): { owner: number; sheltered: boolean; share: number } | null {
  if (land.alive[index] === 0) return null;
  if (!isEstablished(land, index)) return null;
  return {
    owner: land.owner[index]!,
    sheltered: land.sheltered[index] === 1,
    share: land.condition[index]!,
  };
}

/** The fields, flattened for the renderer. See shared/farmland.ts for the format. */
export function packFarmland(land: Farmland): Float32Array {
  let living = 0;
  for (let i = 0; i < land.count; i++) living += land.alive[i]!;

  const out = new Float32Array(living * FARMLAND_STRIDE);
  let at = 0;
  for (let i = 0; i < land.count; i++) {
    if (land.alive[i] === 0) continue;
    out[at] = land.tileX[i]!;
    out[at + 1] = land.tileY[i]!;
    out[at + 2] = land.owner[i]!;
    out[at + 3] = isEstablished(land, i) ? 1 : 0;
    out[at + 4] = land.condition[i]!;
    out[at + 5] = i;
    at += FARMLAND_STRIDE;
  }
  return out;
}
