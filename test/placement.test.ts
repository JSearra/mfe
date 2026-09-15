import { describe, expect, it } from 'vitest';
import { heightmapFrom } from '../src/shared/heightmap.js';
import { generateMap } from '../src/sim/terrain/maps.js';
import { MapScript } from '../src/shared/maps.js';
import { largestRegion, snapToRegion } from '../src/sim/terrain/placement.js';

/** Low ground either side of an unclimbable wall, with a gap nowhere. */
const split = heightmapFrom(
  [
    [0, 0, 9, 0, 0, 0],
    [0, 0, 9, 0, 0, 0],
    [0, 0, 9, 0, 0, 0],
    [0, 0, 9, 0, 0, 0],
  ],
  10,
);

describe('largest walkable region', () => {
  it('picks the bigger side of a wall', () => {
    const region = largestRegion(split);
    // Right of the wall is four columns, left is two.
    expect(region[0 * 6 + 4]).toBe(1);
    expect(region[0 * 6 + 0]).toBe(0);
    // The wall itself stands alone and is not the largest.
    expect(region[0 * 6 + 2]).toBe(0);
  });

  it('is the whole map when nothing divides it', () => {
    const flat = heightmapFrom([[0, 0, 0], [0, 0, 0], [0, 0, 0]], 4);
    expect([...largestRegion(flat)].every((v) => v === 1)).toBe(true);
  });
});

describe('snapping a wanted position onto it', () => {
  it('leaves a position that is already walkable exactly where it is', () => {
    const region = largestRegion(split);
    expect(snapToRegion(split, region, 4.25, 1.75)).toEqual({ x: 4.25, y: 1.75 });
  });

  it('pulls a position off the wrong side of a wall', () => {
    const region = largestRegion(split);
    const moved = snapToRegion(split, region, 0, 1);

    expect(region[Math.floor(moved.y) * 6 + Math.floor(moved.x)]).toBe(1);
    expect(moved.x).toBeGreaterThan(2);
  });

  it('is a no-op across an unbroken map', () => {
    // The default veld and thaba-bosiu are single regions, so placement must not move
    // anything at all — this change is meant to be invisible where it is not needed.
    const map = generateMap(MapScript.ThabaBosiu, 128, 128, 0x4d666563);
    const region = largestRegion(map);
    for (const [x, y] of [[64, 64], [73, 70], [91, 86], [54, 90]] as [number, number][]) {
      expect(snapToRegion(map, region, x, y)).toEqual({ x, y });
    }
  });

  it('answers the same way every time', () => {
    // Placement feeds spawn commands, so two machines building the same map must agree.
    const map = generateMap(MapScript.Umfolozi, 128, 128, 0x4d666563);
    const a = largestRegion(map);
    const b = largestRegion(map);
    expect([...a]).toEqual([...b]);
    expect(snapToRegion(map, a, 64, 64)).toEqual(snapToRegion(map, b, 64, 64));
  });
});
