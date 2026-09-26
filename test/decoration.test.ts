import { describe, expect, it } from 'vitest';
import { planDecorations } from '../src/render/scene/decoration.js';
import { heightmapFrom, heightmapWithWater } from '../src/shared/heightmap.js';

/**
 * Where the stone lies. Rock collects at the foot of a face and breaks out along a rim;
 * a boulder in the middle of a flat is a rarity. These pin that down on hand-built
 * ground, where "the foot of a cliff" is a column we can name.
 */

const SIZE = 64;
const SEEDS = [1, 7, 42, 1298556259];

/** Flat veld at 2, with a block of high ground at 6 filling the west half. */
function cliffMap(): ReturnType<typeof heightmapFrom> {
  return heightmapFrom(
    Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, (_, x) => (x < SIZE / 2 ? 6 : 2))),
    8,
  );
}

function stonesIn(map: ReturnType<typeof heightmapFrom>, columns: (x: number) => boolean): { stones: number; tiles: number } {
  let stones = 0;
  for (const seed of SEEDS) {
    for (const decoration of planDecorations(map, seed)) {
      if (decoration.kind === 'boulder' && columns(Math.floor(decoration.worldX))) stones++;
    }
  }
  let tiles = 0;
  for (let x = 0; x < SIZE; x++) if (columns(x)) tiles += SIZE;
  return { stones, tiles: tiles * SEEDS.length };
}

describe('boulders', () => {
  it('pile up at the foot of a cliff far more than out on the flat', () => {
    const map = cliffMap();
    const foot = stonesIn(map, (x) => x === SIZE / 2);
    const flat = stonesIn(map, (x) => x > SIZE / 2 + 4);
    const footRate = foot.stones / foot.tiles;
    const flatRate = flat.stones / flat.tiles;
    expect(footRate).toBeGreaterThan(0.15);
    expect(flatRate).toBeLessThan(0.02);
  });

  it('never stand in the water', () => {
    const rows = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, (_, x) => (x < 20 ? 0 : 3)));
    const wet = rows.map((row) => row.map((level) => (level === 0 ? 1 : 0)));
    const map = heightmapWithWater(rows, 8, wet);
    for (const seed of SEEDS) {
      for (const decoration of planDecorations(map, seed)) {
        expect(Math.floor(decoration.worldX)).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it('are the same on every machine that builds the same map', () => {
    const map = cliffMap();
    expect(planDecorations(map, 99)).toEqual(planDecorations(map, 99));
  });

  it('vary in size, so no two read as stamped from one die', () => {
    const sizes = new Set(
      planDecorations(cliffMap(), 3)
        .filter((decoration) => decoration.kind === 'boulder')
        .map((decoration) => decoration.scale),
    );
    expect(sizes.size).toBeGreaterThan(5);
  });
});
