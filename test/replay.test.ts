import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeReplayResult,
  recordReplay,
  runReplay,
  verifyReplay,
  type ReplayRecord,
} from '../src/sim/replay.js';
import { tuningHash } from '../src/sim/tuning.js';
import { buildScenario, GOLDEN_CAPACITY, GOLDEN_SEED, GOLDEN_TICKS } from './scenario.js';
import { GOLDEN_PATH, type GoldenFixture } from './golden.js';

const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFixture;

function goldenRecord(): ReplayRecord {
  return {
    seed: golden.seed,
    capacity: golden.capacity,
    ticks: golden.ticks,
    checkpointInterval: golden.checkpointInterval,
    tuningHash: golden.tuningHash,
    // Rebuilt from the seed rather than stored, so the scenario itself is under test.
    commands: buildScenario(golden.seed, golden.ticks),
    checkpoints: golden.checkpoints,
  };
}

describe('golden replay', () => {
  it('reproduces the committed state hashes over 10,000 ticks', () => {
    const result = verifyReplay(goldenRecord());
    expect(describeReplayResult(result)).toBe('replay matches');
    expect(result.ok).toBe(true);
  });

  it('covers the whole run', () => {
    expect(golden.ticks).toBe(GOLDEN_TICKS);
    expect(golden.seed).toBe(GOLDEN_SEED);
    expect(golden.capacity).toBe(GOLDEN_CAPACITY);
    expect(golden.checkpoints).toHaveLength(golden.ticks / golden.checkpointInterval);
  });

  it('produces identical hashes from two independent runs', () => {
    const commands = buildScenario(GOLDEN_SEED, 2000);
    const first = runReplay(GOLDEN_SEED, GOLDEN_CAPACITY, 2000, commands);
    const second = runReplay(GOLDEN_SEED, GOLDEN_CAPACITY, 2000, commands);
    expect(second).toEqual(first);
  });

  it('exercises entity churn rather than an empty world', () => {
    // A replay over a world that never changes would pass trivially.
    const commands = buildScenario(GOLDEN_SEED, 2000);
    expect(commands.length).toBeGreaterThan(100);
    const hashes = runReplay(GOLDEN_SEED, GOLDEN_CAPACITY, 2000, commands);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('divergence reporting', () => {
  it('reports a tuning change as a tuning mismatch, not a hash difference', () => {
    const record: ReplayRecord = { ...goldenRecord(), tuningHash: golden.tuningHash ^ 0xdeadbeef };
    const result = verifyReplay(record);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('tuning-mismatch');
    expect(describeReplayResult(result)).toContain('tuning changed');
    expect(describeReplayResult(result)).toContain('Re-record');
  });

  it('reports state divergence with the tick it first appeared', () => {
    const base = recordReplay(GOLDEN_SEED, GOLDEN_CAPACITY, 500, buildScenario(GOLDEN_SEED, 500));
    const corrupted: ReplayRecord = {
      ...base,
      checkpoints: base.checkpoints.map((h, i) => (i === 2 ? h ^ 1 : h)),
    };

    const result = verifyReplay(corrupted);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'hash-mismatch') throw new Error('expected hash-mismatch');
    expect(result.tick).toBe(300);
    expect(describeReplayResult(result)).toContain('diverged at tick 300');
  });

  it('detects a different seed', () => {
    const base = recordReplay(GOLDEN_SEED, GOLDEN_CAPACITY, 500, buildScenario(GOLDEN_SEED, 500));
    const result = verifyReplay({ ...base, seed: GOLDEN_SEED + 1 });
    expect(result.ok).toBe(false);
  });

  it('records against the current tuning hash', () => {
    const record = recordReplay(GOLDEN_SEED, 64, 100, []);
    expect(record.tuningHash).toBe(tuningHash());
    expect(verifyReplay(record).ok).toBe(true);
  });
});
