import { t, type MessageKey } from '../core/i18n/index.js';
import { Season, seasonOf } from '../shared/calendar.js';
import type { PlayerState } from '../host/directHost.js';
import { Resource } from '../shared/resources.js';

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

/**
 * The stores on the bar, in the order a village thinks about them: its wealth, its two
 * foods, what it builds with, what it trades.
 *
 * `always` for the ones a player needs to see at nought — food and timber are things to
 * go and get. Skins and ivory appear once there are any: a bar that listed every good
 * the village could ever hold would be a sentence nobody reads, and ADR-0022 says more
 * are coming.
 */
const SHOWN: readonly { readonly resource: Resource; readonly key: MessageKey; readonly always: boolean }[] = [
  { resource: Resource.Cattle, key: 'resource.amount.cattle', always: true },
  { resource: Resource.Grain, key: 'resource.amount.grain', always: true },
  { resource: Resource.Meat, key: 'resource.amount.meat', always: true },
  { resource: Resource.Wood, key: 'resource.amount.wood', always: true },
  { resource: Resource.Water, key: 'resource.amount.water', always: true },
  { resource: Resource.Skins, key: 'resource.amount.skins', always: false },
  { resource: Resource.Ivory, key: 'resource.amount.ivory', always: false },
];

/** Season -> its name. Indexed by the enum, so a new season is a compile error here. */
const SEASON_KEYS: Readonly<Record<Season, MessageKey>> = {
  [Season.Rains]: 'season.rains',
  [Season.Drying]: 'season.drying',
  [Season.Dry]: 'season.dry',
  [Season.GreatDry]: 'season.greatDry',
};

/** Trend -1, 0, 1 offset by one, so the array index is the trend plus one. */
const TREND_KEYS: readonly MessageKey[] = ['season.easing', 'season.steady', 'season.drier'];

export interface ResourceBarHandlers {
  /** Select the village's idle people and bring them into view. */
  onSelectIdle(): void;
}

export function createResourceBar(parent: HTMLElement, handlers: ResourceBarHandlers): ResourceBar {
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

  // Who is free, and whether the village is stretched. Work finds its own people now
  // (Phase B2), so the question is no longer who to send but whether anybody is spare —
  // which is what decides between breaking another field and raising another household.
  const work = document.createElement('span');
  work.className = 'resource-bar__work';
  // The idle count is also the way to them, the same as the idle line in the command
  // bar: a number of people standing about is a number a player wants to act on. Only
  // while it says idle — "hands short" has nobody behind it to select.
  let idleClickable = false;
  work.addEventListener('click', () => {
    if (idleClickable) handlers.onSelectIdle();
  });
  work.addEventListener('keydown', (event) => {
    if (!idleClickable || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    handlers.onSelectIdle();
  });

  const warning = document.createElement('span');
  warning.className = 'resource-bar__warning';

  // What each readout means, on the same slow tooltip as the buttons. The bar is where
  // the game's vocabulary is densest — harvest, upkeep, "land feeds" — and it explained
  // none of it.
  totals.dataset.tip = t('tip.totals');
  season.dataset.tip = t('tip.season');
  margin.dataset.tip = t('tip.margin');
  herd.dataset.tip = t('tip.households');
  work.dataset.tip = t('tip.work');
  driving.dataset.tip = t('tip.driving');
  warning.dataset.tip = t('tip.starving');

  element.append(totals, season, margin, driving, herd, work, warning);
  parent.appendChild(element);

  let lastUpdate = -Infinity;

  return {
    element,
    update(player: PlayerState): void {
      const now = performance.now();
      if (now - lastUpdate < UPDATE_INTERVAL_MS) return;
      lastUpdate = now;

      const parts: string[] = [];
      for (const shown of SHOWN) {
        const held = Math.floor(player.stores[shown.resource] ?? 0);
        if (held > 0 || shown.always) parts.push(t(shown.key, { n: held }));
      }
      totals.textContent = parts.join(' · ');

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

      // A count, not a track. There is no target to reach (ADR-0020); how big the
      // village is matters only against what its land can feed, which is the next line.
      herd.textContent = t('village.households', { count: Math.floor(player.households) });

      // Nothing until the first upkeep has actually been paid, or it reads as a deficit
      // the village does not have yet.
      if (player.upkeep > 0) {
        const net = player.harvest - player.upkeep;
        margin.textContent = t('resource.margin', {
          harvest: Math.round(player.harvest),
          upkeep: Math.round(player.upkeep),
          feeds: Math.round(player.feeds),
        });
        // Amber while the land cannot carry the village standing on it. That is not an
        // emergency yet — it is the standing reason to break more ground before raising
        // anyone else — so it is a colour on a readout rather than an alert.
        margin.classList.toggle('is-negative', net < 0 || player.feeds < player.households);
      } else {
        margin.textContent = '';
      }

      // Short outranks idle: a village with work waiting has no spare hands however many
      // are standing about on their way somewhere.
      work.textContent =
        player.handsShort > 0
          ? t('labour.short', { count: Math.round(player.handsShort) })
          : t('labour.idle', { count: player.idle });
      work.classList.toggle('is-negative', player.handsShort > 0);
      const clickable = player.handsShort <= 0 && player.idle > 0;
      if (clickable !== idleClickable) {
        idleClickable = clickable;
        work.classList.toggle('is-action', clickable);
        if (clickable) {
          work.setAttribute('role', 'button');
          work.tabIndex = 0;
        } else {
          work.removeAttribute('role');
          work.removeAttribute('tabindex');
        }
        work.dataset.tip = clickable ? `${t('tip.work')}\n${t('labour.idleHint')}` : t('tip.work');
      }

      driving.textContent =
        player.driving > 0 ? t('resource.driving', { head: player.driving }) : '';

      // Hunger outranks thirst: one hurts people and the other only slows them.
      warning.textContent =
        player.shortfall > 0
          ? t('resource.starving', { amount: Math.ceil(player.shortfall) })
          : player.thirst > 0.01
            ? t('resource.thirsty', { pct: Math.round(player.thirst * 100) })
            : '';
    },
  };
}
