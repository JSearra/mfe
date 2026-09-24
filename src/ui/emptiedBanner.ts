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

export interface OutcomeBannerOptions {
  /** Offered once the match is decided. Without it the banner is a dead end. */
  onRestart?: () => void;
}

const ONGOING = 0;

export function createOutcomeBanner(
  parent: HTMLElement,
  options: OutcomeBannerOptions = {},
): OutcomeBanner {
  const element = document.createElement('div');
  element.className = 'outcome-banner';
  element.hidden = true;
  parent.appendChild(element);

  const message = document.createElement('div');
  element.appendChild(message);

  let shown = false;

  function show(text: string, defeat: boolean): void {
    message.textContent = text;
    element.classList.toggle('is-defeat', defeat);
    element.hidden = false;
    shown = true;

    if (options.onRestart === undefined) return;
    const again = document.createElement('button');
    again.className = 'outcome-again';
    again.textContent = t('victory.again');
    again.addEventListener('click', () => options.onRestart?.());
    element.appendChild(again);
    // The banner is pointer-events:none so it never eats clicks on the map behind it;
    // the button has to opt back in or it cannot be pressed.
    again.style.pointerEvents = 'auto';
  }

  return {
    element,
    update(player: PlayerState, viewerId: number): void {
      if (shown) return;

      if (player.outcome !== ONGOING) {
        const won = player.winner === viewerId;
        show(won ? t('victory.won') : t('victory.lost'), !won);
        return;
      }

      if (player.eliminated) {
        show(t('victory.eliminated'), true);
      }
    },
  };
}
