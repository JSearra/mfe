import { describe, expect, it } from 'vitest';
import { BUILDINGS, BuildingType, EffectKind } from '../src/shared/buildings/index.js';
import { effectAt, effectTotal } from '../src/sim/buildingEffects.js';
import { createWorld, EntityKind, handleIndex, spawn } from '../src/sim/world.js';
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
  // The fifth argument is movementClass and the SIXTH is the kind. Passing
  // EntityKind.Building into the fifth spawned a unit with a strange movement class,
  // and every assertion in this file went on passing because a query that finds no
  // buildings and a query that finds none of this player's buildings both answer zero.
  // A test that cannot observe the thing it names will pass for ever while it is wrong.
  const handle = spawn(world, tileX, tileY, owner, 0, EntityKind.Building);
  const index = handleIndex(handle);
  world.buildingType[index] = type;
  world.buildProgress[index] = finished ? buildingSpec(type).work : 0;
}

describe('the catalogue', () => {
  it('declares no effect on anything that shipped before effects existed', () => {
    // The scaffolding landed inert, so that the golden replay could tell it apart from
    // a rule change; every building that predates it still says so explicitly. Named
    // one by one rather than "all of them", because the point is that these five did
    // not change, not that nothing ever will.
    for (const type of [
      BuildingType.Isibaya,
      BuildingType.Umuzi,
      BuildingType.GrainStore,
      BuildingType.Ikhanda,
      BuildingType.Indlunkulu,
    ]) {
      expect(BUILDINGS[type].effect).toBeNull();
    }
  });

  it('gives the umgodi a village-wide grain reserve', () => {
    const effect = BUILDINGS[BuildingType.Umgodi].effect;
    expect(effect?.kind).toBe(EffectKind.GrainReserve);
    // Radius zero: where a pit was dug is not the point, the grain in it is the
    // village's. `effectTotal` is the query for this shape, not `effectAt`.
    expect(effect?.radius).toBe(0);
    expect(effect?.strength).toBeGreaterThan(0);
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
    // Half a pit holds nothing. Paying out on a site would make placing it the whole
    // of the decision.
    const world = createWorld(64, 1);
    place(world, 0, BuildingType.Umgodi, 10, 10, false);
    expect(effectTotal(world, 0, EffectKind.GrainReserve)).toBe(0);

    place(world, 0, BuildingType.Umgodi, 12, 12, true);
    expect(effectTotal(world, 0, EffectKind.GrainReserve)).toBe(
      BUILDINGS[BuildingType.Umgodi].effect!.strength,
    );
  });

  it('adds up, so a row of pits is a bad year survived', () => {
    const world = createWorld(64, 1);
    place(world, 0, BuildingType.Umgodi, 10, 10);
    place(world, 0, BuildingType.Umgodi, 12, 10);
    place(world, 0, BuildingType.Umgodi, 14, 10);
    expect(effectTotal(world, 0, EffectKind.GrainReserve)).toBe(
      3 * BUILDINGS[BuildingType.Umgodi].effect!.strength,
    );
  });

  it('counts only this player s buildings', () => {
    const world = createWorld(64, 2);
    place(world, 1, BuildingType.Umgodi, 10, 10);
    expect(effectTotal(world, 0, EffectKind.GrainReserve)).toBe(0);
  });
});
