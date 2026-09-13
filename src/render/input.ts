import { panByScreen, zoomAt, zoomStepFactor, type Camera, type CameraInput } from './camera.js';
import { presentation } from './presentation.js';
import type { Rect } from './selection.js';

/**
 * Pointer and keyboard bindings.
 *
 * Button assignment follows the genre: left selects (click or marquee), right issues
 * orders, middle drags the camera. Keyboard and screen-edge panning cover the rest, so
 * the left button stays free for selection — which is why it no longer pans, as it did
 * in Phase 1 before there was anything to select.
 *
 * Input is presentation. Orders become commands posted across the boundary; the camera
 * and the current selection never do, because where someone is looking and what they
 * have highlighted is client state.
 */

export interface InputBindings {
  dispose(): void;
}

export interface InputHandlers {
  /** Left-click without meaningful drag. */
  onClickSelect(viewportX: number, viewportY: number, additive: boolean): void;
  /** Left-drag released. */
  onMarqueeSelect(rect: Rect, additive: boolean): void;
  /** Live marquee rectangle, or null when not dragging. */
  onMarqueeChange(rect: Rect | null): void;
  /** Right-click. */
  onOrder(viewportX: number, viewportY: number): void;
}

type PanKey = 'panLeft' | 'panRight' | 'panUp' | 'panDown';

const PAN_KEYS: Readonly<Record<string, PanKey>> = {
  ArrowLeft: 'panLeft',
  ArrowRight: 'panRight',
  ArrowUp: 'panUp',
  ArrowDown: 'panDown',
  a: 'panLeft',
  d: 'panRight',
  w: 'panUp',
  s: 'panDown',
};

function panKeyFor(key: string): PanKey | undefined {
  return PAN_KEYS[key] ?? PAN_KEYS[key.toLowerCase()];
}

export function bindInput(
  canvas: HTMLCanvasElement,
  camera: Camera,
  input: CameraInput,
  handlers: InputHandlers,
): InputBindings {
  const clickThreshold = presentation.entities.clickThresholdPx;

  let panning = false;
  let lastPanX = 0;
  let lastPanY = 0;

  let marquee: Rect | null = null;
  let additive = false;

  const onKeyDown = (event: KeyboardEvent): void => {
    const field = panKeyFor(event.key);
    if (field === undefined) return;
    input[field] = true;
    event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    const field = panKeyFor(event.key);
    if (field !== undefined) input[field] = false;
  };

  // A window that loses focus mid-keypress never delivers the keyup, which would leave
  // the camera panning forever.
  const onBlur = (): void => {
    input.panLeft = false;
    input.panRight = false;
    input.panUp = false;
    input.panDown = false;
    panning = false;
    marquee = null;
    handlers.onMarqueeChange(null);
  };

  const onPointerMove = (event: PointerEvent): void => {
    input.pointerX = event.offsetX;
    input.pointerY = event.offsetY;
    input.pointerInside = true;

    if (panning) {
      panByScreen(camera, lastPanX - event.clientX, lastPanY - event.clientY);
      lastPanX = event.clientX;
      lastPanY = event.clientY;
    }

    if (marquee !== null) {
      marquee.x1 = event.offsetX;
      marquee.y1 = event.offsetY;
      handlers.onMarqueeChange(marquee);
    }
  };

  const onPointerLeave = (): void => {
    input.pointerInside = false;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button === 1) {
      panning = true;
      lastPanX = event.clientX;
      lastPanY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (event.button === 0) {
      additive = event.shiftKey;
      marquee = { x0: event.offsetX, y0: event.offsetY, x1: event.offsetX, y1: event.offsetY };
      canvas.setPointerCapture(event.pointerId);
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

    if (event.button === 1) {
      panning = false;
      return;
    }

    if (event.button === 0 && marquee !== null) {
      const dragged =
        Math.abs(marquee.x1 - marquee.x0) > clickThreshold ||
        Math.abs(marquee.y1 - marquee.y0) > clickThreshold;

      if (dragged) handlers.onMarqueeSelect(marquee, additive);
      else handlers.onClickSelect(marquee.x0, marquee.y0, additive);

      marquee = null;
      handlers.onMarqueeChange(null);
    }
  };

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    handlers.onOrder(event.offsetX, event.offsetY);
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // Scrolling down (positive deltaY) zooms out.
    zoomAt(camera, zoomStepFactor(-event.deltaY), event.offsetX, event.offsetY);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  return {
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
