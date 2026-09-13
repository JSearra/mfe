import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  atan2,
  cos,
  cosExact,
  lerpAngle,
  PI,
  sin,
  sinExact,
  TWO_PI,
} from '../src/sim/math/trig.js';

/**
 * These tests compare the owned implementations against the native ones they replace.
 * That is legitimate here and banned in src/sim: the native functions are accurate,
 * they are just not reproducible across engines.
 */
describe('trig', () => {
  it('sinExact and cosExact track the native functions', () => {
    for (let i = -2000; i <= 2000; i++) {
      const x = (i / 2000) * 4 * PI;
      expect(sinExact(x)).toBeCloseTo(Math.sin(x), 8);
      expect(cosExact(x)).toBeCloseTo(Math.cos(x), 8);
    }
  });

  it('the interpolated table stays within its stated error bound', () => {
    let worst = 0;
    for (let i = 0; i < 20_000; i++) {
      const x = (i / 20_000) * 6 * PI - 3 * PI;
      worst = Math.max(worst, Math.abs(sin(x) - Math.sin(x)), Math.abs(cos(x) - Math.cos(x)));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('wraps correctly at table boundaries and for negative angles', () => {
    for (const x of [0, TWO_PI, -TWO_PI, PI, -PI, 1e5, -1e5]) {
      expect(sin(x)).toBeCloseTo(Math.sin(x), 5);
      expect(cos(x)).toBeCloseTo(Math.cos(x), 5);
    }
  });

  it('is bit-stable across repeated calls', () => {
    const first = Array.from({ length: 500 }, (_, i) => sin(i * 0.37));
    const second = Array.from({ length: 500 }, (_, i) => sin(i * 0.37));
    expect(second).toEqual(first);
  });

  it('atan2 matches the native implementation across all quadrants', () => {
    for (let i = -60; i <= 60; i++) {
      for (let j = -60; j <= 60; j++) {
        const y = i / 7;
        const x = j / 7;
        expect(atan2(y, x)).toBeCloseTo(Math.atan2(y, x), 9);
      }
    }
  });

  it('atan2 handles the axes and the origin', () => {
    expect(atan2(0, 0)).toBe(0);
    expect(atan2(0, 1)).toBeCloseTo(0, 12);
    expect(atan2(1, 0)).toBeCloseTo(Math.PI / 2, 12);
    expect(atan2(-1, 0)).toBeCloseTo(-Math.PI / 2, 12);
    expect(atan2(0, -1)).toBeCloseTo(Math.PI, 12);
  });

  it('angleDelta takes the short way round', () => {
    const nearZero = 0.05;
    const nearTwoPi = TWO_PI - 0.05;
    expect(angleDelta(nearTwoPi, nearZero)).toBeCloseTo(0.1, 9);
    expect(angleDelta(nearZero, nearTwoPi)).toBeCloseTo(-0.1, 9);
    expect(Math.abs(angleDelta(0, PI))).toBeCloseTo(PI, 9);
  });

  it('lerpAngle does not spin through a full revolution at the wrap', () => {
    const mid = lerpAngle(TWO_PI - 0.1, 0.1, 0.5);
    expect(Math.abs(angleDelta(mid, 0))).toBeLessThan(0.01);
  });
});
