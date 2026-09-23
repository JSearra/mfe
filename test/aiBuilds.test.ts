import { describe, expect, it } from 'vitest';
import { createAi } from '../src/sim/ai/opponent.js';
import { CommandKind } from '../src/sim/commands.js';
import { runTicks } from '../src/sim/loop.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { BuildingType } from '../src/shared/buildings/index.js';
import { updateFog } from '../src/sim/vision/fog.js';
import { EntityKind, spawn } from '../src/sim/world.js';
import { makeSim } from './simHarness.js';
import { tuning } from '../src/sim/tuning.js';

/**
 * What the neighbour knows how to build.
 *
 * Its repertoire was `Umuzi` and `GrainStore` — two of the eight types in the
 * catalogue. It had never known about the ikhanda or the indlunkulu, and Part II added
 * a pit, a weir and a fold that it could not build either, so five of the eight were
 * dead content in every AI match.
 *
 * That is not only a content problem. The pit and the fold exist to answer a bad year,
 * and a neighbour that cannot answer one is not a neighbour worth racing: it will
 * starve on the schedule the weather sets rather than on the one its own decisions set.
 */

function village(seed = 0x0a1) {
  const sim = makeSim(256, seed, undefined, []);
  for (let i = 0; i < 12; i++) spawn(sim.world, 6 + (i % 4), 6 + (i >> 2), 0);
  sim.loop.ai.push({ player: 0, controller: createAi(0) });
  return sim;
}

/**
 * Which building types the AI actually gets STANDING over a run.
 *
 * Driven through the real loop rather than by calling `decide` and reading the commands
 * it emits. A first pass did the latter and it was useless: `decide` does not execute
 * anything, so the homestead count never rose, the AI ordered its first homestead on
 * every decision for the whole run, and the test concluded it could not build a
 * granary. What the AI does next depends on what it has already got, so the only honest
 * way to ask the question is to let it have things.
 */
function standingOver(ticks: number, grain: number, wood: number): Set<number> {
  const sim = village();
  sim.economy.add(0, Resource.Grain, grain);
  sim.economy.add(0, Resource.Wood, wood);
  runTicks(sim.loop, ticks);

  const seen = new Set<number>();
  for (let i = 0; i < sim.world.capacity; i++) {
    if (sim.world.alive[i] !== 1) continue;
    if (sim.world.kind[i] !== EntityKind.Building) continue;
    if (sim.world.faction[i] !== 0) continue;
    seen.add(sim.world.buildingType[i]!);
  }
  return seen;
}

/** Every building type this AI ORDERS, whether or not the order is accepted. */
function ordersOver(ticks: number, grain: number, wood: number): Set<number> {
  const sim = village();
  const economy = sim.economy;
  // Spent down first. A faction opens with 90 timber, so "give it no wood" has to mean
  // taking the opening stock away rather than adding nothing to it — the first version
  // of this test added zero and then asserted about a village holding ninety.
  economy.spend(0, Resource.Grain, economy.balance(0, Resource.Grain));
  economy.spend(0, Resource.Wood, economy.balance(0, Resource.Wood));
  economy.add(0, Resource.Grain, grain);
  economy.add(0, Resource.Wood, wood);

  const seen = new Set<number>();
  const ai = createAi(0);
  for (let tick = 0; tick <= ticks; tick += tuning.ai.decideEveryTicks) {
    sim.world.tick = tick;
    updateFog(sim.world, sim.map, sim.fog);
    ai.decide(sim.world, sim.fog, economy, sim.alliance, sim.tech, (command) => {
      if (command.kind === CommandKind.Build) seen.add(command.c);
    });
  }
  return seen;
}

describe('the neighbour s repertoire', () => {
  it('still raises homesteads and granaries', () => {
    const seen = standingOver(9000, 12_000, 12_000);
    expect(seen.has(BuildingType.Umuzi)).toBe(true);
    expect(seen.has(BuildingType.GrainStore)).toBe(true);
  });

  it('digs pits and builds folds when it can afford to', () => {
    const seen = standingOver(9000, 12_000, 12_000);
    expect(seen.has(BuildingType.Umgodi)).toBe(true);
    expect(seen.has(BuildingType.IsibayaSezimbuzi)).toBe(true);
  });

  it('orders nothing it cannot pay for', () => {
    // Timber is the binding constraint on most of the catalogue, and it was not checked
    // at all: the AI ordered by its grain balance alone, and `place` refused every one
    // of those orders on timber it did not have. A decision spent being refused is a
    // decision not spent herding, trading or asking a neighbour for help.
    expect(ordersOver(4000, 6000, 0).size).toBe(0);
  });

  it('does not put up a weir, because it cannot tell a bank from a field', () => {
    // Deliberate. Siting a weir needs a shore tile, and the AI picks its spots by
    // arithmetic around its own homestead — it would order the same refusal every
    // decision for the whole match. Better to leave one building to the player than to
    // give the neighbour a standing way to waste its turn.
    expect(standingOver(9000, 12_000, 12_000).has(BuildingType.Isiziba)).toBe(false);
  });

  it('runs a long match without stalling', () => {
    const sim = village();
    sim.economy.add(0, Resource.Grain, 4000);
    sim.economy.add(0, Resource.Wood, 4000);
    expect(() => runTicks(sim.loop, 3000)).not.toThrow();
  });
});
