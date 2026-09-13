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
} from '../src/render/camera.js';

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
