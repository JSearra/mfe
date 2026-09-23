import { describe, expect, it } from 'vitest';
import { heightmapFrom } from '../src/shared/heightmap.js';
import { tileCorners, CORNER_COUNT } from '../src/render/scene/surface.js';

/**
 * The ground surface the terrain mesh is built on.
 *
 * The rule under test is the one the whole look of the map turns on: a step a unit can
 * WALK is a slope and must be drawn as one, while a cliff stays the hard edge ADR-0006
 * made it. Both readings come out of the same four numbers, so both are pinned here.
 */

const out = new Float64Array(CORNER_COUNT);

describe('tileCorners', () => {
  it('leaves flat ground flat', () => {
    const map = heightmapFrom(
      [
        [3, 3, 3],
        [3, 3, 3],
        [3, 3, 3],
      ],
      8,
    );
    tileCorners(map, 1, 1, out);
    expect([...out]).toEqual([3, 3, 3, 3]);
  });

  it('puts a walkable step half way between the two grounds', () => {
    // A one-level rise along the eastern column. MAX_CLIMB is 1, so this is a slope.
    const map = heightmapFrom(
      [
        [0, 1, 1],
        [0, 1, 1],
        [0, 1, 1],
      ],
      8,
    );
    // Tile (0,1) is low and touches the high column on its east side. Its corners are
    // the lattice points north (0,1), east (1,1), south (1,2) and west (0,2) — so the
    // two on lattice column 1 sit on the boundary and average the two grounds meeting
    // there, while the two on column 0 are nowhere near it.
    //
    // Worth stating because the first version of this test got it wrong: a corner is
    // named for the compass point of the DIAMOND, and the diamond's north corner is
    // the tile's (x, y) lattice point, which is its western column. North is not the
    // high side; east and south are.
    tileCorners(map, 0, 1, out);
    const [north, east, south, west] = out;
    expect(north).toBeCloseTo(0);
    expect(east).toBeCloseTo(0.5);
    expect(south).toBeCloseTo(0.5);
    expect(west).toBeCloseTo(0);
  });

  it('snaps a corner that touches a cliff, so the cliff keeps its edge', () => {
    // A three-level drop is past MAX_CLIMB and is therefore a cliff, not a slope.
    const map = heightmapFrom(
      [
        [0, 3, 3],
        [0, 3, 3],
        [0, 3, 3],
      ],
      8,
    );
    tileCorners(map, 0, 1, out);
    // Every corner takes the tile's OWN height: a cliff-side tile stays flat and the
    // vertical face between the two grounds survives.
    expect([...out]).toEqual([0, 0, 0, 0]);

    tileCorners(map, 1, 1, out);
    expect([...out]).toEqual([3, 3, 3, 3]);
  });

  it('does not slope off the edge of the map', () => {
    // heightAt returns -1 outside the map. Averaging that sentinel in would pull every
    // border tile down toward it and hang the whole map off a lip.
    const map = heightmapFrom(
      [
        [4, 4],
        [4, 4],
      ],
      8,
    );
    tileCorners(map, 0, 0, out);
    expect([...out]).toEqual([4, 4, 4, 4]);
  });

  it('averages only the grounds that actually meet at a corner', () => {
    // The south corner of tile (0,0) is world point (1,1), touched by all four tiles.
    const map = heightmapFrom(
      [
        [0, 0],
        [0, 2],
      ],
      8,
    );
    tileCorners(map, 0, 0, out);
    // (0+0+0+2)/4. Two is within MAX_CLIMB of nothing here — 2-0 is a cliff — so it
    // snaps instead.
    expect([...out]).toEqual([0, 0, 0, 0]);

    const gentle = heightmapFrom(
      [
        [0, 0],
        [0, 1],
      ],
      8,
    );
    tileCorners(gentle, 0, 0, out);
    expect(out[2]).toBeCloseTo(0.25);
  });
});
