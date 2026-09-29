import { describe, expect, it } from 'vitest';
import { summariseSelection, type RoleTally } from '../src/ui/selectionSummary.js';

/**
 * What is selected, and what it is doing.
 *
 * The panel said "12 units" and nothing else, so a player who had just dragged a box
 * over half their village could not tell whether they had picked up the people holding
 * the cattle, the people standing in the fields, or a crowd of idlers — which is the
 * only question worth asking before giving an order.
 *
 * `src/sim/roles.ts` has computed that answer since it landed and it crosses in the
 * snapshot's flags nibble. Nothing read it but the sprite chooser.
 */

/** Roles as roles.ts numbers them: none, herder, field hand, carrier, elder. */
const NONE = 0;
const HERDER = 1;
const FIELD = 2;
const CARRIER = 3;
const ELDER = 4;

describe('summariseSelection', () => {
  it('counts nothing as nothing', () => {
    expect(summariseSelection([])).toEqual({ total: 0, tallies: [] });
  });

  it('counts a single role', () => {
    const summary = summariseSelection([HERDER, HERDER, HERDER]);
    expect(summary.total).toBe(3);
    expect(summary.tallies).toEqual([{ role: HERDER, count: 3 }]);
  });

  it('orders by how many there are, commonest first', () => {
    // The player reads the first line and stops. It has to be the one that describes
    // the selection.
    const summary = summariseSelection([FIELD, HERDER, FIELD, HERDER, FIELD]);
    expect(summary.tallies).toEqual([
      { role: FIELD, count: 3 },
      { role: HERDER, count: 2 },
    ]);
  });

  it('breaks a tie on the role, not on the order they happened to arrive', () => {
    // Two roles with the same count must always come out the same way round, or the
    // line rewrites itself as units wander in and out of a field.
    const a = summariseSelection([ELDER, HERDER]);
    const b = summariseSelection([HERDER, ELDER]);
    expect(a.tallies).toEqual(b.tallies);
    expect(a.tallies[0]?.role).toBe(HERDER);
  });

  it('puts the idle last however many of them there are', () => {
    // "Nothing in particular" is the least informative thing that can be said about a
    // selection, so it never takes the line the player actually reads — even when it
    // is the biggest group, which it usually is.
    const summary = summariseSelection([NONE, NONE, NONE, NONE, CARRIER]);
    expect(summary.total).toBe(5);
    expect(summary.tallies[0]).toEqual({ role: CARRIER, count: 1 });
    expect(summary.tallies[1]).toEqual({ role: NONE, count: 4 });
  });

  it('ignores a role it does not know', () => {
    // The nibble has room for sixteen and ten are used. A snapshot from a newer build
    // should leave the panel saying less, not crash it.
    const summary = summariseSelection([HERDER, 12, 15]);
    expect(summary.total).toBe(3);
    expect(summary.tallies).toEqual([{ role: HERDER, count: 1 }]);
  });
});

describe('RoleTally', () => {
  it('is a plain record, so the panel can key its strings off the role', () => {
    const tally: RoleTally = { role: HERDER, count: 2 };
    expect(tally.role).toBe(HERDER);
  });
});
