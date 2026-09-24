import { describe, expect, it } from 'vitest';
import { shadowRadius } from '../src/render/scene/entities.js';
import { BuildingType, BUILDINGS } from '../src/shared/buildings/index.js';
import { HALF_TILE_W } from '../src/shared/iso.js';

const KIND_UNIT = 0;
const KIND_CATTLE = 1;
const KIND_BUILDING = 2;

/**
 * How big a thing's shadow is.
 *
 * Buildings were getting the villager's. `drawDecal` drew one ellipse at the unit
 * radius for everything it was handed, so an isibaya two tiles across sat on the same
 * smudge as one person standing — which is most of why the buildings looked like they
 * were resting on the grass rather than standing in it. Every reference sheet of
 * isometric buildings has a cast shadow the size of the building.
 */

describe('shadowRadius', () => {
  it('gives a villager the unit radius', () => {
    expect(shadowRadius(KIND_UNIT, 0)).toBeGreaterThan(0);
  });

  it('gives a beast its own, because a cow is not a person', () => {
    expect(shadowRadius(KIND_CATTLE, 0)).not.toBe(shadowRadius(KIND_UNIT, 0));
  });

  it('scales a building to its footprint rather than to a person', () => {
    const person = shadowRadius(KIND_UNIT, 0);
    for (const spec of Object.values(BUILDINGS)) {
      const shadow = shadowRadius(KIND_BUILDING, spec.type);
      expect(shadow, `${spec.nameKey} is shadowed like a villager`).toBeGreaterThan(person);
      // Roughly the ground it actually covers: half a footprint, in screen pixels.
      expect(shadow).toBeCloseTo(spec.footprint * HALF_TILE_W * 0.5, 0);
    }
  });

  it('gives a two-tile building a larger shadow than a one-tile one', () => {
    const small = shadowRadius(KIND_BUILDING, BuildingType.GrainStore); // footprint 1
    const large = shadowRadius(KIND_BUILDING, BuildingType.Isibaya); // footprint 2
    expect(BUILDINGS[BuildingType.GrainStore].footprint).toBe(1);
    expect(BUILDINGS[BuildingType.Isibaya].footprint).toBe(2);
    expect(large).toBeGreaterThan(small);
  });

  it('answers for a building type it has never heard of', () => {
    // A snapshot from a newer build. It should draw some shadow rather than none.
    expect(shadowRadius(KIND_BUILDING, 250)).toBeGreaterThan(0);
  });
});
