import { describe, it } from 'vitest';
import { createAi } from '../src/sim/ai/opponent.js';
import { runTicks } from '../src/sim/loop.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { EntityKind, spawn } from '../src/sim/world.js';
import { makeSim } from './simHarness.js';

describe('why', () => {
  it('tracks the AI ledger through a match', () => {
    const sim = makeSim(512, 0x0a1, undefined, []);
    for (let i = 0; i < 14; i++) spawn(sim.world, 8 + (i % 4), 8 + (i >> 2), 0);
    for (let i = 0; i < 14; i++) spawn(sim.world, 24 + (i % 4), 24 + (i >> 2), 1);
    sim.loop.ai.push({ player: 0, controller: createAi(0) });
    sim.loop.ai.push({ player: 1, controller: createAi(1) });

    for (let block = 0; block < 8; block++) {
      runTicks(sim.loop, 3000);
      let units = 0;
      let builds = 0;
      for (let i = 0; i < sim.world.capacity; i++) {
        if (sim.world.alive[i] !== 1 || sim.world.faction[i] !== 0) continue;
        if (sim.world.kind[i] === EntityKind.Unit) units++;
        if (sim.world.kind[i] === EntityKind.Building) builds++;
      }
      console.log(
        `t=${sim.world.tick} p0 grain=${sim.economy.balance(0, Resource.Grain).toFixed(0)}` +
        ` harvest=${sim.economy.harvested[0]!.toFixed(0)} upkeep=${sim.economy.upkeep[0]!.toFixed(0)}` +
        ` feeds=${sim.economy.feeds[0]!.toFixed(0)} units=${units} buildings=${builds}` +
        ` short=${sim.economy.shortfall[0]!.toFixed(0)}`,
      );
    }
  });
});
