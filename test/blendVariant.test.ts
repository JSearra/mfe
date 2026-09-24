import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLEND_VARIANTS, blendVariant } from '../src/render/scene/terrainBand.js';

/**
 * Which of a mask's several cuts a tile uses.
 *
 * With one mask per configuration, a straight boundary stamps the same meander tile
 * after tile and the result is a regular scalloped sawtooth — the repetition is as
 * legible as the straight edge it replaced, just at a different frequency. AoE2 solves
 * exactly this: its blendomatic set carries four cuts of each directional mask and
 * picks between them on "the lower 2 bits of tile destination x or y".
 *
 * Hashed rather than taken from the low bits directly, because `x & 3` repeats every
 * four tiles along a row and an isometric boundary runs diagonally — the two line up
 * and produce a new, coarser stripe. The hash is the same one the base tile variant
 * already uses, with its own salt.
 */

describe('blendVariant', () => {
  it('stays inside the set', () => {
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        const v = blendVariant(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(BLEND_VARIANTS);
      }
    }
  });

  it('holds still for a tile, so the ground does not crawl between frames', () => {
    expect(blendVariant(12, 30)).toBe(blendVariant(12, 30));
  });

  it('uses the whole set, fairly evenly', () => {
    const seen = new Array<number>(BLEND_VARIANTS).fill(0);
    for (let x = 0; x < 128; x++) for (let y = 0; y < 128; y++) seen[blendVariant(x, y)]!++;
    const total = 128 * 128;
    for (const count of seen) {
      expect(count).toBeGreaterThan(total / BLEND_VARIANTS * 0.8);
      expect(count).toBeLessThan(total / BLEND_VARIANTS * 1.2);
    }
  });

  it('does not repeat along a diagonal, which is where a boundary actually runs', () => {
    // The failure mode of `x & 3`. An isometric seam runs diagonally, so a chooser that
    // repeats every four tiles along one axis lines up with it and trades a sawtooth at
    // one tile for a sawtooth at four.
    const run: number[] = [];
    for (let i = 0; i < 24; i++) run.push(blendVariant(10 + i, 10 + i));
    let longestRepeat = 0;
    for (let period = 1; period <= 6; period++) {
      let matches = 0;
      for (let i = 0; i + period < run.length; i++) if (run[i] === run[i + period]) matches++;
      const ratio = matches / (run.length - period);
      if (ratio > 0.9) longestRepeat = period;
    }
    expect(longestRepeat, 'the variant repeats on a short diagonal period').toBe(0);
  });
});

describe('the shipped variants', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve('public/assets/terrain/manifest.json'), 'utf8'),
  ) as { tiles: { subject: string; mask?: number; corner?: number; band: number; variant?: number }[] };

  it('cuts the masks that tile a boundary four ways', () => {
    // The single-edge masks are the ones that repeat along a straight seam. The
    // multi-edge combinations happen at kinks and do not need cutting.
    const transitions = manifest.tiles.filter((t) => t.subject === 'transition');
    const bands = new Set(transitions.map((t) => t.band));
    for (const band of bands) {
      for (const mask of [1, 2, 4, 8]) {
        const cuts = transitions.filter((t) => t.band === band && t.mask === mask);
        expect(cuts.length, `band ${band} mask ${mask}`).toBe(BLEND_VARIANTS);
        expect(new Set(cuts.map((t) => t.variant)).size).toBe(BLEND_VARIANTS);
      }
    }
  });

  it('cuts the corner wedges too', () => {
    const corners = manifest.tiles.filter((t) => t.subject === 'corner');
    const bands = new Set(corners.map((t) => t.band));
    for (const band of bands) {
      for (const corner of [0, 1, 2, 3]) {
        const cuts = corners.filter((t) => t.band === band && t.corner === corner);
        expect(cuts.length, `band ${band} corner ${corner}`).toBe(BLEND_VARIANTS);
      }
    }
  });
});
