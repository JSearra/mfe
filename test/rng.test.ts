import { describe, expect, it } from 'vitest';
import { cloneRng, createRng, nextFloat, nextInt, nextU32 } from '../src/sim/math/rng.js';

describe('rng', () => {
  it('produces the same sequence from the same seed across fresh instances', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 1000 }, () => nextU32(a));
    const seqB = Array.from({ length: 1000 }, () => nextU32(b));
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences from different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(Array.from({ length: 32 }, () => nextU32(a))).not.toEqual(
      Array.from({ length: 32 }, () => nextU32(b)),
    );
  });

  it('never degenerates to the all-zero fixed point', () => {
    const rng = createRng(0);
    expect(Array.from(rng.state).some((word) => word !== 0)).toBe(true);
    expect(Array.from({ length: 64 }, () => nextU32(rng)).some((v) => v !== 0)).toBe(true);
  });

  it('serializes and resumes exactly', () => {
    const rng = createRng(777);
    for (let i = 0; i < 50; i++) nextU32(rng);

    const saved = cloneRng(rng);
    const expected = Array.from({ length: 100 }, () => nextU32(rng));
    const actual = Array.from({ length: 100 }, () => nextU32(saved));
    expect(actual).toEqual(expected);
  });

  it('emits u32 values and floats within range', () => {
    const rng = createRng(99);
    for (let i = 0; i < 5000; i++) {
      const u = nextU32(rng);
      expect(Number.isInteger(u)).toBe(true);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(4294967296);
    }
    const f = createRng(100);
    for (let i = 0; i < 5000; i++) {
      const value = nextFloat(f);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('bounds nextInt and stays roughly uniform', () => {
    const rng = createRng(2024);
    const buckets = new Array<number>(6).fill(0);
    const draws = 60_000;
    for (let i = 0; i < draws; i++) {
      const value = nextInt(rng, 6);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
      buckets[value]!++;
    }
    // Rejection sampling, so this should be tight. 5% tolerance is generous.
    for (const count of buckets) {
      expect(count).toBeGreaterThan((draws / 6) * 0.95);
      expect(count).toBeLessThan((draws / 6) * 1.05);
    }
  });
});
