import { EventType, type SimEvent } from '../../shared/events.js';

/**
 * Which entities were struck recently, so the renderer can show it.
 *
 * Built for combat, kept for the stampede. A blow landing was once audible and
 * invisible; with combat retired (Phase V6) the one thing left that strikes a body is a
 * herd going over it, and being trampled is exactly the event a player needs to see
 * rather than merely hear. ADR-0014 and ADR-0017 are not superseded: the stampede stays.
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
        if (event.type !== EventType.Crushed) continue;
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
