import { describe, expect, it } from 'vitest';
import { heightmapFrom, heightmapWithWater } from '../src/shared/heightmap.js';
import {
  cornerSeams,
  edgeSeams,
  SEAM_CORNERS,
  waterCornerSeams,
  waterDepth,
  waterEdgeMask,
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

describe('water seams', () => {
  // A river running down the middle, one tile wide, with a bend — which is where a
  // staircase coastline is worst and where the corner case actually arises.
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
      [0, 0, 1, 0],
      [0, 0, 1, 0],
    ],
  );

  it('gives a dry tile the edges that face water', () => {
    // Tile (0,0) has water at (1,0), which is the diamond's lower-right edge: bit 1.
    expect(waterEdgeMask(river, 0, 0)).toBe(0b0010);
    // Tile (2,0) has water at (1,0) — its lower-LEFT edge is (2,1), which is dry, and
    // its upper-left is (1,0). Bit 3.
    expect(waterEdgeMask(river, 2, 0)).toBe(0b1000);
  });

  it('gives a water tile no bank of its own', () => {
    expect(waterEdgeMask(river, 1, 0)).toBe(0);
  });

  it('finds water that touches only at a corner', () => {
    corners.fill(-1);
    // Tile (1,2): water at (2,2) is orthogonal, so no corner there. Tile (3,1) instead
    // — its diagonal (2,2) is water and neither edge beside it is.
    expect(waterCornerSeams(river, 3, 1, corners)).toBe(1);
  });

  it('does not put a corner wedge where an edge already banks', () => {
    corners.fill(-1);
    // Tile (1,1) is beside the water at (1,0) and (2,2) is diagonal from it — but
    // (1,2) is not water and (2,1) is not water, so this one IS a corner... the case
    // that must NOT fire is a diagonal whose neighbour edge is also wet.
    expect(waterCornerSeams(river, 1, 3, corners)).toBe(0);
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
