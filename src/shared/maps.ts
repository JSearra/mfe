/**
 * The names of the scripted landscapes.
 *
 * Separated from their generators in `src/sim/terrain/maps.ts` because the UI needs to
 * offer them in a menu and the import boundary — rightly — refuses to let UI reach into
 * the simulation for a value. The same split already exists for factions: the identifier
 * is shared vocabulary, the behaviour behind it is not.
 */

export const MapScript = {
  /** Tabular sandstone mesas with sheer sides and a handful of climbable passes. */
  ThabaBosiu: 'thaba-bosiu',
  /** Dissected rolling spurs cut by a braided river. */
  Umfolozi: 'umfolozi',
  /** Flat arid plain, ironstone koppies, and dongas sunk into it. */
  Karoo: 'karoo',
  /** Parallel ridge lines pierced by narrow poorts. */
  Magaliesberg: 'magaliesberg',
} as const;

export type MapScript = (typeof MapScript)[keyof typeof MapScript];

export const MAP_SCRIPTS: readonly MapScript[] = Object.values(MapScript);
