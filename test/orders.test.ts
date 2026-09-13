import { describe, expect, it } from 'vitest';
import { step } from '../src/sim/loop.js';
import { CommandKind } from '../src/sim/commands.js';
import { NULL_HANDLE, handleIndex, spawn } from '../src/sim/world.js';
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

/** A defender standing between the marchers and where they were sent. */
function scenario() {
  const sim = makeSim(64, 7);
  const marcher = spawn(sim.world, 4, 4, PLAYER);
  const defender = spawn(sim.world, 10, 10, ENEMY);
  return { sim, marcher, defender };
}

function run(sim: ReturnType<typeof makeSim>, ticks: number): void {
  for (let t = 0; t < ticks; t++) step(sim.loop);
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
    run(sim, 200);

    const index = handleIndex(marcher);
    // Arrives. The defender is idle and will pick a fight as the marcher goes by — that
    // is the defender's behaviour, not the marcher's, and it is correct — so the thing
    // asserted is only that the march itself completed.
    expect(sim.world.posX[index]! + sim.world.posY[index]!).toBeGreaterThan(38);
    expect(sim.world.alive[handleIndex(defender)]).toBe(1);
  });

  it('stops and engages under an attack-move order', () => {
    const { sim, marcher, defender } = scenario();
    issue(sim, CommandKind.AttackMove, marcher, 20, 20);
    run(sim, 200);

    const index = handleIndex(marcher);
    const defenderIndex = handleIndex(defender);
    // The contrast with the case above is the whole point: given the same order length
    // and the same number of ticks, an attack-mover has NOT arrived, because it stopped
    // to deal with what it met. Unless it won outright, in which case it has every right
    // to be standing at the destination.
    const arrived = sim.world.posX[index]! + sim.world.posY[index]! > 38;
    const won = sim.world.alive[defenderIndex] !== 1;
    expect(arrived && !won).toBe(false);
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
