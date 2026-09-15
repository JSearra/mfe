import { Container, Graphics, Sprite } from 'pixi.js';
import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import {
  ELEV_STEP,
  HALF_TILE_H,
  HALF_TILE_W,
  isCliff,
  worldToScreenX,
  worldToScreenY,
} from '../../shared/iso.js';
import type { Camera } from '../camera.js';
import { presentation } from '../presentation.js';
import type { TerrainTile, TerrainTiles } from '../assets.js';

/**
 * Chunked terrain renderer.
 *
 * Not RenderTexture bakes, despite ARCHITECTURE.md offering them as an option: a
 * 16x16 chunk's isometric bounding box is 1024x568px, so 64 chunks cost ~149MB of
 * VRAM at 1x and ~595MB at the devicePixelRatio 2 we actually render at. Retained
 * Graphics geometry gets the same "build once, draw cheap" property for kilobytes.
 * See docs/adr/0010-terrain-chunking-strategy.md.
 *
 * Culling is per chunk, not per tile — at the configured chunk size that is 16
 * bounding-box tests per frame instead of 16,384.
 *
 * Tile tops are sprites off a single page and cost about 5ms of p99 frame time at a
 * dozen visible chunks, against an 8ms budget: the traversal of ~12,000 sprites, not
 * the drawing of them. Smaller chunks do not help — measured, they cull no meaningful
 * extra work and cost a face draw call each, which took 38 visible chunks to 77 draw
 * calls. If this needs to come down, the lever is a ParticleContainer for the tops
 * rather than finer culling.
 */

const { chunkSize, palette, eastFaceShade, southFaceShade, gridAlpha } = presentation.terrain;

interface Chunk {
  readonly graphics: Graphics;
  readonly tops: Container;
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

/**
 * Scale a colour's channels, clamped.
 *
 * The clamp is not decoration. Every caller until now passed a factor below one, so an
 * overflowing channel was unreachable and the missing bound cost nothing — then the
 * cliff lip needed a factor of 1.18 to brighten an edge, a channel ran past 255 into the
 * next byte, and Pixi refused the result with "Unable to convert color 17819798". The
 * page rendered black: not a wrong colour, no picture at all.
 */
function channel(value: number, factor: number): number {
  const scaled = Math.round(value * factor);
  return scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
}

export function shade(colour: number, factor: number): number {
  return (
    (channel((colour >> 16) & 0xff, factor) << 16) |
    (channel((colour >> 8) & 0xff, factor) << 8) |
    channel(colour & 0xff, factor)
  );
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
/**
 * A stable per-tile hash. Hashed rather than taken from (x+y) so choices do not band
 * into diagonal stripes along the isometric axis, and deterministic so the ground does
 * not crawl between frames or differ between two players looking at the same map.
 */
function tileHash(tileX: number, tileY: number, salt: number): number {
  let hash = (tileX * 0x1f1f1f1f) ^ (tileY * 0x85ebca6b) ^ Math.imul(salt, 0x9e3779b9);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
  return (hash ^ (hash >>> 13)) >>> 0;
}

/**
 * Which height band's art to draw a tile with. Its own, now.
 *
 * It was not. A tile took a random neighbour's band 38% of the time, which scattered
 * each ground a tile or two into the other along every boundary. That was standing in
 * for a blend, and it does not read as one: two textures interleaved at random read as
 * static, not as ground giving way to ground — and it moved the art off the tile whose
 * height the geometry was drawn at, so a patch of high ground appeared in a hollow.
 *
 * The seam is handled properly now, by `transitionsFor` below, and this can be honest.
 */
function bandFor(map: Heightmap, tileX: number, tileY: number): number {
  return map.data[tileY * map.width + tileX]!;
}

/**
 * The four orthogonal neighbours, clockwise from the upper right.
 *
 * Isometric puts tile +x down-RIGHT and tile +y down-LEFT, so the tile-space neighbour
 * (x, y-1) is the diamond's upper-right EDGE rather than its top corner. The order here
 * is the bit order the transition masks were baked with; changing one without the other
 * paints the blend on the wrong side.
 */
const NEIGHBOUR_DX = [0, 1, 0, -1] as const;
const NEIGHBOUR_DY = [-1, 0, 1, 0] as const;

/**
 * Masks of the higher grounds bleeding onto this tile, indexed by band.
 *
 * The higher band always spills onto the lower, never the reverse, so each seam is
 * drawn exactly once — from the uphill side — and two tiles never both try to blend
 * into each other and double the alpha along the join.
 *
 * Returned as a sparse array so the common case, a tile with no boundary at all, costs
 * four height lookups and no allocation beyond it.
 */
function transitionsFor(map: Heightmap, tileX: number, tileY: number, out: number[]): number {
  const own = map.data[tileY * map.width + tileX]!;
  let found = 0;

  for (let bit = 0; bit < 4; bit++) {
    const neighbour = heightAt(map, tileX + NEIGHBOUR_DX[bit]!, tileY + NEIGHBOUR_DY[bit]!);
    if (neighbour <= own) continue;
    // Only where the two grounds actually meet. Across a cliff they do not: there is a
    // face between them, the upper surface is metres above and behind, and bleeding its
    // texture onto the floor below reads as a smear down the drop rather than as a
    // transition. A cliff is meant to be a hard edge — that is the whole of ADR-0006 —
    // and softening it would undo the one boundary that should be legible at a glance.
    if (isCliff(neighbour, own)) continue;
    if (out[neighbour] === undefined) {
      out[neighbour] = 0;
      found++;
    }
    out[neighbour]! |= 1 << bit;
  }
  return found;
}

function variantFor(tiles: readonly TerrainTile[], tileX: number, tileY: number): TerrainTile {
  return tiles[tileHash(tileX, tileY, 3) % tiles.length]!;
}

/**
 * A cliff face, drawn as strata rather than as one flat quad.
 *
 * Faces are NOT textured, and the measurement is the reason. A real map carries 2,634 of
 * them over 16,384 tiles, so sprites would add about a sixth again to a scene whose p99
 * already sits at 5.8ms of an 8ms budget — and worse, a face is anywhere from one to
 * seven levels tall, so a single texture would have to stretch (which smears) or tile
 * vertically (which in Pixi means a heavier object than a sprite). The cost is real and
 * the gain is a surface most often seen edge-on and in shadow.
 *
 * A band per elevation step costs no new display objects, because it is more geometry in
 * the Graphics that was being drawn anyway. It reads as rock bedding, and it does
 * something the flat quad could not: the number of bands IS the height, so how far a
 * drop goes is legible without counting tiles.
 */
function drawFace(
  graphics: Graphics,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  levels: number,
  base: number,
  faceShade: number,
  tileX: number,
  tileY: number,
): void {
  // A little per-tile variation so a long escarpment does not read as one printed sheet.
  // Hashed off the tile so it holds still between frames.
  let hash = (tileX * 0x27d4eb2d) ^ (tileY * 0x165667b1);
  hash = Math.imul(hash ^ (hash >>> 13), 0x85ebca6b);
  const jitter = (((hash >>> 16) & 0xff) / 255 - 0.5) * 0.06;

  for (let band = 0; band < levels; band++) {
    const top = band * ELEV_STEP;
    const bottom = top + ELEV_STEP;
    // Darker with depth: less sky reaches the bottom of a cut, and the gradient is what
    // stops a tall face reading as a painted wall.
    const depth = 1 - (band / Math.max(levels, 1)) * 0.34;
    graphics.moveTo(fromX, fromY + top);
    graphics.lineTo(toX, toY + top);
    graphics.lineTo(toX, toY + bottom);
    graphics.lineTo(fromX, fromY + bottom);
    graphics.closePath();
    graphics.fill({ color: shade(base, faceShade * depth + jitter) });
  }

  // The lip. A hard bright edge where the ground breaks away is most of what says
  // "cliff" rather than "slope" at this size.
  graphics.moveTo(fromX, fromY);
  graphics.lineTo(toX, toY);
  graphics.stroke({ width: 1, color: shade(base, 1.18), alpha: 0.7 });
}

/**
 * Draw one tile's faces into the chunk geometry and append its sprites to `out`.
 *
 * Appends rather than returns, because a boundary tile is a base sprite plus one
 * overlay per higher ground touching it, and a per-tile array would allocate sixteen
 * thousand of them to hold one element each.
 */
function drawTile(
  graphics: Graphics,
  map: Heightmap,
  tileX: number,
  tileY: number,
  tiles: TerrainTiles | null,
  out: Sprite[],
  bleed: number[],
): void {
  const level = map.data[tileY * map.width + tileX]!;
  const centreX = worldToScreenX(tileX + 0.5, tileY + 0.5);
  const centreY = worldToScreenY(tileX + 0.5, tileY + 0.5, level);

  // Diamond corners, matching the world corners (tx,ty), (tx+1,ty), (tx+1,ty+1), (tx,ty+1).
  const northY = centreY - HALF_TILE_H;
  const southY = centreY + HALF_TILE_H;
  const eastX = centreX + HALF_TILE_W;
  const westX = centreX - HALF_TILE_W;

  // Drawn with a possibly-borrowed band, but the geometry still uses the tile's real
  // level: borrowing art must not move the ground a unit walks on.
  const tile =
    tiles === null ? null : (variantFor(tiles.variants(bandFor(map, tileX, tileY)), tileX, tileY) ?? null);
  // The faces take the tile's own average colour rather than the palette's, so a flat
  // shaded cliff matches the textured surface it drops away from.
  const base = tile === null ? colourForLevel(level) : tile.colour;

  // East face: shared edge with (tileX+1, tileY), which is the lower-right edge.
  const eastNeighbour = heightAt(map, tileX + 1, tileY);
  const eastDrop = eastNeighbour < 0 ? level : level - eastNeighbour;
  if (eastDrop > 0) {
    drawFace(graphics, eastX, centreY, centreX, southY, eastDrop, base, eastFaceShade, tileX, tileY);
  }

  // South face: shared edge with (tileX, tileY+1), the lower-left edge.
  const southNeighbour = heightAt(map, tileX, tileY + 1);
  const southDrop = southNeighbour < 0 ? level : level - southNeighbour;
  if (southDrop > 0) {
    drawFace(graphics, centreX, southY, westX, centreY, southDrop, base, southFaceShade, tileX, tileY);
  }

  graphics.moveTo(centreX, northY);
  graphics.lineTo(eastX, centreY);
  graphics.lineTo(centreX, southY);
  graphics.lineTo(westX, centreY);
  graphics.closePath();
  if (tile === null || tiles === null) {
    graphics.fill({ color: base });
    graphics.stroke({ width: 1, color: 0x000000, alpha: gridAlpha });
    return;
  }

  // Untextured, the diamond is only needed to close the path the faces were drawn with;
  // the sprite covers it. Filling it anyway would show through the tile's own alpha at
  // the diamond edge, which is what the grid stroke used to hide.
  graphics.fill({ color: base, alpha: 0 });

  const sprite = new Sprite(tile.texture);
  sprite.position.set(westX, northY);
  out.push(sprite);

  // Higher ground bleeding over the seam. Same page as the tile under it, so these cost
  // sprites but not a draw call, and only boundary tiles have any.
  bleed.length = 0;
  if (transitionsFor(map, tileX, tileY, bleed) > 0) {
    for (let band = 0; band < bleed.length; band++) {
      const mask = bleed[band];
      if (mask === undefined) continue;
      const blend = tiles.transition(band, mask);
      if (blend === null) continue;
      const overlay = new Sprite(blend.texture);
      overlay.position.set(westX, northY);
      out.push(overlay);
    }
  }
}

function buildChunk(
  map: Heightmap,
  chunkX: number,
  chunkY: number,
  tiles: TerrainTiles | null,
): Chunk {
  const graphics = new Graphics();
  const tops = new Container();
  // Reused across every tile in the chunk; drawTile appends and we drain.
  const sprites: Sprite[] = [];
  const bleed: number[] = [];
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
      sprites.length = 0;
      drawTile(graphics, map, tileX, tileY, tiles, sprites, bleed);
      for (const sprite of sprites) tops.addChild(sprite);
    }
  }

  const maxLift = (map.levels - 1) * ELEV_STEP;
  return {
    graphics,
    tops,
    minX: worldToScreenX(startX, endY) - HALF_TILE_W,
    maxX: worldToScreenX(endX, startY) + HALF_TILE_W,
    minY: worldToScreenY(startX, startY, 0) - HALF_TILE_H - maxLift,
    maxY: worldToScreenY(endX, endY, 0) + HALF_TILE_H,
  };
}

export function createTerrain(map: Heightmap, tiles: TerrainTiles | null = null): TerrainRenderer {
  const container = new Container();
  const chunksX = Math.ceil(map.width / chunkSize);
  const chunksY = Math.ceil(map.height / chunkSize);
  const chunks: Chunk[] = [];

  // Two layers spanning every chunk, not two layers inside each chunk.
  //
  // Every face belongs under every top. A face drops down-screen, into the ground of
  // the tiles in FRONT of it, and those are exactly the tops that must cover it;
  // nothing behind a face is ever occluded by it. So the split can be global, and it
  // has to be: interleaving a Graphics with sprites chunk by chunk breaks the sprite
  // batch at every chunk boundary, which took 38 visible chunks to 114 draw calls
  // against a budget of 60. Split globally, the faces batch among themselves and the
  // tops batch among themselves however many chunks are on screen.
  const faceLayer = new Container();
  const topLayer = new Container();
  container.addChild(faceLayer);
  container.addChild(topLayer);

  // Chunks are added back to front for the same reason tiles are.
  for (let sum = 0; sum <= chunksX + chunksY - 2; sum++) {
    for (let chunkX = 0; chunkX < chunksX; chunkX++) {
      const chunkY = sum - chunkX;
      if (chunkY < 0 || chunkY >= chunksY) continue;
      const chunk = buildChunk(map, chunkX, chunkY, tiles);
      chunks.push(chunk);
      faceLayer.addChild(chunk.graphics);
      topLayer.addChild(chunk.tops);
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
        chunk.tops.visible = onScreen;
        if (onScreen) visible++;
      }
      renderer.visibleChunks = visible;
    },
  };

  return renderer;
}
