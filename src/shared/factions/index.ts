/**
 * Faction configuration.
 *
 * Identifiers are stable ASCII slugs; display names live in the locale file and are NOT
 * translated, per docs/CONTENT.md section 2 — `amaZulu` stays `amaZulu` in every locale,
 * and only the gloss changes. Note the orthography: noun-class prefixes are lowercase
 * mid-sentence and the stem carries the capital, so it is `amaZulu` and `amaNdebele`,
 * and `Basotho` has no internal capital at all.
 */

export const FactionId = {
  Zulu: 'zulu',
  Sotho: 'sotho',
  Ndebele: 'ndebele',
  Griqua: 'griqua',
} as const;

export type FactionId = (typeof FactionId)[keyof typeof FactionId];

export interface FactionConfig {
  readonly id: FactionId;
  /** Translation key for the display name. The name itself is never translated. */
  readonly nameKey: string;
  readonly startingCattle: number;
  readonly startingGrain: number;
  readonly startingAmmunition: number;
  /** Multiplier on grain consumed per upkeep. */
  readonly upkeepMultiplier: number;
  /** Multiplier on herd growth. */
  readonly herdGrowthMultiplier: number;
  /** How close a herder can crowd cattle before stress outruns decay. Below 1 is calmer. */
  readonly herdingSkill: number;
  /** Default movement class for this faction's line troops. */
  readonly lineMovementClass: number;
}

export const FACTIONS: Readonly<Record<FactionId, FactionConfig>> = {
  [FactionId.Zulu]: {
    id: FactionId.Zulu,
    nameKey: 'faction.zulu',
    startingCattle: 120,
    startingGrain: 400,
    startingAmmunition: 0,
    upkeepMultiplier: 1.1,
    herdGrowthMultiplier: 1.0,
    herdingSkill: 1.0,
    lineMovementClass: 0,
  },
  [FactionId.Sotho]: {
    id: FactionId.Sotho,
    nameKey: 'faction.sotho',
    startingCattle: 90,
    startingGrain: 560,
    startingAmmunition: 20,
    upkeepMultiplier: 0.9,
    herdGrowthMultiplier: 0.95,
    herdingSkill: 0.85,
    lineMovementClass: 0,
  },
  [FactionId.Ndebele]: {
    id: FactionId.Ndebele,
    nameKey: 'faction.ndebele',
    startingCattle: 150,
    startingGrain: 300,
    startingAmmunition: 0,
    upkeepMultiplier: 1.15,
    herdGrowthMultiplier: 1.15,
    herdingSkill: 0.95,
    lineMovementClass: 0,
  },
  [FactionId.Griqua]: {
    id: FactionId.Griqua,
    nameKey: 'faction.griqua',
    startingCattle: 60,
    startingGrain: 340,
    startingAmmunition: 160,
    upkeepMultiplier: 1.0,
    herdGrowthMultiplier: 0.85,
    herdingSkill: 1.2,
    lineMovementClass: 2,
  },
};

export interface FactionProblem {
  readonly id: string;
  readonly field: string;
  readonly reason: string;
}

/**
 * Validate a faction config.
 *
 * Exists so a malformed config fails a test rather than at runtime, halfway through a
 * match, as a unit that costs NaN grain.
 */
export function validateFaction(config: Partial<FactionConfig>): FactionProblem[] {
  const problems: FactionProblem[] = [];
  const id = String(config.id ?? '<missing>');

  const requireFinite = (field: keyof FactionConfig, min: number): void => {
    const value = config[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push({ id, field, reason: 'must be a finite number' });
    } else if (value < min) {
      problems.push({ id, field, reason: `must be at least ${min}` });
    }
  };

  if (config.id === undefined || !Object.values(FactionId).includes(config.id)) {
    problems.push({ id, field: 'id', reason: 'must be a known faction id' });
  }
  if (typeof config.nameKey !== 'string' || config.nameKey.length === 0) {
    problems.push({ id, field: 'nameKey', reason: 'must be a non-empty translation key' });
  }

  requireFinite('startingCattle', 0);
  requireFinite('startingGrain', 0);
  requireFinite('startingAmmunition', 0);
  requireFinite('upkeepMultiplier', 0.01);
  requireFinite('herdGrowthMultiplier', 0);
  requireFinite('herdingSkill', 0.01);
  requireFinite('lineMovementClass', 0);

  return problems;
}

export function validateAllFactions(): FactionProblem[] {
  return Object.values(FACTIONS).flatMap((config) => validateFaction(config));
}
