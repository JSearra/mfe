import { UPDATE_PRIORITY } from 'pixi.js';
import { t } from './core/i18n/index.js';
import { heightAt } from './shared/heightmap.js';
import { NO_TILE, pickTileIndex, tileX, tileY } from './shared/picking.js';
import { CommandKind } from './sim/commands.js';
import { createDirectSimHost } from './sim/host.js';
import { createHeightmap } from './sim/terrain/generate.js';
import { createWorld } from './sim/world.js';
import { createRenderer } from './render/app.js';
import { createCamera, createCameraInput, setViewport, updateCamera } from './render/camera.js';
import { bindInput } from './render/input.js';
import { createInterpolator, type InterpolatedView } from './render/interpolation.js';
import { installPerfHarness } from './render/perfHarness.js';
import { createEntityLayer } from './render/scene/entities.js';
import { createTileCursor, placeTileCursor } from './render/scene/cursor.js';
import { createTerrain } from './render/scene/terrain.js';
import {
  createMarqueeGraphics,
  createSelection,
  drawMarquee,
  type Rect,
} from './render/selection.js';
import { createRenderStats } from './render/stats.js';
import { createDebugOverlay } from './ui/debugOverlay.js';

/**
 * Phase 3 entry point: the simulation now runs behind a boundary.
 *
 * This module is the composition root, and the only place that touches both sides. The
 * renderer below it reads snapshots and events; it never reads the world. That rule is
 * enforced by ESLint rather than discipline, because it is what makes the eventual
 * worker flip a transport change instead of a UI rewrite — see ADR-0004.
 */

const BACKGROUND = 0x14110d;
const MAP_SIZE = 128;
const MAP_SEED = 0x4d666563;
const WORLD_SEED = 0x5eedcafe;
const PLAYER = 0;
const STARTING_UNITS = 24;

async function main(): Promise<void> {
  document.title = t('app.title');

  const root = document.getElementById('app') ?? document.body;
  root.textContent = '';

  const map = createHeightmap(MAP_SIZE, MAP_SIZE, MAP_SEED);
  const world = createWorld(512, WORLD_SEED);
  const sim = createDirectSimHost({ world, viewerId: PLAYER, playerId: PLAYER });

  // Seed a small force near the centre. Spawning through commands rather than touching
  // the world directly keeps the invariant that commands are the only mutation path.
  const centre = MAP_SIZE / 2;
  for (let i = 0; i < STARTING_UNITS; i++) {
    const column = i % 6;
    const row = Math.floor(i / 6);
    sim.sendCommand(CommandKind.Spawn, centre + column * 1.4 - 4, centre + row * 1.4 - 2, PLAYER);
  }

  const { app } = await createRenderer(root, BACKGROUND);
  const camera = createCamera(app.renderer.width, app.renderer.height);
  const input = createCameraInput();

  camera.x = 0;
  camera.y = MAP_SIZE * 16;

  const terrain = createTerrain(map);
  const cursor = createTileCursor();
  const entities = createEntityLayer();
  terrain.container.addChild(cursor);
  terrain.container.addChild(entities.container);
  app.stage.addChild(terrain.container);

  const marquee = createMarqueeGraphics();
  app.stage.addChild(marquee);

  const interpolator = createInterpolator();
  const selection = createSelection();
  const stats = createRenderStats();
  const overlay = createDebugOverlay(root);

  let view: InterpolatedView | null = null;

  /** Viewport point -> the world position of the tile under it. */
  function worldPointAt(viewportX: number, viewportY: number): { x: number; y: number } | null {
    const isoX = (viewportX - camera.viewportWidth / 2) / camera.zoom + camera.x;
    const isoY = (viewportY - camera.viewportHeight / 2) / camera.zoom + camera.y;
    const index = pickTileIndex(map, isoX, isoY);
    if (index === NO_TILE) return null;
    return { x: tileX(map, index) + 0.5, y: tileY(map, index) + 0.5 };
  }

  bindInput(app.canvas, camera, input, {
    onClickSelect(x, y, additive) {
      if (view !== null) selection.selectAt(view, map, camera, entities, x, y, PLAYER, additive);
    },
    onMarqueeSelect(rect, additive) {
      if (view !== null)
        selection.selectInRect(view, map, camera, entities, rect, PLAYER, additive);
    },
    onMarqueeChange(rect: Rect | null) {
      drawMarquee(marquee, rect);
    },
    onOrder(x, y) {
      const target = worldPointAt(x, y);
      if (target === null || selection.handles.size === 0) return;
      // Orders carry a handle, never a position: by the time this executes the target
      // may be dead, and the handle's generation is what says so.
      for (const handle of selection.handles) {
        sim.sendCommand(CommandKind.MoveTo, handle, target.x, target.y);
      }
    },
  });

  // Dev-only inspection hook for browser-driven verification. Exposes render-side
  // state only — the interpolated view and the selection — never the world, which
  // would be exactly the synchronous simulation read the boundary exists to prevent.
  if (import.meta.env?.DEV) {
    (window as unknown as Record<string, unknown>).__debug = {
      renderTick: () => interpolator.renderTick,
      simTick: () => sim.tick,
      count: () => view?.count ?? 0,
      selected: () => [...selection.handles],
      handles: () => (view === null ? [] : Array.from(view.handle.subarray(0, view.count))),
      positions: () =>
        view === null
          ? []
          : Array.from({ length: view.count }, (_, i) => [view!.x[i]!, view!.y[i]!]),
    };
  }

  if (new URLSearchParams(location.search).has('perf')) {
    installPerfHarness(app, camera, stats, terrain, MAP_SIZE);
  }

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

    sim.pump(ticker.deltaMS);
    const message = sim.receive();
    if (message !== null) interpolator.push(message.snapshot);
    view = interpolator.sample(ticker.deltaMS);

    terrain.container.scale.set(camera.zoom);
    terrain.container.position.set(
      -camera.x * camera.zoom + camera.viewportWidth / 2,
      -camera.y * camera.zoom + camera.viewportHeight / 2,
    );
    terrain.update(camera);

    if (view !== null) entities.update(view, map, selection.handles);

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
      entityCount: view?.count ?? 0,
      selectedCount: selection.handles.size,
      simTick: sim.tick,
      renderTick: interpolator.renderTick,
    });
  });

  app.ticker.add(
    (ticker) => stats.endFrame(ticker.deltaMS, performance.now() - frameStart),
    undefined,
    UPDATE_PRIORITY.UTILITY,
  );
}

void main();
