import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { Outcome } from '../src/sim/victory.js';
import { tuning } from '../src/sim/tuning.js';
import { EntityKind, HerdState, spawn } from '../src/sim/world.js';
import { makeSim } from './simHarness.js';

const V = tuning.victory;

function match() {
  const sim = makeSim(256, 11);
  // Both sides have something, so nobody is eliminated by default.
  for (let i = 0; i < 3; i++) spawn(sim.world, 5 + i, 5, 0);
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

describe('cattle victory', () => {
  it('does not end a match that nobody is winning', () => {
    const sim = match();
    sim.run(V.holdTicks * 2);
    expect(sim.victory.outcome).toBe(Outcome.Ongoing);
    expect(sim.victory.winner).toBe(-1);
  });

  it('needs the herd HELD, not merely touched', () => {
    const sim = match();
    sim.economy.add(0, Resource.Cattle, V.cattleToWin);

    sim.run(V.holdTicks - 10);
    expect(sim.victory.outcome).toBe(Outcome.Ongoing);

    // Lose the herd one tick before the clock runs out.
    sim.economy.spend(0, Resource.Cattle, sim.economy.balance(0, Resource.Cattle));
    sim.run(1);
    expect(sim.victory.holdTicks[0]).toBe(0);

    // A raid that takes the herd and immediately loses it takes nothing.
    sim.run(V.holdTicks * 2);
    expect(sim.victory.outcome).toBe(Outcome.Ongoing);
  });

  it('declares a winner once the herd is held long enough', () => {
    const sim = match();
    sim.economy.add(0, Resource.Cattle, V.cattleToWin);

    sim.run(V.holdTicks + 2);
    expect(sim.victory.outcome).toBe(Outcome.CattleVictory);
    expect(sim.victory.winner).toBe(0);
    expect(sim.events.some((e) => e.type === EventType.VictoryDeclared)).toBe(true);
  });

  it('counts cattle held on the map, not only on the ledger', () => {
    const sim = match();
    const herder = spawn(sim.world, 10, 10, 0);
    const cow = spawn(sim.world, 10.5, 10, 2, 1, EntityKind.Cattle);
    const cowIndex = cow & 0xffffff;
    sim.world.herdState[cowIndex] = HerdState.Leashed;
    sim.world.tetheredTo[cowIndex] = herder;

    const ledger = sim.economy.balance(0, Resource.Cattle);
    sim.run(1);
    // Driving a herd off is how it changes hands, so a driven beast counts.
    expect(sim.victory.cattleHeld[0]).toBe(ledger + 1);
  });

  it('credits a stolen beast to whoever holds the tether now', () => {
    const sim = match();
    const thief = spawn(sim.world, 10, 10, 1);
    const cow = spawn(sim.world, 10.5, 10, 2, 1, EntityKind.Cattle);
    const cowIndex = cow & 0xffffff;
    sim.world.herdState[cowIndex] = HerdState.Leashed;
    sim.world.tetheredTo[cowIndex] = thief;

    const ledgerZero = sim.economy.balance(0, Resource.Cattle);
    sim.run(1);
    expect(sim.victory.cattleHeld[0]).toBe(ledgerZero);
    expect(sim.victory.cattleHeld[1]).toBe(sim.economy.balance(1, Resource.Cattle) + 1);
  });

  it('ignores a beast whose herder has died', () => {
    const sim = match();
    const herder = spawn(sim.world, 10, 10, 0);
    const cow = spawn(sim.world, 10.5, 10, 2, 1, EntityKind.Cattle);
    const cowIndex = cow & 0xffffff;
    sim.world.herdState[cowIndex] = HerdState.Leashed;
    sim.world.tetheredTo[cowIndex] = herder;
    sim.world.alive[herder & 0xffffff] = 0;

    const ledger = sim.economy.balance(0, Resource.Cattle);
    sim.run(1);
    expect(sim.victory.cattleHeld[0]).toBe(ledger);
  });

  it('stops updating once decided, so a result cannot be overwritten', () => {
    const sim = match();
    sim.economy.add(0, Resource.Cattle, V.cattleToWin);
    sim.run(V.holdTicks + 2);
    expect(sim.victory.winner).toBe(0);

    sim.economy.add(1, Resource.Cattle, V.cattleToWin * 2);
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
