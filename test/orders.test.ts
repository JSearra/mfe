import { describe, expect, it } from 'vitest';
import { step } from '../src/sim/loop.js';
import { CommandKind } from '../src/sim/commands.js';
import {
  ORDER_QUEUE_MAX,
  OrderMode,
  handleIndex,
  spawn,
} from '../src/sim/world.js';
import { captureState, restoreState } from '../src/sim/persistence/save.js';
import { makeSim } from './simHarness.js';

/**
 * The command vocabulary: what a player can actually tell an army to do.
 *
 * Attack-move and stances lived here until Phase V6 took combat out; what is left is
 * the part of the vocabulary that was never about fighting — a queue of waypoints, and
 * a beat walked between two points. Both are as useful to somebody moving a herd as
 * they ever were to somebody moving an impi.
 */

const PLAYER = 0;

function run(sim: ReturnType<typeof makeSim>, ticks: number): void {
  for (let t = 0; t < ticks; t++) step(sim.loop);
}

function issue(sim: ReturnType<typeof makeSim>, kind: number, a: number, b: number, c: number): void {
  sim.loop.pending.push({
    kind: kind as never,
    a,
    b,
    c,
    d: 0,
    playerId: PLAYER,
    seq: sim.loop.pending.length,
    tick: sim.world.tick,
  });
  sim.loop.dirty = true;
}

/** Shift-click: append rather than replace. The `d` field carries that. */
function queued(sim: ReturnType<typeof makeSim>, kind: number, a: number, b: number, c: number): void {
  sim.loop.pending.push({
    kind: kind as never,
    a,
    b,
    c,
    d: 1,
    playerId: PLAYER,
    seq: sim.loop.pending.length,
    tick: sim.world.tick,
  });
  sim.loop.dirty = true;
}

describe('order queue', () => {
  it('runs queued waypoints in order', () => {
    const sim = makeSim(64, 5);
    const unit = spawn(sim.world, 4, 4, PLAYER);
    const index = handleIndex(unit);

    issue(sim, CommandKind.MoveTo, unit, 12, 4);
    queued(sim, CommandKind.MoveTo, unit, 12, 14);

    // Somewhere along the way it must have been near the first waypoint, and it must
    // end near the second. Checking only the endpoint would pass for a unit that
    // ignored the first order entirely and went straight to the last.
    let touchedFirst = false;
    for (let t = 0; t < 400; t++) {
      step(sim.loop);
      const dx = sim.world.posX[index]! - 12;
      const dy = sim.world.posY[index]! - 4;
      if (Math.sqrt(dx * dx + dy * dy) < 1.5) touchedFirst = true;
    }

    expect(touchedFirst).toBe(true);
    expect(Math.abs(sim.world.posX[index]! - 12)).toBeLessThan(2);
    expect(Math.abs(sim.world.posY[index]! - 14)).toBeLessThan(2);
  });

  it('an unqueued order throws the queue away', () => {
    const sim = makeSim(64, 5);
    const unit = spawn(sim.world, 4, 4, PLAYER);
    const index = handleIndex(unit);

    issue(sim, CommandKind.MoveTo, unit, 20, 4);
    queued(sim, CommandKind.MoveTo, unit, 20, 20);
    run(sim, 4);
    expect(sim.world.queueCount[index]).toBe(1);

    issue(sim, CommandKind.MoveTo, unit, 4, 20);
    run(sim, 2);
    expect(sim.world.queueCount[index]).toBe(0);
  });

  it('starts marching when the first order is queued onto an idle unit', () => {
    const sim = makeSim(64, 5);
    const unit = spawn(sim.world, 4, 4, PLAYER);
    const index = handleIndex(unit);

    // Nothing to queue behind, so it must start rather than sit in a queue that
    // nothing will ever drain.
    queued(sim, CommandKind.MoveTo, unit, 14, 4);
    run(sim, 6);
    expect(sim.world.hasTarget[index]).toBe(1);
  });

  it('drops orders past the queue limit rather than growing', () => {
    const sim = makeSim(64, 5);
    const unit = spawn(sim.world, 4, 4, PLAYER);
    const index = handleIndex(unit);

    issue(sim, CommandKind.MoveTo, unit, 20, 4);
    run(sim, 2);
    for (let i = 0; i < ORDER_QUEUE_MAX + 5; i++) queued(sim, CommandKind.MoveTo, unit, 20, 6 + i);
    run(sim, 2);
    expect(sim.world.queueCount[index]).toBe(ORDER_QUEUE_MAX);
  });
});

describe('patrol', () => {
  it('turns round at each end and keeps going', () => {
    const sim = makeSim(64, 13);
    const unit = spawn(sim.world, 6, 6, PLAYER);
    const index = handleIndex(unit);

    issue(sim, CommandKind.Patrol, unit, 16, 6);

    // Count the reversals rather than sampling the position: a unit that stopped at one
    // end, or that oscillated inside a tile, would pass a looser check.
    let legs = 0;
    let heading = Math.sign(sim.world.targetX[index]! - sim.world.posX[index]!);
    for (let t = 0; t < 1200; t++) {
      step(sim.loop);
      const now = Math.sign(sim.world.targetX[index]! - sim.world.posX[index]!);
      if (now !== 0 && heading !== 0 && now !== heading) legs++;
      if (now !== 0) heading = now;
    }

    expect(legs).toBeGreaterThanOrEqual(2);
    // And it is still patrolling at the end, not parked.
    expect(sim.world.orderMode[index]).toBe(OrderMode.Patrol);
  });

  it('gives up the patrol when given a plain order', () => {
    const sim = makeSim(64, 13);
    const unit = spawn(sim.world, 6, 6, PLAYER);
    const index = handleIndex(unit);

    issue(sim, CommandKind.Patrol, unit, 16, 6);
    run(sim, 20);
    expect(sim.world.orderMode[index]).toBe(OrderMode.Patrol);

    issue(sim, CommandKind.MoveTo, unit, 6, 16);
    run(sim, 10);
    expect(sim.world.orderMode[index]).toBe(OrderMode.Move);
  });
});

describe('order state survives a save', () => {
  it('round-trips the order mode, the patrol and the queue', () => {
    const sim = makeSim(64, 21);
    const unit = spawn(sim.world, 6, 6, PLAYER);
    const index = handleIndex(unit);

    issue(sim, CommandKind.Patrol, unit, 20, 6);
    queued(sim, CommandKind.MoveTo, unit, 20, 20);
    run(sim, 4);

    const before = {
      mode: sim.world.orderMode[index],
      patrolX: sim.world.patrolX[index],
      queued: sim.world.queueCount[index],
    };
    expect(before.mode).toBe(OrderMode.Patrol);
    expect(before.queued).toBe(1);

    // Every field added for the command vocabulary has to be saved, or a saved patrol
    // stops patrolling and a saved queue comes back empty. The
    // existing save test runs a busy game forward and compares hashes, which would only
    // catch a missing field if its scenario happened to exercise it — this names them.
    const save = captureState(sim.loop);
    const restored = makeSim(64, 21);
    restoreState(restored.loop, save);

    expect(restored.world.orderMode[index]).toBe(before.mode);
    expect(restored.world.patrolX[index]).toBe(before.patrolX);
    expect(restored.world.queueCount[index]).toBe(before.queued);
  });
});
