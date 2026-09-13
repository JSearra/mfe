import { describe, expect, it } from 'vitest';
import { CommandKind, makeCommand } from '../src/sim/commands.js';
import { runTicks, step } from '../src/sim/loop.js';
import {
  captureState,
  restoreState,
  SAVE_VERSION,
  SaveVersionError,
} from '../src/sim/persistence/save.js';
import { hashWorld } from '../src/sim/replay.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { createHeightmap } from '../src/sim/terrain/generate.js';
import { makeSim } from './simHarness.js';

/** A scenario with movement, cattle, orders and an economy all in flight. */
function busyScenario(seed: number) {
  const map = createHeightmap(48, 48, 0x51ee);
  const commands = [];
  let seq = 0;

  for (let i = 0; i < 12; i++) {
    commands.push(makeCommand(0, 0, seq++, CommandKind.Spawn, 10 + (i % 4), 10 + (i >> 2), 0, 0));
  }
  for (let i = 0; i < 10; i++) {
    commands.push(makeCommand(0, 0, seq++, CommandKind.SpawnCattle, 14 + (i % 5) * 0.6, 14));
  }
  for (let tick = 20; tick < 400; tick += 40) {
    commands.push(
      makeCommand(tick, 0, seq++, CommandKind.MoveTo, (1 << 24) | 0, 20 + (tick % 17), 22),
    );
    commands.push(
      makeCommand(tick, 0, seq++, CommandKind.MoveTo, (1 << 24) | 1, 12, 30 - (tick % 11)),
    );
  }

  return makeSim(128, seed, map, commands);
}

describe('save and load', () => {
  // The decisive test. Anything the save left behind — RNG state, a path cursor, the
  // fog, the ledger — shows up as divergence when both halves run on.
  it('restores into a fresh simulation that then runs identically', () => {
    const original = busyScenario(0xabc);
    runTicks(original.loop, 300);

    const save = captureState(original.loop);

    const restored = busyScenario(0xabc);
    // Advance the fresh one to a *different* state first, so a pass cannot come from
    // the two simply having the same history.
    runTicks(restored.loop, 57);
    expect(hashWorld(restored.world)).not.toBe(hashWorld(original.world));

    restoreState(restored.loop, save);
    expect(hashWorld(restored.world)).toBe(hashWorld(original.world));

    for (let tick = 0; tick < 400; tick++) {
      step(original.loop);
      step(restored.loop);
      expect(hashWorld(restored.world), `diverged at tick ${tick}`).toBe(hashWorld(original.world));
    }
  });

  it('carries the RNG state, not just the seed', () => {
    const original = busyScenario(0xdef);
    runTicks(original.loop, 137);
    const save = captureState(original.loop);

    const restored = busyScenario(0xdef);
    restoreState(restored.loop, save);
    expect(Array.from(restored.world.rng.state)).toEqual(Array.from(original.world.rng.state));
  });

  it('carries the ledger and the fog', () => {
    const original = busyScenario(0x123);
    runTicks(original.loop, 420); // past two upkeep cycles

    original.economy.add(0, Resource.Grain, 777);
    const save = captureState(original.loop);

    const restored = busyScenario(0x123);
    restoreState(restored.loop, save);

    expect(restored.economy.balance(0, Resource.Grain)).toBe(
      original.economy.balance(0, Resource.Grain),
    );
    expect(restored.economy.upkeepCount).toBe(original.economy.upkeepCount);
    expect(Array.from(restored.fog.tiles)).toEqual(Array.from(original.fog.tiles));
  });

  it('carries unfinished orders so they still execute after loading', () => {
    const original = busyScenario(0x55);
    runTicks(original.loop, 100);

    const save = captureState(original.loop);
    expect(save.commands.length).toBeGreaterThan(0);

    const restored = busyScenario(0x55);
    restoreState(restored.loop, save);
    expect(restored.loop.pending.length).toBe(save.commands.length);
  });

  it('is stable: saving the same state twice produces the same bytes', () => {
    const sim = busyScenario(0x99);
    runTicks(sim.loop, 250);
    expect(JSON.stringify(captureState(sim.loop))).toBe(JSON.stringify(captureState(sim.loop)));
  });

  it('survives a JSON round trip', () => {
    const original = busyScenario(0x77);
    runTicks(original.loop, 180);

    const text = JSON.stringify(captureState(original.loop));
    const restored = busyScenario(0x77);
    restoreState(restored.loop, JSON.parse(text));

    runTicks(original.loop, 120);
    runTicks(restored.loop, 120);
    expect(hashWorld(restored.world)).toBe(hashWorld(original.world));
  });

  it('refuses a save from a different version rather than misreading it', () => {
    const sim = busyScenario(0x11);
    const save = { ...captureState(sim.loop), version: SAVE_VERSION + 1 };
    expect(() => restoreState(sim.loop, save)).toThrow(SaveVersionError);
  });

  it('refuses a save whose capacity does not match', () => {
    const big = busyScenario(0x22);
    const save = captureState(big.loop);
    const small = makeSim(16, 0x22);
    expect(() => restoreState(small.loop, save)).toThrow(RangeError);
  });
});
