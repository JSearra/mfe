import type { BuildingSpec } from '../shared/buildings/index.js';
import type { TechSpec } from '../shared/tech/index.js';

/**
 * Why an action cannot be taken.
 *
 * `tasks/plan.md` section F has recorded since September that "the command panel offers
 * actions that silently fail": Train on an unfinished building, and buildings or techs
 * the village cannot afford. The click did nothing and said nothing, which is worse
 * than not offering the action — a player cannot tell a broken game from a rule they
 * have not learned yet, and will assume the first.
 *
 * Pure, and separated from the panel, because the interesting part of it is not the
 * rendering. It is the ORDER: a village short of two things has to be told about the
 * one it is shortest of, or the message changes as it earns half of what it needs and
 * reads as noise. Every ordering decision below is a judgement about what a player
 * would do next if they believed the message.
 *
 * This is a HINT and not the authority. The simulation refuses what it refuses; this
 * only says so in advance, and it may be a few hundred milliseconds stale, like
 * everything else the renderer knows. A refusal it gets wrong costs a greyed button,
 * not a wrong outcome.
 */

export const Refusal = {
  None: 0,
  Grain: 1,
  Wood: 2,
  Cattle: 3,
  /** A weir with nowhere to stand. Answered by walking, not by waiting. */
  NeedsWater: 4,
  /** Training ordered on a site that is still bare ground. */
  Unfinished: 5,
  QueueFull: 6,
  AlreadyKnown: 7,
  InProgress: 8,
} as const;

export type Refusal = (typeof Refusal)[keyof typeof Refusal];

export interface Purse {
  readonly grain: number;
  readonly wood: number;
  readonly cattle: number;
}

/**
 * Which shortage is holding the village up, as a fraction of what is needed.
 *
 * Measured as a SHORTFALL RATIO rather than as an absolute gap, because the three
 * resources are not on one scale: two cattle and ninety grain are both a umuzi's price,
 * and comparing 2 against 90 would answer "grain" every time whatever the village
 * actually had. The ratio asks the only question worth asking — which of these is the
 * village furthest from — and it holds its answer steady while the smaller gap closes,
 * so the message does not flicker between two shortages.
 */
function scarcest(purse: Purse, grain: number, wood: number, cattle: number): Refusal {
  const gaps: readonly (readonly [Refusal, number])[] = [
    [Refusal.Grain, grain > 0 ? (grain - purse.grain) / grain : 0],
    [Refusal.Wood, wood > 0 ? (wood - purse.wood) / wood : 0],
    [Refusal.Cattle, cattle > 0 ? (cattle - purse.cattle) / cattle : 0],
  ];

  let worst: Refusal = Refusal.None;
  let deepest = 0;
  for (const [refusal, gap] of gaps) {
    // Strictly greater, so a tie keeps the earlier entry and the answer does not depend
    // on the order this array happens to be written in.
    if (gap > deepest) {
      deepest = gap;
      worst = refusal;
    }
  }
  return worst;
}

/** Why this building cannot be put up, or `None`. */
export function buildAvailability(spec: BuildingSpec, purse: Purse): Refusal {
  // Ahead of the price, because it is the one refusal a player answers by walking
  // somewhere else rather than by waiting. Telling someone to save up for a weir they
  // are standing in the wrong country for is the wrong advice, however true it is.
  if (spec.needsWater) return Refusal.NeedsWater;
  return scarcest(purse, spec.grainCost, spec.woodCost, spec.cattleCost);
}

/** Why this tech cannot be begun, or `None`. */
export function researchAvailability(
  spec: TechSpec,
  purse: Purse,
  known: boolean,
  inProgress: boolean,
): Refusal {
  // "You already have this" is true whatever the granary says, and a player told to
  // save up for something they own would go away and do it.
  if (known) return Refusal.AlreadyKnown;
  if (inProgress) return Refusal.InProgress;
  return scarcest(purse, spec.grainCost, 0, spec.cattleCost);
}

/** Why a soldier cannot be raised here, or `None`. */
export function trainAvailability(
  purse: Purse,
  finished: boolean,
  queued: number,
  queueLimit: number,
  cost: { readonly grain: number; readonly cattle: number },
): Refusal {
  // The refusal the plan named first, and the one with the clearest answer: a site is
  // not a homestead, and the thing to do about it is go and build it.
  if (!finished) return Refusal.Unfinished;
  if (queued >= queueLimit) return Refusal.QueueFull;
  return scarcest(purse, cost.grain, 0, cost.cattle);
}
