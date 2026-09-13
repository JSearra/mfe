import { describe, expect, it } from 'vitest';
import { CommandKind } from '../src/sim/commands.js';
import { createDirectSimHost } from '../src/host/directHost.js';
import { decodeSnapshot } from '../src/shared/snapshot.js';
import { EventType } from '../src/shared/events.js';
import { TICK_MS } from '../src/shared/timing.js';
import { createWorld, isAlive, packHandle } from '../src/sim/world.js';
import { flatMap } from './simHarness.js';

function host(capacity = 64, options: Record<string, unknown> = {}) {
  const world = createWorld(capacity, 99);
  return { world, sim: createDirectSimHost({ world, map: flatMap(32), ...options }) };
}

describe('direct sim host', () => {
  it('advances on a fixed timestep regardless of pump size', () => {
    const { world, sim } = host();
    sim.pump(TICK_MS * 3);
    expect(world.tick).toBe(3);

    sim.pump(TICK_MS / 2);
    expect(world.tick).toBe(3); // partial time accumulates, it does not round up
    sim.pump(TICK_MS / 2);
    expect(world.tick).toBe(4);
  });

  it('caps catch-up so a long stall cannot spiral', () => {
    const { world, sim } = host();
    sim.pump(TICK_MS * 500);
    expect(world.tick).toBeLessThanOrEqual(5);
  });

  it('routes spawns and orders through commands', () => {
    const { world, sim } = host();
    sim.sendCommand(CommandKind.Spawn, 5, 6, 1);
    sim.pump(TICK_MS);

    expect(world.liveCount).toBe(1);
    const handle = packHandle(0, 1);
    expect(isAlive(world, handle)).toBe(true);

    sim.sendCommand(CommandKind.MoveTo, handle, 12, 6);
    sim.pump(TICK_MS);
    expect(world.posX[0]).toBeGreaterThan(5);
  });

  // The backpressure property: a backgrounded tab stops consuming while the simulation
  // keeps running. An uncoalesced queue grows until the tab dies.
  it('coalesces to a single snapshot when the consumer stalls', () => {
    const { sim } = host();
    sim.sendCommand(CommandKind.Spawn, 0, 0, 0);

    for (let i = 0; i < 200; i++) sim.pump(TICK_MS);

    const message = sim.receive();
    expect(message).not.toBeNull();
    expect(decodeSnapshot(message!.snapshot).tick).toBe(200);

    // Nothing queued behind it.
    expect(sim.receive()).toBeNull();
  });

  it('returns null before the first tick', () => {
    const { sim } = host();
    expect(sim.receive()).toBeNull();
  });

  it('delivers events alongside the snapshot, not coalesced away', () => {
    const { sim } = host();
    sim.sendCommand(CommandKind.Spawn, 1, 1, 0);
    sim.pump(TICK_MS);
    sim.sendCommand(CommandKind.Destroy, packHandle(0, 1));
    sim.pump(TICK_MS);

    const message = sim.receive()!;
    const types = message.events.map((event) => event.type);
    expect(types).toContain(EventType.Spawned);
    expect(types).toContain(EventType.Destroyed);
    expect(message.droppedEvents).toBe(0);
  });

  it('drops the oldest events and reports it when the consumer stalls too long', () => {
    const { sim } = host(512, { maxPendingEvents: 4 });
    for (let i = 0; i < 10; i++) {
      sim.sendCommand(CommandKind.Spawn, i, i, 0);
      sim.pump(TICK_MS);
    }

    const message = sim.receive()!;
    expect(message.events).toHaveLength(4);
    expect(message.droppedEvents).toBe(6);
  });

  // The generation counter earning its keep across the boundary.
  it('drops a command naming a recycled handle rather than retargeting', () => {
    const { world, sim } = host(4);
    sim.sendCommand(CommandKind.Spawn, 0, 0, 0);
    sim.pump(TICK_MS);

    const stale = packHandle(0, 1);
    sim.sendCommand(CommandKind.Destroy, stale);
    sim.pump(TICK_MS);

    sim.sendCommand(CommandKind.Spawn, 50, 50, 0);
    sim.pump(TICK_MS);

    const live = packHandle(0, 2);
    expect(isAlive(world, live)).toBe(true);
    expect(isAlive(world, stale)).toBe(false);

    // An order issued against the dead handle must not move the unit now in that slot.
    sim.sendCommand(CommandKind.MoveTo, stale, -999, -999);
    sim.pump(TICK_MS);
    expect(world.hasTarget[0]).toBe(0);
    expect(world.posX[0]).toBeCloseTo(50, 6);
  });

  it('hands the renderer a snapshot detached from simulation memory', () => {
    const { world, sim } = host(8, { strict: true });
    sim.sendCommand(CommandKind.Spawn, 3, 3, 0);
    sim.pump(TICK_MS);

    const message = sim.receive()!;
    const view = decodeSnapshot(message.snapshot);
    const before = view.x[0]!;

    // Keep simulating; the delivered buffer must not change underneath the renderer.
    world.posX[0] = 1000;
    for (let i = 0; i < 5; i++) sim.pump(TICK_MS);

    expect(decodeSnapshot(message.snapshot).x[0]).toBe(before);
  });

  it('stamps commands with the configured execution delay', () => {
    const { world, sim } = host(8, { commandDelayTicks: 3 });
    sim.sendCommand(CommandKind.Spawn, 0, 0, 0);

    // Issued on tick 0, scheduled for tick 3, so the first three steps must not run it.
    sim.pump(TICK_MS * 3);
    expect(world.liveCount).toBe(0);

    sim.pump(TICK_MS);
    expect(world.liveCount).toBe(1);
  });
});
