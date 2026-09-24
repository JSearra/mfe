import { buildPermutationWith } from '../../shared/noise.js';
import { createRng, nextU32 } from '../math/rng.js';

/**
 * The lattice table, shuffled over the simulation's own seeded RNG.
 *
 * The shuffle itself lives in `shared/noise.ts` with the rest of the value-noise
 * primitives, because the renderer needs those too and may not import from `src/sim`.
 * What stays here is the one thing that genuinely belongs to the simulation: its RNG.
 */
export function buildPermutation(seed: number): Uint8Array {
  const rng = createRng(seed);
  return buildPermutationWith((bound) => nextU32(rng) % bound);
}
