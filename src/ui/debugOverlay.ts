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
  entityCount: number;
  selectedCount: number;
  cattleCount: number;
  leashedCount: number;
  stampedingCount: number;
  simTick: number;
  renderTick: number;
}

export interface DebugOverlay {
  readonly element: HTMLElement;
  update(readout: DebugReadout): void;
  /** Show or hide the stats. The controls stay where they are either way. */
  setStatsVisible(visible: boolean): void;
  /** Collapse the controls to their heading, or open them again. */
  setControlsOpen(open: boolean): void;
}

/** Text updates are throttled; re-rendering strings at 60Hz is pure waste for a readout. */
const UPDATE_INTERVAL_MS = 250;
const LINE_COUNT = 9;

/** The controls, grouped by the question being asked. The note goes last. */
const CONTROL_LINES = [
  'controls.select',
  'controls.build',
  'controls.land',
  'controls.groups',
  'controls.time',
  'controls.note',
] as const;

/**
 * The stats and the controls, in one corner but not one box.
 *
 * They were a single panel, always on, occupying the top-left QUARTER of a 1440x900
 * screen — and they are not the same kind of thing at all. Frame times and draw calls
 * are for whoever is working on the renderer; a list of what the keys do is for whoever
 * is playing. Shipping a game with its frame counter welded on is a choice nobody made
 * deliberately, and hiding both would have taken the only documentation of the controls
 * off the screen with it.
 *
 * So: the stats are off by default and come back on F1, and the controls stay, folded
 * down to a heading on H.
 */
export function createDebugOverlay(parent: HTMLElement): DebugOverlay {
  const element = document.createElement('div');
  element.className = 'hud-controls';

  /*
   * The stats go under the resource bar rather than above the command panel.
   *
   * Both were in the top-left column, and with a village's full set of actions the
   * panel is tall enough to reach them: three stacked boxes do not fit one edge. The
   * stats are numbers about the program, the resource bar is numbers about the village,
   * and numbers belong with numbers — which also leaves the left edge to the two things
   * a player reads, the controls and the selection.
   */
  const stats = document.createElement('div');
  stats.className = 'debug-overlay';
  stats.hidden = true;

  const heading = document.createElement('strong');
  heading.textContent = t('debug.heading');
  stats.appendChild(heading);

  const lines: HTMLElement[] = [];
  for (let i = 0; i < LINE_COUNT; i++) {
    const line = document.createElement('div');
    lines.push(line);
    stats.appendChild(line);
  }

  const controls = document.createElement('div');
  controls.className = 'controls';

  const controlsHeading = document.createElement('strong');
  controlsHeading.textContent = t('debug.controlsHeading');
  controls.appendChild(controlsHeading);

  /*
   * A list rather than a paragraph.
   *
   * The hint was one sentence of six clauses and nobody reads that in a corner of a
   * game — it was scrolling out of its own box mid-word. Grouped by the question being
   * asked: how do I choose things, how do I build, how do I work the land, how do I
   * manage a crowd, how do I control time. The note about how sites and fields behave
   * goes last, because it is the one line that is not a key.
   */
  const hint = document.createElement('div');
  hint.className = 'controls__body';
  for (const key of CONTROL_LINES) {
    const line = document.createElement('div');
    line.className = key === 'controls.note' ? 'controls__note' : 'controls__line';
    line.textContent = t(key);
    hint.appendChild(line);
  }
  controls.appendChild(hint);

  element.append(controls);
  parent.append(stats, element);

  let lastUpdate = -Infinity;

  return {
    element,

    setStatsVisible(visible: boolean): void {
      stats.hidden = !visible;
    },

    setControlsOpen(open: boolean): void {
      hint.hidden = !open;
    },

    update(readout: DebugReadout): void {
      // Nothing to say while nobody is looking, and the strings are not free.
      if (stats.hidden) return;
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
      lines[5]!.textContent = t('debug.entities', {
        count: readout.entityCount,
        selected: readout.selectedCount,
      });
      lines[6]!.textContent = t('debug.tickLag', {
        sim: readout.simTick,
        render: readout.renderTick.toFixed(1),
      });
      lines[7]!.textContent = t('debug.herd', {
        cattle: readout.cattleCount,
        leashed: readout.leashedCount,
        stampeding: readout.stampedingCount,
      });
      lines[8]!.textContent = readout.pointerOnMap
        ? t('debug.cursorTile', { x: readout.tileX, y: readout.tileY, h: readout.tileHeight })
        : t('debug.cursorOffMap');
    },
  };
}
