import { describe, expect, it } from 'vitest';
import { heightmapFrom, heightmapWithWater, isWater } from '../src/shared/heightmap.js';
import {
  cornerSeams,
  edgeSeams,
  SEAM_CORNERS,
  waterDepth,
  landSeams,
  smoothWaterDepth,
} from '../src/render/scene/seams.js';

/**
 * Which neighbours bleed onto a tile, and from where.
 *
 * Pulled out of the terrain renderer so the rule can be read and tested without a GPU.
 * The edge half has been shipping since the transition tiles landed; the corner half is
 * new, and exists because ground meeting a tile only at a corner used to contribute
 * nothing at all and left a sharp notch at every diagonal on the map.
 */

const bleed: number[] = [];

/**
 * The seam rule is expressed over GROUND now, not height — they stopped being the same
 * thing when the ground field landed (see render/scene/ground.ts). These cases are all
 * about the rule rather than about the field, so each map's own heights are handed in
 * as its ground, which is exactly what they used to mean.
 */
const asGround = (map: { data: Uint8Array }): Uint8Array => map.data;
const corners = new Int8Array(SEAM_CORNERS);

/** Bits, clockwise from the upper-right EDGE of the diamond. */
const UPPER_RIGHT = 1;
const LOWER_RIGHT = 2;

describe('edgeSeams', () => {
  it('finds nothing on flat ground', () => {
    const map = heightmapFrom([[2, 2, 2], [2, 2, 2], [2, 2, 2]], 8);
    bleed.length = 0;
    expect(edgeSeams(map, asGround(map), 1, 1, bleed)).toBe(0);
  });

  it('bleeds the higher ground downhill and never the reverse', () => {
    const map = heightmapFrom([[1, 1, 1], [1, 0, 1], [1, 1, 1]], 8);
    bleed.length = 0;
    // The hollow at the centre takes all four of its neighbours.
    expect(edgeSeams(map, asGround(map), 1, 1, bleed)).toBe(1);
    expect(bleed[1]).toBe(0b1111);

    // And none of them takes the hollow: a seam is drawn once, from the uphill side.
    bleed.length = 0;
    expect(edgeSeams(map, asGround(map), 1, 0, bleed)).toBe(0);
  });

  it('does not bleed across a cliff', () => {
    // A four-level rise is past MAX_CLIMB. There is a face between the two grounds and
    // the upper surface is metres above and behind; smearing its texture down the drop
    // would soften the one boundary ADR-0006 exists to keep hard.
    const map = heightmapFrom([[0, 4, 0], [0, 0, 0], [0, 0, 0]], 8);
    bleed.length = 0;
    expect(edgeSeams(map, asGround(map), 1, 1, bleed)).toBe(0);
  });
});

describe('cornerSeams', () => {
  it('finds a higher ground that touches only at a corner', () => {
    // Tile (1,1) is low; the high ground sits diagonally off its upper-right corner
    // only. Nothing orthogonal is higher, so the edge blends contribute nothing and the
    // corner was left as a hard notch.
    const map = heightmapFrom([[0, 0, 1], [0, 0, 0], [0, 0, 0]], 8);
    corners.fill(-1);
    expect(cornerSeams(map, asGround(map), 1, 1, corners)).toBe(1);
    // Corner 0 is the diamond's EAST point, between the upper-right and lower-right
    // edges — the tile-space diagonal (+1, -1).
    expect(corners[0]).toBe(1);
    expect([...corners.slice(1)]).toEqual([-1, -1, -1]);
  });

  it('leaves the corner alone when an edge blend already covers it', () => {
    // The same diagonal, but now the orthogonal neighbour beside it is high too. Its
    // edge blend already reaches that corner, and laying a second one over it would
    // double the alpha exactly where two seams meet.
    const map = heightmapFrom([[0, 1, 1], [0, 0, 0], [0, 0, 0]], 8);
    corners.fill(-1);
    expect(cornerSeams(map, asGround(map), 1, 1, corners)).toBe(0);

    bleed.length = 0;
    // ...and the edge blend really is there, on the upper-right.
    edgeSeams(map, asGround(map), 1, 1, bleed);
    expect(bleed[1]! & UPPER_RIGHT).toBe(UPPER_RIGHT);
    expect(bleed[1]! & LOWER_RIGHT).toBe(0);
  });

  it('does not bleed a corner across a cliff either', () => {
    const map = heightmapFrom([[0, 0, 4], [0, 0, 0], [0, 0, 0]], 8);
    corners.fill(-1);
    expect(cornerSeams(map, asGround(map), 1, 1, corners)).toBe(0);
  });

  it('ignores a corner that is lower, and one off the map', () => {
    const map = heightmapFrom([[3, 3, 3], [3, 2, 3], [3, 3, 3]], 8);
    corners.fill(-1);
    // Every diagonal is higher here, and none of the orthogonals is not — so all four
    // are covered by edges and none is a corner seam.
    expect(cornerSeams(map, asGround(map), 1, 1, corners)).toBe(0);

    // A tile in the map's own corner has two diagonals off the map entirely.
    const edge = heightmapFrom([[0, 0], [0, 1]], 8);
    corners.fill(-1);
    expect(cornerSeams(edge, asGround(edge), 0, 0, corners)).toBe(1);
    // (+1,+1) is the diamond's SOUTH point: corner 1.
    expect(corners[1]).toBe(1);
  });
});

describe('waterDepth', () => {
  it('is deepest in open water and shallowest at a bank', () => {
    const pan = heightmapWithWater(
      [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ],
      8,
      [
        [0, 0, 0, 0, 0],
        [0, 1, 1, 1, 0],
        [0, 1, 1, 1, 0],
        [0, 1, 1, 1, 0],
        [0, 0, 0, 0, 0],
      ],
    );
    // The middle of the pan is surrounded on all eight sides.
    expect(waterDepth(pan, 2, 2)).toBe(8);
    // A corner of it touches three.
    expect(waterDepth(pan, 1, 1)).toBe(3);
  });

  it('counts eight ways, not four, so a one-tile river is not a checkerboard', () => {
    // The whole reason this replaces "are all four neighbours wet". On a river a tile
    // wide, NO tile has four wet neighbours, so every one of them drew as a bank and
    // the river read as a strip of alternating light and dark diamonds.
    const narrow = heightmapWithWater(
      [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      8,
      [
        [0, 1, 0],
        [0, 1, 0],
        [0, 1, 0],
      ],
    );
    expect(waterDepth(narrow, 1, 1)).toBe(2);
    expect(waterDepth(narrow, 1, 0)).toBe(1);
  });
});

describe('land bleeding over water', () => {
  /*
   * The waterline was hard on BOTH sides and only softened on one.
   *
   * Nothing was ever drawn on the water, so its own edge stayed a dead diamond and a
   * river read as a staircase of blue lozenges. (A pebble bank on the land side was the
   * first answer and turned out to be a staircase of its own; it is gone — plan V5.)
   */
  const river = heightmapWithWater(
    [
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ],
    8,
    [
      [0, 1, 0, 0],
      [0, 1, 0, 0],
      [0, 1, 1, 0],
      [0, 0, 1, 0],
    ],
  );
  const ground = new Uint8Array(16).fill(3);

  it('finds the land on a water tile s edges', () => {
    bleed.length = 0;
    // The water at (1,0) has dry land at (0,0) and (2,0) — its upper-left and
    // lower-right edges — and water above and below it.
    const found = landSeams(river, ground, 1, 0, bleed);
    expect(found).toBe(1);
    expect(bleed[3]).toBeGreaterThan(0);
  });

  it('finds nothing on open water', () => {
    const pan = heightmapWithWater(
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      8,
      [[1, 1, 1], [1, 1, 1], [1, 1, 1]],
    );
    bleed.length = 0;
    expect(landSeams(pan, new Uint8Array(9).fill(2), 1, 1, bleed)).toBe(0);
  });

  it('finds nothing on dry land, which has a bank of its own instead', () => {
    bleed.length = 0;
    expect(landSeams(river, ground, 0, 0, bleed)).toBe(0);
  });

  it('carries the neighbour s own ground, so a bank matches the country behind it', () => {
    const mixed = new Uint8Array(16).fill(3);
    mixed[0 * 4 + 0] = 5;
    bleed.length = 0;
    landSeams(river, mixed, 1, 0, bleed);
    expect(bleed[5], 'the band-5 neighbour did not bleed').toBeGreaterThan(0);
  });
});

describe('smoothWaterDepth', () => {
  it('runs shallow at a bank and deep in the open', () => {
    const pan = heightmapWithWater(
      [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ],
      8,
      [
        [0, 0, 0, 0, 0],
        [0, 1, 1, 1, 0],
        [0, 1, 1, 1, 0],
        [0, 1, 1, 1, 0],
        [0, 0, 0, 0, 0],
      ],
    );
    expect(smoothWaterDepth(pan, 2, 2)).toBeGreaterThan(smoothWaterDepth(pan, 1, 1));
  });

  it('varies less between neighbours than the raw count does', () => {
    /*
     * The quilt this exists to remove. `waterDepth` is a count of eight neighbours, so
     * it steps by whole numbers between adjacent tiles — and each water tile is filled
     * with one flat colour, so those steps drew a patchwork of visibly different blue
     * lozenges across every river on the map.
     */
    const river = heightmapWithWater(
      Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 0)),
      8,
      Array.from({ length: 9 }, (_, y) =>
        Array.from({ length: 9 }, (_, x) => (Math.abs(x - 4) <= 1 + (y % 2) ? 1 : 0)),
      ),
    );
    let rawJump = 0;
    let smoothJump = 0;
    for (let y = 1; y < 8; y++) {
      for (let x = 1; x < 8; x++) {
        if (!isWater(river, x, y) || !isWater(river, x + 1, y)) continue;
        rawJump = Math.max(rawJump, Math.abs(waterDepth(river, x, y) - waterDepth(river, x + 1, y)));
        smoothJump = Math.max(
          smoothJump,
          Math.abs(smoothWaterDepth(river, x, y) - smoothWaterDepth(river, x + 1, y)),
        );
      }
    }
    expect(rawJump).toBeGreaterThan(0);
    expect(smoothJump).toBeLessThan(rawJump);
  });
});
