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
) as {
  tiles: {
    subject: string;
    mask?: number;
    band: number;
    frontWander?: number;
    field?: string;
    spill?: number;
    file: string;
  }[];
};

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

describe('the shipped field tiles', () => {
  const fields = manifest.tiles.filter((tile) => tile.field !== undefined);

  it('exists in both states for every band a field can be sited on', () => {
    expect(fields.length).toBeGreaterThan(0);
    for (const tile of fields) {
      expect(typeof tile.spill, `no spill recorded for ${tile.file}`).toBe('number');
    }
  });

  it('spills past its own diamond, so a patch is not a row of lozenges', () => {
    /*
     * Fields were hard diamonds, so six tiles of one field read as six lozenges and its
     * outer boundary was a staircase. Against ground that dissolves everywhere else
     * they became the most obviously drawn thing on the map.
     *
     * This works for fields and not for terrain because fields are SPRITES drawn at the
     * full rect, so a tile already overlaps its neighbours and has somewhere to spill
     * into. Terrain tops are a watertight mesh whose quads share corners exactly, and
     * the same idea there opens gaps instead — see docs/REFERENCES.md.
     */
    for (const tile of fields) {
      expect(tile.spill ?? 0, `${tile.file} stops dead at its diamond`).toBeGreaterThan(0.1);
    }
  });

  it('keeps a crop tighter than turned earth', () => {
    // A crop is sown to a line; turned ground has a scuffed, indefinite margin. If the
    // two were the same the distinction would be decoration rather than a reading.
    const broken = fields.filter((t) => t.field === 'broken');
    const crop = fields.filter((t) => t.field === 'crop');
    expect(broken.length).toBeGreaterThan(0);
    expect(crop.length).toBeGreaterThan(0);
    const mean = (xs: typeof fields) => xs.reduce((s, t) => s + (t.spill ?? 0), 0) / xs.length;
    expect(mean(broken)).toBeGreaterThan(mean(crop));
  });

  it('still stops well short of the tile corner, so a field keeps an edge', () => {
    // A worked field HAS a definite boundary — it is ploughed to a line. What was wrong
    // was never that the edge was hard, only that it was a diamond. A field that faded
    // away into the veld would be a different error.
    for (const tile of fields) {
      expect(tile.spill ?? 0, `${tile.file} bleeds away into the veld`).toBeLessThan(0.75);
    }
  });
});
