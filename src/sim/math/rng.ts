/**
 * Seeded, serializable pseudo-random number generator.
 *
 * xoshiro128** — chosen over PCG32 because PCG32's 64-bit state step has no native
 * representation in JavaScript. Emulating it costs either BigInt (allocating, roughly
 * an order of magnitude slower) or manual high/low recombination through Math.imul,
 * which is easy to get subtly wrong in the sign and shift. xoshiro128** is entirely
 * 32-bit: every operation here is exact, so the sequence is bit-identical everywhere.
 *
 * State is a Uint32Array(4), so it serializes into saves and replays directly.
 */

export interface Rng {
  readonly state: Uint32Array;
}

const STATE_WORDS = 4;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** splitmix32, used only to expand a single seed into a full state. */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export function createRng(seed: number): Rng {
  const state = new Uint32Array(STATE_WORDS);
  const next = splitmix32(seed);
  for (let i = 0; i < STATE_WORDS; i++) state[i] = next();

  // An all-zero state is a fixed point for xoshiro: it would emit zeros forever.
  if (state[0] === 0 && state[1] === 0 && state[2] === 0 && state[3] === 0) {
    state[0] = 1;
  }
  return { state };
}

/** Uniform in [0, 2^32). */
export function nextU32(rng: Rng): number {
  const s = rng.state;
  const result = Math.imul(rotl(Math.imul(s[1]!, 5) >>> 0, 7), 9) >>> 0;
  const t = (s[1]! << 9) >>> 0;

  s[2]! ^= s[0]!;
  s[3]! ^= s[1]!;
  s[1]! ^= s[2]!;
  s[0]! ^= s[3]!;
  s[2]! ^= t;
  s[3] = rotl(s[3]!, 11);

  return result;
}

/** Uniform in [0, 1). Division by a power of two is exact. */
export function nextFloat(rng: Rng): number {
  return nextU32(rng) / 4294967296;
}

/** Uniform in [-1, 1). */
export function nextSigned(rng: Rng): number {
  return nextFloat(rng) * 2 - 1;
}

/**
 * Uniform integer in [0, maxExclusive), rejection-sampled so the distribution is
 * exactly uniform rather than modulo-biased. Rejection keeps determinism: the
 * number of draws is a function of the state, not of timing.
 */
export function nextInt(rng: Rng, maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  const limit = 4294967296 - (4294967296 % maxExclusive);
  let value = nextU32(rng);
  while (value >= limit) value = nextU32(rng);
  return value % maxExclusive;
}

export function cloneRng(rng: Rng): Rng {
  return { state: new Uint32Array(rng.state) };
}

export function copyRngInto(target: Rng, source: Rng): void {
  target.state.set(source.state);
}
