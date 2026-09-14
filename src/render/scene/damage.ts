import { EventType, type SimEvent } from '../../shared/events.js';

/**
 * Which entities were struck recently, so the renderer can show it.
 *
 * Combat was audible and invisible: `hpPct` crossed the boundary in every snapshot and
 * was interpolated on arrival, and then nothing ever drew it. A player could hear a blow
 * land and had no way to see who was hurt, who was winning, or which of two engagements
 * to reinforce.
 *
 * Driven by the event stream rather than by diffing snapshots, for the reason the event
 * stream exists: a blow that lands and leaves a unit alive is a thing that HAPPENED, and
 * a state diff shows only that a number moved — while a blow that kills removes the
 * entity from the next snapshot entirely, so the diff shows nothing at all.
 */

/** How long a struck unit stays lit. Long enough to see, short enough not to smear. */
const FLASH_MS = 180;

export interface DamageFlashes {
  handle(events: readonly SimEvent[], now: number): void;
  /** True while this entity should be drawn as having just been hit. */
  isFlashing(handle: number, now: number): boolean;
  /** Drop expired entries. Called once a frame so the map cannot grow without bound. */
  expire(now: number): void;
}

export function createDamageFlashes(): DamageFlashes {
  const struck = new Map<number, number>();

  return {
    handle(events, now): void {
      for (const event of events) {
        if (event.type !== EventType.Hit && event.type !== EventType.Crushed) continue;
        struck.set(event.handle, now);
      }
    },

    isFlashing(handle, now): boolean {
      const at = struck.get(handle);
      return at !== undefined && now - at < FLASH_MS;
    },

    expire(now): void {
      for (const [handle, at] of struck) {
        if (now - at >= FLASH_MS) struck.delete(handle);
      }
    },
  };
}
