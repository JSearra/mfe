import { hashTypedArray } from '../shared/hash.js';
import { createLoop, step } from './loop.js';
import { createCattleSystem } from './cattle.js';
import { createMovementSystem } from './movement.js';
import { createHeightmap } from './terrain/generate.js';
import { tuningHash } from './tuning.js';
import type { Command } from './commands.js';
import { createWorld, type World } from './world.js';

/**
 * The golden replay: (seed, tuning hash, command log) -> state hash every N ticks.
 *
 * Built in Phase 0, before there is anything to regress, because it is trivial now
 * and expensive to bolt on later. One artifact yields determinism enforcement,
 * desync detection, the foundation of save/load, regression testing, and headless
 * soak runs. See docs/ARCHITECTURE.md section 1.
 */

export const DEFAULT_CHECKPOINT_INTERVAL = 100;

/**
 * Terrain size for replays. Small enough to keep the golden run fast, large enough that
 * pathfinding has real cliffs and detours to be deterministic about — the map is
 * generated from the same seed, so route choice is part of what the hash pins down.
 */
export const REPLAY_MAP_SIZE = 64;

export interface ReplayRecord {
  readonly seed: number;
  readonly capacity: number;
  readonly tuningHash: number;
  readonly ticks: number;
  readonly checkpointInterval: number;
  readonly commands: readonly Command[];
  /** State hash sampled every `checkpointInterval` ticks. */
  readonly checkpoints: readonly number[];
}

// Reused across calls so hashing a checkpoint allocates nothing.
const scalarScratch = new Float64Array(4);

/**
 * Hash the complete mutable state, dead slots included.
 *
 * Dead slots are deliberate: they carry the free-stack ordering, and free-stack
 * divergence is exactly the cascading failure that generation counters and the
 * sorted destroy flush exist to prevent. Hashing only live entities would hide it.
 */
export function hashWorld(world: World): number {
  scalarScratch[0] = world.tick;
  scalarScratch[1] = world.liveCount;
  scalarScratch[2] = world.freeCount;
  scalarScratch[3] = world.pendingDestroyCount;

  let h = hashTypedArray(scalarScratch);
  h = hashTypedArray(world.rng.state, h);
  h = hashTypedArray(world.alive, h);
  h = hashTypedArray(world.generation, h);
  h = hashTypedArray(world.freeStack, h);
  h = hashTypedArray(world.posX, h);
  h = hashTypedArray(world.posY, h);
  h = hashTypedArray(world.velX, h);
  h = hashTypedArray(world.velY, h);
  return h;
}

/** Run a scenario and collect its checkpoint hashes. */
export function runReplay(
  seed: number,
  capacity: number,
  ticks: number,
  commands: readonly Command[],
  checkpointInterval: number = DEFAULT_CHECKPOINT_INTERVAL,
): number[] {
  const world = createWorld(capacity, seed);
  const map = createHeightmap(REPLAY_MAP_SIZE, REPLAY_MAP_SIZE, seed);
  const loop = createLoop(world, createMovementSystem(map), createCattleSystem(), commands);
  const checkpoints: number[] = [];

  for (let i = 0; i < ticks; i++) {
    step(loop);
    if (world.tick % checkpointInterval === 0) checkpoints.push(hashWorld(world));
  }
  return checkpoints;
}

export function recordReplay(
  seed: number,
  capacity: number,
  ticks: number,
  commands: readonly Command[],
  checkpointInterval: number = DEFAULT_CHECKPOINT_INTERVAL,
): ReplayRecord {
  return {
    seed,
    capacity,
    tuningHash: tuningHash(),
    ticks,
    checkpointInterval,
    commands,
    checkpoints: runReplay(seed, capacity, ticks, commands, checkpointInterval),
  };
}

export type ReplayResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'tuning-mismatch';
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'checkpoint-count';
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'hash-mismatch';
      readonly tick: number;
      readonly expected: number;
      readonly actual: number;
    };

/**
 * Verify a recorded replay against the current build.
 *
 * The tuning check comes first and short-circuits. A replay recorded against
 * different tuning constants *will* produce different hashes, and reporting that as
 * a bare hash difference sends you hunting for a determinism bug that is not there.
 */
export function verifyReplay(record: ReplayRecord): ReplayResult {
  const currentTuning = tuningHash();
  if (currentTuning !== record.tuningHash) {
    return { ok: false, reason: 'tuning-mismatch', expected: record.tuningHash, actual: currentTuning };
  }

  const actual = runReplay(
    record.seed,
    record.capacity,
    record.ticks,
    record.commands,
    record.checkpointInterval,
  );

  if (actual.length !== record.checkpoints.length) {
    return {
      ok: false,
      reason: 'checkpoint-count',
      expected: record.checkpoints.length,
      actual: actual.length,
    };
  }

  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== record.checkpoints[i]) {
      return {
        ok: false,
        reason: 'hash-mismatch',
        tick: (i + 1) * record.checkpointInterval,
        expected: record.checkpoints[i]!,
        actual: actual[i]!,
      };
    }
  }

  return { ok: true };
}

export function describeReplayResult(result: ReplayResult): string {
  if (result.ok) return 'replay matches';
  switch (result.reason) {
    case 'tuning-mismatch':
      return `tuning changed since this replay was recorded (recorded ${result.expected.toString(16)}, current ${result.actual.toString(16)}). Re-record the golden replay if the change was intentional.`;
    case 'checkpoint-count':
      return `expected ${result.expected} checkpoints, got ${result.actual}`;
    case 'hash-mismatch':
      return `state diverged at tick ${result.tick} (expected ${result.expected.toString(16)}, got ${result.actual.toString(16)})`;
  }
}
