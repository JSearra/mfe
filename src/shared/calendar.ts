/**
 * The year, said out loud.
 *
 * The economy has been seasonal since Phase 6 and the only thing on screen about it was
 * `Drought 0%`: a percentage, with no sense of where in the year it sat or which way it
 * was going. A village that plants a field is making a bet on the next few months, and
 * it could not see them.
 *
 * **The season is derived from the drought, not from a calendar of its own.** A second
 * clock running beside the one that actually drives the harvest would be two things to
 * keep in step and one of them a fiction — and it would let the HUD say "the rains"
 * through a year in which nothing grew. What the player is told here is what the
 * simulation is doing.
 *
 * Lives in shared because both sides need it and neither owns it: the host names the
 * season when it builds a player's state, and the HUD reads the name. It takes
 * `seasonTicks` as an argument rather than importing the tuning file, so the boundary
 * rules stay simple and nothing here has to know which side of them it is on.
 */

export const Season = {
  /** Wet. Ground breaks easily and a field put in now has the whole year ahead of it. */
  Rains: 0,
  /** Drying. Still yielding, and the last comfortable moment to commit to anything. */
  Drying: 1,
  /** Dry. The open veld is well down; sheltered ground and the fold are carrying. */
  Dry: 2,
  /**
   * The great dry.
   *
   * Named at `tuning.economy.droughtThreshold`, which is where this project has always
   * called a drought severe and where the resource bar already turns amber. One opinion
   * about when a year has gone wrong, not two.
   */
  GreatDry: 3,
} as const;

export type Season = (typeof Season)[keyof typeof Season];

/**
 * Where the season boundaries sit on the drought scale.
 *
 * The top one is `droughtThreshold` from the tuning file, repeated here as a number
 * because this file may not import it — a test pins the two together so they cannot
 * drift apart silently.
 */
export const SEASON_AT = [0.25, 0.5, 0.75] as const;

/** Whole years elapsed. */
export function yearOf(tick: number, seasonTicks: number): number {
  return Math.floor(tick / seasonTicks);
}

/** Which season a given drought reading is. */
export function seasonOf(drought: number): Season {
  if (drought < SEASON_AT[0]) return Season.Rains;
  if (drought < SEASON_AT[1]) return Season.Drying;
  if (drought < SEASON_AT[2]) return Season.Dry;
  return Season.GreatDry;
}

/**
 * Which way the year is going: 1 drying, -1 easing, 0 steady.
 *
 * The half of this that is actually actionable. Knowing it is dry says whether to worry;
 * knowing it is still drying says whether to act now or wait, and those are different
 * decisions. Compared against a small threshold so the turn of the curve does not
 * flicker between the two at its peak and its trough.
 */
export function trendOf(now: number, soon: number): -1 | 0 | 1 {
  const change = soon - now;
  if (change > 0.002) return 1;
  if (change < -0.002) return -1;
  return 0;
}
