import {
  screenToWorldX,
  screenToWorldY,
  worldToScreenX,
  worldToScreenY,
} from '../shared/iso.js';
import { presentation } from './presentation.js';

/**
 * Isometric camera.
 *
 * Position is the centre of the viewport expressed in unzoomed isometric screen space,
 * which is the space panning naturally happens in. World coordinates reach the screen
 * as: iso projection (with elevation) -> camera offset -> zoom -> viewport centring.
 *
 * All functions are scalar in and scalar out. Returning {x, y} would allocate on every
 * call, and these run per frame and per pointer event.
 */

const { minZoom, maxZoom, zoomStep, keyboardPanSpeed, edgePanSpeed, edgePanMargin } =
  presentation.camera;

export const MIN_ZOOM = minZoom;
export const MAX_ZOOM = maxZoom;

export interface Camera {
  /** Viewport centre, in unzoomed isometric screen space. */
  x: number;
  y: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}

export function createCamera(viewportWidth: number, viewportHeight: number): Camera {
  return { x: 0, y: 0, zoom: 1, viewportWidth, viewportHeight };
}

export function setViewport(camera: Camera, width: number, height: number): void {
  camera.viewportWidth = width;
  camera.viewportHeight = height;
}

export function clampZoom(zoom: number): number {
  if (zoom < MIN_ZOOM) return MIN_ZOOM;
  if (zoom > MAX_ZOOM) return MAX_ZOOM;
  return zoom;
}

export function setZoom(camera: Camera, zoom: number): void {
  camera.zoom = clampZoom(zoom);
}

/**
 * Zoom while holding the world point under (viewportX, viewportY) still.
 *
 * Zooming about the viewport centre instead makes the map slide under the cursor,
 * which reads as the camera fighting the player.
 */
export function zoomAt(camera: Camera, factor: number, viewportX: number, viewportY: number): void {
  const offsetX = viewportX - camera.viewportWidth / 2;
  const offsetY = viewportY - camera.viewportHeight / 2;

  const isoX = offsetX / camera.zoom + camera.x;
  const isoY = offsetY / camera.zoom + camera.y;

  camera.zoom = clampZoom(camera.zoom * factor);

  camera.x = isoX - offsetX / camera.zoom;
  camera.y = isoY - offsetY / camera.zoom;
}

export function zoomStepFactor(direction: number): number {
  return direction > 0 ? zoomStep : 1 / zoomStep;
}

/** Pan by a screen-pixel delta, so panning feels the same at every zoom level. */
export function panByScreen(camera: Camera, deltaX: number, deltaY: number): void {
  camera.x += deltaX / camera.zoom;
  camera.y += deltaY / camera.zoom;
}

// --- projection --------------------------------------------------------------

export function worldToViewportX(camera: Camera, worldX: number, worldY: number): number {
  return (worldToScreenX(worldX, worldY) - camera.x) * camera.zoom + camera.viewportWidth / 2;
}

export function worldToViewportY(
  camera: Camera,
  worldX: number,
  worldY: number,
  height: number,
): number {
  return (
    (worldToScreenY(worldX, worldY, height) - camera.y) * camera.zoom + camera.viewportHeight / 2
  );
}

function isoX(camera: Camera, viewportX: number): number {
  return (viewportX - camera.viewportWidth / 2) / camera.zoom + camera.x;
}

function isoY(camera: Camera, viewportY: number): number {
  return (viewportY - camera.viewportHeight / 2) / camera.zoom + camera.y;
}

/** Inverse projection at a known terrain height. See the note in shared/iso.ts. */
export function viewportToWorldX(
  camera: Camera,
  viewportX: number,
  viewportY: number,
  height: number,
): number {
  return screenToWorldX(isoX(camera, viewportX), isoY(camera, viewportY), height);
}

export function viewportToWorldY(
  camera: Camera,
  viewportX: number,
  viewportY: number,
  height: number,
): number {
  return screenToWorldY(isoX(camera, viewportX), isoY(camera, viewportY), height);
}

// --- input-driven movement ---------------------------------------------------

export interface CameraInput {
  panLeft: boolean;
  panRight: boolean;
  panUp: boolean;
  panDown: boolean;
  pointerX: number;
  pointerY: number;
  pointerInside: boolean;
}

export function createCameraInput(): CameraInput {
  return {
    panLeft: false,
    panRight: false,
    panUp: false,
    panDown: false,
    pointerX: 0,
    pointerY: 0,
    pointerInside: false,
  };
}

/**
 * Advance the camera for one rendered frame.
 *
 * dtSeconds comes from the render clock, not the simulation: camera movement is
 * presentation and is expected to vary with framerate. Nothing here feeds back into
 * simulation state.
 */
export function updateCamera(camera: Camera, input: CameraInput, dtSeconds: number): void {
  let dx = 0;
  let dy = 0;

  if (input.panLeft) dx -= keyboardPanSpeed;
  if (input.panRight) dx += keyboardPanSpeed;
  if (input.panUp) dy -= keyboardPanSpeed;
  if (input.panDown) dy += keyboardPanSpeed;

  if (input.pointerInside) {
    const { pointerX, pointerY } = input;
    const right = camera.viewportWidth - edgePanMargin;
    const bottom = camera.viewportHeight - edgePanMargin;

    if (pointerX < edgePanMargin) dx -= edgePanSpeed;
    else if (pointerX > right) dx += edgePanSpeed;

    if (pointerY < edgePanMargin) dy -= edgePanSpeed;
    else if (pointerY > bottom) dy += edgePanSpeed;
  }

  if (dx !== 0 || dy !== 0) panByScreen(camera, dx * dtSeconds, dy * dtSeconds);
}
