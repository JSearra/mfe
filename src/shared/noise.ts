
/**
 * Value-noise primitives.
 *
 * Extracted from the default generator when the named map scripts arrived and needed the
 * same lattice. Deterministic throughout: every interpolation uses only + - *.
 *
 * In `shared/` because both sides need it now. The simulation builds the heightmap with
 * it, and the renderer decides which GROUND to draw with it — see render/scene/ground.ts,
 * where the ground type stopped being a synonym for the tile's height. The boundary rule
 * would rightly refuse to let the renderer reach into src/sim for a lattice, and this is
 * the same split heightmap.ts already has: the data and the pure functions over it are
 * shared, and the part that needs the seeded RNG stays in the simulation.
 */

const PERM_SIZE = 256;
const PERM_MASK = PERM_SIZE - 1;

/**
 * Shuffled lattice table. Fisher-Yates over a caller-supplied stream of draws.
 *
 * `next` is injected rather than imported, because the seeded RNG lives in `src/sim` and
 * this file may not reach for it — the simulation hands it `nextU32` over its own state
 * and the renderer hands it whatever it likes. The shuffle is identical either way, so
 * a permutation built here still reproduces exactly.
 */
export function buildPermutationWith(next: (bound: number) => number): Uint8Array {
  const perm = new Uint8Array(PERM_SIZE);
  for (let i = 0; i < PERM_SIZE; i++) perm[i] = i;

  for (let i = PERM_SIZE - 1; i > 0; i--) {
    const j = next(i + 1);
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

