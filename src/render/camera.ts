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

/**
 * Where the viewport centre is allowed to roam, as the map's own tile extent.
 *
 * Nothing constrained the camera before this: holding a pan key walked the view off the
 * map into empty space, and since no input is relative to the map, nothing brought it
 * back. The player had to restart.
 *
 * The first fix was a screen-space box around the projected map, and it did not work,
 * because **the map is a diamond on screen and not a rectangle**. A 128x128 map has its
 * west point at (-4096, 2048) and its north point at (0, 0); clamping x and y
 * independently against the bounding box therefore allows (-4096, 0), a box corner two
 * thousand pixels clear of the nearest land. Holding left and up for fifteen seconds
 * parked the camera there with an entirely empty screen and no clue which way the map
 * had gone — the very failure the clamp was added to prevent, moved rather than removed.
 *
 * So the clamp happens in TILE space, where the map really is a rectangle. The camera
 * centre is projected back to tile coordinates, clamped per axis there, and projected
 * out again, which lands it on the nearest point of the map instead of the nearest
 * point of a box that mostly is not the map. Inside the map the round trip is exact and
 * the clamp is a no-op, so it stays idempotent.
 *
 * At the extreme the centre sits on a map corner with half a viewport of void beyond it
 * — this time actually. Insetting further, so that no void ever shows, inverts when the
 * map is smaller than the window and leaves the camera nowhere legal to be.
 */
export interface CameraBounds {
  readonly tilesX: number;
  readonly tilesY: number;
}

/**
 * Roaming bounds for a map of this tile size.
 *
 * No allowance is made for terrain lifting geometry above the ground plane. It was a
 * parameter while the bounds were a screen box, and it is not needed: half a viewport is
 * 205px at the tightest zoom the game allows against a 120px maximum lift, so a peak
 * standing on a corner tile is still on screen with the camera centred on that tile.
 */
export function mapBounds(width: number, height: number): CameraBounds {
  return { tilesX: width, tilesY: height };
}

/** Pull the camera back over the map. Idempotent, and a no-op while it is already there. */
export function clampCamera(camera: Camera, bounds: CameraBounds): void {
  // At ground level: the camera roams the plane the tiles sit on, not any tile's top.
  const tileX = screenToWorldX(camera.x, camera.y, 0);
  const tileY = screenToWorldY(camera.x, camera.y, 0);

  const clampedX = tileX < 0 ? 0 : tileX > bounds.tilesX ? bounds.tilesX : tileX;
  const clampedY = tileY < 0 ? 0 : tileY > bounds.tilesY ? bounds.tilesY : tileY;
  if (clampedX === tileX && clampedY === tileY) return;

  camera.x = worldToScreenX(clampedX, clampedY);
  camera.y = worldToScreenY(clampedX, clampedY, 0);
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
