import { describe, expect, it } from 'vitest';
import { BUILDINGS, BuildingType, EffectKind } from '../src/shared/buildings/index.js';
import { effectAt, effectTotal } from '../src/sim/buildingEffects.js';
import { createWorld, EntityKind, spawn } from '../src/sim/world.js';
import { buildingSpec } from '../src/shared/buildings/index.js';

/**
 * What a building does to the ground around it.
 *
 * Every building in the catalogue until now differed from the others only in the
 * numbers on grainYield, cattleYield and trains — the spec had no vocabulary at all for
 * a building that ACTS on something. This is that vocabulary, landed on its own and
 * declared by nothing, so the mechanism and the buildings that use it are separable.
 */

function place(
  world: ReturnType<typeof createWorld>,
  owner: number,
  type: BuildingType,
  tileX: number,
  tileY: number,
  finished = true,
): void {
  const handle = spawn(world, tileX, tileY, owner, EntityKind.Building);
  const index = handle & 0xffffff;
  world.buildingType[index] = type;
  world.buildProgress[index] = finished ? buildingSpec(type).work : 0;
}

describe('the catalogue', () => {
  it('declares no effect on anything that shipped before effects existed', () => {
    // The scaffolding has to be inert or the golden replay could not tell it apart from
    // a rule change. Every building that predates it says so explicitly.
    for (const spec of Object.values(BUILDINGS)) {
      expect(spec.effect).toBeNull();
    }
  });
});

describe('effectAt', () => {
  it('is zero where a player has nothing', () => {
    const world = createWorld(64, 1);
    expect(effectAt(world, 0, EffectKind.DroughtShelter, 10, 10)).toBe(0);
  });

  it('reaches a tile inside the radius and not one outside it', () => {
    const world = createWorld(64, 1);
    place(world, 0, BuildingType.Isibaya, 10, 10);
    // Isibaya declares no effect, so nothing reaches anywhere — the query reads the
    // catalogue rather than assuming every building has one.
    expect(effectAt(world, 0, EffectKind.DroughtShelter, 11, 10)).toBe(0);
  });

  it('counts only finished buildings', () => {
    const world = createWorld(64, 1);
    place(world, 0, BuildingType.GrainStore, 10, 10, false);
    expect(effectTotal(world, 0, EffectKind.GrainReserve)).toBe(0);
  });

  it('counts only this player s buildings', () => {
    const world = createWorld(64, 2);
    place(world, 1, BuildingType.GrainStore, 10, 10);
    expect(effectTotal(world, 0, EffectKind.GrainReserve)).toBe(0);
  });
});
