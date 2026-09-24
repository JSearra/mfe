/**
 * The second channel across the boundary.
 *
 * State snapshots cannot express events. An entity that dies simply vanishes from the
 * next snapshot, with no signal to play a death animation; anything that happens and
 * reverts inside one tick is invisible entirely. So discrete occurrences travel
 * alongside the state, and audio, VFX and the alert bar all read from here.
 *
 * See docs/ARCHITECTURE.md section 5.
 */

export const EventType = {
  Spawned: 0,
  Destroyed: 1,
  OrderIssued: 2,
  StampedeBegan: 3,
  Crushed: 4,
  Starved: 5,
  /**
   * 6 was `Hit`, the only combat-only event. Retired with combat in Phase V6 and left
   * as a gap rather than renumbered: event values cross the worker boundary and sit in
   * recorded command logs, so reusing one would make an old log decode as nonsense
   * instead of failing.
   */
  /** Not combat-only, and never was: starvation and stampede crush both end here. */
  Died: 7,
  BuildingPlaced: 8,
  BuildingCompleted: 9,
  TechCompleted: 10,
  UnitTrained: 11,
  /*
   * 12 was `VictoryDeclared`. Retired with the win condition (ADR-0020) and left as a
   * gap for the same reason as 6.
   */
  /**
   * A village has had nobody in it for the whole grace period. Was `PlayerEliminated`,
   * with the same value: the event is the same, but it no longer ends anything.
   */
  VillageEmptied: 13,
  /** A neighbour agreed a trade. `value` carries what came back. */
  Traded: 14,
  /** A neighbour said no. Worth telling the player, who cannot see their books. */
  TradeRefused: 15,
  /** A standing tie was made. `x` is the proposer, `y` the neighbour. */
  AllianceFormed: 16,
  /** A neighbour would not have you. `x` is the proposer, `y` the neighbour. */
  AllianceRefused: 17,
  /** Somebody walked away. `x` is who broke it, `y` who was left. */
  AllianceBroken: 18,
  /**
   * An ally sent grain to one who went short. `x` gave, `y` received, `payload` is how
   * much — the one occasion an alliance pays out, so it is worth saying out loud.
   */
  AllianceRelief: 19,
  /**
   * A neighbour has asked for a tie and is waiting on an answer. `x` asked, `y` is being
   * asked. A tie costs cattle every season, so being asked is news the player must see —
   * it used to just happen to them.
   */
  AllianceOffered: 20,
  /** Cattle slaughtered for the meat. `x` is the village, `payload` the head taken. */
  Culled: 21,
  /**
   * This village's fields are losing condition faster than anyone is tending them.
   *
   * `x`/`y` are the worst field, so the alert can be jumped to, and `payload` is the
   * village. The single most important thing the game failed to say: fields decay every
   * season nobody stands on them, and three playthroughs died of it without a word on
   * screen.
   */
  FieldsFailing: 22,
  /*
   * 23 was `NeighbourSettling`, the warning that a rival was close to winning. Retired
   * with the win condition (ADR-0020) and left as a gap.
   */
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export interface SimEvent {
  readonly tick: number;
  readonly type: EventType;
  readonly handle: number;
  readonly x: number;
  readonly y: number;
  readonly payload: number;
}

export function makeEvent(
  tick: number,
  type: EventType,
  handle: number,
  x = 0,
  y = 0,
  payload = 0,
): SimEvent {
  return { tick, type, handle, x, y, payload };
}
