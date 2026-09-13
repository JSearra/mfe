import { Container, Graphics } from 'pixi.js';
import { HALF_TILE_H, HALF_TILE_W, worldToScreenX, worldToScreenY } from '../../shared/iso.js';
import type { Heightmap } from '../../shared/heightmap.js';
import { heightAt } from '../../shared/heightmap.js';
import type { Camera } from '../camera.js';
import { presentation } from '../presentation.js';

/**
 * Fog of war overlay.
 *
 * Drawn per chunk and rebuilt only when that chunk's fog actually changed. Fog updates
 * five times a second and a full map is 16,384 diamonds, so rebuilding everything on
 * every update would cost more than the rest of the frame put together — but in practice
 * only the chunks near a moving army change at all.
 *
 * Visible tiles draw nothing. Remembered ground is dimmed; unexplored ground is opaque.
 */

const FOG_UNEXPLORED = 0;
const FOG_EXPLORED = 1;

const { chunkSize } = presentation.terrain;

interface FogChunk {
  readonly graphics: Graphics;
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  /** Cheap checksum of this chunk's fog, so unchanged chunks are skipped. */
  checksum: number;
}

export interface FogRenderer {
  readonly container: Container;
  /** Hand in new fog data. Null means unchanged since last time. */
  setFog(fog: Uint8Array | null): void;
  update(camera: Camera): void;
  rebuiltLastFrame: number;
}

export function createFogRenderer(map: Heightmap): FogRenderer {
  const container = new Container();
  const chunks: FogChunk[] = [];
  let current: Uint8Array | null = null;
  let dirty = false;

  const chunksX = Math.ceil(map.width / chunkSize);
  const chunksY = Math.ceil(map.height / chunkSize);
  const maxLift = (map.levels - 1) * 8;

  for (let chunkY = 0; chunkY < chunksY; chunkY++) {
    for (let chunkX = 0; chunkX < chunksX; chunkX++) {
      const startX = chunkX * chunkSize;
      const startY = chunkY * chunkSize;
      const endX = Math.min(startX + chunkSize, map.width);
      const endY = Math.min(startY + chunkSize, map.height);
      const graphics = new Graphics();
      container.addChild(graphics);

      chunks.push({
        graphics,
        startX,
        startY,
        endX,
        endY,
        minX: worldToScreenX(startX, endY) - HALF_TILE_W,
        maxX: worldToScreenX(endX, startY) + HALF_TILE_W,
        minY: worldToScreenY(startX, startY, 0) - HALF_TILE_H - maxLift,
        maxY: worldToScreenY(endX, endY, 0) + HALF_TILE_H,
        checksum: -1,
      });
    }
  }

  function checksum(fog: Uint8Array, chunk: FogChunk): number {
    let hash = 0x811c9dc5;
    for (let y = chunk.startY; y < chunk.endY; y++) {
      const row = y * map.width;
      for (let x = chunk.startX; x < chunk.endX; x++) {
        hash = (Math.imul(hash ^ fog[row + x]!, 0x01000193) >>> 0);
      }
    }
    return hash;
  }

  function rebuild(fog: Uint8Array, chunk: FogChunk): void {
    const g = chunk.graphics;
    g.clear();

    for (let y = chunk.startY; y < chunk.endY; y++) {
      for (let x = chunk.startX; x < chunk.endX; x++) {
        const state = fog[y * map.width + x]!;
        if (state !== FOG_UNEXPLORED && state !== FOG_EXPLORED) continue;

        const height = heightAt(map, x, y);
        const cx = worldToScreenX(x + 0.5, y + 0.5);
        const cy = worldToScreenY(x + 0.5, y + 0.5, height < 0 ? 0 : height);

        g.moveTo(cx, cy - HALF_TILE_H);
        g.lineTo(cx + HALF_TILE_W, cy);
        g.lineTo(cx, cy + HALF_TILE_H);
        g.lineTo(cx - HALF_TILE_W, cy);
        g.closePath();
        g.fill({ color: 0x0b0906, alpha: state === FOG_UNEXPLORED ? 0.97 : 0.5 });
      }
    }
  }

  const renderer: FogRenderer = {
    container,
    rebuiltLastFrame: 0,

    setFog(fog: Uint8Array | null): void {
      if (fog === null) return;
      current = fog;
      dirty = true;
    },

    update(camera: Camera): void {
      renderer.rebuiltLastFrame = 0;
      if (current === null) return;

      const halfWidth = camera.viewportWidth / 2 / camera.zoom;
      const halfHeight = camera.viewportHeight / 2 / camera.zoom;
      const left = camera.x - halfWidth;
      const right = camera.x + halfWidth;
      const top = camera.y - halfHeight;
      const bottom = camera.y + halfHeight;

      for (const chunk of chunks) {
        const onScreen =
          chunk.maxX >= left && chunk.minX <= right && chunk.maxY >= top && chunk.minY <= bottom;
        chunk.graphics.visible = onScreen;
        if (!onScreen) continue;

        // Rebuilt lazily: a chunk off-screen when the fog changed is rebuilt when it
        // comes back into view, not before.
        const stamp = dirty || chunk.checksum === -1 ? checksum(current, chunk) : chunk.checksum;
        if (stamp === chunk.checksum) continue;

        rebuild(current, chunk);
        chunk.checksum = stamp;
        renderer.rebuiltLastFrame++;
      }
      dirty = false;
    },
  };

  return renderer;
}
