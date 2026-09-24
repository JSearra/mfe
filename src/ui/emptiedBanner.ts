import { t } from '../core/i18n/index.js';
import type { PlayerState } from '../host/directHost.js';

/**
 * Said once when nobody is left in the player's village.
 *
 * This was the outcome banner, back when a match could be won or lost. Nothing ends a
 * game now (ADR-0020), and this does not end one either: the simulation keeps running
 * underneath. But a village with nobody in it cannot raise anybody, and a map of empty
 * huts does not make that obvious, so it is said out loud and a fresh start is offered.
 *
 * Left up once shown. It clears itself if people come back, which the census allows.
 */
export interface EmptiedBanner {
  readonly element: HTMLElement;
  update(player: PlayerState): void;
}

export interface EmptiedBannerOptions {
  /** Offered alongside the notice. Without it the banner has nothing to suggest. */
  onRestart?: () => void;
}

export function createEmptiedBanner(
  parent: HTMLElement,
  options: EmptiedBannerOptions = {},
): EmptiedBanner {
  const element = document.createElement('div');
  element.className = 'emptied-banner';
  element.hidden = true;
  parent.appendChild(element);

  const message = document.createElement('div');
  message.textContent = t('village.emptied');
  element.appendChild(message);

  if (options.onRestart !== undefined) {
    const again = document.createElement('button');
    again.className = 'emptied-again';
    again.textContent = t('village.again');
    again.addEventListener('click', () => options.onRestart?.());
    // The banner is pointer-events:none so it never eats clicks on the map behind it;
    // the button has to opt back in or it cannot be pressed.
    again.style.pointerEvents = 'auto';
    element.appendChild(again);
  }

  return {
    element,
    update(player: PlayerState): void {
      element.hidden = !player.emptied;
    },
  };
}
