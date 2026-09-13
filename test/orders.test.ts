import { describe, expect, it } from 'vitest';
import { step } from '../src/sim/loop.js';
import { CommandKind } from '../src/sim/commands.js';
import { NULL_HANDLE, Stance, handleIndex, spawn } from '../src/sim/world.js';
import { tuning } from '../src/sim/tuning.js';
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

describe('attack-move', () => {
  it('walks past a fight under a plain move order', () => {
    const { sim, marcher, defender } = scenario();
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
