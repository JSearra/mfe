import { describe, expect, it } from 'vitest';
import { CommandKind, compareCommands, makeCommand } from '../src/sim/commands.js';
import { createLoop, runTicks, step, TICK_HZ, TICK_MS } from '../src/sim/loop.js';
import { createWorld, handleIndex, isAlive, packHandle } from '../src/sim/world.js';

describe('loop', () => {
  it('runs at a fixed 20Hz', () => {
    expect(TICK_HZ).toBe(20);
    expect(TICK_MS).toBe(50);
  });

  it('orders same-tick commands by (playerId, seq), never by arrival', () => {
    const arrival = [
      makeCommand(0, 1, 5, CommandKind.Spawn),
      makeCommand(0, 0, 9, CommandKind.Spawn),
      makeCommand(0, 1, 2, CommandKind.Spawn),
      makeCommand(0, 0, 1, CommandKind.Spawn),
    ];
    const sorted = [...arrival].sort(compareCommands);
    expect(sorted.map((c) => [c.playerId, c.seq])).toEqual([
      [0, 1],
      [0, 9],
      [1, 2],
      [1, 5],
    ]);
  });

  it('sorts the log on construction, so arrival order cannot leak in', () => {
    const world = createWorld(8, 1);
    const loop = createLoop(world, [
      makeCommand(3, 0, 1, CommandKind.Spawn),
      makeCommand(1, 1, 0, CommandKind.Spawn),
      makeCommand(1, 0, 0, CommandKind.Spawn),
    ]);
    expect(loop.pending.map((c: { tick: number; playerId: number }) => [c.tick, c.playerId])).toEqual([
      [1, 0],
      [1, 1],
      [3, 0],
    ]);
  });

  it('executes each command on its own tick', () => {
    const world = createWorld(8, 1);
    const loop = createLoop(world, [
      makeCommand(0, 0, 0, CommandKind.Spawn),
      makeCommand(2, 0, 1, CommandKind.Spawn),
    ]);

    step(loop);
    expect(world.liveCount).toBe(1);
    step(loop);
    expect(world.liveCount).toBe(1);
    step(loop);
    expect(world.liveCount).toBe(2);
  });

  it('counts late commands instead of stalling the cursor', () => {
    const world = createWorld(8, 1);
    const loop = createLoop(world, [makeCommand(0, 0, 0, CommandKind.Spawn)]);
    world.tick = 50; // as if the command arrived after its tick had passed

    step(loop);
    expect(loop.lateCommands).toBe(1);
    expect(loop.cursor).toBe(1);
  });

  it('drops a command naming a recycled handle rather than retargeting', () => {
    const world = createWorld(4, 1);
    const loop = createLoop(world, [
      makeCommand(0, 0, 0, CommandKind.Spawn, 0, 0, 0, 0),
      makeCommand(1, 0, 1, CommandKind.Destroy, packHandle(0, 1)),
      makeCommand(2, 0, 2, CommandKind.Spawn, 5, 5, 0, 0),
      // Stale: index 0 is live again, but at generation 2.
      makeCommand(3, 0, 3, CommandKind.MoveTo, packHandle(0, 1), 99, 99),
    ]);

    runTicks(loop, 4);

    const live = packHandle(0, 2);
    expect(isAlive(world, live)).toBe(true);
    // The stale order must not have retargeted the recycled slot toward (99, 99).
    expect(world.hasTarget[handleIndex(live)]).toBe(0);
  });

  it('advances the tick counter exactly once per step', () => {
    const world = createWorld(8, 1);
    const loop = createLoop(world, []);
    runTicks(loop, 137);
    expect(world.tick).toBe(137);
  });
});
