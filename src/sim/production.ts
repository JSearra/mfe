import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import { buildingSpec } from '../shared/buildings/index.js';
import type { Economy } from './economy/ledger.js';
import { Resource } from './economy/ledger.js';
import { MovementClass } from './pathing/costs.js';
import type { MovementSystem } from './movement.js';
import { tuning } from './tuning.js';
import {
  EntityKind,
  handleIndex,
  isAlive,
  spawn,
  type Handle,
  type World,
} from './world.js';

/**
 * Raising troops.
 *
 * Until this existed the game had no loop. Units were seeded once at startup and combat
 * only ever subtracted, so a long match trended toward both sides holding full granaries
 * and empty fields. Production is what closes it: grain and cattle buy troops, troops
 * take and lose ground, losses demand more grain and cattle.
 *
 * It also gives the rest of the simulation something to act on. Drought becomes a threat
 * because it starves the reinforcement rate rather than merely a number on the bar;
 * cattle raiding becomes worth doing because cattle buy soldiers; and amabutho becomes a
 * real decision against simply training more bodies.
 */

/** Two bits per queue slot, so a five-deep queue fits in a u16. */
const KIND_BITS = 2;
const KIND_MASK = 0b11;

export const TrainableClass = {
  Infantry: MovementClass.Infantry,
  Mounted: MovementClass.Mounted,
} as const;

export interface TrainingCost {
  readonly grain: number;
  readonly cattle: number;
  readonly ticks: number;
}

export function trainingCost(movementClass: number): TrainingCost {
  const p = tuning.production;
  return movementClass === MovementClass.Mounted
    ? { grain: p.mountedGrain, cattle: p.mountedCattle, ticks: p.mountedTicks }
    : { grain: p.infantryGrain, cattle: p.infantryCattle, ticks: p.infantryTicks };
}

export interface ProductionStats {
  queued: number;
  trained: number;
  refused: number;
}

export const TrainResult = {
  Queued: 0,
  NotATrainer: 1,
  Unfinished: 2,
  QueueFull: 3,
  Unaffordable: 4,
} as const;

export type TrainResult = (typeof TrainResult)[keyof typeof TrainResult];

export interface ProductionSystem {
  readonly stats: ProductionStats;
  train(world: World, economy: Economy, building: Handle, movementClass: number): TrainResult;
  setRally(world: World, building: Handle, x: number, y: number): boolean;
  /** Economy is not consulted: the cost was paid when the order was placed. */
  update(world: World, events: SimEvent[]): void;
  /** Queue depth, for the UI. */
  queueLength(world: World, building: Handle): number;
}

function queuedKind(world: World, index: number, slot: number): number {
  return (world.trainKinds[index]! >> (slot * KIND_BITS)) & KIND_MASK;
}

/** Drop the head of the queue and shift the rest down. */
function shiftQueue(world: World, index: number): void {
  world.trainKinds[index] = world.trainKinds[index]! >> KIND_BITS;
  world.trainQueue[index]!--;
  world.trainProgress[index] = 0;
}

export function createProductionSystem(movement: MovementSystem): ProductionSystem {
  const stats: ProductionStats = { queued: 0, trained: 0, refused: 0 };

  return {
    stats,

    train(world, economy, building, movementClass): TrainResult {
      if (!isAlive(world, building)) return TrainResult.NotATrainer;
      const index = handleIndex(building);
      if (world.kind[index] !== EntityKind.Building) return TrainResult.NotATrainer;

      const spec = buildingSpec(world.buildingType[index]!);
      if (!spec.trains) return TrainResult.NotATrainer;
      // A half-built homestead houses nobody.
      if (world.buildProgress[index]! < spec.work) return TrainResult.Unfinished;
      if (world.trainQueue[index]! >= tuning.production.queueLimit) return TrainResult.QueueFull;

      const owner = world.faction[index]!;
      const cost = trainingCost(movementClass);
      if (
        economy.balance(owner, Resource.Grain) < cost.grain ||
        economy.balance(owner, Resource.Cattle) < cost.cattle
      ) {
        stats.refused++;
        return TrainResult.Unaffordable;
      }

      // Paid on queueing, not on completion. Otherwise a player queues five and spends
      // the grain elsewhere while they cook, which is a cheat rather than a strategy.
      economy.spend(owner, Resource.Grain, cost.grain);
      economy.spend(owner, Resource.Cattle, cost.cattle);

      const slot = world.trainQueue[index]!;
      world.trainKinds[index] =
        (world.trainKinds[index]! | ((movementClass & KIND_MASK) << (slot * KIND_BITS))) & 0xffff;
      world.trainQueue[index] = slot + 1;
      stats.queued++;
      return TrainResult.Queued;
    },

    setRally(world, building, x, y): boolean {
      if (!isAlive(world, building)) return false;
      const index = handleIndex(building);
      if (world.kind[index] !== EntityKind.Building) return false;
      world.rallyX[index] = x;
      world.rallyY[index] = y;
      return true;
    },

    queueLength(world, building) {
      if (!isAlive(world, building)) return 0;
      return world.trainQueue[handleIndex(building)]!;
    },

    update(world, events): void {
      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Building) continue;
        if (world.trainQueue[index] === 0) continue;

        const movementClass = queuedKind(world, index, 0);
        const cost = trainingCost(movementClass);

        world.trainProgress[index] = world.trainProgress[index]! + 1;
        if (world.trainProgress[index]! < cost.ticks) continue;

        // Place the new soldier clear of the footprint, then send them to the rally.
        const spec = buildingSpec(world.buildingType[index]!);
        const offset = spec.footprint / 2 + tuning.production.spawnRadius;
        const handle = spawn(
          world,
          world.posX[index]! + offset,
          world.posY[index]! + offset,
          world.faction[index]!,
          movementClass,
        );

        if (handle === 0) {
          // No room in the entity store. Hold the queue rather than silently losing a
          // soldier the player already paid for.
          world.trainProgress[index] = cost.ticks;
          continue;
        }

        shiftQueue(world, index);
        stats.trained++;
        movement.order(world, handle, world.rallyX[index]!, world.rallyY[index]!);

        events.push(
          makeEvent(
            world.tick,
            EventType.UnitTrained,
            handle,
            world.posX[handleIndex(handle)]!,
            world.posY[handleIndex(handle)]!,
            movementClass,
          ),
        );
      }
    },
  };
}
