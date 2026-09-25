import { Graphics } from 'pixi.js';
import { heightAt, isShore, isWater, type Heightmap } from '../../shared/heightmap.js';
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

/**
 * Where an armed building would stand, and whether it can.
 *
 * A refused site used to be discovered by clicking and seeing nothing appear; now a
 * refusal is at least explained, but a player still had to click to find out. This
 * draws the footprint under the pointer, green where it can stand and red where it
 * cannot, before the click.
 *
 * Judged render-side, from the renderer's own copy of the map and the buildings in the
 * snapshot — never a read into the simulation. So it mirrors the placement rules rather
 * than asking them: the simulation still decides, and says why if it disagrees (for
 * instance a cow standing in the way is not modelled here).
 */
export interface FootprintCheck {
  /** Square footprint, in tiles. */
  readonly size: number;
  /** How far heights may differ across the footprint. */
  readonly maxHeightVariation: number;
  /** A weir: some tile of the footprint must stand on a bank. */
  readonly needsWater: boolean;
  /** False when the village cannot pay for it right now. */
  readonly affordable: boolean;
}

export function footprintFits(
  map: Heightmap,
  tileX: number,
  tileY: number,
  check: FootprintCheck,
  taken: ReadonlySet<number>,
): boolean {
  if (!check.affordable) return false;
  let low = Infinity;
  let high = -Infinity;
  let bank = false;
  for (let dy = 0; dy < check.size; dy++) {
    for (let dx = 0; dx < check.size; dx++) {
      const x = tileX + dx;
      const y = tileY + dy;
      const level = heightAt(map, x, y);
      if (level < 0 || isWater(map, x, y) || taken.has(y * map.width + x)) return false;
      if (level < low) low = level;
      if (level > high) high = level;
      if (isShore(map, x, y)) bank = true;
    }
  }
  if (high - low > check.maxHeightVariation) return false;
  return !check.needsWater || bank;
}

export function drawFootprint(
  graphics: Graphics,
  map: Heightmap,
  tileX: number,
  tileY: number,
  size: number,
  fits: boolean,
): void {
  graphics.clear();
  const colour = fits ? 0x9ec86a : 0xd9573a;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const x = tileX + dx;
      const y = tileY + dy;
      const level = heightAt(map, x, y);
      if (level < 0) continue;
      const cx = worldToScreenX(x + 0.5, y + 0.5);
      const cy = worldToScreenY(x + 0.5, y + 0.5, level);
      graphics.moveTo(cx, cy - HALF_TILE_H);
      graphics.lineTo(cx + HALF_TILE_W, cy);
      graphics.lineTo(cx, cy + HALF_TILE_H);
      graphics.lineTo(cx - HALF_TILE_W, cy);
      graphics.closePath();
    }
  }
  graphics.fill({ color: colour, alpha: 0.28 });
  graphics.stroke({ width: 2, color: colour, alpha: 0.9 });
  graphics.visible = true;
}
