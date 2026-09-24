import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { BuildingType } from '../src/shared/buildings/index.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { tuning } from '../src/sim/tuning.js';
import { EntityKind, spawn } from '../src/sim/world.js';
import { makeSim } from './simHarness.js';

const GRACE = tuning.census.emptiedGraceTicks;

function village(households = 3) {
  const sim = makeSim(256, 11);
  for (let i = 0; i < households; i++) spawn(sim.world, 5 + (i % 8) * 0.6, 5 + (i / 8 | 0) * 0.6, 0);
  for (let i = 0; i < 3; i++) spawn(sim.world, 25 + i, 25, 1);

  const events: SimEvent[] = [];
  const run = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      sim.census.update(sim.world, events);
      sim.world.tick++;
    }
  };
  const empty = (player: number): void => {
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] === 1 && sim.world.faction[i] === player && sim.world.kind[i] === EntityKind.Unit) {
        sim.world.alive[i] = 0;
      }
    }
  };
  return { ...sim, events, run, empty };
}

describe('the census', () => {
  it('counts the people, not the herd', () => {
    const sim = village(60);
    // A vast herd is wealth and does not make a village bigger.
    sim.economy.add(0, Resource.Cattle, 5000);
    sim.run(1);
    expect(sim.census.households[0]).toBe(60);
    expect(sim.census.households[1]).toBe(3);
  });

  it('has no size at which anything happens — there is no target (ADR-0020)', () => {
    // The old objective settled a village at sixty and ended the match. Nothing
    // should come of any size now, however large or however long it is held.
    const sim = village(200);
    sim.run(20_000);
    expect(sim.events).toEqual([]);
    expect(sim.census.emptied[0]).toBe(0);
  });
});

describe('an emptied village', () => {
  it('gives a grace period before calling a village empty', () => {
    const sim = village();
    sim.empty(1);

    sim.run(GRACE - 5);
    // The window covers a last villager dying while a homestead finishes a replacement.
    expect(sim.census.emptied[1]).toBe(0);

    sim.run(10);
    expect(sim.census.emptied[1]).toBe(1);
    expect(sim.events.filter((e) => e.type === EventType.VillageEmptied)).toHaveLength(1);
  });

  it('is emptied of people, whatever is still standing', () => {
    const sim = village();
    // Empty huts do not keep a village alive: nothing destroys a building any more, so
    // requiring them gone would make this unreachable (see Phase V6).
    sim.construction.place(sim.world, sim.economy, 1, BuildingType.Umuzi, 25, 25, []);
    sim.empty(1);
    sim.run(GRACE + 5);
    expect(sim.census.emptied[1]).toBe(1);
  });

  it('does not end anything for anyone else', () => {
    const sim = village();
    sim.empty(1);
    sim.run(GRACE * 3);
    // The other village is simply still there. Nobody wins by being last.
    expect(sim.census.emptied[0]).toBe(0);
    expect(sim.census.households[0]).toBe(3);
    expect(sim.events.filter((e) => e.type === EventType.VillageEmptied)).toHaveLength(1);
  });

  it('stops being empty when somebody lives there again', () => {
    const sim = village();
    sim.empty(1);
    sim.run(GRACE + 5);
    expect(sim.census.emptied[1]).toBe(1);

    spawn(sim.world, 30, 30, 1);
    sim.run(1);
    expect(sim.census.emptied[1]).toBe(0);
    expect(sim.census.graceTicks[1]).toBe(0);
  });
});
