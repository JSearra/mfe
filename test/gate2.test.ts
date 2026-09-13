import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/shared/events.js';
import { createCattleSystem } from '../src/sim/cattle.js';
import { createSpatialGrid, type SpatialGrid } from '../src/sim/spatial/grid.js';
import { tuning } from '../src/sim/tuning.js';
import { presentation } from '../src/render/presentation.js';
import { createDepthOrder } from '../src/render/scene/depthOrder.js';
import {
  EntityKind,
  HerdState,
  createWorld,
  handleIndex,
  spawn,
  type World,
} from '../src/sim/world.js';

/**
 * Gate 2: is a stampeding herd legible as overlapping isometric sprites?
 *
 * ROADMAP Phase 5 holds this open as a separate risk from Gate 1, and says plainly that
 * passing the control gate does not imply passing this one — a mechanic that works as
 * circles can be illegible as sprites. It stayed open because it needs real sprites and
 * there were none.
 *
 * The half of it that can be measured is flicker. `depthOrder.test.ts` already covers the
 * comparator against synthetic jitter, which proves the dead band works but says nothing
 * about whether the band is WIDE ENOUGH for the motion this game actually produces. That
 * is the open question, and it needs real herd motion: forty animals at stampede speed,
 * mutually overlapping, sampled at the render rate rather than the tick rate.
 *
 * The other half — whether a player can see which way the herd is turning — is not
 * testable and was assessed by looking. See ROADMAP Phase 5.
 */

const C = tuning.cattle;
const HYSTERESIS = presentation.entities.depthHysteresis;

/** Render frames per simulation tick: 60Hz over a 20Hz tick. */
const FRAMES_PER_TICK = 3;

const HERD = 40;

function rebuild(world: World, grid: SpatialGrid): void {
  grid.clear();
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] === 1) grid.insert(i, world.posX[i]!, world.posY[i]!);
  }
}

function makeHerd(cows: number) {
  const world = createWorld(128, 90210);
  const grid = createSpatialGrid(64, 64, 2);
  const cattle = createCattleSystem();
  const events: SimEvent[] = [];

  const handles: number[] = [];
  for (let i = 0; i < cows; i++) {
    // Packed at the separation distance they will settle to, so the herd starts at the
    // density it spends its life at rather than exploding apart on the first tick.
    handles.push(
      spawn(
        world,
        20 + (i % 8) * C.separationRadius,
        20 + Math.floor(i / 8) * C.separationRadius,
        0,
        1,
        EntityKind.Cattle,
      ),
    );
  }

  const tick = () => {
    rebuild(world, grid);
    cattle.update(world, grid, events);
    world.tick++;
  };
  return { world, cattle, events, handles, tick };
}

/**
 * Run a herd and drive the render-side depth sort from its motion.
 *
 * Positions are interpolated between ticks exactly as the renderer interpolates them,
 * because the renderer sorts on interpolated positions — sorting a stampede on tick
 * positions would measure something the player never sees.
 *
 * What is counted is REVERSALS PER PAIR, not the comparator's own swap counter. That
 * counter reports insertion-sort shifts, so one beast genuinely overtaking the herd
 * registers about forty of them — a correct reorder, indistinguishable in that number
 * from forty animals shimmering. The first version of this test asserted on it and
 * failed at 135, which turned out to say nothing at all about flicker.
 *
 * Shimmer is specifically a pair that keeps changing its mind. So: track the relative
 * order of every pair across frames, and count how often each pair reverses. A pair
 * that reverses once has overtaken. A pair that reverses fifty times is the artifact
 * the hysteresis exists to prevent.
 */
function measureFlicker(
  world: World,
  handles: readonly number[],
  tick: () => void,
  ticks: number,
): { worstReversals: number; meanReversals: number; frames: number } {
  const depthOrder = createDepthOrder();
  const count = handles.length;
  const handleArray = new Uint32Array(handles);
  const indices = handles.map((handle) => handleIndex(handle));

  const previousX = new Float64Array(count);
  const previousY = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    previousX[i] = world.posX[indices[i]!]!;
    previousY[i] = world.posY[indices[i]!]!;
  }

  let frames = 0;

  const blendX = new Float64Array(count);
  const blendY = new Float64Array(count);

  const rank = new Int32Array(count);
  // Relative order of every pair on the previous frame, and how often it has reversed.
  const wasAhead = new Int8Array(count * count).fill(-1);
  const reversals = new Int32Array(count * count);

  for (let t = 0; t < ticks; t++) {
    tick();

    for (let frame = 1; frame <= FRAMES_PER_TICK; frame++) {
      const alpha = frame / FRAMES_PER_TICK;
      for (let i = 0; i < count; i++) {
        const index = indices[i]!;
        blendX[i] = previousX[i]! + (world.posX[index]! - previousX[i]!) * alpha;
        blendY[i] = previousY[i]! + (world.posY[index]! - previousY[i]!) * alpha;
      }

      const order = depthOrder.order(
        count,
        handleArray,
        (slot) => blendX[slot]! + blendY[slot]!,
        HYSTERESIS,
      );
      frames++;

      for (let position = 0; position < order.length; position++) rank[order[position]!] = position;
      for (let a = 0; a < count; a++) {
        for (let b = a + 1; b < count; b++) {
          const ahead = rank[a]! < rank[b]! ? 1 : 0;
          const key = a * count + b;
          if (wasAhead[key] !== -1 && wasAhead[key] !== ahead) reversals[key]!++;
          wasAhead[key] = ahead;
        }
      }
    }

    for (let i = 0; i < count; i++) {
      previousX[i] = world.posX[indices[i]!]!;
      previousY[i] = world.posY[indices[i]!]!;
    }
  }

  let worstReversals = 0;
  let total = 0;
  let pairs = 0;
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      const value = reversals[a * count + b]!;
      if (value > worstReversals) worstReversals = value;
      total += value;
      pairs++;
    }
  }

  return { worstReversals, meanReversals: total / pairs, frames };
}

describe('gate 2 — a dense herd holds its draw order', () => {
  it('barely reorders while grazing', () => {
    const { world, handles, tick } = makeHerd(HERD);
    // Settle first: the interesting measurement is steady state, not the shove apart
    // that happens on the first few ticks.
    for (let t = 0; t < 60; t++) tick();

    const result = measureFlicker(world, handles, tick, 200);

    // Measured when this was written: the worst pair reverses twice in 600 frames, and
    // the average pair 0.06 times. The bound is loose against that on purpose — these
    // are real numbers from real flocking and will move a little with cattle tuning —
    // but it is tight enough that a herd which actually shimmered would fail it.
    expect(result.worstReversals).toBeLessThanOrEqual(6);
  });

  it('does not churn while stampeding', () => {
    const { world, handles, tick } = makeHerd(HERD);
    for (let t = 0; t < 60; t++) tick();

    // Panic the whole herd in one direction, which is the worst case for the sort: forty
    // animals moving together at speed hold near-identical depths for a long time, so
    // every pair sits inside the dead band and any noise at all can flip it.
    for (const handle of handles) {
      const index = handleIndex(handle);
      world.herdState[index] = HerdState.Stampeding;
      world.stress[index] = C.stressMax;
      world.stampedeTicks[index] = C.stampedeTicks;
      world.velX[index] = C.stampedeSpeed * 0.7;
      world.velY[index] = C.stampedeSpeed * 0.7;
    }

    const result = measureFlicker(world, handles, tick, C.stampedeTicks);

    // Measured: ZERO reversals across the whole stampede, 210 frames of it. Which on
    // reflection is what should happen — a stampede drives the whole herd one way, so
    // relative depth is preserved by the motion itself and the dead band only has to
    // absorb the separation jitter on top. The worst case for this sort is not the
    // stampede at all; it is the grazing herd milling above.
    expect(result.worstReversals).toBeLessThanOrEqual(3);
    expect(result.meanReversals).toBeLessThan(0.1);
  });

  it('still lets a beast that genuinely overtakes the herd move in front of it', () => {
    const { world, handles, tick } = makeHerd(HERD);
    for (let t = 0; t < 60; t++) tick();

    const depthOrder = createDepthOrder();
    const handleArray = new Uint32Array(handles);
    const indices = handles.map((handle) => handleIndex(handle));
    const depth = (slot: number) =>
      world.posX[indices[slot]!]! + world.posY[indices[slot]!]!;

    depthOrder.order(handles.length, handleArray, depth, HYSTERESIS);

    // Hysteresis that never yields is just a frozen order, which is a worse defect than
    // shimmer: a cow would run through the herd and stay drawn behind it.
    const runner = indices[0]!;
    world.posX[runner] = world.posX[runner]! + 12;
    world.posY[runner] = world.posY[runner]! + 12;

    const order = depthOrder.order(handles.length, handleArray, depth, HYSTERESIS);
    expect(order[order.length - 1]).toBe(0);
  });
});
