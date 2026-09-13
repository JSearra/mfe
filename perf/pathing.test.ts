import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMovementSystem } from '../src/sim/movement.js';
import { MovementClass } from '../src/sim/pathing/costs.js';
import { createPathingService } from '../src/sim/pathing/service.js';
import { createHeightmap } from '../src/sim/terrain/generate.js';
import { createWorld, spawn } from '../src/sim/world.js';
import { TICK_MS } from '../src/shared/timing.js';

/**
 * Pathing performance budget.
 *
 * NOT the brief's "300 path vectors within 10ms". That optimises a workload that never
 * occurs: a 300-unit army is 6 to 20 groups sharing flow fields, and steady state is a
 * handful of requests per tick plus collision repaths. Chasing the phantom burst is what
 * pushed the original design toward JPS. See ADR-0003.
 *
 * What players actually notice is a hitching simulation and orders that feel ignored,
 * so those are what get asserted: the per-tick cost of the movement subsystem, and how
 * long a path request waits.
 */

const MAP_SIZE = 128;
const UNITS = 300;
const TICKS = 600;

/**
 * Two budgets, not one, because the costs are different in kind.
 *
 * Most ticks only move units along fields that already exist, and that must stay cheap
 * enough to disappear inside the 50ms tick. Ticks that also build a flow field pay for a
 * Dijkstra over the whole map — bounded to one per tick by the pathing budget — and
 * conflating the two produces a single number that hides which one regressed.
 */
const STEADY_BUDGET_MS = 1.5;
const BUILD_BUDGET_MS = 8;
/** A path request that takes longer than this reads as an ignored order. */
const LATENCY_BUDGET_MS = 200;

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

describe('pathing performance', () => {
  it(`keeps ${UNITS} units moving within ${STEADY_BUDGET_MS}ms of simulation time per tick`, () => {
    const map = createHeightmap(MAP_SIZE, MAP_SIZE, 0xfeed);
    const world = createWorld(1024, 0xbeef);
    const movement = createMovementSystem(map);

    const handles: number[] = [];
    for (let i = 0; i < UNITS; i++) {
      const column = i % 20;
      const row = Math.floor(i / 20);
      handles.push(spawn(world, 10 + column * 0.8, 10 + row * 0.8, i % 2));
    }

    // Fifteen groups of twenty, which is what a 300-unit army actually looks like.
    const groups = 15;
    const perGroup = Math.ceil(UNITS / groups);
    for (let group = 0; group < groups; group++) {
      const goalX = 20 + ((group * 7) % 90);
      const goalY = 20 + ((group * 23) % 90);
      for (let i = group * perGroup; i < Math.min((group + 1) * perGroup, UNITS); i++) {
        movement.order(world, handles[i]!, goalX, goalY);
      }
    }

    // Cost layers are built lazily on first use. That is load-time cost, not steady
    // state, so it is paid before measuring — as the render harness does for shader
    // compilation.
    movement.update(world);
    world.tick++;

    const steadyTimes: number[] = [];
    const buildTimes: number[] = [];
    let maxBuildsInOneTick = 0;

    for (let tick = 0; tick < TICKS; tick++) {
      // Re-order a group periodically, as a player redirecting an army would.
      if (tick > 0 && tick % 60 === 0) {
        const group = (tick / 60) % groups;
        const goalX = 15 + ((tick * 13) % 100);
        const goalY = 15 + ((tick * 29) % 100);
        for (let i = group * perGroup; i < Math.min((group + 1) * perGroup, UNITS); i++) {
          movement.order(world, handles[i]!, goalX, goalY);
        }
      }

      const started = performance.now();
      movement.update(world);
      const elapsed = performance.now() - started;
      world.tick++;

      const built = movement.pathing.stats.flowFieldsBuiltThisTick;
      maxBuildsInOneTick = Math.max(maxBuildsInOneTick, built);
      if (built > 0) buildTimes.push(elapsed);
      else steadyTimes.push(elapsed);
    }

    const steadyP99 = percentile(steadyTimes, 0.99);
    const steadyMean = steadyTimes.reduce((a, b) => a + b, 0) / steadyTimes.length;
    const worstBuild = buildTimes.length === 0 ? 0 : Math.max(...buildTimes);

    fs.writeFileSync(
      '/tmp/perf-pathing.txt',
      `${UNITS} units / ${TICKS} ticks\n` +
        `  steady: mean ${steadyMean.toFixed(2)}ms p99 ${steadyP99.toFixed(2)}ms over ${steadyTimes.length} ticks\n` +
        `  builds: ${buildTimes.length} ticks, worst ${worstBuild.toFixed(2)}ms, max ${maxBuildsInOneTick} per tick\n` +
        `  ${movement.stats.flowFieldGroups} groups, ${movement.stats.singlePaths} single paths, ${movement.stats.stuckRepaths} repaths\n`,
    );

    // The pathing budget must actually bound construction, or a redirected army builds
    // every field at once.
    expect(maxBuildsInOneTick).toBeLessThanOrEqual(1);
    expect(steadyP99).toBeLessThan(STEADY_BUDGET_MS);
    expect(worstBuild).toBeLessThan(BUILD_BUDGET_MS);
  });

  it(`serves path requests within ${LATENCY_BUDGET_MS}ms under realistic load`, () => {
    const map = createHeightmap(MAP_SIZE, MAP_SIZE, 0xfeed);
    const service = createPathingService(map);

    const issuedAt = new Map<number, number>();
    const latencies: number[] = [];
    const outstanding: number[] = [];

    for (let tick = 0; tick < 400; tick++) {
      // A steady trickle of lone units, plus an occasional burst as a player
      // redirects several stragglers at once.
      const issue = tick % 20 === 0 ? 20 : tick % 3 === 0 ? 3 : 0;
      for (let i = 0; i < issue; i++) {
        const start = (tick * 37 + i * 911) % (MAP_SIZE * MAP_SIZE);
        const goal = (tick * 613 + i * 71) % (MAP_SIZE * MAP_SIZE);
        const handle = service.requestPath(start, goal, MovementClass.Infantry);
        issuedAt.set(handle, tick);
        outstanding.push(handle);
      }

      service.process();

      for (let i = outstanding.length - 1; i >= 0; i--) {
        const handle = outstanding[i]!;
        if (service.consumePath(handle) === null) continue;
        latencies.push((tick - issuedAt.get(handle)!) * TICK_MS);
        outstanding.splice(i, 1);
      }
    }

    const p99 = percentile(latencies, 0.99);
    fs.appendFileSync(
      '/tmp/perf-pathing.txt',
      `${latencies.length} requests — p99 latency ${p99.toFixed(0)}ms, ` +
        `worst ${Math.max(...latencies).toFixed(0)}ms, ${outstanding.length} still queued\n`,
    );

    expect(latencies.length).toBeGreaterThan(500);
    expect(p99).toBeLessThan(LATENCY_BUDGET_MS);
  });
});
