import { describe, expect, it } from 'vitest';
import { BUILDINGS, BuildingType } from '../src/shared/buildings/index.js';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { MovementClass } from '../src/sim/pathing/costs.js';
import { TrainResult, trainingCost } from '../src/sim/production.js';
import { tuning } from '../src/sim/tuning.js';
import { EntityKind, handleIndex, packHandle } from '../src/sim/world.js';
import { makeSim } from './simHarness.js';

const P = tuning.production;

/** A finished homestead with money in the bank. */
function homestead(complete = true) {
  const sim = makeSim(128, 5);
  sim.economy.add(0, Resource.Grain, 5000);
  sim.economy.add(0, Resource.Cattle, 200);

  sim.construction.place(sim.world, sim.economy, 0, BuildingType.Umuzi, 6, 6, []);
  const handle = packHandle(0, sim.world.generation[0]!);
  if (complete) sim.world.buildProgress[0] = BUILDINGS[BuildingType.Umuzi].work;

  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      sim.production.update(sim.world, []);
      sim.world.tick++;
    }
  };
  return { ...sim, handle, tick };
}

describe('queueing', () => {
  it('charges when the order is placed, not when it finishes', () => {
    const sim = homestead();
    const cost = trainingCost(MovementClass.Infantry);
    const before = sim.economy.balance(0, Resource.Grain);

    expect(sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry)).toBe(
      TrainResult.Queued,
    );

    // Paid up front. Otherwise five are queued and the grain spent elsewhere while they
    // cook, which is a cheat rather than a strategy.
    expect(sim.economy.balance(0, Resource.Grain)).toBe(before - cost.grain);
  });

  it('refuses a building that does not raise troops', () => {
    const sim = makeSim(128, 5);
    sim.economy.add(0, Resource.Grain, 5000);
    sim.construction.place(sim.world, sim.economy, 0, BuildingType.GrainStore, 6, 6, []);
    sim.world.buildProgress[0] = BUILDINGS[BuildingType.GrainStore].work;

    expect(
      sim.production.train(sim.world, sim.economy, packHandle(0, 1), MovementClass.Infantry),
    ).toBe(TrainResult.NotATrainer);
  });

  it('refuses a half-built homestead, which houses nobody', () => {
    const sim = homestead(false);
    expect(sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry)).toBe(
      TrainResult.Unfinished,
    );
  });

  it('refuses past the queue limit', () => {
    const sim = homestead();
    for (let i = 0; i < P.queueLimit; i++) {
      expect(sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry)).toBe(
        TrainResult.Queued,
      );
    }
    expect(sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry)).toBe(
      TrainResult.QueueFull,
    );
  });

  it('refuses what cannot be paid for, and does not charge for the refusal', () => {
    const sim = homestead();
    sim.economy.spend(0, Resource.Grain, sim.economy.balance(0, Resource.Grain));
    const cattleBefore = sim.economy.balance(0, Resource.Cattle);

    expect(sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry)).toBe(
      TrainResult.Unaffordable,
    );
    expect(sim.economy.balance(0, Resource.Cattle)).toBe(cattleBefore);
  });

  it('prices horsemen above spearmen, in time as well as goods', () => {
    const infantry = trainingCost(MovementClass.Infantry);
    const mounted = trainingCost(MovementClass.Mounted);
    expect(mounted.grain).toBeGreaterThan(infantry.grain);
    expect(mounted.cattle).toBeGreaterThan(infantry.cattle);
    expect(mounted.ticks).toBeGreaterThan(infantry.ticks);
  });
});

describe('training', () => {
  it('produces a soldier after the full time and not before', () => {
    const sim = homestead();
    const cost = trainingCost(MovementClass.Infantry);
    sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry);

    sim.tick(cost.ticks - 1);
    expect(sim.world.liveCount).toBe(1); // the building alone

    sim.tick(1);
    expect(sim.world.liveCount).toBe(2);
    expect(sim.production.stats.trained).toBe(1);
  });

  it('announces the new soldier', () => {
    const sim = homestead();
    const events: SimEvent[] = [];
    sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry);

    for (let i = 0; i <= trainingCost(MovementClass.Infantry).ticks; i++) {
      sim.production.update(sim.world, events);
      sim.world.tick++;
    }
    expect(events.some((e) => e.type === EventType.UnitTrained)).toBe(true);
  });

  it('works the queue in order', () => {
    const sim = homestead();
    sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Mounted);
    sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry);

    sim.tick(trainingCost(MovementClass.Mounted).ticks);
    // The horseman was ordered first and so is finished first, even though a spearman
    // would have been quicker.
    const first = sim.world.movementClass[1]!;
    expect(first).toBe(MovementClass.Mounted);
    expect(sim.production.queueLength(sim.world, sim.handle)).toBe(1);
  });

  it('sends the soldier to the rally point', () => {
    const sim = homestead();
    sim.production.setRally(sim.world, sim.handle, 20, 20);
    sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry);
    sim.tick(trainingCost(MovementClass.Infantry).ticks);

    expect(sim.world.hasTarget[1]).toBe(1);
    expect(sim.world.targetX[1]).toBeCloseTo(20, 6);
    expect(sim.world.targetY[1]).toBeCloseTo(20, 6);
  });

  it('places the soldier clear of the footprint', () => {
    const sim = homestead();
    sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry);
    sim.tick(trainingCost(MovementClass.Infantry).ticks);

    const dx = sim.world.posX[1]! - sim.world.posX[0]!;
    const dy = sim.world.posY[1]! - sim.world.posY[0]!;
    expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(
      BUILDINGS[BuildingType.Umuzi].footprint / 2,
    );
  });

  it('holds the queue rather than losing a soldier already paid for', () => {
    // A full entity store must not swallow the order silently.
    const sim = makeSim(2, 5);
    sim.economy.add(0, Resource.Grain, 5000);
    sim.economy.add(0, Resource.Cattle, 200);
    sim.construction.place(sim.world, sim.economy, 0, BuildingType.Umuzi, 3, 3, []);
    sim.world.buildProgress[0] = BUILDINGS[BuildingType.Umuzi].work;
    const handle = packHandle(0, sim.world.generation[0]!);

    sim.production.train(sim.world, sim.economy, handle, MovementClass.Infantry);
    // Fill the one remaining slot.
    sim.world.alive[1] = 1;
    sim.world.freeCount = 0;

    for (let i = 0; i <= trainingCost(MovementClass.Infantry).ticks + 50; i++) {
      sim.production.update(sim.world, []);
      sim.world.tick++;
    }
    expect(sim.production.queueLength(sim.world, handle)).toBe(1);
    expect(sim.production.stats.trained).toBe(0);
  });
});

describe('the loop closes', () => {
  // The gap this system exists to fill: before it, combat only ever subtracted and a
  // long match ended with full granaries and empty fields.
  it('lets a side replace losses out of its economy', () => {
    const sim = homestead();
    sim.production.setRally(sim.world, sim.handle, 10, 10);

    const cost = trainingCost(MovementClass.Infantry);
    const grainBefore = sim.economy.balance(0, Resource.Grain);
    let trained = 0;
    for (let round = 0; round < 4; round++) {
      sim.production.train(sim.world, sim.economy, sim.handle, MovementClass.Infantry);
      sim.tick(cost.ticks);
      trained++;

      // Something kills the newcomer.
      const index = handleIndex(packHandle(trained, sim.world.generation[trained]!));
      if (sim.world.alive[index] === 1 && sim.world.kind[index] === EntityKind.Unit) {
        sim.world.hp[index] = 0;
      }
    }
    expect(sim.production.stats.trained).toBe(4);
    // Replacements are paid for out of the granary: that is the loop closing.
    expect(sim.economy.balance(0, Resource.Grain)).toBe(grainBefore - 4 * cost.grain);
  });
});
