import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import { heightAt, isShore, type Heightmap } from '../shared/heightmap.js';
import { BuildingType, buildingSpec } from '../shared/buildings/index.js';
import type { Economy } from './economy/ledger.js';
import { Resource } from './economy/ledger.js';
import { blockTile, MovementClass } from './pathing/costs.js';
import type { PathingService } from './pathing/service.js';
import type { SpatialGrid } from './spatial/grid.js';
import { tuning } from './tuning.js';
import { Work } from './labour.js';
import {
  destroy,
  EntityKind,
  isAlive,
  NULL_HANDLE,
  handleIndex,
  packHandle,
  spawn,
  type Handle,
  type World,
} from './world.js';

/**
 * Placing and raising buildings.
 *
 * The consequence that matters beyond this file: a building changes the navigation grid,
 * and every cached flow field describing the old world is now wrong. ADR-0013 warned
 * that the precomputed cost tables carry an obligation, and this is the thing that was
 * going to collect on it — a foundation laid by writing tileCost alone would be walked
 * straight through. Placement goes through blockTile and then invalidates the cache.
 */

export interface ConstructionStats {
  placed: number;
  completed: number;
  refused: number;
}

export const PlacementResult = {
  Placed: 0,
  OffMap: 1,
  Occupied: 2,
  TooSteep: 3,
  Unaffordable: 4,
  NoRoom: 5,
  /**
   * A weir with no water to hold.
   *
   * Its own result rather than folding into `Unsuitable`, because it is the one refusal
   * the player can act on by walking somewhere else — the panel says which, and a
   * reason a player can answer is worth a value of its own.
   */
  NoWater: 6,
} as const;

export type PlacementResult = (typeof PlacementResult)[keyof typeof PlacementResult];

export interface ConstructionSystem {
  readonly stats: ConstructionStats;
  place(
    world: World,
    economy: Economy,
    owner: number,
    type: BuildingType,
    tileX: number,
    tileY: number,
    events: SimEvent[],
    /**
     * Found it already standing, and free.
     *
     * For laying out the village a match STARTS with, which is a fact about the map
     * rather than a thing anybody built — the same reason the starting fields come back
     * established and the starting wood is not all saplings. A player who begins in an
     * empty field is not beginning in a village. Costs are skipped with it: charging a
     * village for the huts it already lives in would just be a different opening
     * balance.
     */
    founded?: boolean,
  ): PlacementResult;
  /**
   * `labour` is injected rather than imported, the way the ledger takes its grain
   * multiplier: construction knows that people build things, and does not need to learn
   * what a tech tree is to find out how fast.
   */
  update(
    world: World,
    grid: SpatialGrid,
    events: SimEvent[],
    labour?: (player: number) => number,
  ): void;
  /**
   * Block the footprint of every building standing in `world`, as placing it did.
   *
   * For loading a save: the buildings come back in the world arrays, but the tiles they
   * block live in the pathing layers, which no save copies. Without this the huts are
   * there and people walk straight through them.
   */
  restoreFootprints(world: World): void;
  /**
   * Take down `owner`'s building and give the ground back. False if the handle is not
   * a living building of theirs. The entity goes at the tick's destroy flush.
   */
  demolish(world: World, handle: Handle, owner: number): boolean;
  /**
   * Grain and cattle produced per upkeep by this player's finished buildings, each
   * scaled by the share of its hands that are there.
   */
  yieldFor(world: World, owner: number): { grain: number; hardyGrain: number; cattle: number };
}

export function createConstructionSystem(
  map: Heightmap,
  pathing: PathingService,
): ConstructionSystem {
  const stats: ConstructionStats = { placed: 0, completed: 0, refused: 0 };
  const neighbours: number[] = [];
  /** Finished buildings that need staff, rebuilt each tick. */
  const staffed: number[] = [];
  /** Footprint origin per building, so completion and demolition know their tiles. */
  const origins = new Map<number, { tileX: number; tileY: number; type: BuildingType }>();

  /** Block a footprint for everyone — except, for an enclosure, the cattle it holds. */
  function blockFootprint(tileX: number, tileY: number, size: number, holdsCattle: boolean): void {
    for (const movementClass of [MovementClass.Infantry, MovementClass.Cattle, MovementClass.Mounted]) {
      if (holdsCattle && movementClass === MovementClass.Cattle) continue;
      const layer = pathing.layer(movementClass);
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) blockTile(layer, tileX + dx, tileY + dy);
      }
    }
  }

  function footprintFree(tileX: number, tileY: number, size: number): boolean {
    const layer = pathing.layer(MovementClass.Infantry);
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const x = tileX + dx;
        const y = tileY + dy;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
        if (layer.tileCost[y * map.width + x] === 255) return false;
      }
    }
    return true;
  }

  /** Does any tile of this footprint stand on a bank? */
  function touchesWater(tileX: number, tileY: number, size: number): boolean {
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        if (isShore(map, tileX + dx, tileY + dy)) return true;
      }
    }
    return false;
  }

  function levelEnough(tileX: number, tileY: number, size: number, tolerance: number): boolean {
    let low = Infinity;
    let high = -Infinity;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const h = heightAt(map, tileX + dx, tileY + dy);
        if (h < 0) return false;
        if (h < low) low = h;
        if (h > high) high = h;
      }
    }
    return high - low <= tolerance;
  }

  return {
    stats,

    place(world, economy, owner, type, tileX, tileY, events, founded): PlacementResult {
      const spec = buildingSpec(type);
      const size = spec.footprint;

      if (tileX < 0 || tileY < 0 || tileX + size > map.width || tileY + size > map.height) {
        stats.refused++;
        return PlacementResult.OffMap;
      }
      if (!levelEnough(tileX, tileY, size, spec.maxHeightVariation)) {
        stats.refused++;
        return PlacementResult.TooSteep;
      }
      if (!footprintFree(tileX, tileY, size)) {
        stats.refused++;
        return PlacementResult.Occupied;
      }
      // A weir has to have water to hold. Checked on the footprint's own tiles rather
      // than within a radius: it is built ON the bank, and a work of irrigation a
      // village away from the river is just a trench.
      if (spec.needsWater && !touchesWater(tileX, tileY, size)) {
        stats.refused++;
        return PlacementResult.NoWater;
      }
      if (
        economy.balance(owner, Resource.Grain) < spec.grainCost ||
        // Timber as well as grain. A village that has felled its wood to the last stump
        // cannot build, which is the whole point of the wood being a resource rather
        // than scenery — see src/sim/woodland.ts.
        economy.balance(owner, Resource.Wood) < spec.woodCost ||
        economy.balance(owner, Resource.Cattle) < spec.cattleCost
      ) {
        if (founded !== true) {
          stats.refused++;
          return PlacementResult.Unaffordable;
        }
      }

      const handle = spawn(
        world,
        tileX + size / 2,
        tileY + size / 2,
        owner,
        0,
        EntityKind.Building,
      );
      if (handle === NULL_HANDLE) {
        stats.refused++;
        return PlacementResult.NoRoom;
      }

      if (founded !== true) {
        economy.spend(owner, Resource.Grain, spec.grainCost);
        economy.spend(owner, Resource.Wood, spec.woodCost);
        economy.spend(owner, Resource.Cattle, spec.cattleCost);
      }

      const index = handleIndex(handle);
      world.buildingType[index] = type;
      // A founded building is already standing; anything else starts as bare ground.
      world.buildProgress[index] = founded === true ? spec.work : 0;
      world.hasTarget[index] = 0;

      // The foundation blocks immediately, not on completion: units should walk around
      // a building site, and a half-built kraal is still a wall.
      //
      // Except to the cattle it is built for. An enclosure is a thing you put a herd
      // INSIDE, and blocking the footprint for every movement class made the kraal a
      // solid block that the herd stood awkwardly beside — a pen with no inside to it.
      // The wall stays a wall to anyone on two legs, so it still reads as an enclosure
      // and still shapes where people walk.
      blockFootprint(tileX, tileY, size, spec.holdsCattle);
      // Every cached field describes a world without this building in it.
      pathing.invalidateFields();

      origins.set(handle, { tileX, tileY, type });
      stats.placed++;
      events.push(makeEvent(world.tick, EventType.BuildingPlaced, handle, tileX, tileY, type));
      return PlacementResult.Placed;
    },

    update(world, grid, events, labour): void {
      const b = tuning.buildings;

      /*
       * Hands at the finished buildings that need them (ADR-0020, Phase B2).
       *
       * Counted from where people stand, like every other place of work, and each person
       * counted ONCE, at the nearest such building. A granary and a kraal a few tiles
       * apart would otherwise both claim whoever stood between them, and a village could
       * staff two buildings with one pair of hands. Nearest, ties broken on the building's
       * index, so the answer does not depend on scan order.
       */
      staffed.length = 0;
      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Building) continue;
        const spec = buildingSpec(world.buildingType[index]!);
        if (spec.hands === 0 || world.buildProgress[index]! < spec.work) continue;
        world.builders[index] = 0;
        staffed.push(index);
      }
      if (staffed.length > 0) {
        const reachSq = tuning.labour.buildingReach * tuning.labour.buildingReach;
        for (let unit = 0; unit < world.capacity; unit++) {
          if (world.alive[unit] !== 1 || world.kind[unit] !== EntityKind.Unit) continue;
          /*
           * A hunter counts for the camp they belong to, wherever they are. Its people
           * work out on the veld, not at its walls, and counting only those standing by
           * it made a camp whose hunters were all out read "nobody working it" — which
           * was exactly backwards (ADR-0022).
           */
          if (world.workKind[unit] === Work.Hunt) {
            const camp = world.workAt[unit]!;
            if (camp >= 0 && world.alive[camp] === 1 && world.builders[camp]! < 255) {
              world.builders[camp] = world.builders[camp]! + 1;
            }
            continue;
          }
          let nearest = -1;
          let nearestSq = Infinity;
          for (const building of staffed) {
            if (world.faction[building] !== world.faction[unit]) continue;
            const dx = world.posX[building]! - world.posX[unit]!;
            const dy = world.posY[building]! - world.posY[unit]!;
            const distanceSq = dx * dx + dy * dy;
            if (distanceSq > reachSq) continue;
            // Strictly nearer, so a tie keeps the lower index (staffed is in index order).
            if (distanceSq < nearestSq) {
              nearestSq = distanceSq;
              nearest = building;
            }
          }
          if (nearest !== -1 && world.builders[nearest]! < 255) {
            world.builders[nearest] = world.builders[nearest]! + 1;
          }
        }
      }

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Building) continue;

        const spec = buildingSpec(world.buildingType[index]!);
        if (world.buildProgress[index]! >= spec.work) {
          // A building that needs staff keeps the count taken above; one that runs
          // itself has nobody to count.
          if (spec.hands === 0) world.builders[index] = 0;
          continue;
        }

        // Work is done by whoever is standing near it. Nobody there, nothing happens —
        // a site does not raise itself.
        const siteX = world.posX[index]!;
        const siteY = world.posY[index]!;
        const count = grid.query(siteX, siteY, b.buildRadius, neighbours);
        // The grid answers in whole cells, so what comes back is a superset of the
        // radius asked for and has to be narrowed here. It was not, and with
        // buildRadius 2.2 against cellSize 2 that let a unit 4.2 away raise the
        // building — and counted it, so sites also went up faster than they were tuned
        // to. Every other caller of query() already does this.
        const reachSq = b.buildRadius * b.buildRadius;
        let builders = 0;
        for (let n = 0; n < count; n++) {
          const other = neighbours[n]!;
          if (world.alive[other] !== 1) continue;
          if (world.kind[other] !== EntityKind.Unit) continue;
          if (world.faction[other] !== world.faction[index]) continue;
          const dx = world.posX[other]! - siteX;
          const dy = world.posY[other]! - siteY;
          if (dx * dx + dy * dy > reachSq) continue;
          builders++;
        }
        // Written even when nobody is there, because "nobody is working this" is the
        // single most useful thing the site can tell the player.
        world.builders[index] = builders > 255 ? 255 : builders;
        if (builders === 0) continue;

        const rate = b.progressPerBuilder * (labour?.(world.faction[index]!) ?? 1);
        world.buildProgress[index] = world.buildProgress[index]! + builders * rate;
        if (world.buildProgress[index]! < spec.work) continue;

        world.buildProgress[index] = spec.work;
        stats.completed++;
        events.push(
          makeEvent(
            world.tick,
            EventType.BuildingCompleted,
            packHandle(index, world.generation[index]!),
            world.posX[index]!,
            world.posY[index]!,
            spec.type,
          ),
        );
      }
    },

    demolish(world, handle, owner): boolean {
      if (!isAlive(world, handle)) return false;
      const index = handleIndex(handle);
      if (world.kind[index] !== EntityKind.Building || world.faction[index] !== owner) return false;
      if (world.destroyPending[index] === 1) return false;
      if (!destroy(world, handle)) return false;
      // Bare terrain, then everything still standing blocked again. The one going is
      // marked for destruction and skipped, though it is alive until the flush.
      pathing.resetLayers();
      this.restoreFootprints(world);
      return true;
    },

    restoreFootprints(world): void {
      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Building) continue;
        if (world.destroyPending[index] === 1) continue;
        const spec = buildingSpec(world.buildingType[index]!);
        const size = spec.footprint;
        // Placement puts the entity at the footprint's centre, tile + size / 2.
        const tileX = Math.round(world.posX[index]! - size / 2);
        const tileY = Math.round(world.posY[index]! - size / 2);
        blockFootprint(tileX, tileY, size, spec.holdsCattle);
      }
      pathing.invalidateFields();
    },

    yieldFor(world, owner) {
      let grain = 0;
      let hardyGrain = 0;
      let cattle = 0;

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Building) continue;
        if (world.faction[index] !== owner) continue;

        const spec = buildingSpec(world.buildingType[index]!);
        if (world.buildProgress[index]! < spec.work) continue;
        // Paid in proportion to the hands actually there. An unstaffed granary stores
        // nothing and an unkept kraal breeds nothing (ADR-0020, Phase B2).
        const present = world.builders[index]!;
        const share =
          spec.hands === 0 ? 1 : (present < spec.hands ? present : spec.hands) / spec.hands;
        grain += spec.grainYield * share;
        hardyGrain += spec.hardyGrainYield * share;
        cattle += spec.cattleYield * share;
      }
      return { grain, hardyGrain, cattle };
    },
  };
}

export function isComplete(world: World, handle: Handle): boolean {
  const index = handleIndex(handle);
  if (world.kind[index] !== EntityKind.Building) return false;
  return world.buildProgress[index]! >= buildingSpec(world.buildingType[index]!).work;
}
