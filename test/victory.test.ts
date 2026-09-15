import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { Outcome } from '../src/sim/victory.js';
import { tuning } from '../src/sim/tuning.js';
import { spawn } from '../src/sim/world.js';
import { makeSim } from './simHarness.js';

const V = tuning.victory;

function match(households = 3) {
  const sim = makeSim(256, 11);
  // Both sides have somebody, so nobody is eliminated by default.
  for (let i = 0; i < households; i++) spawn(sim.world, 5 + (i % 8) * 0.6, 5 + (i / 8 | 0) * 0.6, 0);
  for (let i = 0; i < 3; i++) spawn(sim.world, 25 + i, 25, 1);

  const events: SimEvent[] = [];
  const run = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      sim.victory.update(sim.world, sim.economy, events);
      sim.world.tick++;
    }
  };
  return { ...sim, events, run };
}

describe('settling a village', () => {
  /**
   * The objective stopped being cattle on 2026-09-15 — see ADR-0019. It is now the
   * village itself: settle a given number of households and keep them fed long enough
   * that the place is established rather than briefly crowded.
   *
   * Holding matters more than it did under the old condition, not less. Population is
   * trivially spiked — train until the granary is empty — and a village that doubles in
   * a minute and starves in the next has settled nothing.
   */
  it('does not end a match that nobody is winning', () => {
    const sim = match();
    sim.run(V.holdTicks * 2);
    expect(sim.victory.outcome).toBe(Outcome.Ongoing);
    expect(sim.victory.winner).toBe(-1);
  });

  it('counts the people, not the herd', () => {
    const sim = match(V.householdsToSettle);
    // A vast herd is wealth and does not settle anybody.
    sim.economy.add(0, Resource.Cattle, 5000);
    sim.run(1);
    expect(sim.victory.households[0]).toBe(V.householdsToSettle);
  });

  it('needs the village HELD at size, not merely reached', () => {
    const sim = match(V.householdsToSettle);

    sim.run(V.holdTicks - 10);
    expect(sim.victory.outcome).toBe(Outcome.Ongoing);

    // One household lost, a few ticks short of established.
    sim.world.alive[0] = 0;
    sim.run(1);
    expect(sim.victory.holdTicks[0]).toBe(0);

    sim.run(V.holdTicks * 2);
    expect(sim.victory.outcome).toBe(Outcome.Ongoing);
  });

  it('declares a winner once the village has stood long enough', () => {
    const sim = match(V.householdsToSettle);

    sim.run(V.holdTicks + 2);
    expect(sim.victory.outcome).toBe(Outcome.Settled);
    expect(sim.victory.winner).toBe(0);
    expect(sim.events.some((e) => e.type === EventType.VictoryDeclared)).toBe(true);
  });

  it('stops updating once decided, so a result cannot be overwritten', () => {
    const sim = match(V.householdsToSettle);
    sim.run(V.holdTicks + 2);
    expect(sim.victory.winner).toBe(0);

    for (let i = 0; i < V.householdsToSettle * 2; i++) spawn(sim.world, 40 + (i % 8) * 0.6, 40, 1);
    sim.run(V.holdTicks * 2);
    expect(sim.victory.winner).toBe(0);
  });
});

describe('elimination', () => {
  it('gives a grace period rather than counting out an empty-handed player at once', () => {
    const sim = match();
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] === 1 && sim.world.faction[i] === 1) sim.world.alive[i] = 0;
    }

    sim.run(V.eliminationGraceTicks - 5);
    // The window covers a last soldier dying while a homestead finishes a replacement.
    expect(sim.victory.eliminated[1]).toBe(0);

    sim.run(10);
    expect(sim.victory.eliminated[1]).toBe(1);
  });

  it('resets the grace period if the player recovers', () => {
    const sim = match();
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] === 1 && sim.world.faction[i] === 1) sim.world.alive[i] = 0;
    }
    sim.run(V.eliminationGraceTicks - 20);
    spawn(sim.world, 30, 30, 1);
    sim.run(1);
    expect(sim.victory.graceTicks[1]).toBe(0);
  });

  it('hands the match to the last side standing', () => {
    const sim = match();
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] === 1 && sim.world.faction[i] === 1) sim.world.alive[i] = 0;
    }

    sim.run(V.eliminationGraceTicks + 5);
    expect(sim.victory.outcome).toBe(Outcome.LastStanding);
    expect(sim.victory.winner).toBe(0);
  });
});
