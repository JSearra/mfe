/**
 * What a village can hold, as one catalogue.
 *
 * Three resources were named one by one wherever they were used. The ledger seeded them,
 * trade priced them through a chain of `if (resource === Resource.Grain)`, and the HUD
 * printed them from a fixed sentence. Adding meat, skins and ivory that way would have
 * meant finding every one of those chains, and the owner has said more are coming
 * (ADR-0022: water next, "and possibly other resources in future"). So a resource is a
 * row here, and code that treats resources alike iterates the rows.
 *
 * Shared rather than simulation-only, because the HUD needs the indices as values to
 * read the stores it is handed, and the import boundary rightly refuses to let it reach
 * into `src/sim` for them.
 *
 * **Indices are appended, never reordered.** They are not durable wire values (no
 * recorded command names one; see ledger.ts), but the save format and the replay hash
 * both lay the ledger out by index, so moving one silently re-labels a village's stores.
 */
export const Resource = {
  Cattle: 0,
  Grain: 1,
  /** Timber, cut from the woodland. See src/sim/woodland.ts. */
  Wood: 2,
  /** Food that spoils. Eaten before grain. From the cull and, in time, the hunt. */
  Meat: 3,
  /** Hides. Kept, traded and built with. */
  Skins: 4,
  /** From elephant. Rare, and worth more to a neighbour than anything else a village has. */
  Ivory: 5,
  /**
   * Drawn from rivers, wells and the rain, and drunk every upkeep (ADR-0023). Not food,
   * not traded, and it does not keep: what is held evaporates fast.
   */
  Water: 6,
} as const;

export type Resource = (typeof Resource)[keyof typeof Resource];

export const RESOURCE_COUNT = 7;

/** Every resource, in index order. Ties anywhere that iterates this break on that order. */
export const RESOURCES: readonly Resource[] = [
  Resource.Cattle,
  Resource.Grain,
  Resource.Wood,
  Resource.Meat,
  Resource.Skins,
  Resource.Ivory,
  Resource.Water,
];

/**
 * The name each resource goes by in `tuning.json`.
 *
 * Tuning is keyed by name rather than by index so the file stays readable, and so a
 * resource added later is a new key rather than a column nobody can find.
 */
export const RESOURCE_NAMES: Readonly<Record<Resource, string>> = {
  [Resource.Cattle]: 'cattle',
  [Resource.Grain]: 'grain',
  [Resource.Wood]: 'wood',
  [Resource.Meat]: 'meat',
  [Resource.Skins]: 'skins',
  [Resource.Ivory]: 'ivory',
  [Resource.Water]: 'water',
};

/**
 * What the people eat, in the order they eat it.
 *
 * Meat first because it will not keep. A village eating its grain while its meat went
 * off would be wasting food for no reason, and nobody does that.
 */
export const FOODS: readonly Resource[] = [Resource.Meat, Resource.Grain];

/**
 * What a neighbour will trade in.
 *
 * Meat is left out. It spoils within a season, and a parcel of it would be carrion by
 * the time it arrived.
 */
export const TRADED: readonly Resource[] = [
  Resource.Cattle,
  Resource.Grain,
  Resource.Wood,
  Resource.Skins,
  Resource.Ivory,
];
