import { describe, expect, it } from 'vitest';
import { step } from '../src/sim/loop.js';
import { CommandKind } from '../src/sim/commands.js';
import {
  NULL_HANDLE,
  ORDER_QUEUE_MAX,
  OrderMode,
  Stance,
  handleIndex,
  spawn,
} from '../src/sim/world.js';
import { tuning } from '../src/sim/tuning.js';
import { captureState, restoreState } from '../src/sim/persistence/save.js';
import { makeSim } from './simHarness.js';

/**
 * The command vocabulary: what a player can actually tell an army to do.
 *
 * Before these, the whole set was move, attack one named target, build, train, research
 * and set a rally point. An army could be walked across a map but not advanced across
 * one — a unit under a move order explicitly refused to look for a fight, so a column
 * ordered past an enemy walked straight through the middle of it.
 */

const PLAYER = 0;
const ENEMY = 1;

/**
 * A defender standing between the marchers and where they were sent.
 *
 * The defender is pinned to hold ground. Left aggressive it chases the marcher and gets
 * in its way, which stalls a plain move as surely as an order to fight would — correct
 * behaviour, and it made the scenario measure two things at once. Holding it still
 * isolates the only question here, which is what the MARCHER does.
 */
function scenario() {
  const sim = makeSim(64, 7);
  const marcher = spawn(sim.world, 4, 4, PLAYER);
  const defender = spawn(sim.world, 10, 10, ENEMY);
  sim.world.stance[handleIndex(defender)] = Stance.HoldGround;
  return { sim, marcher, defender };
}

function run(sim: ReturnType<typeof makeSim>, ticks: number): void {
  for (let t = 0; t < ticks; t++) step(sim.loop);
}

/**
 * Furthest the unit ever got along the isometric axis, not where it ended up.
 *
 * Where it ended up is not the question and stopped being a usable measure once units
 * learned to pursue: a plain-move unit arrives, goes idle, acquires whatever is nearby
 * and chases it back the way it came. That is correct, and it has nothing to do with
 * whether the march itself was interrupted.
 */
function furthest(sim: ReturnType<typeof makeSim>, index: number, ticks: number): number {
  let best = sim.world.posX[index]! + sim.world.posY[index]!;
  for (let t = 0; t < ticks; t++) {
    step(sim.loop);
    const reached = sim.world.posX[index]! + sim.world.posY[index]!;
    if (reached > best) best = reached;
  }
  return best;
}

/**
 * Queue a command the way a host would.
 *
 * `pending` is sorted by (tick, playerId, seq) from the cursor onward, and `dirty` is
 * what tells the loop the tail needs re-sorting before it is read — pushing without it
 * would work by luck whenever the new command already happened to sort last.
 */
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

describe('attack-move', () => {
  it('walks past a fight under a plain move order', () => {
    const { sim, marcher } = scenario();
    issue(sim, CommandKind.MoveTo, marcher, 20, 20);

    const index = handleIndex(marcher);
    // Walks past the defender at (10,10) and reaches the far end. The defender is idle
    // and will pick a fight as the marcher goes by — that is the defender's behaviour,
    // not the marcher's — so what is asserted is only that the march completed.
    expect(furthest(sim, index, 200)).toBeGreaterThan(38);
  });

  it('stops and engages under an attack-move order', () => {
    const { sim, marcher, defender } = scenario();
    issue(sim, CommandKind.AttackMove, marcher, 20, 20);

    const index = handleIndex(marcher);
    const defenderIndex = handleIndex(defender);
    const reached = furthest(sim, index, 200);
    const won = sim.world.alive[defenderIndex] !== 1;

    // The contrast with the case above is the whole point: same order, same tick count,
    // and the attack-mover never gets to the far end, because it stopped to deal with
    // what it met. Unless it won outright, in which case it has every right to finish.
    expect(reached > 38 && !won).toBe(false);
    expect(
      sim.world.attackTarget[index] !== NULL_HANDLE || won,
      'attack-mover neither engaged nor killed anything',
    ).toBe(true);
  });

  it('resumes the march once the fight is over', () => {
    const { sim, marcher, defender } = scenario();
    issue(sim, CommandKind.AttackMove, marcher, 20, 20);
    run(sim, 60);

    // Remove the obstacle mid-advance. The order is kept rather than cleared when a unit
    // stops to fight, so it must pick the march back up rather than standing there.
    const defenderIndex = handleIndex(defender);
    sim.world.alive[defenderIndex] = 0;

    const index = handleIndex(marcher);
    const before = sim.world.posX[index]! + sim.world.posY[index]!;
    run(sim, 200);
    expect(sim.world.posX[index]! + sim.world.posY[index]!).toBeGreaterThan(before + 2);
  });
});

describe('stances', () => {
  /** A defender at its post, and an intruder placed at `distance` from it. */
  function post(stance: number, distance: number) {
    const sim = makeSim(64, 11);
    const guard = spawn(sim.world, 16, 16, PLAYER);
    const intruder = spawn(sim.world, 16 + distance, 16, ENEMY);
    const guardIndex = handleIndex(guard);
    sim.world.stance[guardIndex] = stance;
    sim.world.postX[guardIndex] = 16;
    sim.world.postY[guardIndex] = 16;
    // The intruder is pinned so the test measures the guard, not a scrum.
    sim.world.stance[handleIndex(intruder)] = Stance.HoldGround;
    return { sim, guard, guardIndex, intruder };
  }

  function distanceFromPost(sim: ReturnType<typeof makeSim>, index: number): number {
    const dx = sim.world.posX[index]! - sim.world.postX[index]!;
    const dy = sim.world.posY[index]! - sim.world.postY[index]!;
    return Math.sqrt(dx * dx + dy * dy);
  }

  it('holds ground without moving at all', () => {
    const { sim, guardIndex } = post(Stance.HoldGround, 6);
    run(sim, 150);
    // Not "barely moves" — does not move. A unit told to hold a gate that drifts out of
    // it has not held it.
    expect(distanceFromPost(sim, guardIndex)).toBeLessThan(0.01);
  });

  it('chases when aggressive', () => {
    const { sim, guardIndex } = post(Stance.Aggressive, 6);
    run(sim, 150);
    expect(distanceFromPost(sim, guardIndex)).toBeGreaterThan(1);
  });

  it('stays on its leash when defensive', () => {
    const { sim, guardIndex } = post(Stance.Defensive, 8);
    run(sim, 200);
    // The intruder sits beyond the leash, so a defensive guard must not be drawn out to
    // it at all. Measured from the post, which is what stops a defender being walked off
    // its position a tile at a time by something that retreats slowly.
    expect(distanceFromPost(sim, guardIndex)).toBeLessThan(tuning.combat.defendRadius);
  });

  it('is set through a command, not by writing to the world', () => {
    const sim = makeSim(64, 3);
    const unit = spawn(sim.world, 8, 8, PLAYER);
    issue(sim, CommandKind.SetStance, unit, Stance.HoldGround, 0);
    run(sim, 2);
    expect(sim.world.stance[handleIndex(unit)]).toBe(Stance.HoldGround);
  });
});

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
  it('round-trips stance, mode, post and the queue', () => {
    const sim = makeSim(64, 21);
    const unit = spawn(sim.world, 6, 6, PLAYER);
    const index = handleIndex(unit);

    issue(sim, CommandKind.AttackMove, unit, 20, 6);
    queued(sim, CommandKind.MoveTo, unit, 20, 20);
    issue(sim, CommandKind.SetStance, unit, Stance.Defensive, 0);
    run(sim, 4);

    const before = {
      stance: sim.world.stance[index],
      mode: sim.world.orderMode[index],
      postX: sim.world.postX[index],
      queued: sim.world.queueCount[index],
    };
    expect(before.queued).toBe(1);

    // Every field added for the command vocabulary has to be in WORLD_FIELDS, or a
    // saved advance reloads as a stroll and a saved patrol stops patrolling. The
    // existing save test runs a busy game forward and compares hashes, which would only
    // catch a missing field if its scenario happened to exercise it — this names them.
    const save = captureState(sim.loop);
    const restored = makeSim(64, 21);
    restoreState(restored.loop, save);

    expect(restored.world.stance[index]).toBe(before.stance);
    expect(restored.world.orderMode[index]).toBe(before.mode);
    expect(restored.world.postX[index]).toBe(before.postX);
    expect(restored.world.queueCount[index]).toBe(before.queued);
  });
});
