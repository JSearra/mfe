/**
 * Slow tooltips: what a control does, for a player who stops on it to ask.
 *
 * Any element carrying `data-tip` gets one, through a single delegated listener on the
 * document rather than a listener per button. The command panel rebuilds its buttons
 * whenever the selection or the purse changes shape, and a per-button tooltip would
 * have to be re-wired on every rebuild — and would lose the hover it was timing.
 *
 * Not the browser's `title`. That appears after a delay the page cannot set, in a font
 * the page cannot style, and it was carrying only the cost: a player hovering "umgodi"
 * was told what it cost and not what it was. The delay is deliberately long (see
 * presentation.json, `hud.tooltipDelayMs`) so the text answers a question rather than
 * following the pointer across the panel.
 */

export interface TooltipOptions {
  /** How long the pointer has to rest on a control before its tip appears. */
  readonly delayMs: number;
}

export interface Tooltips {
  readonly element: HTMLElement;
  /** Take the tip down now, and forget what was being timed. */
  hide(): void;
  dispose(): void;
}

/** Gap between the control and the tip, in CSS pixels. */
const GAP = 8;
/** How often a visible tip checks that its control still exists. */
const WATCH_MS = 250;

export function installTooltips(options: TooltipOptions): Tooltips {
  const element = document.createElement('div');
  element.className = 'tooltip';
  element.id = 'tooltip';
  element.setAttribute('role', 'tooltip');
  element.hidden = true;
  document.body.appendChild(element);

  const lifetime = new AbortController();
  const { signal } = lifetime;

  /** The control being timed or shown. */
  let target: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watch: ReturnType<typeof setInterval> | null = null;
  /** Where the pointer last was, to find a control that was rebuilt under it. */
  let pointerX = -1;
  let pointerY = -1;
  /**
   * Whether the last thing the player did was press a key. Focus from a click, or from
   * a screen that focuses its own default button on load, is not a question being asked.
   */
  let keyboard = false;

  function tipOf(node: EventTarget | null): HTMLElement | null {
    if (!(node instanceof Element)) return null;
    return node.closest<HTMLElement>('[data-tip]');
  }

  function clearTimers(): void {
    if (timer !== null) clearTimeout(timer);
    if (watch !== null) clearInterval(watch);
    timer = null;
    watch = null;
  }

  function hide(): void {
    clearTimers();
    if (target !== null) target.removeAttribute('aria-describedby');
    target = null;
    element.hidden = true;
  }

  /**
   * The control under the pointer, if the one being timed has been replaced.
   *
   * The panel rebuilds its buttons when the purse crosses a whole unit, and the new
   * button sits exactly where the old one did. Without this the tip would vanish
   * mid-read for a reason the player cannot see.
   */
  function resolve(): HTMLElement | null {
    if (target !== null && target.isConnected) return target;
    if (pointerX < 0) return null;
    return tipOf(document.elementFromPoint(pointerX, pointerY));
  }

  function place(control: HTMLElement): void {
    const box = control.getBoundingClientRect();
    const tip = element.getBoundingClientRect();
    const maxLeft = window.innerWidth - tip.width - GAP;
    const left = Math.max(GAP, Math.min(maxLeft, box.left + box.width / 2 - tip.width / 2));
    // Above if there is room, which there usually is — the panel sits at the bottom.
    const above = box.top - tip.height - GAP;
    const top = above >= GAP ? above : Math.min(window.innerHeight - tip.height - GAP, box.bottom + GAP);
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }

  function show(): void {
    timer = null;
    const control = resolve();
    const text = control?.dataset.tip ?? '';
    if (control === null || text === '') {
      hide();
      return;
    }
    target = control;
    element.textContent = text;
    element.hidden = false;
    control.setAttribute('aria-describedby', element.id);
    place(control);

    if (watch === null) {
      watch = setInterval(() => {
        const current = resolve();
        if (current === null) {
          hide();
          return;
        }
        // Rebuilt in place: follow the new control and whatever it now says.
        if (current !== target || current.dataset.tip !== element.textContent) {
          target = current;
          element.textContent = current.dataset.tip ?? '';
          current.setAttribute('aria-describedby', element.id);
          place(current);
        }
      }, WATCH_MS);
    }
  }

  function arm(control: HTMLElement): void {
    if (control === target) return;
    hide();
    target = control;
    timer = setTimeout(show, options.delayMs);
  }

  document.addEventListener(
    'pointerover',
    (event) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      const control = tipOf(event.target);
      if (control === null) {
        if (target !== null && !target.isConnected) return;
        hide();
        return;
      }
      arm(control);
    },
    { signal },
  );

  document.addEventListener(
    'pointermove',
    (event) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
    },
    { passive: true, signal },
  );

  document.addEventListener(
    'pointerout',
    (event) => {
      if (target === null) return;
      // Moving between a button and its own children is not leaving it.
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      // A control rebuilt under a still pointer fires this with no related target;
      // the watch deals with that case, so do not treat it as the pointer leaving.
      if (!target.isConnected) return;
      hide();
    },
    { signal },
  );

  // Pressing a control is an answer to the question the tip exists for.
  document.addEventListener(
    'pointerdown',
    () => {
      keyboard = false;
      hide();
    },
    { signal },
  );
  document.addEventListener('wheel', hide, { passive: true, signal });

  // Keyboard users get the same text, on the same delay, from focus.
  document.addEventListener(
    'focusin',
    (event) => {
      const control = tipOf(event.target);
      if (control !== null && keyboard) arm(control);
    },
    { signal },
  );
  document.addEventListener('focusout', hide, { signal });
  document.addEventListener(
    'keydown',
    (event) => {
      keyboard = true;
      if (event.key === 'Escape') hide();
    },
    // Capture, because the help dialog stops its keys reaching the game — and a player
    // tabbing through it is exactly who the focus tips are for.
    { signal, capture: true },
  );

  return {
    element,
    hide,
    dispose(): void {
      hide();
      lifetime.abort();
      element.remove();
    },
  };
}
