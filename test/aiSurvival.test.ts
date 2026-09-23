import { describe, expect, it } from 'vitest';
import { createAi } from '../src/sim/ai/opponent.js';
import { runTicks } from '../src/sim/loop.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { EntityKind, spawn } from '../src/sim/world.js';
import { makeSim } from './simHarness.js';

/**
 * The neighbour obeys the rule the game states.
 *
 * Traced over a 24,000-tick match, the AI grew 14 villagers to 63 on land that feeds
 * 64-77 in a good year. That pinned its granary at about 145 — just above the training
 * floor of 160 and nowhere near the build bar of 400 — so it raised exactly one
 * homestead in twenty minutes. Then the drought came, `feeds` fell to 16 against 63
 * mouths, every villager starved, and its grain climbed to 1,070 with nobody left.
 *
 * `economy.feeds` is the number the HUD puts in front of the human — "land feeds 63" —
 * and the whole of the win path is to break more ground rather than raise more people.
 * The neighbour was doing the opposite as fast as it could afford to. This is not a
 * retune: it is the AI following the rule the interface already states.
 */

/** A symmetric match on the harness's own starting fields. */
function match(seed: number, ticks: number) {
  const sim = makeSim(512, seed, undefined, []);
  for (let i = 0; i < 14; i++) spawn(sim.world, 8 + (i % 4), 8 + (i >> 2), 0);
  for (let i = 0; i < 14; i++) spawn(sim.world, 24 + (i % 4), 24 + (i >> 2), 1);
  sim.loop.ai.push({ player: 0, controller: createAi(0) });
  sim.loop.ai.push({ player: 1, controller: createAi(1) });
  runTicks(sim.loop, ticks);

  const count = (player: number, kind: number): number => {
    let n = 0;
    for (let i = 0; i < sim.world.capacity; i++) {
      if (sim.world.alive[i] !== 1 || sim.world.faction[i] !== player) continue;
      if (sim.world.kind[i] === kind) n++;
    }
    return n;
  };

  return {
    units: (p: number) => count(p, EntityKind.Unit),
    buildings: (p: number) => count(p, EntityKind.Building),
    feeds: (p: number) => sim.economy.feeds[p]!,
    grain: (p: number) => sim.economy.balance(p, Resource.Grain),
  };
}

describe('the neighbour and its own ledger', () => {
  it('still has a village after a hard year', () => {
    // The whole of it. Before, every villager on both sides was dead by tick 21,000 and
    // the granaries were full.
    for (const seed of [0x0a1, 0xf00d]) {
      const m = match(seed, 24_000);
      expect(m.units(0), `seed ${seed} player 0 wiped out`).toBeGreaterThan(0);
      expect(m.units(1), `seed ${seed} player 1 wiped out`).toBeGreaterThan(0);
    }
  });

  it('does not grow far past what its land will carry', () => {
    const m = match(0x0a1, 18_000);
    // Some overshoot is honest: `feeds` is what the LAST harvest would carry and the
    // weather moves under it. What is not honest is doubling it.
    expect(m.units(0)).toBeLessThan(m.feeds(0) * 2 + 20);
  });

  it('builds more than one thing in twenty minutes', () => {
    // Grain no longer sits pinned just above the training floor, so the build bar is
    // reachable at all.
    const m = match(0x0a1, 24_000);
    expect(m.buildings(0)).toBeGreaterThan(1);
  });

  it('does not simply stop spending', () => {
    // The failure mode opposite the one being fixed: an AI that refuses to train and
    // hoards would pass every assertion above and play worse than the one it replaced.
    const m = match(0x0a1, 24_000);
    expect(m.units(0)).toBeGreaterThan(14);
  });
});
