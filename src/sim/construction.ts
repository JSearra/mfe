import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import { heightAt, type Heightmap } from '../shared/heightmap.js';
import { BuildingType, buildingSpec } from '../shared/buildings/index.js';
import type { Economy } from './economy/ledger.js';
import { Resource } from './economy/ledger.js';
import { blockTile, MovementClass } from './pathing/costs.js';
import type { PathingService } from './pathing/service.js';
import type { SpatialGrid } from './spatial/grid.js';
import { tuning } from './tuning.js';
import {
  EntityKind,
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
  ): PlacementResult;
  update(world: World, grid: SpatialGrid, events: SimEvent[]): void;
  /** Grain and cattle produced per upkeep by this player's finished buildings. */
  yieldFor(world: World, owner: number): { grain: number; cattle: number };
}

export function createConstructionSystem(
  map: Heightmap,
  pathing: PathingService,
): ConstructionSystem {
  const stats: ConstructionStats = { placed: 0, completed: 0, refused: 0 };
  const neighbours: number[] = [];
  /** Footprint origin per building, so completion and demolition know their tiles. */
  const origins = new Map<number, { tileX: number; tileY: number; type: BuildingType }>();

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

    place(world, economy, owner, type, tileX, tileY, events): PlacementResult {
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
      if (
        economy.balance(owner, Resource.Grain) < spec.grainCost ||
        economy.balance(owner, Resource.Cattle) < spec.cattleCost
      ) {
        stats.refused++;
        return PlacementResult.Unaffordable;
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

      economy.spend(owner, Resource.Grain, spec.grainCost);
      economy.spend(owner, Resource.Cattle, spec.cattleCost);

      const index = handleIndex(handle);
      world.buildingType[index] = type;
      world.buildProgress[index] = 0;
      world.hasTarget[index] = 0;

      // The foundation blocks immediately, not on completion: units should walk around
      // a building site, and a half-built kraal is still a wall.
      for (const movementClass of [MovementClass.Infantry, MovementClass.Cattle, MovementClass.Mounted]) {
        const layer = pathing.layer(movementClass);
        for (let dy = 0; dy < size; dy++) {
          for (let dx = 0; dx < size; dx++) blockTile(layer, tileX + dx, tileY + dy);
        }
      }
      // Every cached field describes a world without this building in it.
      pathing.invalidateFields();

      origins.set(handle, { tileX, tileY, type });
      stats.placed++;
      events.push(makeEvent(world.tick, EventType.BuildingPlaced, handle, tileX, tileY, type));
      return PlacementResult.Placed;
    },

    update(world, grid, events): void {
      const b = tuning.buildings;

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Building) continue;

        const spec = buildingSpec(world.buildingType[index]!);
        if (world.buildProgress[index]! >= spec.work) continue;

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
        if (builders === 0) continue;

        world.buildProgress[index] = world.buildProgress[index]! + builders * b.progressPerBuilder;
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

    yieldFor(world, owner) {
      let grain = 0;
      let cattle = 0;

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Building) continue;
        if (world.faction[index] !== owner) continue;

        const spec = buildingSpec(world.buildingType[index]!);
        if (world.buildProgress[index]! < spec.work) continue;
        grain += spec.grainYield;
        cattle += spec.cattleYield;
      }
      return { grain, cattle };
    },
  };
}

export function isComplete(world: World, handle: Handle): boolean {
  const index = handleIndex(handle);
  if (world.kind[index] !== EntityKind.Building) return false;
  return world.buildProgress[index]! >= buildingSpec(world.buildingType[index]!).work;
}
