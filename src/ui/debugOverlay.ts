import { t } from '../core/i18n/index.js';

/**
 * Debug readout as a DOM overlay rather than Pixi text.
 *
 * See docs/ARCHITECTURE.md section 10: the HUD is DOM because text shaping for
 * diacritic-heavy isiZulu and Sesotho is free in the browser and painful in Pixi,
 * and because it keeps i18n and accessibility straightforward.
 */

export interface DebugReadout {
  cameraX: number;
  cameraY: number;
  zoom: number;
  fps: number;
  frameP99: number;
  drawCalls: number;
  visibleChunks: number;
  totalChunks: number;
  tileX: number;
  tileY: number;
  tileHeight: number;
  pointerOnMap: boolean;
}

export interface DebugOverlay {
  readonly element: HTMLElement;
  update(readout: DebugReadout): void;
}

/** Text updates are throttled; re-rendering strings at 60Hz is pure waste for a readout. */
const UPDATE_INTERVAL_MS = 250;
const LINE_COUNT = 6;

export function createDebugOverlay(parent: HTMLElement): DebugOverlay {
  const element = document.createElement('div');
  element.className = 'debug-overlay';

  const heading = document.createElement('strong');
  heading.textContent = t('debug.heading');
  element.appendChild(heading);

  const lines: HTMLElement[] = [];
  for (let i = 0; i < LINE_COUNT; i++) {
    const line = document.createElement('div');
    lines.push(line);
    element.appendChild(line);
  }

  const hint = document.createElement('div');
  hint.className = 'debug-overlay__hint';
  hint.textContent = t('debug.hint');
  element.appendChild(hint);

  parent.appendChild(element);

  let lastUpdate = -Infinity;

  return {
    element,
    update(readout: DebugReadout): void {
      const now = performance.now();
      if (now - lastUpdate < UPDATE_INTERVAL_MS) return;
      lastUpdate = now;

      lines[0]!.textContent = t('debug.fps', { fps: Math.round(readout.fps) });
      lines[1]!.textContent = t('debug.frameP99', { ms: readout.frameP99.toFixed(1) });
      lines[2]!.textContent = t('debug.drawCalls', { calls: readout.drawCalls });
      lines[3]!.textContent = t('debug.chunks', {
        visible: readout.visibleChunks,
        total: readout.totalChunks,
      });
      lines[4]!.textContent = t('debug.zoom', { zoom: readout.zoom.toFixed(2) });
      lines[5]!.textContent = readout.pointerOnMap
        ? t('debug.cursorTile', { x: readout.tileX, y: readout.tileY, h: readout.tileHeight })
        : t('debug.cursorOffMap');
    },
  };
}
