import { describe, expect, it } from 'vitest';
import { heightAt, heightmapFrom, inBounds } from '../src/shared/heightmap.js';
import {
  derivePassability,
  EDGE_ALL,
  EDGE_DX,
  EDGE_DY,
  EDGE_EAST,
  EDGE_NORTH,
  EDGE_SOUTH,
  EDGE_WEST,
  isPassable,
  stepCost,
} from '../src/shared/passability.js';
import { MAX_CLIMB, worldToScreenX, worldToScreenY } from '../src/shared/iso.js';
import { NO_TILE, pickTileIndex, tileX, tileY } from '../src/shared/picking.js';
import { createHeightmap } from '../src/sim/terrain/generate.js';

const MAP_SIZE = 128;
const SEED = 0xabcdef;

describe('heightmap generation', () => {
  it('is deterministic for a seed', () => {
    const a = createHeightmap(64, 64, SEED);
    const b = createHeightmap(64, 64, SEED);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });

  it('differs between seeds', () => {
    const a = createHeightmap(64, 64, 1);
    const b = createHeightmap(64, 64, 2);
    expect(Array.from(b.data)).not.toEqual(Array.from(a.data));
  });

  it('produces a 128x128 map inside the level range', () => {
    const map = createHeightmap(MAP_SIZE, MAP_SIZE, SEED);
    expect(map.data).toHaveLength(MAP_SIZE * MAP_SIZE);
    for (const value of map.data) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(map.levels);
    }
  });

  it('generates varied terrain rather than a plateau or a plain', () => {
    const map = createHeightmap(MAP_SIZE, MAP_SIZE, SEED);
    const distinct = new Set(map.data);
    expect(distinct.size).toBeGreaterThan(2);

    // Some cliffs, but not a shattered map that nothing can cross.
    const flags = derivePassability(map);
    let blocked = 0;
    for (const mask of flags) blocked += 4 - popcount(mask);
    const ratio = blocked / (flags.length * 4);
    expect(ratio).toBeGreaterThan(0.001);
    expect(ratio).toBeLessThan(0.4);
  });

  it('leaves most of the map mutually reachable', () => {
    // A generator that produces beautiful terrain nobody can walk across is a bug,
    // and it is invisible until pathfinding lands in Phase 4.
    const map = createHeightmap(MAP_SIZE, MAP_SIZE, SEED);
    const flags = derivePassability(map);
    const reached = floodFill(map.width, map.height, flags, 0, 0);
    expect(reached / (map.width * map.height)).toBeGreaterThan(0.5);
  });
});

function popcount(value: number): number {
  let count = 0;
  for (let bit = 0; bit < 4; bit++) if (value & (1 << bit)) count++;
  return count;
}

function floodFill(
  width: number,
  height: number,
  flags: Uint8Array,
  startX: number,
  startY: number,
): number {
  const seen = new Uint8Array(width * height);
  const stack = [startY * width + startX];
  seen[stack[0]!] = 1;
  let count = 0;

  while (stack.length > 0) {
    const index = stack.pop()!;
    count++;
    const x = index % width;
    const y = (index / width) | 0;

    for (let dir = 0; dir < 4; dir++) {
      if ((flags[index]! & (1 << dir)) === 0) continue;
      const nx = x + EDGE_DX[dir]!;
      const ny = y + EDGE_DY[dir]!;
      const next = ny * width + nx;
      if (seen[next] === 1) continue;
      seen[next] = 1;
      stack.push(next);
    }
  }
  return count;
}

describe('passability', () => {
  // A hand-authored fixture: a flat plain, a one-step ramp, and a sheer mesa.
  const fixture = heightmapFrom(
    [
      [0, 0, 0, 0],
      [0, 1, 5, 0],
      [0, 1, 5, 0],
      [0, 0, 0, 0],
    ],
    8,
  );
  const flags = derivePassability(fixture);

  it('treats a step of MAX_CLIMB or less as walkable', () => {
    expect(MAX_CLIMB).toBe(1);
    // (1,1) is height 1 next to height 0 at (0,1) — a ramp, so walkable.
    expect(isPassable(fixture, flags, 1, 1, 3)).toBe(true); // west
  });

  it('treats a larger step as a cliff', () => {
    // (2,1) is height 5 next to height 1 at (1,1) — a sheer face.
    expect(isPassable(fixture, flags, 2, 1, 3)).toBe(false); // west
    expect(isPassable(fixture, flags, 1, 1, 1)).toBe(false); // east, from the other side
  });

  it('is symmetric — a cliff is a cliff from either side', () => {
    for (let y = 0; y < fixture.height; y++) {
      for (let x = 0; x < fixture.width; x++) {
        for (let dir = 0; dir < 4; dir++) {
          const nx = x + EDGE_DX[dir]!;
          const ny = y + EDGE_DY[dir]!;
          if (!inBounds(fixture, nx, ny)) continue;
          const back = (dir + 2) % 4;
          expect(isPassable(fixture, flags, x, y, dir)).toBe(
            isPassable(fixture, flags, nx, ny, back),
          );
        }
      }
    }
  });

  it('blocks every off-map edge', () => {
    expect(isPassable(fixture, flags, 0, 0, 0)).toBe(false); // north
    expect(isPassable(fixture, flags, 0, 0, 3)).toBe(false); // west
    expect(isPassable(fixture, flags, 3, 3, 1)).toBe(false); // east
    expect(isPassable(fixture, flags, 3, 3, 2)).toBe(false); // south
  });

  it('produces exactly the expected edge mask on the plain', () => {
    // (1,0): open east and south and west; north is off-map.
    const mask = flags[0 * fixture.width + 1]!;
    expect(mask & EDGE_NORTH).toBe(0);
    expect(mask & EDGE_WEST).toBe(EDGE_WEST);
    expect(mask & EDGE_SOUTH).toBe(EDGE_SOUTH);
    // East of (1,0) is (2,0) at height 0 — walkable.
    expect(mask & EDGE_EAST).toBe(EDGE_EAST);
  });

  it('has an interior flat tile open on all four sides', () => {
    const flat = heightmapFrom(
      [
        [2, 2, 2],
        [2, 2, 2],
        [2, 2, 2],
      ],
      8,
    );
    const flatFlags = derivePassability(flat);
    expect(flatFlags[1 * 3 + 1]).toBe(EDGE_ALL);
  });

  it('charges more for a slope than for flat ground, and nothing for a cliff', () => {
    expect(stepCost(fixture, 0, 1, 1)).toBe(2); // (0,1)h0 -> (1,1)h1, a ramp
    expect(stepCost(fixture, 0, 0, 1)).toBe(1); // flat
    expect(stepCost(fixture, 1, 1, 1)).toBe(0); // into the mesa face
    expect(stepCost(fixture, 0, 0, 0)).toBe(0); // off-map
  });
});

describe('elevation-aware picking', () => {
  it('round-trips every tile centre on flat ground at every height', () => {
    for (let level = 0; level < 8; level++) {
      const map = heightmapFrom(
        Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => level)),
        8,
      );

      for (let ty = 0; ty < map.height; ty++) {
        for (let tx = 0; tx < map.width; tx++) {
          const isoX = worldToScreenX(tx + 0.5, ty + 0.5);
          const isoY = worldToScreenY(tx + 0.5, ty + 0.5, level);
          const index = pickTileIndex(map, isoX, isoY);
          expect([tileX(map, index), tileY(map, index)]).toEqual([tx, ty]);
        }
      }
    }
  });

  // The test that matters: on a slope, ignoring height picks the wrong tile.
  it('round-trips every tile centre on a slope where nothing is occluded', () => {
    // Height falls as tx+ty grows, so no tile hides the one behind it.
    const size = 8;
    const map = heightmapFrom(
      Array.from({ length: size }, (_, ty) =>
        Array.from({ length: size }, (_, tx) => Math.max(0, 7 - Math.floor((tx + ty) / 2))),
      ),
      8,
    );

    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        const level = heightAt(map, tx, ty);
        const isoX = worldToScreenX(tx + 0.5, ty + 0.5);
        const isoY = worldToScreenY(tx + 0.5, ty + 0.5, level);
        const index = pickTileIndex(map, isoX, isoY);
        expect([tileX(map, index), tileY(map, index)]).toEqual([tx, ty]);
      }
    }
  });

  it('would pick the wrong tile if height were ignored', () => {
    // Guards the guard: proves the slope case is actually discriminating.
    const map = heightmapFrom(
      [
        [6, 6, 6],
        [6, 6, 6],
        [6, 6, 6],
      ],
      8,
    );
    const isoX = worldToScreenX(1.5, 1.5);
    const isoY = worldToScreenY(1.5, 1.5, 6);

    const flatEarth = heightmapFrom(
      [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      8,
    );
    expect(pickTileIndex(map, isoX, isoY)).not.toBe(pickTileIndex(flatEarth, isoX, isoY));
  });

  it('lets tall terrain occlude the low ground behind it', () => {
    // Occlusion runs from higher tx+ty toward lower, which is worth stating because the
    // intuition points the other way: raising a tile *behind* another lifts it further
    // up the screen and away, so it hides nothing. It is the tile in FRONT — larger
    // tx+ty, drawn lower — that covers the ground behind it once it is tall enough.
    const map = heightmapFrom(
      [
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 4, 0],
        [0, 0, 0, 0, 0, 0],
      ],
      8,
    );
    const isoX = worldToScreenX(3.5, 3.5);
    const isoY = worldToScreenY(3.5, 3.5, 0);

    // Without the tall tile at (4,4) this point resolves to (3,3).
    const flat = heightmapFrom(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 0)),
      8,
    );
    const unoccluded = pickTileIndex(flat, isoX, isoY);
    expect([tileX(flat, unoccluded), tileY(flat, unoccluded)]).toEqual([3, 3]);

    const occluded = pickTileIndex(map, isoX, isoY);
    expect([tileX(map, occluded), tileY(map, occluded)]).toEqual([4, 4]);
  });

  it('returns NO_TILE well outside the map', () => {
    const map = heightmapFrom(
      [
        [0, 0],
        [0, 0],
      ],
      8,
    );
    expect(pickTileIndex(map, worldToScreenX(-50, -50), worldToScreenY(-50, -50, 0))).toBe(NO_TILE);
  });
});
