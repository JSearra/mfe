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

/**
 * What a building does to the ground, the season or the granary around it.
 *
 * Every type in the catalogue until now differed from every other only in the numbers
 * on `grainYield`, `cattleYield` and `trains` — five buildings and one verb between
 * them, which is why the answer to every problem the village had was another granary.
 * A spec with no way to say "this one SHELTERS the fields near it" can only ever
 * produce more of what is already produced.
 *
 * Retired kinds are numbered gaps like every other enum here. See CLAUDE.md.
 */
export const EffectKind = {
  /**
   * Fields within reach lose less of their yield to a drought.
   *
   * A weir, a furrow, a cistern: works that hold water on the land. The drought is the
   * only pressure the economy has that the player cannot answer by working harder, so
   * this is the one kind of building that answers it.
   */
  DroughtShelter: 0,
  /**
   * Grain held back against a hungry season, above what the granary is already storing.
   *
   * Village-wide rather than local — a pit is dug where it is dug, and the grain in it
   * is the village's. Declared with `radius` zero to say so.
   */
  GrainReserve: 1,
} as const;

export type EffectKind = (typeof EffectKind)[keyof typeof EffectKind];

export interface BuildingEffect {
  readonly kind: EffectKind;
  /**
   * Tiles from the building's own tile, or ZERO for an effect that belongs to the
   * village rather than to a place. Not a sentinel standing in for "everywhere": a
   * radius of nought genuinely is the building's own tile, and the two readings agree
   * for every effect that would want either.
   */
  readonly radius: number;
  /** What one finished building of this type contributes. Effects of a kind add up. */
  readonly strength: number;
}

export interface BuildingSpec {
  readonly type: BuildingType;
  readonly nameKey: string;
  /** Square footprint, in tiles. Kept square so depth sorting stays unambiguous. */
  readonly footprint: number;
  readonly grainCost: number;
  /**
   * Timber, cut from the woodland. Every building needs some: it is what makes a wood
   * worth keeping near a village rather than felling to the last stump.
   */
  readonly woodCost: number;
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
  /**
   * Cattle may walk into it; people may not.
   *
   * An enclosure is a thing you put a herd INSIDE. Blocking the footprint for every
   * movement class made the kraal a solid block that the cattle it exists to hold stood
   * awkwardly beside — a pen you cannot put anything in. The wall is still a wall to
   * anyone on two legs, which is what keeps it reading as an enclosure rather than as
   * open ground with a fence drawn on it.
   */
  readonly holdsCattle: boolean;
  /**
   * What this one DOES, beyond adding to a total. Null for most of them.
   *
   * Null rather than optional, so adding a building type is a decision about this
   * rather than an omission of it.
   */
  readonly effect: BuildingEffect | null;
}

export const BUILDINGS: Readonly<Record<BuildingType, BuildingSpec>> = {
  [BuildingType.Isibaya]: {
    type: BuildingType.Isibaya,
    nameKey: 'building.isibaya',
    footprint: 2,
    grainCost: 120,
    woodCost: 40,
    cattleCost: 0,
    work: 600,
    grainYield: 0,
    /**
     * Sixty upkeeps is ten minutes, so a kraal running that long breeds exactly the
     * thirty head already grazing on the map at the start. Building is therefore never
     * faster than going and taking what is there, which is the whole argument of the
     * game. It was 1.5 — ninety head over the same ten minutes — and a player who
     * ignored the herd entirely and put up two kraals won faster than one who raided.
     */
    cattleYield: 0.5,
    maxHeightVariation: 0,
    holdsCattle: true,
    trains: false,
    effect: null,
  },
  [BuildingType.Umuzi]: {
    type: BuildingType.Umuzi,
    nameKey: 'building.umuzi',
    footprint: 2,
    grainCost: 90,
    woodCost: 55,
    cattleCost: 2,
    work: 480,
    /*
     * A dwelling is shelter, not a granary.
     *
     * This was 4, which made a hut a small farm: a village that begins as a village
     * rather than as a crowd in a field founds several of them, and the opening went
     * from feeding 61 households to feeding 104 against a settle target of 60 — the
     * whole economic arc handed over before the player had done anything. The target
     * was costed in Phase V1 as "about 15 more a cycle than the land gives, which is
     * two granaries and the work to raise them", and dwellings quietly paying that
     * bill is what broke it.
     *
     * A umuzi still earns its cost several times over, because what it produces is
     * PEOPLE — `trains` below is the whole point of it. Food comes from the land and
     * from the granary that stores what the land gives.
     */
    grainYield: 1,
    cattleYield: 0,
    maxHeightVariation: 0,
    // A homestead is where people come from, so this is where troops are raised.
    holdsCattle: false,
    trains: true,
    effect: null,
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
    woodCost: 90,
    cattleCost: 4,
    work: 900,
    // It feeds nobody: an ikhanda consumes the countryside around it rather than
    // provisioning itself, which is the whole political economy of a standing army.
    grainYield: 0,
    cattleYield: 0,
    maxHeightVariation: 0,
    holdsCattle: false,
    trains: true,
    effect: null,
  },
  [BuildingType.Indlunkulu]: {
    type: BuildingType.Indlunkulu,
    nameKey: 'building.indlunkulu',
    footprint: 2,
    grainCost: 150,
    woodCost: 70,
    cattleCost: 3,
    work: 700,
    grainYield: 2,
    // A third of the isibaya's, as it was before that came down. At parity the
    // indlunkulu would be strictly better — the same cattle plus grain — and the
    // building actually named for cattle would be the wrong thing to build.
    cattleYield: 0.15,
    maxHeightVariation: 0,
    holdsCattle: false,
    trains: false,
    effect: null,
  },
  [BuildingType.GrainStore]: {
    type: BuildingType.GrainStore,
    nameKey: 'building.grainStore',
    footprint: 1,
    grainCost: 60,
    woodCost: 30,
    cattleCost: 0,
    work: 300,
    grainYield: 9,
    cattleYield: 0,
    maxHeightVariation: 0,
    holdsCattle: false,
    trains: false,
    effect: null,
  },
};

export function buildingSpec(type: number): BuildingSpec {
  return BUILDINGS[(type as BuildingType) in BUILDINGS ? (type as BuildingType) : BuildingType.GrainStore];
}
