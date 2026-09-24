import { describe, expect, it } from 'vitest';
import { createAi } from '../src/sim/ai/opponent.js';
import { runTicks } from '../src/sim/loop.js';
import { EntityKind, spawn } from '../src/sim/world.js';
import { foundHomestead, makeSim, flatMap } from './simHarness.js';
import { createHeightmap } from '../src/sim/terrain/generate.js';

/**
 * The neighbour works its own fields.
 *
 * "Fields lose condition unless someone stands on them" is the central rule of this
 * game — it is in the hint text, it has its own alert, and three playthroughs died of
 * not knowing it. The AI had no branch that ever put a villager on one. It herded,
 * built, trained, traded, allied and (lately) felled, and it never once tended.
 *
 * It got away with that on the harness's flat map, where the villagers spawn more or
 * less on top of their fields and hold them by accident. On generated terrain the
 * fields are sited on whatever ground will carry them, nobody goes near, and the
 * measurement is unambiguous — mean field condition over a match:
 *
 *   flat         0.97  0.94  0.92  0.92  0.97  0.98
 *   generated    0.86  0.68  0.50  0.32  0.14  0.01
 *
 * Both villages then starved at tick 18,000 with their land at nothing. It looked like
 * an economy problem and it was a rule the neighbour did not know.
 */

function match(map: ReturnType<typeof flatMap>, ticks: number) {
  const sim = makeSim(512, 0x0a1, map, []);
  for (let i = 0; i < 14; i++) spawn(sim.world, 8 + (i % 4), 8 + (i >> 2), 0);
  for (let i = 0; i < 14; i++) spawn(sim.world, 24 + (i % 4), 24 + (i >> 2), 1);
  foundHomestead(sim, 0, 8, 8);
  foundHomestead(sim, 1, 24, 24);
  sim.loop.ai.push({ player: 0, controller: createAi(0) });
  sim.loop.ai.push({ player: 1, controller: createAi(1) });
  runTicks(sim.loop, ticks);

  let condition = 0;
  let live = 0;
  for (let i = 0; i < sim.farmland.count; i++) {
    if (sim.farmland.owner[i] !== 0 || sim.farmland.alive[i] === 0) continue;
    condition += sim.farmland.condition[i]!;
    live++;
  }
  let villagers = 0;
  for (let i = 0; i < sim.world.capacity; i++) {
    if (sim.world.alive[i] === 1 && sim.world.kind[i] === EntityKind.Unit) villagers++;
  }
  return { condition: condition / Math.max(live, 1), villagers, sim };
}

describe('the neighbour and its fields', () => {
  it('keeps its land in condition on real terrain', () => {
    // Measured at 0.01 before this: the fields had rotted to nothing.
    const m = match(createHeightmap(64, 64, 0x0a1), 18_000);
    expect(m.condition).toBeGreaterThan(0.5);
  });

  it('still has villagers at the end of a match on real terrain', () => {
    // Both villages starved to zero at tick 18,000 with their land at nothing. This is
    // X7, and the land is why.
    expect(match(createHeightmap(64, 64, 0x0a1), 18_000).villagers).toBeGreaterThan(0);
  });

  it('has not lost what already worked on flat ground', () => {
    const m = match(flatMap(64, 2), 18_000);
    expect(m.condition).toBeGreaterThan(0.5);
    expect(m.villagers).toBeGreaterThan(0);
  });
});
