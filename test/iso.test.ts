import { describe, expect, it } from 'vitest';
import {
  ELEV_STEP,
  isCliff,
  MAX_CLIMB,
  screenToWorldX,
  screenToWorldY,
  TILE_H,
  TILE_W,
  worldToScreenX,
  worldToScreenY,
} from '../src/shared/iso.js';

describe('isometric projection', () => {
  it('round-trips world -> screen -> world at every height', () => {
    for (let height = 0; height <= 15; height++) {
      for (let wx = -40; wx <= 40; wx += 3.5) {
        for (let wy = -40; wy <= 40; wy += 3.5) {
          const sx = worldToScreenX(wx, wy);
          const sy = worldToScreenY(wx, wy, height);
          expect(screenToWorldX(sx, sy, height)).toBeCloseTo(wx, 10);
          expect(screenToWorldY(sx, sy, height)).toBeCloseTo(wy, 10);
        }
      }
    }
  });

  it('uses a 2:1 diamond', () => {
    expect(TILE_W).toBe(2 * TILE_H);
    // One step along +x moves half a tile right and half a tile down.
    expect(worldToScreenX(1, 0) - worldToScreenX(0, 0)).toBe(TILE_W / 2);
    expect(worldToScreenY(1, 0, 0) - worldToScreenY(0, 0, 0)).toBe(TILE_H / 2);
    // +x and +y are mirror images horizontally.
    expect(worldToScreenX(0, 1)).toBe(-worldToScreenX(1, 0));
  });

  it('lifts by exactly ELEV_STEP per unit of height, without moving horizontally', () => {
    expect(worldToScreenY(4, 6, 0) - worldToScreenY(4, 6, 3)).toBe(3 * ELEV_STEP);
    expect(worldToScreenX(4, 6)).toBe(worldToScreenX(4, 6));
  });

  it('derives cliffs from height deltas rather than a tile type', () => {
    expect(isCliff(0, 0)).toBe(false);
    expect(isCliff(3, 3 + MAX_CLIMB)).toBe(false);
    expect(isCliff(3, 3 - MAX_CLIMB)).toBe(false);
    expect(isCliff(3, 3 + MAX_CLIMB + 1)).toBe(true);
    expect(isCliff(3, 3 - MAX_CLIMB - 1)).toBe(true);
    // Symmetric: a cliff is a cliff from either side.
    expect(isCliff(0, 9)).toBe(isCliff(9, 0));
  });
});
