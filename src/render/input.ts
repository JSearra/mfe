import {
  panByScreen,
  zoomAt,
  zoomStepFactor,
  type Camera,
  type CameraInput,
} from './camera.js';

/**
 * Pointer and keyboard bindings for the camera.
 *
 * Input lives on the render side and is presentation only. When the simulation
 * boundary lands in Phase 3, player actions become commands posted across it; the
 * camera never will, because where someone is looking is client state.
 */

export interface InputBindings {
  dispose(): void;
}

/** Only the boolean pan fields; widening to keyof CameraInput mixes in the numeric ones. */
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

export function bindCameraInput(
  canvas: HTMLCanvasElement,
  camera: Camera,
  input: CameraInput,
): InputBindings {
  let dragging = false;
  let lastDragX = 0;
  let lastDragY = 0;

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

  // A window that loses focus mid-keypress never delivers the keyup, which would
  // leave the camera panning forever.
  const onBlur = (): void => {
    input.panLeft = false;
    input.panRight = false;
    input.panUp = false;
    input.panDown = false;
    dragging = false;
  };

  const onPointerMove = (event: PointerEvent): void => {
    input.pointerX = event.offsetX;
    input.pointerY = event.offsetY;
    input.pointerInside = true;

    if (dragging) {
      panByScreen(camera, lastDragX - event.clientX, lastDragY - event.clientY);
      lastDragX = event.clientX;
      lastDragY = event.clientY;
    }
  };

  const onPointerLeave = (): void => {
    input.pointerInside = false;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    dragging = true;
    lastDragX = event.clientX;
    lastDragY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  };

  const onPointerUp = (event: PointerEvent): void => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
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
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
