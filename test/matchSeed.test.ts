import { describe, expect, it } from 'vitest';
import { matchSeed } from '../src/host/opening.js';
import { FactionId } from '../src/shared/factions/index.js';
import { createEconomy } from '../src/sim/economy/ledger.js';
import { tuning } from '../src/sim/tuning.js';

/**
 * Every match ran the same weather, whatever map it was on: the simulation was seeded
 * from a fixed world seed. And only in the worker — the direct host took its seed from an
 * option nobody passed and ran everything on seed 0, so one match had two different
 * years depending on which thread it ran on.
 */

function droughtCurve(seed: number): number[] {
  const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], seed);
  const out: number[] = [];
  for (let t = 0; t < tuning.economy.seasonTicks * 4; t += tuning.economy.upkeepIntervalTicks * 5) {
    out.push(economy.drought(t));
  }
  return out;
}

describe('the match seed', () => {
  it('gives different land different weather', () => {
    expect(matchSeed(0x4d666563)).not.toBe(matchSeed(0xbeef));
    expect(droughtCurve(matchSeed(0x4d666563))).not.toEqual(droughtCurve(matchSeed(0xbeef)));
  });

  it('gives the same land the same weather every time', () => {
    expect(droughtCurve(matchSeed(0xbeef))).toEqual(droughtCurve(matchSeed(0xbeef)));
  });
});
