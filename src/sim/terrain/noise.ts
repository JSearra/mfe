import { createRng, nextU32 } from '../math/rng.js';

/**
 * Value-noise primitives.
 *
 * Extracted from the default generator when the named map scripts arrived and needed the
 * same lattice. Deterministic throughout: the permutation is shuffled with the seeded
 * RNG and every interpolation uses only + - *.
 */

const PERM_SIZE = 256;
const PERM_MASK = PERM_SIZE - 1;

/** Shuffled lattice table. Fisher-Yates over the seeded RNG, so it reproduces exactly. */
export function buildPermutation(seed: number): Uint8Array {
  const perm = new Uint8Array(PERM_SIZE);
  for (let i = 0; i < PERM_SIZE; i++) perm[i] = i;

  const rng = createRng(seed);
  for (let i = PERM_SIZE - 1; i > 0; i--) {
    const j = nextU32(rng) % (i + 1);
    const swap = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = swap;
  }
  return perm;
}

/** Lattice value in [0, 1). */
export function latticeValue(perm: Uint8Array, x: number, y: number): number {
  return perm[(perm[x & PERM_MASK]! + y) & PERM_MASK]! / PERM_SIZE;
}

/** Hermite smoothing. Only + - *, so it is exactly reproducible. */
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoise(perm: Uint8Array, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);

  const v00 = latticeValue(perm, ix, iy);
  const v10 = latticeValue(perm, ix + 1, iy);
  const v01 = latticeValue(perm, ix, iy + 1);
  const v11 = latticeValue(perm, ix + 1, iy + 1);

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

/** Fractional Brownian motion: octaves of value noise, normalised to [0, 1]. */
export function fbm(
  perm: Uint8Array,
  x: number,
  y: number,
  octaves: number,
  lacunarity: number,
  gain: number,
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;

  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(perm, x * frequency, y * frequency) * amplitude;
    total += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / total;
}

