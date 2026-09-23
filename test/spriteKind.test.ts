import { describe, expect, it } from 'vitest';
import { BUILDING_KINDS, buildingSpriteKind } from '../src/render/scene/entities.js';
import { BUILDINGS, BuildingType } from '../src/shared/buildings/index.js';

/**
 * Which sprite draws which building.
 *
 * This test exists because of a defect it would have caught. `BUILDING_KINDS` was a
 * five-element array indexed by building type, and three types were added to the
 * catalogue without it — so a grain pit, a weir and a goat fold every one of them fell
 * through to `BUILDING_KINDS[0]` and drew as a cattle enclosure. Nothing failed. The
 * command panel listed all three correctly, which is what got checked, and the map was
 * not looked at.
 *
 * A lookup keyed by position in an array cannot notice that the array is short. The
 * first assertion below is the whole point: every type in the catalogue has art, and
 * adding one without art is a test failure rather than a silent mis-draw.
 */

describe('building sprites', () => {
  it('has a distinct sprite for every building in the catalogue', () => {
    const kinds = new Set<string>();
    for (const spec of Object.values(BUILDINGS)) {
      const kind = buildingSpriteKind(spec.type);
      expect(kind, `no sprite for building type ${spec.type}`).not.toBe('');
      kinds.add(kind);
    }
    // Distinct, not merely present. Two buildings sharing a silhouette is the defect
    // this file was written for, and it is invisible unless the count is checked.
    expect(kinds.size).toBe(Object.values(BUILDINGS).length);
  });

  it('names every sprite it hands out', () => {
    // The atlas is loaded by name, so a kind nothing has rendered draws nothing at all.
    for (const spec of Object.values(BUILDINGS)) {
      expect(BUILDING_KINDS).toContain(buildingSpriteKind(spec.type));
    }
  });

  it('falls back to a named default rather than to whatever is first', () => {
    // An unknown type is a snapshot from a newer build. It should draw as SOMETHING,
    // and that something should be a deliberate choice rather than an accident of
    // array order — which is what made the original defect so quiet.
    expect(buildingSpriteKind(250)).toBe('umuzi');
  });

  it('still draws the five that shipped before as themselves', () => {
    expect(buildingSpriteKind(BuildingType.Isibaya)).toBe('isibaya');
    expect(buildingSpriteKind(BuildingType.Umuzi)).toBe('umuzi');
    expect(buildingSpriteKind(BuildingType.GrainStore)).toBe('grain-store');
    expect(buildingSpriteKind(BuildingType.Ikhanda)).toBe('ikhanda');
    expect(buildingSpriteKind(BuildingType.Indlunkulu)).toBe('indlunkulu');
  });
});
