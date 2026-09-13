import { Graphics } from 'pixi.js';
import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import { HALF_TILE_H, HALF_TILE_W, worldToScreenX, worldToScreenY } from '../../shared/iso.js';
import { presentation } from '../presentation.js';

/**
 * Isometric highlight on the hovered tile.
 *
 * Drawn once as a unit diamond and then moved, rather than rebuilt each frame — the
 * shape never changes, only where it sits.
 */
export function createTileCursor(): Graphics {
  const colour = Number.parseInt(presentation.terrain.cursorColour.slice(1), 16);
  const cursor = new Graphics();

  cursor.moveTo(0, -HALF_TILE_H);
  cursor.lineTo(HALF_TILE_W, 0);
  cursor.lineTo(0, HALF_TILE_H);
  cursor.lineTo(-HALF_TILE_W, 0);
  cursor.closePath();
  cursor.fill({ color: colour, alpha: 0.14 });
  cursor.stroke({ width: 2, color: colour, alpha: 0.85 });
  cursor.visible = false;

  return cursor;
}

export function placeTileCursor(
  cursor: Graphics,
  map: Heightmap,
  tileX: number,
  tileY: number,
): void {
  const level = heightAt(map, tileX, tileY);
  if (level < 0) {
    cursor.visible = false;
    return;
  }

  cursor.visible = true;
  cursor.position.set(
    worldToScreenX(tileX + 0.5, tileY + 0.5),
    worldToScreenY(tileX + 0.5, tileY + 0.5, level),
  );
}
