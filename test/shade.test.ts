import { describe, expect, it } from 'vitest';
import { shade } from '../src/render/scene/terrain.js';

/**
 * Colour scaling must stay inside 24 bits.
 *
 * Every caller passed a factor below one for as long as this existed, so the missing
 * clamp was unreachable and free — until the cliff lip wanted 1.18 to brighten an edge.
 * A channel ran past 255 into the next byte, Pixi refused the value outright, and the
 * whole page rendered black. Not a wrong colour: no picture, and no obvious connection
 * between "added a highlight to cliff edges" and "the game does not start".
 */
describe('shade', () => {
  it('darkens without going negative', () => {
    expect(shade(0x806040, 0.5)).toBe(0x403020);
    expect(shade(0x806040, 0)).toBe(0x000000);
    expect(shade(0x806040, -1)).toBe(0x000000);
  });

  it('brightens without overflowing into the next channel', () => {
    const bright = shade(0xf0e0d0, 2);
    expect(bright).toBe(0xffffff);
    expect(bright).toBeLessThanOrEqual(0xffffff);
  });

  it('never leaves 24 bits, whatever it is given', () => {
    for (const colour of [0x000000, 0x7f7f7f, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff]) {
      for (const factor of [0, 0.5, 1, 1.18, 4, 100]) {
        const result = shade(colour, factor);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(0xffffff);
      }
    }
  });
});
