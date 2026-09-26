import { describe, expect, it } from 'vitest';
import { createGroundField } from '../src/render/scene/ground.js';
import { createHeightmap } from '../src/sim/terrain/generate.js';
import { heightmapFrom, heightmapWithWater, isWater } from '../src/shared/heightmap.js';

/**
 * Which ground a tile is drawn with, which is no longer a synonym for its height.
 *
 * It was. `bandFor` returned `map.data[...]` — the tile's own height — so every single
 * one-level step in the terrain was also a complete change of ground texture. On rolling
 * country that is constant: measured over three seeds, 18% of all adjacent tile pairs
 * changed ground, a texture boundary every 5.5 tiles. No amount of blending fixes that.
 * The map is permanently mid-transition and every one of those transitions is a visible
 * edge, which is exactly the "hard edge/stop at every height change" it looks like.
 *
 * Age of Empires and Red Alert both keep terrain type and elevation INDEPENDENT — grass
 * exists at many heights in both. This does the same, while keeping the land's own shape
 * in the answer: the ground follows a smoothed height blended with a slow noise field,
 * so high country still tends to be dry and a single tile's wobble cannot flip it.
 */

const SEEDS = [1298556259, 7, 42];

function boundaryDensity(map: ReturnType<typeof createHeightmap>, ground: Uint8Array): number {
  let pairs = 0;
  let changes = 0;
  for (let y = 0; y < map.height - 1; y++) {
    for (let x = 0; x < map.width - 1; x++) {
      if (isWater(map, x, y)) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        if (isWater(map, x + dx, y + dy)) continue;
        pairs++;
        if (ground[y * map.width + x] !== ground[(y + dy) * map.width + (x + dx)]) changes++;
      }
    }
  }
  return (changes / pairs) * 100;
}

describe('createGroundField', () => {
  it('reproduces for a seed, so the ground does not differ between two viewers', () => {
    const map = createHeightmap(64, 64, 7);
    expect([...createGroundField(map, 7, 8)]).toEqual([...createGroundField(map, 7, 8)]);
  });

  it('gives a different country for a different seed', () => {
    const map = createHeightmap(64, 64, 7);
    expect([...createGroundField(map, 7, 8)]).not.toEqual([...createGroundField(map, 99, 8)]);
  });

  it('stays inside the ramp', () => {
    const map = createHeightmap(64, 64, 3);
    for (const band of createGroundField(map, 3, 8)) {
      expect(band).toBeGreaterThanOrEqual(0);
      expect(band).toBeLessThan(8);
    }
  });

  it('changes ground far less often than the height does', () => {
    // The whole point, and the number this was chosen against. 18% was a boundary every
    // 5.5 tiles; under 8% is one every thirteen or better.
    for (const seed of SEEDS) {
      const map = createHeightmap(128, 128, seed);
      const density = boundaryDensity(map, createGroundField(map, seed, map.levels));
      expect(density, `seed ${seed}`).toBeLessThan(8);
    }
  });

  it('still follows the land, so high country is still the dry end of the ramp', () => {
    // Decoupling ground from height must not mean ignoring it. If the correlation went
    // the ground would be noise laid over the terrain rather than a fact about it, and
    // the aridity shift the map scripts rely on would stop meaning anything.
    for (const seed of SEEDS) {
      const map = createHeightmap(128, 128, seed);
      const ground = createGroundField(map, seed, map.levels);
      let lowSum = 0, lowN = 0, highSum = 0, highN = 0;
      for (let i = 0; i < ground.length; i++) {
        const h = map.data[i]!;
        if (h <= 2) { lowSum += ground[i]!; lowN++; }
        if (h >= 5) { highSum += ground[i]!; highN++; }
      }
      expect(highN, 'no high ground to compare').toBeGreaterThan(0);
      expect(highSum / highN, `seed ${seed}`).toBeGreaterThan(lowSum / lowN);
    }
  });

  it('gives flat ground one single texture', () => {
    // A dead-flat map has nothing for the ground to follow, so the noise alone decides.
    // It must still be coherent rather than speckled: the whole point is large regions.
    const flat = heightmapFrom(
      Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 3)),
      8,
    );
    const ground = createGroundField(flat, 5, 8);
    let changes = 0;
    for (let y = 0; y < 63; y++) for (let x = 0; x < 63; x++) {
      if (ground[y * 64 + x] !== ground[y * 64 + x + 1]) changes++;
    }
    expect(changes / (63 * 63) * 100).toBeLessThan(8);
  });
});

describe('beaches', () => {
  /** A sea along the east side, far larger than any river reach, with low land west of it. */
  function seaMap(seaColumns: number, size = 24): ReturnType<typeof heightmapFrom> {
    const rows = Array.from({ length: size }, () =>
      Array.from({ length: size }, (_, x) => (x >= size - seaColumns ? 0 : 1)),
    );
    const wet = rows.map((row) => row.map((_, x) => (x >= size - seaColumns ? 1 : 0)));
    return heightmapWithWater(rows, 8, wet);
  }

  it('draws a strand of sand along the sea', () => {
    const map = seaMap(14);
    const ground = createGroundField(map, 5, map.levels);
    // Every dry tile on the waterline, and the one behind it, is sand.
    for (let y = 0; y < map.height; y++) {
      expect(ground[y * map.width + (map.width - 15)]).toBe(6);
      expect(ground[y * map.width + (map.width - 16)]).toBe(6);
    }
  });

  it('leaves a riverbank alone — a small water body is not the sea', () => {
    const map = seaMap(2);
    const plain = createGroundField(heightmapFrom(Array.from({ length: 24 }, () => Array(24).fill(1)), 8), 5, 8);
    const ground = createGroundField(map, 5, map.levels);
    for (let y = 0; y < map.height; y++) {
      const at = y * map.width + (map.width - 3);
      expect(ground[at]).toBe(plain[at]);
    }
  });

  it('does not run sand up a sea cliff', () => {
    const size = 24;
    const rows = Array.from({ length: size }, () => Array.from({ length: size }, (_, x) => (x >= 10 ? 0 : 5)));
    const wet = rows.map((row) => row.map((level) => (level === 0 ? 1 : 0)));
    const map = heightmapWithWater(rows, 8, wet);
    const ground = createGroundField(map, 5, map.levels);
    for (let y = 0; y < size; y++) expect(ground[y * size + 9]).not.toBe(6);
  });
});
