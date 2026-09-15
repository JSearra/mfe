import { EventType, type SimEvent } from '../shared/events.js';
import { worldToScreenX, worldToScreenY } from '../shared/iso.js';
import type { Camera } from '../render/camera.js';
import { t, type MessageKey } from '../core/i18n/index.js';

/**
 * Things that happened somewhere you were not looking, and a way to go there.
 *
 * Found by running Gate 2: driving the herd from your own units sent it off the edge of
 * the screen, and twice partly behind the minimap panel. A stampede you cannot see is one
 * you cannot aim, which bears directly on the question Gate 1 left open about whether a
 * stampede can be aimed precisely rather than merely pointed away from you.
 *
 * The camera is NOT moved automatically. Having the view yanked away mid-order is worse
 * than missing the event — the player may be doing something deliberate elsewhere, and a
 * stampede is most likely to fire exactly when they are busy. This is the affordance the
 * genre settled on instead: say that it happened, say roughly where, and make going there
 * one key.
 */

/** How long an alert stays worth jumping to. */
const LIFETIME_MS = 12_000;

interface Alert {
  readonly type: number;
  readonly worldX: number;
  readonly worldY: number;
  readonly at: number;
}

export interface Alerts {
  readonly element: HTMLElement;
  /**
   * Collect alerts from a tick's events.
   *
   * `viewer` is needed because the event stream is global: relief between two other
   * villages is not this village's news, and announcing it would tell the player about
   * books they cannot see.
   */
  handle(events: readonly SimEvent[], now: number, viewer: number): void;
  /** Centre the camera on the most recent live alert. True if there was one. */
  jump(camera: Camera, now: number): boolean;
  update(now: number): void;
}

/** Which events are worth interrupting for, and the string that names them. */
const WATCHED: Readonly<Record<number, MessageKey>> = {
  [EventType.StampedeBegan]: 'alert.stampede',
  [EventType.BuildingCompleted]: 'alert.buildingComplete',
  [EventType.TechCompleted]: 'alert.research',
  // The only thing left that kills anybody (Phase V6), so it is worth interrupting for.
  // It has a real position — the unit going hungry — so the camera can be sent to it.
  [EventType.Starved]: 'alert.starving',
  [EventType.AllianceRelief]: 'alert.relief',
};

/**
 * Alerts that did not happen anywhere.
 *
 * An ally sending grain is worth saying out loud — it is the one occasion a standing tie
 * pays out, and the alternative is a number in the granary that moved for no visible
 * reason. It has no position, though: its `x`/`y` carry the two villages. Jumping the
 * camera to them would fly it to the corner of the map, so it is announced and not
 * followed. See src/sim/alliance.ts.
 */
const PLACELESS: ReadonlySet<number> = new Set([EventType.AllianceRelief]);

export function createAlerts(): Alerts {
  const element = document.createElement('div');
  element.className = 'alerts';

  const live: Alert[] = [];

  const alerts: Alerts = {
    element,

    handle(events, now, viewer): void {
      for (const event of events) {
        const key = WATCHED[event.type];
        if (key === undefined) continue;
        // Relief carries the two villages in x/y. Only the one receiving it is being
        // told something; the giver already knows, and third parties are not owed it.
        if (event.type === EventType.AllianceRelief && event.y !== viewer) continue;
        // One alert per burst. A herd going over produces a StampedeBegan for every
        // beast in it, and twenty identical lines is not a notification, it is noise.
        const last = live[live.length - 1];
        if (last !== undefined && last.type === event.type && now - last.at < 1500) continue;
        live.push({ type: event.type, worldX: event.x, worldY: event.y, at: now });
      }
    },

    jump(camera, now): boolean {
      for (let i = live.length - 1; i >= 0; i--) {
        const alert = live[i]!;
        if (now - alert.at > LIFETIME_MS) break;
        if (PLACELESS.has(alert.type)) continue;
        camera.x = worldToScreenX(alert.worldX, alert.worldY);
        camera.y = worldToScreenY(alert.worldX, alert.worldY, 0);
        return true;
      }
      return false;
    },

    update(now): void {
      while (live.length > 0 && now - live[0]!.at > LIFETIME_MS) live.shift();

      const newest = live[live.length - 1];
      if (newest === undefined) {
        element.textContent = '';
        element.hidden = true;
        return;
      }
      element.hidden = false;
      element.textContent = PLACELESS.has(newest.type)
        ? t(WATCHED[newest.type]!)
        : `${t(WATCHED[newest.type]!)} — ${t('alert.jump')}`;
    },
  };

  return alerts;
}
