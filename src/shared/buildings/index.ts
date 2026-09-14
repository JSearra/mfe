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
  /**
   * A military homestead: where the amabutho are quartered and raised.
   *
   * Historically an ikhanda is a royal homestead housing an age-regiment, laid out like
   * any other umuzi but larger and built around the king's authority rather than a
   * family's. That is why it trains faster than a homestead does and costs more: it is
   * the instrument of a standing army, not a household that also produces men.
   */
  Ikhanda: 3,
  /**
   * The great house at the head of the homestead.
   *
   * The indlunkulu stands opposite the entrance, above the isibaya. It is where standing
   * and decision sit, so in play it is what research is done from.
   */
  Indlunkulu: 4,
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
  [BuildingType.Ikhanda]: {
    type: BuildingType.Ikhanda,
    nameKey: 'building.ikhanda',
    // Two, not three, and the test that caught the difference is worth keeping in mind:
    // ARCHITECTURE section 4 settles multi-tile depth sorting by CONSTRAINING footprints
    // so pairwise occlusion ambiguity cannot arise, and a three-tile footprint reopens a
    // decision that was made to avoid a class of bug. The ikhanda still reads as the
    // largest thing on the map, because how big a building LOOKS is its sprite and how
    // much ground it occupies is this number; they were never the same thing.
    footprint: 2,
    grainCost: 200,
    cattleCost: 4,
    work: 900,
    // It feeds nobody: an ikhanda consumes the countryside around it rather than
    // provisioning itself, which is the whole political economy of a standing army.
    grainYield: 0,
    cattleYield: 0,
    maxHeightVariation: 0,
    trains: true,
  },
  [BuildingType.Indlunkulu]: {
    type: BuildingType.Indlunkulu,
    nameKey: 'building.indlunkulu',
    footprint: 2,
    grainCost: 150,
    cattleCost: 3,
    work: 700,
    grainYield: 2,
    cattleYield: 0.5,
    maxHeightVariation: 0,
    trains: false,
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
