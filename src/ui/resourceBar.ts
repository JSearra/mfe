import { t, type MessageKey } from '../core/i18n/index.js';
import { Season, seasonOf } from '../shared/calendar.js';
import type { PlayerState } from '../host/directHost.js';

/**
 * The player's standing: herd, granary, powder, and what the season is doing.
 *
 * DOM rather than Pixi text, like the rest of the HUD — see ARCHITECTURE section 10.
 * Every string goes through t(); the lint rule in eslint.config.js refuses literals
 * assigned to textContent in this directory.
 */

export interface ResourceBar {
  readonly element: HTMLElement;
  update(player: PlayerState): void;
}

const UPDATE_INTERVAL_MS = 250;

/** Season -> its name. Indexed by the enum, so a new season is a compile error here. */
const SEASON_KEYS: Readonly<Record<Season, MessageKey>> = {
  [Season.Rains]: 'season.rains',
  [Season.Drying]: 'season.drying',
  [Season.Dry]: 'season.dry',
  [Season.GreatDry]: 'season.greatDry',
};

/** Trend -1, 0, 1 offset by one, so the array index is the trend plus one. */
const TREND_KEYS: readonly MessageKey[] = ['season.easing', 'season.steady', 'season.drier'];

export function createResourceBar(parent: HTMLElement): ResourceBar {
  const element = document.createElement('div');
  element.className = 'resource-bar';

  const totals = document.createElement('span');
  const season = document.createElement('span');
  season.className = 'resource-bar__season';
  const herd = document.createElement('span');
  herd.className = 'resource-bar__herd';

  // What the season cost against what it brought in. Sits beside the totals rather than
  // in the panel because it is the number that decides whether to raise another
  // household, and that decision is taken while looking at the map.
  const margin = document.createElement('span');
  margin.className = 'resource-bar__margin';

  // Cattle under hand, which is not the same as cattle on the ledger. Shown only while
  // there are any: taking a herd had no feedback at all outside the debug overlay.
  const driving = document.createElement('span');
  driving.className = 'resource-bar__driving';

  const warning = document.createElement('span');
  warning.className = 'resource-bar__warning';

  element.append(totals, season, margin, driving, herd, warning);
  parent.appendChild(element);

  let lastUpdate = -Infinity;

  return {
    element,
    update(player: PlayerState): void {
      const now = performance.now();
      if (now - lastUpdate < UPDATE_INTERVAL_MS) return;
      lastUpdate = now;

      totals.textContent = t('resource.bar', {
        cattle: Math.floor(player.cattle),
        grain: Math.floor(player.grain),
        wood: Math.floor(player.wood),
      });

      /*
       * The year, the season and which way it is going.
       *
       * `Drought 41%` was the whole of what the HUD said about a ten-minute year, and a
       * percentage on its own answers none of the questions a village actually has:
       * where in the year this is, whether the number is on its way up or down, and
       * whether it has reached the point where the open veld stops paying. A village
       * that plants is betting on the next few months and could not see them.
       *
       * The trend is the actionable half. Knowing it is dry says whether to worry;
       * knowing it is still drying says whether to act now or wait.
       */
      const pct = Math.round(player.drought * 100);
      season.textContent = t('season.line', {
        year: player.year,
        season: t(SEASON_KEYS[seasonOf(player.drought)]),
        trend: t(TREND_KEYS[player.droughtTrend + 1]!),
        pct,
      });
      season.classList.toggle('is-severe', player.droughtSevere);

      // The victory track, always visible. A win condition the player cannot see the
      // progress of is one they cannot play toward.
      const standing = Math.floor(player.households);
      herd.textContent =
        player.holdProgress > 0
          ? t('victory.holding', {
              held: standing,
              needed: player.householdsToSettle,
              pct: Math.round(player.holdProgress * 100),
            })
          : t('victory.progress', { held: standing, needed: player.householdsToSettle });
      herd.classList.toggle('is-holding', player.holdProgress > 0);

      // Nothing until the first upkeep has actually been paid, or it reads as a deficit
      // the village does not have yet.
      if (player.upkeep > 0) {
        const net = player.harvest - player.upkeep;
        margin.textContent = t('resource.margin', {
          harvest: Math.round(player.harvest),
          upkeep: Math.round(player.upkeep),
          feeds: Math.round(player.feeds),
        });
        // Amber while the land cannot carry the village it is being asked for. That is
        // not an emergency — it is the standing reason to break more ground — so it is
        // a colour on a readout rather than an alert that interrupts.
        margin.classList.toggle(
          'is-negative',
          net < 0 || player.feeds < player.householdsToSettle,
        );
      } else {
        margin.textContent = '';
      }

      driving.textContent =
        player.driving > 0 ? t('resource.driving', { head: player.driving }) : '';

      warning.textContent =
        player.shortfall > 0 ? t('resource.starving', { amount: Math.ceil(player.shortfall) }) : '';
    },
  };
}
