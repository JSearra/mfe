import { t } from './core/i18n/index.js';
import { createRenderer } from './render/app.js';
import {
  createCamera,
  createCameraInput,
  setViewport,
  updateCamera,
  viewportToWorldX,
  viewportToWorldY,
} from './render/camera.js';
import { bindCameraInput } from './render/input.js';
import { presentation } from './render/presentation.js';
import { applyCamera, createDebugGrid } from './render/scene/debugGrid.js';
import { createDebugOverlay } from './ui/debugOverlay.js';

/**
 * Phase 1 entry point: Pixi canvas, isometric camera, i18n.
 *
 * The render loop here is independent of simulation timing by construction — there is
 * no simulation wired in yet. Phase 3 introduces the snapshot boundary and the render
 * side starts interpolating between ticks rather than reading state directly.
 */

const BACKGROUND = 0x14110d;

/** Ground level. Elevation-aware picking needs the heightmap, which arrives in Phase 2. */
const PICK_HEIGHT = 0;

async function main(): Promise<void> {
  document.title = t('app.title');

  const root = document.getElementById('app') ?? document.body;
  root.textContent = '';

  const { app } = await createRenderer(root, BACKGROUND);
  const canvas = app.canvas;

  const camera = createCamera(app.renderer.width, app.renderer.height);
  const input = createCameraInput();
  bindCameraInput(canvas, camera, input);

  const scene = createDebugGrid(presentation.debug.gridRadius);
  app.stage.addChild(scene);

  const overlay = createDebugOverlay(root);

  app.ticker.add((ticker) => {
    if (camera.viewportWidth !== app.renderer.width || camera.viewportHeight !== app.renderer.height) {
      setViewport(camera, app.renderer.width, app.renderer.height);
    }

    updateCamera(camera, input, ticker.deltaMS / 1000);
    applyCamera(scene, camera);

    const worldX = viewportToWorldX(camera, input.pointerX, input.pointerY, PICK_HEIGHT);
    const worldY = viewportToWorldY(camera, input.pointerX, input.pointerY, PICK_HEIGHT);

    overlay.update({
      cameraX: camera.x,
      cameraY: camera.y,
      zoom: camera.zoom,
      fps: ticker.FPS,
      tileX: Math.floor(worldX),
      tileY: Math.floor(worldY),
      pointerOnMap: input.pointerInside,
    });
  });
}

void main();
