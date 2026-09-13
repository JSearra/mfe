import { Container, Graphics } from 'pixi.js';
import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import {
  ELEV_STEP,
  HALF_TILE_H,
  HALF_TILE_W,
  worldToScreenX,
  worldToScreenY,
} from '../../shared/iso.js';
import type { Camera } from '../camera.js';
import { presentation } from '../presentation.js';

/**
 * Chunked terrain renderer.
 *
 * Not RenderTexture bakes, despite ARCHITECTURE.md offering them as an option: a
 * 16x16 chunk's isometric bounding box is 1024x568px, so 64 chunks cost ~149MB of
 * VRAM at 1x and ~595MB at the devicePixelRatio 2 we actually render at. Retained
 * Graphics geometry gets the same "build once, draw cheap" property for kilobytes.
 * See docs/adr/0010-terrain-chunking-strategy.md.
 *
 * Culling is per chunk, not per tile — 64 bounding-box tests per frame instead of
 * 16,384.
 */

const { chunkSize, palette, eastFaceShade, southFaceShade, gridAlpha } = presentation.terrain;

interface Chunk {
  readonly graphics: Graphics;
  /** Isometric-space bounding box, computed once. */
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface TerrainRenderer {
  readonly container: Container;
  readonly chunkCount: number;
  visibleChunks: number;
  update(camera: Camera): void;
}

function shade(colour: number, factor: number): number {
  const r = Math.round(((colour >> 16) & 0xff) * factor);
  const g = Math.round(((colour >> 8) & 0xff) * factor);
  const b = Math.round((colour & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

const PALETTE = palette.map((hex) => Number.parseInt(hex.slice(1), 16));

function colourForLevel(level: number): number {
  return PALETTE[Math.min(level, PALETTE.length - 1)] ?? PALETTE[0]!;
}

/**
 * Draw one tile: its two camera-facing cliff faces, then its top surface.
 *
 * Only the east and south faces are ever visible. Both +x and +y move down-screen in
 * this projection, so those are the two sides turned toward the viewer; the north and
 * west faces are always hidden behind the tile's own top.
 */
function drawTile(graphics: Graphics, map: Heightmap, tileX: number, tileY: number): void {
  const level = map.data[tileY * map.width + tileX]!;
  const centreX = worldToScreenX(tileX + 0.5, tileY + 0.5);
  const centreY = worldToScreenY(tileX + 0.5, tileY + 0.5, level);

  // Diamond corners, matching the world corners (tx,ty), (tx+1,ty), (tx+1,ty+1), (tx,ty+1).
  const northY = centreY - HALF_TILE_H;
  const southY = centreY + HALF_TILE_H;
  const eastX = centreX + HALF_TILE_W;
  const westX = centreX - HALF_TILE_W;

  const base = colourForLevel(level);

  // East face: shared edge with (tileX+1, tileY), which is the lower-right edge.
  const eastNeighbour = heightAt(map, tileX + 1, tileY);
  const eastDrop = eastNeighbour < 0 ? level : level - eastNeighbour;
  if (eastDrop > 0) {
    const drop = eastDrop * ELEV_STEP;
    graphics.moveTo(eastX, centreY);
    graphics.lineTo(centreX, southY);
    graphics.lineTo(centreX, southY + drop);
    graphics.lineTo(eastX, centreY + drop);
    graphics.closePath();
    graphics.fill({ color: shade(base, eastFaceShade) });
  }

  // South face: shared edge with (tileX, tileY+1), the lower-left edge.
  const southNeighbour = heightAt(map, tileX, tileY + 1);
  const southDrop = southNeighbour < 0 ? level : level - southNeighbour;
  if (southDrop > 0) {
    const drop = southDrop * ELEV_STEP;
    graphics.moveTo(centreX, southY);
    graphics.lineTo(westX, centreY);
    graphics.lineTo(westX, centreY + drop);
    graphics.lineTo(centreX, southY + drop);
    graphics.closePath();
    graphics.fill({ color: shade(base, southFaceShade) });
  }

  graphics.moveTo(centreX, northY);
  graphics.lineTo(eastX, centreY);
  graphics.lineTo(centreX, southY);
  graphics.lineTo(westX, centreY);
  graphics.closePath();
  graphics.fill({ color: base });
  graphics.stroke({ width: 1, color: 0x000000, alpha: gridAlpha });
}

function buildChunk(map: Heightmap, chunkX: number, chunkY: number): Chunk {
  const graphics = new Graphics();
  const startX = chunkX * chunkSize;
  const startY = chunkY * chunkSize;
  const endX = Math.min(startX + chunkSize, map.width);
  const endY = Math.min(startY + chunkSize, map.height);

  // Painter's order within the chunk: increasing tileX + tileY draws back to front,
  // so a tile's top surface covers the cliff faces of whatever sits behind it.
  for (let sum = startX + startY; sum <= endX + endY - 2; sum++) {
    for (let tileX = startX; tileX < endX; tileX++) {
      const tileY = sum - tileX;
      if (tileY < startY || tileY >= endY) continue;
      drawTile(graphics, map, tileX, tileY);
    }
  }

  const maxLift = (map.levels - 1) * ELEV_STEP;
  return {
    graphics,
    minX: worldToScreenX(startX, endY) - HALF_TILE_W,
    maxX: worldToScreenX(endX, startY) + HALF_TILE_W,
    minY: worldToScreenY(startX, startY, 0) - HALF_TILE_H - maxLift,
    maxY: worldToScreenY(endX, endY, 0) + HALF_TILE_H,
  };
}

export function createTerrain(map: Heightmap): TerrainRenderer {
  const container = new Container();
  const chunksX = Math.ceil(map.width / chunkSize);
  const chunksY = Math.ceil(map.height / chunkSize);
  const chunks: Chunk[] = [];

  // Chunks are added back to front for the same reason tiles are.
  for (let sum = 0; sum <= chunksX + chunksY - 2; sum++) {
    for (let chunkX = 0; chunkX < chunksX; chunkX++) {
      const chunkY = sum - chunkX;
      if (chunkY < 0 || chunkY >= chunksY) continue;
      const chunk = buildChunk(map, chunkX, chunkY);
      chunks.push(chunk);
      container.addChild(chunk.graphics);
    }
  }

  const renderer: TerrainRenderer = {
    container,
    chunkCount: chunks.length,
    visibleChunks: 0,
    update(camera: Camera): void {
      const halfWidth = camera.viewportWidth / 2 / camera.zoom;
      const halfHeight = camera.viewportHeight / 2 / camera.zoom;
      const left = camera.x - halfWidth;
      const right = camera.x + halfWidth;
      const top = camera.y - halfHeight;
      const bottom = camera.y + halfHeight;

      let visible = 0;
      for (const chunk of chunks) {
        const onScreen =
          chunk.maxX >= left && chunk.minX <= right && chunk.maxY >= top && chunk.minY <= bottom;
        chunk.graphics.visible = onScreen;
        if (onScreen) visible++;
      }
      renderer.visibleChunks = visible;
    },
  };

  return renderer;
}
