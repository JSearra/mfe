/**
 * Researchable advances.
 *
 * Naming follows docs/CONTENT.md. Two of these use isiZulu terms that are well attested
 * — `amabutho`, the age-set regiments, and `umkhosi`, the first-fruits ceremony — and
 * they are not translated, only glossed. The rest use plain or Afrikaans-register names
 * rather than inventing isiZulu the project cannot vouch for, which is the same caution
 * CONTENT.md section 3 applies to `iklwa`: a term whose historicity is debated is not
 * improved by putting it in a tech tree.
 */

export const TechId = {
  Amabutho: 'amabutho',
  Umkhosi: 'umkhosi',
  ScoutingParties: 'scouting-parties',
  CattleLore: 'cattle-lore',
  MountedCommando: 'mounted-commando',
} as const;

export type TechId = (typeof TechId)[keyof typeof TechId];

/** What a completed advance multiplies. Every modifier defaults to 1. */
export const Modifier = {
  CombatDamage: 'combatDamage',
  VisionRadius: 'visionRadius',
  /** Below 1 means cattle are calmer near herders — a larger band to work in. */
  HerdStress: 'herdStress',
  MoveSpeed: 'moveSpeed',
  GrainYield: 'grainYield',
} as const;

export type Modifier = (typeof Modifier)[keyof typeof Modifier];

export interface TechSpec {
  readonly id: TechId;
  readonly nameKey: string;
  readonly grainCost: number;
  readonly cattleCost: number;
  /** Ticks of research once paid for. */
  readonly researchTicks: number;
  readonly requires: readonly TechId[];
  readonly effects: Readonly<Partial<Record<Modifier, number>>>;
}

export const TECHS: Readonly<Record<TechId, TechSpec>> = {
  [TechId.Amabutho]: {
    id: TechId.Amabutho,
    nameKey: 'tech.amabutho',
    grainCost: 180,
    cattleCost: 4,
    researchTicks: 900,
    requires: [],
    effects: { [Modifier.CombatDamage]: 1.25 },
  },
  [TechId.Umkhosi]: {
    id: TechId.Umkhosi,
    nameKey: 'tech.umkhosi',
    grainCost: 140,
    cattleCost: 2,
    researchTicks: 700,
    requires: [],
    effects: { [Modifier.GrainYield]: 1.3 },
  },
  [TechId.ScoutingParties]: {
    id: TechId.ScoutingParties,
    nameKey: 'tech.scoutingParties',
    grainCost: 120,
    cattleCost: 0,
    researchTicks: 600,
    requires: [],
    effects: { [Modifier.VisionRadius]: 1.3 },
  },
  [TechId.CattleLore]: {
    id: TechId.CattleLore,
    nameKey: 'tech.cattleLore',
    grainCost: 200,
    cattleCost: 6,
    researchTicks: 1000,
    requires: [TechId.Umkhosi],
    effects: { [Modifier.HerdStress]: 0.7 },
  },
  [TechId.MountedCommando]: {
    id: TechId.MountedCommando,
    nameKey: 'tech.mountedCommando',
    grainCost: 260,
    cattleCost: 8,
    researchTicks: 1200,
    requires: [TechId.Amabutho],
    effects: { [Modifier.MoveSpeed]: 1.2, [Modifier.CombatDamage]: 1.1 },
  },
};

export const TECH_IDS: readonly TechId[] = Object.values(TechId);

export interface TechProblem {
  readonly id: string;
  readonly reason: string;
}

/**
 * Validate the tree.
 *
 * Catches the two mistakes a tech tree actually makes: a prerequisite that does not
 * exist, and a cycle — where A needs B and B needs A, so neither is ever researchable
 * and nothing says so.
 */
export function validateTechTree(): TechProblem[] {
  const problems: TechProblem[] = [];

  for (const spec of Object.values(TECHS)) {
    for (const requirement of spec.requires) {
      if (!(requirement in TECHS)) {
        problems.push({ id: spec.id, reason: `requires unknown tech "${requirement}"` });
      }
    }
    if (Object.keys(spec.effects).length === 0) {
      problems.push({ id: spec.id, reason: 'has no effect' });
    }
  }

  // Depth-first cycle detection.
  const state = new Map<string, number>();
  const visit = (id: TechId): boolean => {
    const mark = state.get(id) ?? 0;
    if (mark === 1) return true;
    if (mark === 2) return false;
    state.set(id, 1);
    for (const requirement of TECHS[id]?.requires ?? []) {
      if (requirement in TECHS && visit(requirement)) return true;
    }
    state.set(id, 2);
    return false;
  };

  for (const id of TECH_IDS) {
    if (visit(id)) problems.push({ id, reason: 'is part of a prerequisite cycle' });
  }
  return problems;
}
