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
  VictoryDeclared: 12,
  PlayerEliminated: 13,
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
