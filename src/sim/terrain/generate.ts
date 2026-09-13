import { createRng, nextU32 } from '../math/rng.js';
import type { Heightmap } from '../../shared/heightmap.js';
import { tuning } from '../tuning.js';

/**
 * Deterministic heightmap generation.
 *
 * Lives in src/sim because it consumes the seeded RNG and its output is simulation
 * state. The resulting map is handed to the renderer once at load; the data structure
 * and the pure functions over it live in shared/heightmap.ts.
 */

const PERM_SIZE = 256;
const PERM_MASK = PERM_SIZE - 1;

/** Shuffled lattice table. Fisher-Yates over the seeded RNG, so it reproduces exactly. */
function buildPermutation(seed: number): Uint8Array {
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
function latticeValue(perm: Uint8Array, x: number, y: number): number {
  return perm[(perm[x & PERM_MASK]! + y) & PERM_MASK]! / PERM_SIZE;
}

/** Hermite smoothing. Only + - *, so it is exactly reproducible. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(perm: Uint8Array, x: number, y: number): number {
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
function fbm(
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

export interface HeightmapOptions {
  levels: number;
  frequency: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  /**
   * How many times to re-apply smoothstep before quantising. Each pass pushes values
   * toward 0 and 1, which is what turns smooth noise into flats and plateaus with
   * abrupt steps between them — the shape the four map scripts need.
   */
  flatten: number;
}

export function createHeightmap(
  width: number,
  height: number,
  seed: number,
  options: HeightmapOptions = tuning.terrain,
): Heightmap {
  const { levels, frequency, octaves, lacunarity, gain, flatten } = options;
  const perm = buildPermutation(seed);
  const data = new Uint8Array(width * height);
  const maxLevel = levels - 1;

  for (let tileY = 0; tileY < height; tileY++) {
    for (let tileX = 0; tileX < width; tileX++) {
      let value = fbm(perm, tileX * frequency, tileY * frequency, octaves, lacunarity, gain);
      for (let i = 0; i < flatten; i++) value = smoothstep(value);

      let level = Math.floor(value * levels);
      if (level < 0) level = 0;
      if (level > maxLevel) level = maxLevel;
      data[tileY * width + tileX] = level;
    }
  }

  return { width, height, levels, data };
}
