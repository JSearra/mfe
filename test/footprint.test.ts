import { describe, expect, it } from 'vitest';
import { heightmapFrom, heightmapWithWater } from '../src/shared/heightmap.js';
import { footprintFits } from '../src/render/scene/cursor.js';

/**
 * The armed building's preview, judged render-side from the map and the buildings in the
 * snapshot. It mirrors the placement rules rather than asking the simulation, so these
 * pin that it agrees with them on the cases a player meets.
 */
const flat = heightmapFrom(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 1)), 8);
const check = { size: 2, maxHeightVariation: 0, needsWater: false, affordable: true };

describe('footprintFits', () => {
  it('fits open level ground', () => {
    expect(footprintFits(flat, 2, 2, check, new Set())).toBe(true);
  });

  it('does not fit ground a building holds', () => {
    expect(footprintFits(flat, 2, 2, check, new Set([3 * 8 + 3]))).toBe(false);
  });

  it('does not fit off the edge, or when it cannot be paid for', () => {
    expect(footprintFits(flat, 7, 7, check, new Set())).toBe(false);
    expect(footprintFits(flat, 2, 2, { ...check, affordable: false }, new Set())).toBe(false);
  });

  it('does not fit uneven ground', () => {
    const rows = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 1));
    rows[3]![3] = 2;
    expect(footprintFits(heightmapFrom(rows, 8), 2, 2, check, new Set())).toBe(false);
  });

  it('needs a bank for a weir, and never stands in water', () => {
    const rows = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 1));
    const wet = Array.from({ length: 8 }, () => Array.from({ length: 8 }, (_, x) => (x === 5 ? 1 : 0)));
    const river = heightmapWithWater(rows, 8, wet);
    const weir = { ...check, size: 1, needsWater: true };
    expect(footprintFits(river, 4, 2, weir, new Set())).toBe(true);
    expect(footprintFits(river, 1, 2, weir, new Set())).toBe(false);
    expect(footprintFits(river, 5, 2, { ...check, size: 1 }, new Set())).toBe(false);
  });
});
