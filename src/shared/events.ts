/**
 * The second channel across the boundary.
 *
 * State snapshots cannot express events. An entity that dies simply vanishes from the
 * next snapshot, with no signal to play a death animation; anything that happens and
 * reverts inside one tick is invisible entirely. So discrete occurrences travel
 * alongside the state, and audio, VFX and floating combat text all read from here.
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
  Hit: 6,
  Died: 7,
  BuildingPlaced: 8,
  BuildingCompleted: 9,
  TechCompleted: 10,
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
