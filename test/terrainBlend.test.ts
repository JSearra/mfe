import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shipped blend masks, checked against the thing that makes them work.
 *
 * A terrain blend whose leading edge is a straight line reads as a printed seam however
 * soft the gradient across it is — the boundary falls on the tile grid and the eye picks
 * the grid out. Both games this was modelled on avoid it: AoE2's blendomatic carries
 * nine blend MODES including "rough transition, used for dirt, grass" and "rough hard
 * edges, spraylike", and Red Alert's LAT transition tiles are hand-drawn with irregular
 * boundaries. Neither ever draws a straight one.
 *
 * This is exactly the class of defect this project keeps shipping — it passes types,
 * tests, lint and the size budget, and is visible only to somebody looking at the map.
 * `postprocess.py` measures each mask's wander when it generates it and records it in
 * the manifest; this reads the number back. A regeneration with the roughness reset to
 * zero would otherwise be completely silent.
 */

const manifest = JSON.parse(
  fs.readFileSync(path.resolve('public/assets/terrain/manifest.json'), 'utf8'),
) as { tiles: { subject: string; mask?: number; band: number; frontWander?: number }[] };

const transitions = manifest.tiles.filter((tile) => tile.subject === 'transition');

/** The single-edge masks: the four that tile along a long, straight boundary. */
const SINGLE_EDGE = [1, 2, 4, 8];

describe('the shipped blend masks', () => {
  it('has a mask for every edge configuration of every band', () => {
    // Fifteen non-empty configurations of four edges, which is the same indexing
    // Command & Conquer's LAT sets use for the same job.
    const bands = new Set(transitions.map((tile) => tile.band));
    expect(bands.size).toBeGreaterThan(0);
    for (const band of bands) {
      const masks = transitions.filter((tile) => tile.band === band).map((tile) => tile.mask);
      expect(new Set(masks).size, `band ${band} is short of masks`).toBe(15);
    }
  });

  it('records how far each front wanders', () => {
    // If the measurement stops being taken the assertion below silently passes on
    // undefined, which is the failure mode of every guard that reads its own input.
    for (const tile of transitions) {
      expect(typeof tile.frontWander, `no wander recorded for mask ${tile.mask}`).toBe('number');
    }
  });

  it('never ships a straight blend front on the masks that tile a boundary', () => {
    const single = transitions.filter((tile) => SINGLE_EDGE.includes(tile.mask ?? 0));
    expect(single.length).toBeGreaterThan(0);

    const mean = single.reduce((sum, tile) => sum + (tile.frontWander ?? 0), 0) / single.length;
    // A tile is 64px across. Under a pixel of wander is a straight line with rounding
    // on it; the shipped set averages about six, which is an eighth of a tile of
    // meander and enough to break the grid up.
    expect(mean).toBeGreaterThan(3);
  });

  it('does not let any single-edge front go completely flat', () => {
    // The mean could stay healthy while one band's masks were flat, and one flat band
    // is a whole ground type with a ruled edge around it.
    for (const tile of transitions.filter((t) => SINGLE_EDGE.includes(t.mask ?? 0))) {
      expect(tile.frontWander ?? 0, `band ${tile.band} mask ${tile.mask} is flat`).toBeGreaterThan(0.5);
    }
  });
});
