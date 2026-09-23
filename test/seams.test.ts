import { describe, expect, it } from 'vitest';
import { heightmapFrom } from '../src/shared/heightmap.js';
import { cornerSeams, edgeSeams, SEAM_CORNERS } from '../src/render/scene/seams.js';

/**
 * Which neighbours bleed onto a tile, and from where.
 *
 * Pulled out of the terrain renderer so the rule can be read and tested without a GPU.
 * The edge half has been shipping since the transition tiles landed; the corner half is
 * new, and exists because ground meeting a tile only at a corner used to contribute
 * nothing at all and left a sharp notch at every diagonal on the map.
 */

const bleed: number[] = [];
const corners = new Int8Array(SEAM_CORNERS);

/** Bits, clockwise from the upper-right EDGE of the diamond. */
const UPPER_RIGHT = 1;
const LOWER_RIGHT = 2;

describe('edgeSeams', () => {
  it('finds nothing on flat ground', () => {
    const map = heightmapFrom([[2, 2, 2], [2, 2, 2], [2, 2, 2]], 8);
    bleed.length = 0;
    expect(edgeSeams(map, 1, 1, bleed)).toBe(0);
  });

  it('bleeds the higher ground downhill and never the reverse', () => {
    const map = heightmapFrom([[1, 1, 1], [1, 0, 1], [1, 1, 1]], 8);
    bleed.length = 0;
    // The hollow at the centre takes all four of its neighbours.
    expect(edgeSeams(map, 1, 1, bleed)).toBe(1);
    expect(bleed[1]).toBe(0b1111);

    // And none of them takes the hollow: a seam is drawn once, from the uphill side.
    bleed.length = 0;
    expect(edgeSeams(map, 1, 0, bleed)).toBe(0);
  });

  it('does not bleed across a cliff', () => {
    // A four-level rise is past MAX_CLIMB. There is a face between the two grounds and
    // the upper surface is metres above and behind; smearing its texture down the drop
    // would soften the one boundary ADR-0006 exists to keep hard.
    const map = heightmapFrom([[0, 4, 0], [0, 0, 0], [0, 0, 0]], 8);
    bleed.length = 0;
    expect(edgeSeams(map, 1, 1, bleed)).toBe(0);
  });
});

describe('cornerSeams', () => {
  it('finds a higher ground that touches only at a corner', () => {
    // Tile (1,1) is low; the high ground sits diagonally off its upper-right corner
    // only. Nothing orthogonal is higher, so the edge blends contribute nothing and the
    // corner was left as a hard notch.
    const map = heightmapFrom([[0, 0, 1], [0, 0, 0], [0, 0, 0]], 8);
    corners.fill(-1);
    expect(cornerSeams(map, 1, 1, corners)).toBe(1);
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
    expect(cornerSeams(map, 1, 1, corners)).toBe(0);

    bleed.length = 0;
    // ...and the edge blend really is there, on the upper-right.
    edgeSeams(map, 1, 1, bleed);
    expect(bleed[1]! & UPPER_RIGHT).toBe(UPPER_RIGHT);
    expect(bleed[1]! & LOWER_RIGHT).toBe(0);
  });

  it('does not bleed a corner across a cliff either', () => {
    const map = heightmapFrom([[0, 0, 4], [0, 0, 0], [0, 0, 0]], 8);
    corners.fill(-1);
    expect(cornerSeams(map, 1, 1, corners)).toBe(0);
  });

  it('ignores a corner that is lower, and one off the map', () => {
    const map = heightmapFrom([[3, 3, 3], [3, 2, 3], [3, 3, 3]], 8);
    corners.fill(-1);
    // Every diagonal is higher here, and none of the orthogonals is not — so all four
    // are covered by edges and none is a corner seam.
    expect(cornerSeams(map, 1, 1, corners)).toBe(0);

    // A tile in the map's own corner has two diagonals off the map entirely.
    const edge = heightmapFrom([[0, 0], [0, 1]], 8);
    corners.fill(-1);
    expect(cornerSeams(edge, 0, 0, corners)).toBe(1);
    // (+1,+1) is the diamond's SOUTH point: corner 1.
    expect(corners[1]).toBe(1);
  });
});
