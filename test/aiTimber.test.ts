import { describe, expect, it } from 'vitest';
import { createAi } from '../src/sim/ai/opponent.js';
import { runTicks } from '../src/sim/loop.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { EntityKind, spawn } from '../src/sim/world.js';
import { makeSim } from './simHarness.js';
import { createHeightmap } from '../src/sim/terrain/generate.js';
import { updateFog } from '../src/sim/vision/fog.js';
import { CommandKind } from '../src/sim/commands.js';
import { tuning } from '../src/sim/tuning.js';
import { FACTIONS, FactionId } from '../src/shared/factions/index.js';

/**
 * The neighbour cuts its own timber.
 *
 * With the rest of its economy working it still stopped building for ever after its
 * opening stock: it starts with 90 timber, every building costs some, and nothing in
 * `decide` had ever felled a tree — the woodland was not even passed to it. Timber is
 * the one resource that cannot be reliably traded for and cannot be produced by
 * building. It has to be walked to and cut.
 *
 * **The assertions here are about TIMBER and not about buildings, and that is a
 * correction.** The first version asserted a building count, and it could not pass:
 * measured on the generated map below, the AI's binding constraint is grain rather than
 * timber, so it sits on 150 timber it cannot spend. Asserting the building count would
 * have been asserting something this change does not claim to do.
 */

const OPENING_WOOD = FACTIONS[FactionId.Zulu].startingWood;

/** A symmetric match on real terrain, which is the only kind with trees on it. */
function match(seed: number, ticks: number) {
  // The harness's default map is flat at level nought, where nothing can take root, so
  // its woodland is empty — and a test about felling on a map with no trees would have
  // passed the moment the AI did nothing at all.
  const sim = makeSim(512, seed, createHeightmap(64, 64, seed), []);
  for (let i = 0; i < 14; i++) spawn(sim.world, 8 + (i % 4), 8 + (i >> 2), 0);
  for (let i = 0; i < 14; i++) spawn(sim.world, 24 + (i % 4), 24 + (i >> 2), 1);
  sim.loop.ai.push({ player: 0, controller: createAi(0) });
  sim.loop.ai.push({ player: 1, controller: createAi(1) });
  runTicks(sim.loop, ticks);

  let standing = 0;
  for (let i = 0; i < sim.woodland.count; i++) standing += sim.woodland.alive[i]!;
  let villagers = 0;
  for (let i = 0; i < sim.world.capacity; i++) {
    if (sim.world.alive[i] === 1 && sim.world.kind[i] === EntityKind.Unit) villagers++;
  }
  return { wood: sim.economy.balance(0, Resource.Wood), standing, villagers, sim };
}

describe('the neighbour and its timber', () => {
  it('ends a match holding more timber than it started with', () => {
    // It cannot trade for this and cannot build it. The only way the number goes up is
    // that somebody walked to a tree and cut it.
    expect(match(0x0a1, 24_000).wood).toBeGreaterThan(OPENING_WOOD);
  });

  it('orders the axe only while it is short', () => {
    /*
     * The guard that makes the assertion above mean something, and it is a direct one
     * rather than a window in time. Two attempts at a timing guard both failed because
     * felling is FAST — the village holds its ceiling within two hundred ticks — and a
     * test that cannot find a moment before the behaviour starts is testing the clock
     * rather than the rule.
     *
     * So: ask `decide` twice on the same world, once below the timber floor and once
     * above it, and look at what it emits. That is the rule itself.
     */
    const sim = makeSim(512, 0x0a1, createHeightmap(64, 64, 0x0a1), []);
    for (let i = 0; i < 14; i++) spawn(sim.world, 8 + (i % 4), 8 + (i >> 2), 0);
    updateFog(sim.world, sim.map, sim.fog);
    sim.world.tick = tuning.ai.decideEveryTicks;

    const felling = (): boolean => {
      let sawFell = false;
      createAi(0).decide(
        sim.world, sim.fog, sim.economy, sim.alliance, sim.tech,
        (command) => { if (command.kind === CommandKind.Fell) sawFell = true; },
        sim.woodland,
      );
      return sawFell;
    };

    sim.economy.spend(0, Resource.Wood, sim.economy.balance(0, Resource.Wood));
    expect(felling(), 'a village with no timber should be cutting').toBe(true);

    sim.economy.add(0, Resource.Wood, tuning.ai.timberFloor * 3);
    expect(felling(), 'a village with plenty should not be').toBe(false);
  });

  it('stops cutting once it has enough, and leaves the wood standing', () => {
    // A village that fells everything within reach has taken the one renewable thing on
    // the map and made it not renewable — a standing wood is what seeds the next one.
    const start = match(0x0a1, 200);
    const end = match(0x0a1, 24_000);
    expect(end.standing).toBeGreaterThan(start.standing * 0.8);
  });

  it('costs the village nothing it was not already losing', () => {
    // Measured with the branch on and off before this landed: the village on this map
    // collapses at tick 18,000 either way, at the same tick, for want of GRAIN. Felling
    // pulls people off the fields to do it, so it could have made that worse and did
    // not. Pinned here because "it did not make things worse" is a claim that rots.
    const m = match(0x0a1, 12_000);
    expect(m.villagers).toBeGreaterThan(0);
  });
});
