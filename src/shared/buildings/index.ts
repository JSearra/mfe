/**
 * Building types.
 *
 * Footprints are deliberately square and small. ARCHITECTURE section 4 settled the
 * multi-tile depth-sorting problem by constraining footprints so pairwise occlusion
 * ambiguity cannot arise, rather than by slicing art into per-tile strips or running a
 * cycle-prone topological sort. This is where that constraint lives.
 *
 * Names follow docs/CONTENT.md: the terms are isiZulu and are not translated, only
 * glossed. An `isibaya` is a cattle enclosure; a `umuzi` is a homestead.
 */

export const BuildingType = {
  Isibaya: 0,
  Umuzi: 1,
  GrainStore: 2,
} as const;

export type BuildingType = (typeof BuildingType)[keyof typeof BuildingType];

export interface BuildingSpec {
  readonly type: BuildingType;
  readonly nameKey: string;
  /** Square footprint, in tiles. Kept square so depth sorting stays unambiguous. */
  readonly footprint: number;
  readonly grainCost: number;
  readonly cattleCost: number;
  /** Builder-ticks of work needed. */
  readonly work: number;
  /** Grain added at each upkeep once complete. */
  readonly grainYield: number;
  /** Cattle added at each upkeep once complete. */
  readonly cattleYield: number;
  /** Terrain must be this flat across the footprint. */
  readonly maxHeightVariation: number;
  /** Whether troops can be raised here. */
  readonly trains: boolean;
}

export const BUILDINGS: Readonly<Record<BuildingType, BuildingSpec>> = {
  [BuildingType.Isibaya]: {
    type: BuildingType.Isibaya,
    nameKey: 'building.isibaya',
    footprint: 2,
    grainCost: 120,
    cattleCost: 0,
    work: 600,
    grainYield: 0,
    cattleYield: 1.5,
    maxHeightVariation: 0,
    trains: false,
  },
  [BuildingType.Umuzi]: {
    type: BuildingType.Umuzi,
    nameKey: 'building.umuzi',
    footprint: 2,
    grainCost: 90,
    cattleCost: 2,
    work: 480,
    grainYield: 4,
    cattleYield: 0,
    maxHeightVariation: 0,
    // A homestead is where people come from, so this is where troops are raised.
    trains: true,
  },
  [BuildingType.GrainStore]: {
    type: BuildingType.GrainStore,
    nameKey: 'building.grainStore',
    footprint: 1,
    grainCost: 60,
    cattleCost: 0,
    work: 300,
    grainYield: 9,
    cattleYield: 0,
    maxHeightVariation: 0,
    trains: false,
  },
};

export function buildingSpec(type: number): BuildingSpec {
  return BUILDINGS[(type as BuildingType) in BUILDINGS ? (type as BuildingType) : BuildingType.GrainStore];
}
