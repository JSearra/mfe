import { describe, expect, it } from 'vitest';
import { originOf } from '../src/render/assets.js';

describe('originOf', () => {
  const origins = {
    villager: { x: 100, y: 180, pixelsPerUnit: 56 },
    nguni: { x: 64, y: 90, pixelsPerUnit: 40 },
    'nguni-dark': { x: 70, y: 95, pixelsPerUnit: 40 },
  };

  it('gives a body its own origin', () => {
    expect(originOf(origins, 'villager')).toEqual(origins.villager);
  });

  it("anchors an overlay at its body's origin, so the outfit lands on the figure", () => {
    expect(originOf(origins, 'villager-team')).toEqual(origins.villager);
    expect(originOf(origins, 'nguni-shield')).toEqual(origins.nguni);
  });

  it('strips only the overlay suffix, not a hyphen in the body name', () => {
    expect(originOf(origins, 'nguni-dark-team')).toEqual(origins['nguni-dark']);
  });

  it('falls back to the frame centre for a kind with no origin anywhere', () => {
    expect(originOf(origins, 'unknown-team')).toEqual({ x: 64, y: 64 });
  });
});
