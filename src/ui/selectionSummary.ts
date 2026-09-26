/**
 * What is selected, and what it is doing.
 *
 * The panel said "12 units" and nothing more, so a player who had just dragged a box
 * over half their village could not tell whether they had picked up the people holding
 * the cattle, the people standing in the fields, or a crowd of idlers. That is the only
 * question worth asking before giving an order, and it was the one thing the selection
 * would not answer.
 *
 * `src/sim/roles.ts` has computed the answer since it landed — it rides in the high
 * nibble of `world.flags` and crosses in the snapshot — and until now the only thing
 * that read it was the sprite chooser. The picture knew; the words did not.
 *
 * Pure, so the ordering can be tested. The ordering is the whole of the design here.
 */

/** Roles as `src/sim/roles.ts` numbers them. Repeated because `src/ui` may not import it. */
export const SummaryRole = {
  None: 0,
  Herder: 1,
  FieldHand: 2,
  Carrier: 3,
  Elder: 4,
  Hunter: 5,
  Injured: 6,
  WaterCarrier: 7,
} as const;

export type SummaryRole = (typeof SummaryRole)[keyof typeof SummaryRole];

const KNOWN: readonly SummaryRole[] = [
  SummaryRole.None,
  SummaryRole.Herder,
  SummaryRole.FieldHand,
  SummaryRole.Carrier,
  SummaryRole.Elder,
  SummaryRole.Hunter,
  SummaryRole.Injured,
  SummaryRole.WaterCarrier,
];

export interface RoleTally {
  readonly role: SummaryRole;
  readonly count: number;
}

export interface SelectionSummary {
  readonly total: number;
  /** Commonest first, with the idle always last. */
  readonly tallies: readonly RoleTally[];
}

/**
 * Tally a selection's roles.
 *
 * Three ordering rules, and each of them is about what a player reads rather than about
 * what is easy to compute:
 *
 *  - Commonest first, because the player reads the first line and stops.
 *  - Ties break on the ROLE, never on the order the units arrived in. Two roles with
 *    the same count must always come out the same way round, or the line rewrites
 *    itself as people wander in and out of a field and the panel looks like it is
 *    flickering rather than reporting.
 *  - The idle go last however many of them there are, which is usually most of them.
 *    "Nothing in particular" is the least informative thing that can be said about a
 *    selection and it must not take the line the player actually reads.
 *
 * An unknown role is dropped rather than shown. The nibble holds sixteen and five are
 * used; a snapshot from a newer build should make this panel say less, not break it.
 */
export function summariseSelection(roles: readonly number[]): SelectionSummary {
  const counts = new Map<SummaryRole, number>();

  for (const role of roles) {
    if (!KNOWN.includes(role as SummaryRole)) continue;
    const known = role as SummaryRole;
    counts.set(known, (counts.get(known) ?? 0) + 1);
  }

  const tallies: RoleTally[] = [...counts].map(([role, count]) => ({ role, count }));
  tallies.sort((a, b) => {
    const aIdle = a.role === SummaryRole.None ? 1 : 0;
    const bIdle = b.role === SummaryRole.None ? 1 : 0;
    if (aIdle !== bIdle) return aIdle - bIdle;
    if (a.count !== b.count) return b.count - a.count;
    return a.role - b.role;
  });

  return { total: roles.length, tallies };
}
