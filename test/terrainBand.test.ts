import { describe, expect, it } from 'vitest';
import { bandShiftFor, groundBand } from '../src/render/scene/terrainBand.js';
import { MapScript } from '../src/shared/maps.js';

/**
 * Which ground a height is drawn with.
 *
 * The palette is a ramp from wet to dry and the band is the tile's HEIGHT, so the two
 * together say "high ground is drier". That works for one landscape and not for five.
 * Measured across the scripts once the palette was toned strongly enough to be read at
 * all:
 *
 *   thaba-bosiu    24% riverbed, 69% savanna-low  — a sandstone mesa on wet sand
 *   karoo          72% savanna-mid                — a semi-desert in the lushest green
 *   magaliesberg   57% riverbed                   — a quartzite range drawn as riverbed
 *
 * None of that was visible while every band came out orange; the maps looked arid by
 * accident rather than by arrangement. The shift moves a script's ART along the ramp
 * without touching a single height, so geometry, cliffs, movement cost, pathing and
 * every reachability guarantee in `tasks/plan.md` section G are untouched. It is a
 * statement about how dry a country is, which is exactly what the heightmap was never
 * able to say.
 */

describe('groundBand', () => {
  it('is the tile s own height where a script asks for no shift', () => {
    expect(groundBand(3, 0, 8)).toBe(3);
  });

  it('moves the whole ramp for an arid country', () => {
    expect(groundBand(2, 2, 8)).toBe(4);
    expect(groundBand(0, 2, 8)).toBe(2);
  });

  it('clamps at both ends rather than falling off the ramp', () => {
    // A band off the end draws nothing at all, so the top of a shifted mesa must stop
    // at rock rather than index past it.
    expect(groundBand(7, 2, 8)).toBe(7);
    expect(groundBand(0, -3, 8)).toBe(0);
  });

  it('keeps two different heights distinguishable wherever it can', () => {
    // The ramp's whole job is to tell high ground from low. A shift that flattened two
    // adjacent bands into one would trade one wrong reading for another.
    expect(groundBand(3, 2, 8)).not.toBe(groundBand(4, 2, 8));
  });
});

describe('bandShiftFor', () => {
  it('leaves the two scripts that already sit on the ramp alone', () => {
    // umfolozi spreads 3-43% across bands 1-5 and the coast 2-22% across 1-6. Both are
    // already saying what they are, and a shift would be meddling.
    expect(bandShiftFor(MapScript.Umfolozi)).toBe(0);
    expect(bandShiftFor(MapScript.Coast)).toBe(0);
  });

  it('dries out the three that do not', () => {
    expect(bandShiftFor(MapScript.Karoo)).toBeGreaterThan(0);
    expect(bandShiftFor(MapScript.ThabaBosiu)).toBeGreaterThan(0);
    expect(bandShiftFor(MapScript.Magaliesberg)).toBeGreaterThan(0);
  });

  it('answers for a map with no script at all', () => {
    // The default generator has no name, and it is the one the golden replay runs on.
    expect(bandShiftFor(null)).toBe(0);
  });
});
