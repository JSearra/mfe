import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeReplayResult,
  recordReplay,
  runReplay,
  verifyReplay,
  hashWorld,
  type ReplayRecord,
} from '../src/sim/replay.js';
import { tuningHash } from '../src/sim/tuning.js';
import { createWorld, worldStateFields, type World } from '../src/sim/world.js';
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

describe('what the state hash can see', () => {
  /**
   * `hashWorld` said it hashed "the complete mutable state" and listed ten arrays by
   * hand while the world held fifty-three. The gate was blind to health, faction, kind,
   * facing, every order and its queue, every building's type and progress and every
   * attack target — so a determinism bug anywhere in combat or construction moved
   * nothing at all. It also made the save round-trip test blind, which is how a save
   * that dropped nine world arrays passed for as long as it did.
   */
  // This one pins the derivation that both the hash and the save consume; the eight
  // below pin what the hash itself can actually see. Kept separate on purpose — a
  // complete field list that the hash then failed to iterate would pass this and fail
  // those.
  it('derives a field list covering every typed array the world holds', () => {
    const world = createWorld(16, 1);
    const held = Object.keys(world).filter((key) =>
      ArrayBuffer.isView((world as unknown as Record<string, unknown>)[key] as object),
    );
    const covered = new Set(worldStateFields(world));
    const blind = held.filter((key) => !covered.has(key));
    expect(blind, `state the hash cannot see: ${blind.join(', ')}`).toEqual([]);
  });

  it.each([
    ['hp', (w: World) => (w.hp[0] = 7)],
    ['buildingType', (w: World) => (w.buildingType[0] = 3)],
    ['buildProgress', (w: World) => (w.buildProgress[0] = 12)],
    ['attackTarget', (w: World) => (w.attackTarget[0] = 99)],
    ['stance', (w: World) => (w.stance[0] = 2)],
    ['queueCount', (w: World) => (w.queueCount[0] = 1)],
    ['faction', (w: World) => (w.faction[0] = 1)],
    ['facing', (w: World) => (w.facing[0] = 1.5)],
  ])('notices a change to %s', (_name, mutate) => {
    const before = createWorld(16, 1);
    const after = createWorld(16, 1);
    expect(hashWorld(after)).toBe(hashWorld(before));

    mutate(after);
    expect(hashWorld(after)).not.toBe(hashWorld(before));
  });
});
