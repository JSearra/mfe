import { describe, expect, it } from 'vitest';
import { createDirectSimHost } from '../src/host/directHost.js';
import { createWorld } from '../src/sim/world.js';
import { flatMap } from './simHarness.js';

/**
 * Pause and fast-forward are host concerns and must stay that way.
 *
 * The tick is a fixed 50ms and every determinism guarantee in the project rests on it
 * staying fixed. Speed changes how many of those identical ticks a second of real time
 * buys — never what a tick computes — so a game run at double speed reaches exactly the
 * state a normal one would, just sooner.
 */

function host() {
  return createDirectSimHost({ world: createWorld(64, 1), map: flatMap(32), strict: false });
}

describe('simulation speed', () => {
  it('advances at real time by default', () => {
    const sim = host();
    sim.pump(1000);
    expect(sim.tick).toBe(5); // capped by the catch-up limiter, not by speed
  });

  it('stops entirely when paused', () => {
    const sim = host();
    sim.pump(200);
    const at = sim.tick;
    sim.speed = 0;
    for (let i = 0; i < 10; i++) sim.pump(200);
    expect(sim.tick).toBe(at);
  });

  it('does not bank time while paused', () => {
    const sim = host();
    sim.speed = 0;
    // A long pause must not fast-forward on resume. Banking the elapsed time is the
    // obvious implementation and the wrong one.
    for (let i = 0; i < 50; i++) sim.pump(1000);
    sim.speed = 1;
    sim.pump(50);
    expect(sim.tick).toBe(1);
  });

  it('reaches the same state faster when sped up', () => {
    const slow = host();
    const fast = host();
    // Same simulated time, different real time. Pumped in tick-sized slices so the
    // catch-up limiter does not truncate either run.
    for (let i = 0; i < 20; i++) slow.pump(50);
    fast.speed = 2;
    for (let i = 0; i < 10; i++) fast.pump(50);
    expect(fast.tick).toBe(slow.tick);
  });
});
