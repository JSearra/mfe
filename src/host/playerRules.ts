import { MovementClass } from '../sim/pathing/costs.js';
import { trainingCost } from '../sim/production.js';
import { TECH_IDS } from '../shared/tech/index.js';
import type { TechState } from '../sim/tech.js';

/**
 * Rules the HUD needs to know but may not go and read.
 *
 * `src/ui` cannot import tuning or the simulation, so anything the panel needs in order
 * to say WHY an action is unavailable has to cross the boundary as data. `cullHead`
 * established the pattern and the reason: what a thing costs is a rule, and the renderer
 * is not allowed to know rules, only to be told them.
 *
 * Shared between the two hosts rather than written twice. The direct host and the worker
 * build the same PlayerState and had already drifted in smaller ways; a helper each
 * would have been a third.
 */

/**
 * What each movement class costs to raise, by index.
 *
 * Built once: it is a constant of the rules, and the panel wants it every time it draws
 * a homestead's actions.
 */
export const TRAIN_COSTS: readonly { readonly grain: number; readonly cattle: number }[] = [
  trainingCost(MovementClass.Infantry),
  trainingCost(MovementClass.Mounted),
];

/** One player's row of the tech table, as plain numbers: 0 unknown, 1 learning, 2 known. */
export function techStatusFor(tech: TechState, player: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < TECH_IDS.length; i++) {
    out.push(tech.status[player * TECH_IDS.length + i] ?? 0);
  }
  return out;
}
