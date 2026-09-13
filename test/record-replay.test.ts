import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { formatHash } from '../src/shared/hash.js';
import { DEFAULT_CHECKPOINT_INTERVAL, runReplay } from '../src/sim/replay.js';
import { tuningHash } from '../src/sim/tuning.js';
import { buildScenario, GOLDEN_CAPACITY, GOLDEN_SEED, GOLDEN_TICKS } from './scenario.js';
import { GOLDEN_PATH } from './golden.js';

/**
 * Regenerates the golden replay fixture. Skipped unless RECORD_GOLDEN=1, because
 * re-recording on every run would turn the determinism gate into a no-op that always
 * agrees with itself.
 *
 * Run deliberately, via `npm run replay:record`, only when tuning or the scenario
 * changed on purpose — and say so in the commit message.
 */
describe.runIf(process.env.RECORD_GOLDEN === '1')('record golden replay', () => {
  it('writes the fixture', () => {
    const checkpoints = runReplay(
      GOLDEN_SEED,
      GOLDEN_CAPACITY,
      GOLDEN_TICKS,
      buildScenario(GOLDEN_SEED, GOLDEN_TICKS),
      DEFAULT_CHECKPOINT_INTERVAL,
    );

    const fixture = {
      seed: GOLDEN_SEED,
      capacity: GOLDEN_CAPACITY,
      ticks: GOLDEN_TICKS,
      checkpointInterval: DEFAULT_CHECKPOINT_INTERVAL,
      tuningHash: tuningHash(),
      checkpoints,
    };

    fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(fixture, null, 2)}\n`);

    const final = checkpoints[checkpoints.length - 1];
    console.log(
      `recorded ${checkpoints.length} checkpoints over ${GOLDEN_TICKS} ticks; ` +
        `tuning=${formatHash(fixture.tuningHash)} final=${formatHash(final ?? 0)}`,
    );
  });
});
