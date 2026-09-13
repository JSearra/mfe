import { describe, expect, it } from 'vitest';
import { createAi } from '../src/sim/ai/opponent.js';
import { CommandKind } from '../src/sim/commands.js';
import { runTicks, step } from '../src/sim/loop.js';
import { hashWorld } from '../src/sim/replay.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { tuning } from '../src/sim/tuning.js';
import { updateFog } from '../src/sim/vision/fog.js';
import { EntityKind, spawn } from '../src/sim/world.js';
import { makeSim } from './simHarness.js';

const AI = tuning.ai;

function contest(seed = 0x0a1) {
  const sim = makeSim(256, seed, undefined, []);
  for (let i = 0; i < 10; i++) spawn(sim.world, 6 + (i % 4), 6 + (i >> 2), 0);
  for (let i = 0; i < 10; i++) spawn(sim.world, 24 + (i % 4), 24 + (i >> 2), 1);
  sim.loop.ai.push({ player: 0, controller: createAi(0) });
  sim.loop.ai.push({ player: 1, controller: createAi(1) });
  return sim;
}

describe('ai as a command source', () => {
  // The invariant ARCHITECTURE said would make this cheap, asserted rather than assumed.
  it('changes nothing directly — every effect goes through a command', () => {
    const sim = contest();
    updateFog(sim.world, sim.map, sim.fog);
    sim.world.tick = AI.decideEveryTicks;

    const ai = createAi(0);
    const before = hashWorld(sim.world);

    const emitted: unknown[] = [];
    ai.decide(sim.world, sim.fog, sim.economy, sim.tech, (command) => emitted.push(command));

    expect(hashWorld(sim.world)).toBe(before);
    expect(emitted.length).toBeGreaterThan(0);
  });

  it('thinks on its cadence, not every tick', () => {
    const sim = contest();
    const ai = createAi(0);

    sim.world.tick = AI.decideEveryTicks + 1;
    ai.decide(sim.world, sim.fog, sim.economy, sim.tech, () => {});
    expect(ai.stats.decisions).toBe(0);

    sim.world.tick = AI.decideEveryTicks * 2;
    ai.decide(sim.world, sim.fog, sim.economy, sim.tech, () => {});
    expect(ai.stats.decisions).toBe(1);
  });

  it('acts only on what it can see', () => {
    const sim = makeSim(128, 1, undefined, []);
    spawn(sim.world, 4, 4, 0);
    spawn(sim.world, 28, 28, 1); // beyond vision

    updateFog(sim.world, sim.map, sim.fog);
    sim.world.tick = AI.decideEveryTicks;

    const ai = createAi(0);
    const kinds: number[] = [];
    ai.decide(sim.world, sim.fog, sim.economy, sim.tech, (c) => kinds.push(c.kind));

    // An enemy it cannot see draws no attack order — it scouts or builds instead.
    expect(kinds).not.toContain(CommandKind.Attack);
  });

  it('concentrates on one target when it has the numbers', () => {
    const sim = makeSim(128, 1, undefined, []);
    for (let i = 0; i < 8; i++) spawn(sim.world, 10 + i * 0.4, 10, 0);
    spawn(sim.world, 12, 10, 1);
    spawn(sim.world, 13, 10, 1);

    updateFog(sim.world, sim.map, sim.fog);
    sim.world.tick = AI.decideEveryTicks;
    sim.economy.spend(0, Resource.Grain, sim.economy.balance(0, Resource.Grain));

    const attacks: number[] = [];
    createAi(0).decide(sim.world, sim.fog, sim.economy, sim.tech, (c) => {
      if (c.kind === CommandKind.Attack) attacks.push(c.b);
    });

    expect(attacks.length).toBe(8);
    expect(new Set(attacks).size).toBe(1);
  });

  it('pulls back rather than feeding units in when outnumbered', () => {
    const sim = makeSim(128, 1, undefined, []);
    spawn(sim.world, 10, 10, 0);
    for (let i = 0; i < 6; i++) spawn(sim.world, 11 + i * 0.3, 10, 1);

    updateFog(sim.world, sim.map, sim.fog);
    sim.world.tick = AI.decideEveryTicks;
    sim.economy.spend(0, Resource.Grain, sim.economy.balance(0, Resource.Grain));

    const kinds: number[] = [];
    createAi(0).decide(sim.world, sim.fog, sim.economy, sim.tech, (c) => kinds.push(c.kind));
    expect(kinds).toContain(CommandKind.MoveTo);
    expect(kinds).not.toContain(CommandKind.Attack);
  });

  it('goes for cattle when there is nothing to fight', () => {
    const sim = makeSim(128, 1, undefined, []);
    for (let i = 0; i < 4; i++) spawn(sim.world, 10 + i * 0.5, 10, 0);
    spawn(sim.world, 10.5, 10.5, 2, 1, EntityKind.Cattle);

    updateFog(sim.world, sim.map, sim.fog);
    sim.world.tick = AI.decideEveryTicks;
    sim.economy.spend(0, Resource.Grain, sim.economy.balance(0, Resource.Grain));

    const kinds: number[] = [];
    createAi(0).decide(sim.world, sim.fog, sim.economy, sim.tech, (c) => kinds.push(c.kind));
    // Cattle are what the war is about.
    expect(kinds.some((k) => k === CommandKind.Leash || k === CommandKind.MoveTo)).toBe(true);
  });
});

describe('ai soak', () => {
  // The free dividend of "the AI is just another command source": a headless match that
  // exercises movement, pathing, combat, construction and the economy together.
  it('runs an AI-vs-AI match without stalling or throwing', () => {
    const sim = contest();
    runTicks(sim.loop, 3000);

    const [a, b] = sim.loop.ai;
    expect(a!.controller.stats.decisions).toBeGreaterThan(100);
    expect(b!.controller.stats.decisions).toBeGreaterThan(100);
    expect(a!.controller.stats.ordersIssued).toBeGreaterThan(0);

    // Something actually happened: contact was made, or ground was taken.
    const fought = sim.combat.stats.strikes > 0;
    const built = sim.construction.stats.placed > 0;
    expect(fought || built).toBe(true);
  });

  it('reproduces exactly, so a match can be replayed', () => {
    const first = contest(0xbeef);
    const second = contest(0xbeef);

    for (let tick = 0; tick < 1200; tick++) {
      step(first.loop);
      step(second.loop);
      expect(hashWorld(second.world), `diverged at tick ${tick}`).toBe(hashWorld(first.world));
    }
  });
});
