import { describe, expect, it } from 'vitest';
import {
  cornerPositions,
  diamondUvs,
  faceTrapezoid,
  QUAD_FLOATS,
} from '../src/render/scene/terrainGeometry.js';
import { ELEV_STEP, HALF_TILE_H, HALF_TILE_W } from '../src/shared/iso.js';

/**
 * The arithmetic the terrain mesh is built from.
 *
 * Pure and tested here rather than eyeballed in a browser, because every defect this
 * project has shipped in its rendering passed every gate it had — and a UV off by a
 * frame or a corner off by a level is exactly the kind that does.
 */

const positions = new Float32Array(QUAD_FLOATS);
const uvs = new Float32Array(QUAD_FLOATS);

describe('cornerPositions', () => {
  it('lays a flat tile out as the diamond the projection describes', () => {
    cornerPositions(0, 0, new Float64Array([0, 0, 0, 0]), positions);
    expect([...positions]).toEqual([
      0, 0, // north, world (0,0)
      HALF_TILE_W, HALF_TILE_H, // east, world (1,0)
      0, HALF_TILE_H * 2, // south, world (1,1)
      -HALF_TILE_W, HALF_TILE_H, // west, world (0,1)
    ]);
  });

  it('lifts each corner by its own height', () => {
    cornerPositions(0, 0, new Float64Array([0, 1, 0, 0]), positions);
    // Only the east corner moved, and it moved UP the screen by one elevation step.
    expect(positions[3]).toBe(HALF_TILE_H - ELEV_STEP);
    expect(positions[1]).toBe(0);
    expect(positions[5]).toBe(HALF_TILE_H * 2);
  });

  it('takes fractional heights, which is the whole point of it', () => {
    cornerPositions(0, 0, new Float64Array([0, 0.5, 0, 0]), positions);
    expect(positions[3]).toBe(HALF_TILE_H - ELEV_STEP / 2);
  });

  it('offsets by the tile, so two tiles meet exactly on their shared edge', () => {
    const flat = new Float64Array([0, 0, 0, 0]);
    const east = new Float32Array(QUAD_FLOATS);
    cornerPositions(0, 0, flat, positions);
    cornerPositions(1, 0, flat, east);
    // Tile (0,0)'s EAST corner is tile (1,0)'s NORTH corner: the same world point.
    expect([east[0], east[1]]).toEqual([positions[2], positions[3]]);
    // And tile (0,0)'s SOUTH corner is tile (1,0)'s WEST corner.
    expect([east[6], east[7]]).toEqual([positions[4], positions[5]]);
  });
});

describe('diamondUvs', () => {
  it('maps the diamond corners of a frame, held just inside its edges', () => {
    // A 64x32 frame at (128, 64) in a 512x512 page. The corners are the MIDPOINTS of
    // the frame's edges, because the art is a 2:1 diamond inscribed in a rectangle
    // whose corners are transparent — pulled 1.5 texels across and 0.75 down, because
    // the diamond's own widest row stops one texel short of the frame at each end and
    // sampling the edge exactly lands on nothing.
    diamondUvs(128, 64, 64, 32, 512, 512, uvs);
    expect([...uvs]).toEqual([
      160 / 512, 64.75 / 512, // north
      190.5 / 512, 80 / 512, // east
      160 / 512, 95.25 / 512, // south
      129.5 / 512, 80 / 512, // west
    ]);
  });

  it('never samples the transparent texel ring the mask leaves', () => {
    // The guard on the number above rather than on its arithmetic: whatever the inset
    // is, it has to clear a staircase that deviates by a texel.
    diamondUvs(0, 0, 64, 32, 64, 32, uvs);
    expect(uvs[6]! * 64).toBeGreaterThanOrEqual(1);
    expect(uvs[2]! * 64).toBeLessThanOrEqual(63);
    expect(uvs[1]! * 32).toBeGreaterThanOrEqual(0.5);
    expect(uvs[5]! * 32).toBeLessThanOrEqual(31.5);
  });
});

describe('faceTrapezoid', () => {
  it('finds no gap between two tiles whose shared corners agree', () => {
    expect(faceTrapezoid(2, 2, 2, 2)).toBe(false);
  });

  it('finds the gap a cliff leaves', () => {
    // Own ground at 3, the neighbour's snapped flat at 0: a three-level face.
    expect(faceTrapezoid(3, 3, 0, 0)).toBe(true);
  });

  it('finds the gap a single disagreeing corner leaves', () => {
    // This is the case that makes deriving faces from the SURFACE rather than from the
    // tile heights worth doing. Heights 0, 1, 4 in a row: the middle tile touches a
    // cliff so all four of its corners snap to 1, while its western neighbour is on a
    // gentle step and averages the shared corner to 0.5. Nothing about the two tile
    // HEIGHTS (0 and 1, one apart, walkable) says there is a gap; the surface does.
    expect(faceTrapezoid(1, 1, 0.5, 0.5)).toBe(true);
  });

  it('is one-sided: a tile lower than its neighbour is hidden behind it, not a face', () => {
    expect(faceTrapezoid(0, 0, 3, 3)).toBe(false);
  });
});
