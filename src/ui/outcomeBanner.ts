import { t } from '../core/i18n/index.js';
import type { PlayerState } from '../host/directHost.js';

/**
 * The end of a match.
 *
 * Shown once and left up. A result that flashes and clears leaves a player wondering
 * what happened, and the simulation keeps running underneath — stopping it is a
 * separate decision this does not make for them.
 */
export interface OutcomeBanner {
  readonly element: HTMLElement;
  update(player: PlayerState, viewerId: number): void;
}

const ONGOING = 0;

export function createOutcomeBanner(parent: HTMLElement): OutcomeBanner {
  const element = document.createElement('div');
  element.className = 'outcome-banner';
  element.hidden = true;
  parent.appendChild(element);

  let shown = false;

  return {
    element,
    update(player: PlayerState, viewerId: number): void {
      if (shown) return;

      if (player.outcome !== ONGOING) {
        const won = player.winner === viewerId;
        element.textContent = won ? t('victory.won') : t('victory.lost');
        element.classList.toggle('is-defeat', !won);
        element.hidden = false;
        shown = true;
        return;
      }

      if (player.eliminated) {
        element.textContent = t('victory.eliminated');
        element.classList.add('is-defeat');
        element.hidden = false;
        shown = true;
      }
    },
  };
}
