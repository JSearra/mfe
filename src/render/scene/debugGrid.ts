import { Container, Graphics } from 'pixi.js';
import { HALF_TILE_H, HALF_TILE_W, worldToScreenX, worldToScreenY } from '../../shared/iso.js';
import type { Camera } from '../camera.js';

/**
 * A flat reference grid, drawn once, so the camera can be seen working.
 *
 * Explicitly NOT the tilemap: no heightmap, no chunked RenderTexture bakes, no frustum
 * culling, no terrain textures. Phase 2 builds that. This exists only so Phase 1 has
 * something on screen to pan and zoom against.
 */

const COLOUR_GRID = 0x3a3226;
const COLOUR_AXIS_X = 0x8c5a32;
const COLOUR_AXIS_Y = 0x4a6a4a;
const COLOUR_ORIGIN = 0xc8a86a;

function diamond(graphics: Graphics, tileX: number, tileY: number): void {
  const cx = worldToScreenX(tileX + 0.5, tileY + 0.5);
  const cy = worldToScreenY(tileX + 0.5, tileY + 0.5, 0);

  graphics.moveTo(cx, cy - HALF_TILE_H);
  graphics.lineTo(cx + HALF_TILE_W, cy);
  graphics.lineTo(cx, cy + HALF_TILE_H);
  graphics.lineTo(cx - HALF_TILE_W, cy);
  graphics.closePath();
}

export function createDebugGrid(radius: number): Container {
  const container = new Container();

  const grid = new Graphics();
  for (let tileX = -radius; tileX <= radius; tileX++) {
    for (let tileY = -radius; tileY <= radius; tileY++) {
      diamond(grid, tileX, tileY);
    }
  }
  grid.stroke({ width: 1, color: COLOUR_GRID, alpha: 0.9 });
  container.addChild(grid);

  // Axes, so the projection's orientation is readable at a glance.
  const axes = new Graphics();
  axes.moveTo(worldToScreenX(0, 0), worldToScreenY(0, 0, 0));
  axes.lineTo(worldToScreenX(radius + 1, 0), worldToScreenY(radius + 1, 0, 0));
  axes.stroke({ width: 2, color: COLOUR_AXIS_X });

  axes.moveTo(worldToScreenX(0, 0), worldToScreenY(0, 0, 0));
  axes.lineTo(worldToScreenX(0, radius + 1), worldToScreenY(0, radius + 1, 0));
  axes.stroke({ width: 2, color: COLOUR_AXIS_Y });
  container.addChild(axes);

  const origin = new Graphics();
  diamond(origin, 0, 0);
  origin.fill({ color: COLOUR_ORIGIN, alpha: 0.35 });
  container.addChild(origin);

  return container;
}

/**
 * Push the camera onto the scene container as a single transform.
 *
 * One transform per frame rather than repositioning every tile — and it reproduces
 * worldToViewport exactly, so what the player clicks is what the camera maths says.
 */
export function applyCamera(container: Container, camera: Camera): void {
  container.scale.set(camera.zoom);
  container.position.set(
    -camera.x * camera.zoom + camera.viewportWidth / 2,
    -camera.y * camera.zoom + camera.viewportHeight / 2,
  );
}
