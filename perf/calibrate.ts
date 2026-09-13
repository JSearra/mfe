/**
 * Scale wall-clock budgets to the machine running them.
 *
 * The pathing budgets were calibrated on a developer machine and asserted as absolute
 * milliseconds, which meant CI failed on every commit from the first push: a shared
 * two-core runner is several times slower than the laptop the numbers came from, and
 * `worstBuild` had under twice its own headroom. The gate was not detecting anything,
 * it was measuring the hardware.
 *
 * The alternative was to make the wall-clock checks advisory in CI, as
 * scripts/perf-terrain.mjs does for frame times. That is right there — a GPU falling
 * back to software rendering makes frame times meaningless rather than merely slower —
 * but it is wrong here. There is no confound in this gate, only a slower CPU, and
 * pathing is the one budget in this project that has already caught a real disaster:
 * 81.9ms against a 3ms budget, a 25x algorithmic blowup. Switching it off in the only
 * place it runs automatically would retire the guard that has actually earned its keep.
 *
 * So the budgets scale instead. A fixed reference workload measures this machine, and
 * the ratio against the machine the budgets were written on multiplies them.
 *
 * WHAT THIS DELIBERATELY CANNOT CATCH. A regression smaller than the spread between
 * fast and slow hardware is now invisible to this gate. That is the price, and it is
 * the right trade: the failures worth catching here are order-of-magnitude, and a
 * budget that fails on every commit catches nothing at all because nobody reads it.
 */

/** Median reference time, in milliseconds, on the machine the budgets were written on. */
const REFERENCE_MS = 22.5;

/**
 * Never tighten below the stated budget. The numbers in pathing.test.ts come from
 * docs/ARCHITECTURE.md and are the design target; a machine faster than the reference
 * does not get to move the target, it just passes comfortably.
 */
const MIN_FACTOR = 1;

/**
 * Chosen so the gate still fails on what it exists to catch. The regression that
 * prompted this budget ran at 81.9ms of steady time per tick; at maximum tolerance the
 * steady budget is 1.5 x 12 = 18ms, so that failure is still a failure on the slowest
 * machine this will allow for. A factor above this is a broken runner, not a slow one.
 */
const MAX_FACTOR = 12;

const SAMPLES = 5;

/**
 * Deterministic, allocation-free, and the same shape of work the gate measures: typed
 * array traffic and float arithmetic. No RNG and no clock inside the loop, so two runs
 * on the same machine differ only by scheduling.
 */
function referenceWorkload(): number {
  const size = 1 << 16;
  const buffer = new Float64Array(size);
  let accumulator = 0;

  for (let pass = 0; pass < 256; pass++) {
    for (let i = 0; i < size; i++) {
      const hashed = (i * 2654435761) >>> 0;
      buffer[i] = Math.sqrt(hashed % 10007) + buffer[(i + pass) & (size - 1)]! * 0.5;
    }
    for (let i = 0; i < size; i++) accumulator += buffer[i]!;
  }
  return accumulator;
}

export interface Calibration {
  readonly factor: number;
  readonly medianMs: number;
  /** Scale a budget expressed in milliseconds to this machine. */
  scale(budgetMs: number): number;
}

/**
 * Measure this machine. Median rather than minimum: the minimum reports how fast the
 * box can go when nothing else is happening, but the gate runs under whatever load the
 * runner is under, and the budget has to hold there.
 */
export function calibrate(): Calibration {
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    referenceWorkload();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const medianMs = samples[Math.floor(samples.length / 2)]!;

  const raw = medianMs / REFERENCE_MS;
  const factor = raw < MIN_FACTOR ? MIN_FACTOR : raw > MAX_FACTOR ? MAX_FACTOR : raw;

  return {
    factor,
    medianMs,
    scale: (budgetMs: number) => budgetMs * factor,
  };
}
