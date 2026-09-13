import { t } from '../core/i18n/index.js';
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

export function createResourceBar(parent: HTMLElement): ResourceBar {
  const element = document.createElement('div');
  element.className = 'resource-bar';

  const totals = document.createElement('span');
  const season = document.createElement('span');
  season.className = 'resource-bar__season';
  const herd = document.createElement('span');
  herd.className = 'resource-bar__herd';

  const warning = document.createElement('span');
  warning.className = 'resource-bar__warning';

  element.append(totals, season, herd, warning);
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
        ammunition: Math.floor(player.ammunition),
      });

      const pct = Math.round(player.drought * 100);
      season.textContent = player.droughtSevere
        ? t('resource.droughtSevere', { pct })
        : t('resource.drought', { pct });
      season.classList.toggle('is-severe', player.droughtSevere);

      // The victory track, always visible. A win condition the player cannot see the
      // progress of is one they cannot play toward.
      const held = Math.floor(player.cattleHeld);
      herd.textContent =
        player.holdProgress > 0
          ? t('victory.holding', {
              held,
              needed: player.cattleToWin,
              pct: Math.round(player.holdProgress * 100),
            })
          : t('victory.progress', { held, needed: player.cattleToWin });
      herd.classList.toggle('is-holding', player.holdProgress > 0);

      warning.textContent =
        player.shortfall > 0 ? t('resource.starving', { amount: Math.ceil(player.shortfall) }) : '';
    },
  };
}
