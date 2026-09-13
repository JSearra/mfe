import { UPDATE_PRIORITY } from 'pixi.js';
import { t } from './core/i18n/index.js';
import { heightAt } from './shared/heightmap.js';
import { NO_TILE, pickTileIndex, tileX, tileY } from './shared/picking.js';
import { createHeightmap } from './sim/terrain/generate.js';
import { createRenderer } from './render/app.js';
import {
  createCamera,
  createCameraInput,
  setViewport,
  updateCamera,
} from './render/camera.js';
import { bindCameraInput } from './render/input.js';
import { installPerfHarness } from './render/perfHarness.js';
import { createRenderStats } from './render/stats.js';
import { createTileCursor, placeTileCursor } from './render/scene/cursor.js';
import { createTerrain } from './render/scene/terrain.js';
import { createDebugOverlay } from './ui/debugOverlay.js';

/**
 * Phase 2 entry point: isometric tilemap with elevation.
 *
 * There is still no simulation loop wired in — the heightmap is generated once and
 * handed to the renderer, which is exactly how terrain will cross the boundary in
 * Phase 3, since terrain is static and does not belong in a per-tick snapshot.
 */

const BACKGROUND = 0x14110d;
const MAP_SIZE = 128;
const MAP_SEED = 0x4d666563;

async function main(): Promise<void> {
  document.title = t('app.title');

  const root = document.getElementById('app') ?? document.body;
  root.textContent = '';

  const map = createHeightmap(MAP_SIZE, MAP_SIZE, MAP_SEED);

  const { app } = await createRenderer(root, BACKGROUND);
  const camera = createCamera(app.renderer.width, app.renderer.height);
  const input = createCameraInput();
  bindCameraInput(app.canvas, camera, input);

  // Start looking at the middle of the map rather than its northern corner.
  camera.x = 0;
  camera.y = MAP_SIZE * 16;

  const terrain = createTerrain(map);
  const cursor = createTileCursor();
  terrain.container.addChild(cursor);
  app.stage.addChild(terrain.container);

  const stats = createRenderStats();
  const overlay = createDebugOverlay(root);

  if (new URLSearchParams(location.search).has('perf')) {
    installPerfHarness(app, camera, stats, terrain, MAP_SIZE);
  }

  // Frame cost is measured across three ticker priorities, because Pixi renders at
  // LOW: opening at HIGH and closing at UTILITY brackets our update *and* the render
  // submission, rather than timing only our own callback and reporting a flattering
  // number that ignores most of the frame.
  let frameStart = 0;

  app.ticker.add(
    () => {
      stats.beginFrame();
      frameStart = performance.now();
    },
    undefined,
    UPDATE_PRIORITY.HIGH,
  );

  app.ticker.add((ticker) => {
    if (
      camera.viewportWidth !== app.renderer.width ||
      camera.viewportHeight !== app.renderer.height
    ) {
      setViewport(camera, app.renderer.width, app.renderer.height);
    }

    updateCamera(camera, input, ticker.deltaMS / 1000);

    terrain.container.scale.set(camera.zoom);
    terrain.container.position.set(
      -camera.x * camera.zoom + camera.viewportWidth / 2,
      -camera.y * camera.zoom + camera.viewportHeight / 2,
    );
    terrain.update(camera);

    // Pointer -> unzoomed isometric space -> tile, accounting for terrain height.
    const isoX = (input.pointerX - camera.viewportWidth / 2) / camera.zoom + camera.x;
    const isoY = (input.pointerY - camera.viewportHeight / 2) / camera.zoom + camera.y;
    const index = input.pointerInside ? pickTileIndex(map, isoX, isoY) : NO_TILE;

    const hoverX = index === NO_TILE ? 0 : tileX(map, index);
    const hoverY = index === NO_TILE ? 0 : tileY(map, index);
    if (index === NO_TILE) cursor.visible = false;
    else placeTileCursor(cursor, map, hoverX, hoverY);

    overlay.update({
      cameraX: camera.x,
      cameraY: camera.y,
      zoom: camera.zoom,
      fps: ticker.FPS,
      frameP99: stats.p99(),
      drawCalls: stats.drawCalls,
      visibleChunks: terrain.visibleChunks,
      totalChunks: terrain.chunkCount,
      tileX: hoverX,
      tileY: hoverY,
      tileHeight: index === NO_TILE ? 0 : heightAt(map, hoverX, hoverY),
      pointerOnMap: index !== NO_TILE,
    });
  });

  app.ticker.add(
    (ticker) => stats.endFrame(ticker.deltaMS, performance.now() - frameStart),
    undefined,
    UPDATE_PRIORITY.UTILITY,
  );
}

void main();
