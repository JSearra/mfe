import type { Heightmap } from '../shared/heightmap.js';
import type { Camera } from '../render/camera.js';
import { screenToWorldX, screenToWorldY } from '../shared/iso.js';
import type { InterpolatedView } from '../render/interpolation.js';
import { presentation } from '../render/presentation.js';

/**
 * Top-down minimap.
 *
 * Top-down rather than isometric on purpose. An isometric minimap is prettier and worse:
 * a diamond wastes half its bounding box, and at this size the elevation cues that
 * justify the projection on the main view are illegible anyway. Players read a square.
 *
 * Drawn with a 2D canvas rather than through Pixi — it shares no state with the scene,
 * it updates at its own rate, and keeping it out of the render graph means it cannot
 * cost draw calls in the budget the terrain gate measures.
 */

const { size, unexploredColour, exploredDim, viewportColour, dotSize } = presentation.minimap;
const { palette } = presentation.terrain;

const FOG_UNEXPLORED = 0;
const FOG_EXPLORED = 1;
const KIND_CATTLE = 1;
const KIND_BUILDING = 2;

export interface Minimap {
  readonly element: HTMLCanvasElement;
  update(view: InterpolatedView | null, fog: Uint8Array | null, camera: Camera): void;
  dispose(): void;
}

export interface MinimapHandlers {
  /** The player clicked or dragged to a world position. */
  onSeek(worldX: number, worldY: number): void;
}

function parseHex(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function createMinimap(
  parent: HTMLElement,
  map: Heightmap,
  handlers: MinimapHandlers,
): Minimap {
  const element = document.createElement('canvas');
  element.className = 'minimap';
  element.width = size;
  element.height = size;
  parent.appendChild(element);

  const context = element.getContext('2d');
  const scale = size / map.width;

  // Terrain never changes, so it is painted once into an offscreen canvas and blitted.
  // Repainting 16,384 tiles every frame to draw a dozen dots on top would be absurd.
  const terrain = document.createElement('canvas');
  terrain.width = map.width;
  terrain.height = map.height;
  const terrainContext = terrain.getContext('2d');

  if (terrainContext !== null) {
    const image = terrainContext.createImageData(map.width, map.height);
    const colours = palette.map(parseHex);
    for (let i = 0; i < map.data.length; i++) {
      const [r, g, b] = colours[Math.min(map.data[i]!, colours.length - 1)] ?? [0, 0, 0];
      image.data[i * 4] = r;
      image.data[i * 4 + 1] = g;
      image.data[i * 4 + 2] = b;
      image.data[i * 4 + 3] = 255;
    }
    terrainContext.putImageData(image, 0, 0);
  }

  // Fog is repainted only when it changes, which is five times a second at most.
  const fogCanvas = document.createElement('canvas');
  fogCanvas.width = map.width;
  fogCanvas.height = map.height;
  const fogContext = fogCanvas.getContext('2d');
  let fogStamp: Uint8Array | null = null;

  function repaintFog(fog: Uint8Array): void {
    if (fogContext === null) return;
    const image = fogContext.createImageData(map.width, map.height);
    const [r, g, b] = parseHex(unexploredColour);

    for (let i = 0; i < fog.length; i++) {
      const state = fog[i]!;
      if (state === FOG_UNEXPLORED) {
        image.data[i * 4 + 3] = 255;
      } else if (state === FOG_EXPLORED) {
        image.data[i * 4 + 3] = Math.round(exploredDim * 255);
      } else {
        image.data[i * 4 + 3] = 0;
      }
      image.data[i * 4] = r;
      image.data[i * 4 + 1] = g;
      image.data[i * 4 + 2] = b;
    }
    fogContext.putImageData(image, 0, 0);
  }

  const seek = (event: PointerEvent): void => {
    const bounds = element.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * map.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * map.height;
    handlers.onSeek(x, y);
  };

  const onPointerDown = (event: PointerEvent): void => {
    element.setPointerCapture(event.pointerId);
    seek(event);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (element.hasPointerCapture(event.pointerId)) seek(event);
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);

  const factionColours = presentation.entities.factionColours;

  return {
    element,

    update(view, fog, camera): void {
      if (context === null) return;

      if (fog !== null && fog !== fogStamp) {
        repaintFog(fog);
        fogStamp = fog;
      }

      context.imageSmoothingEnabled = false;
      context.drawImage(terrain, 0, 0, size, size);

      if (view !== null) {
        for (let i = 0; i < view.count; i++) {
          const kind = view.kind[i]!;
          context.fillStyle =
            kind === KIND_CATTLE
              ? presentation.cattle.bodyColour
              : (factionColours[view.faction[i]! % factionColours.length] ?? '#ffffff');

          const px = view.x[i]! * scale;
          const py = view.y[i]! * scale;
          const radius = kind === KIND_BUILDING ? dotSize + 1 : dotSize;
          context.fillRect(px - radius / 2, py - radius / 2, radius, radius);
        }
      }

      if (fogStamp !== null) context.drawImage(fogCanvas, 0, 0, size, size);

      drawViewport(context, camera, scale);
    },

    dispose(): void {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
    },
  };
}

/**
 * The camera's footprint, drawn as the quadrilateral it actually is.
 *
 * The viewport is a rectangle in isometric screen space, which is a rotated square in
 * world space — drawing it as an axis-aligned box would put it in the wrong place at
 * every corner. The four corners are unprojected individually.
 */
function drawViewport(context: CanvasRenderingContext2D, camera: Camera, scale: number): void {
  const halfWidth = camera.viewportWidth / 2 / camera.zoom;
  const halfHeight = camera.viewportHeight / 2 / camera.zoom;

  const corners: [number, number][] = [
    [camera.x - halfWidth, camera.y - halfHeight],
    [camera.x + halfWidth, camera.y - halfHeight],
    [camera.x + halfWidth, camera.y + halfHeight],
    [camera.x - halfWidth, camera.y + halfHeight],
  ];

  context.beginPath();
  for (let i = 0; i < corners.length; i++) {
    const [isoX, isoY] = corners[i]!;
    // Unprojected at ground level through the shared inverse, so the minimap and the
    // world cannot drift apart if the tile dimensions ever change.
    const worldX = screenToWorldX(isoX, isoY, 0) * scale;
    const worldY = screenToWorldY(isoX, isoY, 0) * scale;
    if (i === 0) context.moveTo(worldX, worldY);
    else context.lineTo(worldX, worldY);
  }
  context.closePath();
  context.strokeStyle = viewportColour;
  context.lineWidth = 1;
  context.globalAlpha = 0.8;
  context.stroke();
  context.globalAlpha = 1;
}
