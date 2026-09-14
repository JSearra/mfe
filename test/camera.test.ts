import { describe, expect, it } from 'vitest';
import {
  createCamera,
  createCameraInput,
  MAX_ZOOM,
  MIN_ZOOM,
  panByScreen,
  setViewport,
  setZoom,
  updateCamera,
  viewportToWorldX,
  viewportToWorldY,
  worldToViewportX,
  worldToViewportY,
  zoomAt,
  zoomStepFactor,
  clampCamera,
  mapBounds,
} from '../src/render/camera.js';
import { worldToScreenX, worldToScreenY } from '../src/shared/iso.js';

describe('camera zoom', () => {
  it('clamps at both ends', () => {
    const camera = createCamera(800, 600);

    setZoom(camera, 99);
    expect(camera.zoom).toBe(MAX_ZOOM);

    setZoom(camera, 0.001);
    expect(camera.zoom).toBe(MIN_ZOOM);

    setZoom(camera, 1.25);
    expect(camera.zoom).toBe(1.25);
  });

  it('clamps when stepping repeatedly in one direction', () => {
    const camera = createCamera(800, 600);
    for (let i = 0; i < 50; i++) zoomAt(camera, zoomStepFactor(1), 400, 300);
    expect(camera.zoom).toBe(MAX_ZOOM);

    for (let i = 0; i < 50; i++) zoomAt(camera, zoomStepFactor(-1), 400, 300);
    expect(camera.zoom).toBe(MIN_ZOOM);
  });

  it('holds the point under the cursor still while zooming', () => {
    const camera = createCamera(800, 600);
    const anchorX = 610;
    const anchorY = 140;
    const height = 3;

    const worldX = viewportToWorldX(camera, anchorX, anchorY, height);
    const worldY = viewportToWorldY(camera, anchorX, anchorY, height);

    zoomAt(camera, 1.4, anchorX, anchorY);

    expect(worldToViewportX(camera, worldX, worldY)).toBeCloseTo(anchorX, 8);
    expect(worldToViewportY(camera, worldX, worldY, height)).toBeCloseTo(anchorY, 8);
  });
});

describe('camera projection', () => {
  it('round-trips viewport -> world -> viewport at every height and zoom', () => {
    const camera = createCamera(1280, 720);

    for (const zoom of [MIN_ZOOM, 0.75, 1, 1.5, MAX_ZOOM]) {
      setZoom(camera, zoom);
      camera.x = 137.5;
      camera.y = -62.25;

      for (let height = 0; height <= 12; height += 3) {
        for (let wx = -30; wx <= 30; wx += 7.5) {
          for (let wy = -30; wy <= 30; wy += 7.5) {
            const vx = worldToViewportX(camera, wx, wy);
            const vy = worldToViewportY(camera, wx, wy, height);
            expect(viewportToWorldX(camera, vx, vy, height)).toBeCloseTo(wx, 8);
            expect(viewportToWorldY(camera, vx, vy, height)).toBeCloseTo(wy, 8);
          }
        }
      }
    }
  });

  it('puts the camera position at the centre of the viewport', () => {
    const camera = createCamera(800, 600);
    // World origin projects to iso origin, which is where the camera starts.
    expect(worldToViewportX(camera, 0, 0)).toBeCloseTo(400, 10);
    expect(worldToViewportY(camera, 0, 0, 0)).toBeCloseTo(300, 10);
  });

  it('tracks a viewport resize', () => {
    const camera = createCamera(800, 600);
    setViewport(camera, 1000, 500);
    expect(worldToViewportX(camera, 0, 0)).toBeCloseTo(500, 10);
    expect(worldToViewportY(camera, 0, 0, 0)).toBeCloseTo(250, 10);
  });
});

describe('camera panning', () => {
  it('pans by screen pixels regardless of zoom', () => {
    const a = createCamera(800, 600);
    const b = createCamera(800, 600);
    setZoom(b, 2);

    panByScreen(a, 100, 0);
    panByScreen(b, 100, 0);

    // Same on-screen movement, so the underlying iso delta halves at 2x zoom.
    expect(a.x).toBe(100);
    expect(b.x).toBe(50);
  });

  it('moves on keyboard input, scaled by frame time', () => {
    const camera = createCamera(800, 600);
    const input = createCameraInput();
    input.panRight = true;

    updateCamera(camera, input, 0.5);
    const afterHalfSecond = camera.x;
    expect(afterHalfSecond).toBeGreaterThan(0);

    updateCamera(camera, input, 0.25);
    expect(camera.x - afterHalfSecond).toBeCloseTo(afterHalfSecond / 2, 8);
  });

  it('cancels opposing keys', () => {
    const camera = createCamera(800, 600);
    const input = createCameraInput();
    input.panLeft = true;
    input.panRight = true;
    input.panUp = true;
    input.panDown = true;

    updateCamera(camera, input, 1);
    expect(camera.x).toBe(0);
    expect(camera.y).toBe(0);
  });

  it('edge-pans only when the pointer is inside and near an edge', () => {
    const camera = createCamera(800, 600);
    const input = createCameraInput();

    input.pointerInside = true;
    input.pointerX = 400;
    input.pointerY = 300;
    updateCamera(camera, input, 1);
    expect(camera.x).toBe(0);

    input.pointerX = 2;
    updateCamera(camera, input, 1);
    expect(camera.x).toBeLessThan(0);

    const before = camera.x;
    input.pointerInside = false;
    updateCamera(camera, input, 1);
    expect(camera.x).toBe(before);
  });

  it('edge-pans right and down at the far edges', () => {
    const camera = createCamera(800, 600);
    const input = createCameraInput();
    input.pointerInside = true;
    input.pointerX = 799;
    input.pointerY = 599;

    updateCamera(camera, input, 1);
    expect(camera.x).toBeGreaterThan(0);
    expect(camera.y).toBeGreaterThan(0);
  });
});

describe('camera bounds', () => {
  const bounds = mapBounds(128, 128);

  it('keeps a camera that is already over the map where it is', () => {
    const camera = createCamera(1280, 720);
    camera.x = 0;
    camera.y = 128 * 16;
    const { x, y } = { x: camera.x, y: camera.y };
    clampCamera(camera, bounds);
    expect(camera.x).toBe(x);
    expect(camera.y).toBe(y);
  });

  it('stops a sustained pan from leaving the map', () => {
    // The defect this guards: nothing clamped the camera, so holding a pan key walked
    // the view off into empty space and no input brought it back.
    const camera = createCamera(1280, 720);
    const input = createCameraInput();
    input.panRight = true;
    input.panDown = true;

    for (let frame = 0; frame < 6000; frame++) {
      updateCamera(camera, input, 1 / 60);
      clampCamera(camera, bounds);
    }

    expect(camera.x).toBeLessThanOrEqual(bounds.maxX);
    expect(camera.y).toBeLessThanOrEqual(bounds.maxY);

    input.panRight = false;
    input.panDown = false;
    input.panLeft = true;
    input.panUp = true;
    for (let frame = 0; frame < 6000; frame++) {
      updateCamera(camera, input, 1 / 60);
      clampCamera(camera, bounds);
    }

    expect(camera.x).toBeGreaterThanOrEqual(bounds.minX);
    expect(camera.y).toBeGreaterThanOrEqual(bounds.minY);
  });

  it('brackets the projected corners of the map', () => {
    // Far west is (0, height); far east is (width, 0). A box that does not contain both
    // would clip a corner of the map out of reach.
    expect(bounds.minX).toBeLessThanOrEqual(worldToScreenX(0, 128));
    expect(bounds.maxX).toBeGreaterThanOrEqual(worldToScreenX(128, 0));
    expect(bounds.maxY).toBeGreaterThanOrEqual(worldToScreenY(128, 128, 0));
  });

  it('pins the camera inside a map smaller than the viewport rather than oscillating', () => {
    const small = mapBounds(8, 8);
    const camera = createCamera(1920, 1080);
    camera.x = 9999;
    camera.y = -9999;
    clampCamera(camera, small);
    expect(camera.x).toBe(small.maxX);
    expect(camera.y).toBe(small.minY);
    const once = { x: camera.x, y: camera.y };
    clampCamera(camera, small);
    expect(camera.x).toBe(once.x);
    expect(camera.y).toBe(once.y);
  });
});
