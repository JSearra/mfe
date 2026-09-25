import { Container, Graphics, Mesh, MeshGeometry } from 'pixi.js';
import { heightAt, isWater, type Heightmap } from '../../shared/heightmap.js';
import {
  ELEV_STEP,
  HALF_TILE_H,
  HALF_TILE_W,
  MAX_CLIMB,
  worldToScreenX,
  worldToScreenY,
} from '../../shared/iso.js';
import type { Camera } from '../camera.js';
import { presentation } from '../presentation.js';
import type { TerrainTile, TerrainTiles } from '../assets.js';
import { CORNER_COUNT, tileCorners } from './surface.js';
import { blendVariant, groundBand } from './terrainBand.js';
import { createGroundField } from './ground.js';
import {
  cornerSeams,
  edgeSeams,
  landSeams,
  SEAM_CORNERS,
  smoothWaterDepth,
} from './seams.js';
import { cornerPositions, faceTrapezoid, QUAD_FLOATS } from './terrainGeometry.js';

/**
 * Chunked terrain renderer.
 *
 * Not RenderTexture bakes, despite ARCHITECTURE.md offering them as an option: a
 * 16x16 chunk's isometric bounding box is 1024x568px, so 64 chunks cost ~149MB of
 * VRAM at 1x and ~595MB at the devicePixelRatio 2 we actually render at. Retained
 * geometry gets the same "build once, draw cheap" property for kilobytes.
 * See docs/adr/0010-terrain-chunking-strategy.md.
 *
 * Culling is per chunk, not per tile — at the configured chunk size that is 16
 * bounding-box tests per frame instead of 16,384.
 *
 * ## The ground is a mesh, not a field of diamonds
 *
 * Tile tops were a sprite each, laid flat at the tile's own integer height. Flat
 * diamonds cannot express a slope, so every height change however small had to be a
 * vertical face — and with `MAX_CLIMB` at 1 and `ELEV_STEP` at 8px against a 32px tile,
 * every one-level contour on a rolling map was a quarter-tile wall with a lit lip on
 * it. The contours are everywhere, so the walls were: the ground ended at a right angle
 * wherever it changed at all.
 *
 * Now each tile is a quad whose four corners carry their own height, from
 * `surface.tileCorners`, so a walkable step is a ramp. Corners touching a real cliff
 * snap back to their tile's height and the face between the two grounds survives, which
 * is ADR-0006's hard edge kept exactly where it earns its keep.
 *
 * The simulation is untouched by all of this. It keeps one integer height per tile;
 * movement cost, pathing, line of sight and picking all read that and are unchanged.
 * This is a reading of the same data, not a second copy of it.
 *
 * One mesh per chunk rather than a sprite per tile also happens to be much cheaper.
 * The sprite path spent about 5ms of an 8ms p99 budget on traversing ~12,000 sprites
 * rather than on drawing them; a chunk is now one object and one draw call, because
 * every tile on the map indexes into the same page.
 */

const { chunkSize, palette, eastFaceShade, southFaceShade, gridAlpha } = presentation.terrain;
/** Open water, and the lighter margin where it meets a bank. */
const waterColour = Number.parseInt(presentation.terrain.water.slice(1), 16);
const waterEdgeColour = Number.parseInt(presentation.terrain.waterEdge.slice(1), 16);

/**
 * Water's colour, run from the margin into the channel by how enclosed the tile is.
 *
 * It used to be a choice between two colours on "are all four square neighbours wet",
 * and on a river a tile or two wide NO tile satisfies that — so every tile in the river
 * took the margin colour, with the occasional one that did not, and the water read as a
 * strip of alternating light and dark diamonds rather than as a river. Eight neighbours
 * and a ramp instead, so a channel darkens toward its middle and a wide pan still has a
 * pale rim.
 */
function waterFill(depth: number): number {
  const t = depth / 8;
  return mix(waterEdgeColour, waterColour, t * t);
}

/** Blend two packed colours. Squared above, so the rim keeps its width on a wide body. */
function mix(from: number, to: number, t: number): number {
  const lerp = (shift: number): number => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    const value = Math.round(a + (b - a) * t);
    return value < 0 ? 0 : value > 255 ? 255 : value;
  };
  return (lerp(16) << 16) | (lerp(8) << 8) | lerp(0);
}

interface Chunk {
  readonly graphics: Graphics;
  /**
   * Tile tops and the seam blends over them, in one mesh.
   *
   * One rather than two, and the draw-call budget is the reason. A chunk's geometry is
   * far too large for Pixi to batch it with anything, so every mesh is a draw call of
   * its own: a base and an overlay layer put twelve visible chunks at 59 calls against
   * a budget of 60. Triangles rasterise in index order within a single draw, so
   * appending every overlay quad after every base quad in the same buffer keeps the
   * blends above the ground they bleed onto for free.
   *
   * Null on a map with no terrain page, which falls back to filled diamonds.
   */
  readonly tops: Mesh | null;
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
  /**
   * Show the ground at a point on the season ramp, 0 wet to 2 drought (Phase B5).
   *
   * The tops re-tone through the tile page (`TerrainTiles.setSeason`). The cliff faces
   * are flat colours taken from each tile's wet average, so they are tinted toward the
   * season instead — the one place this is a tint, and on the smallest thing on screen.
   */
  setSeason(position: number): void;
}

/**
 * Where on the season ramp a drought reading falls: 0 the rains, 1 the dry season, 2
 * drought.
 *
 * Held at each end rather than sliding the whole way, so the veld is plainly green
 * through the wet months and plainly gold at the height of the dry, and the change is
 * spent crossing between them. Thresholds in tuning/presentation.json — the simulation
 * never reads what colour its grass is.
 */
export function seasonPosition(drought: number): number {
  const r = presentation.terrain.seasonRamp;
  if (drought <= r.wetUntil) return 0;
  if (drought < r.dryFrom) return (drought - r.wetUntil) / (r.dryFrom - r.wetUntil);
  if (drought <= r.dryUntil) return 1;
  if (drought < r.droughtFrom) return 1 + (drought - r.dryUntil) / (r.droughtFrom - r.dryUntil);
  return 2;
}

/** A packed colour from '#rrggbb'. */
function parseColour(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

/** Channel-wise blend of two packed colours. */
function blendColour(a: number, b: number, t: number): number {
  const mix = (shift: number): number =>
    Math.round(((a >> shift) & 0xff) * (1 - t) + ((b >> shift) & 0xff) * t) << shift;
  return mix(16) | mix(8) | mix(0);
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
 * Which height band's art to draw a tile with. Its own.
 *
 * It was not always. A tile took a random neighbour's band 38% of the time, which
 * scattered each ground a tile or two into the other along every boundary. That was
 * standing in for a blend, and it does not read as one: two textures interleaved at
 * random read as static, not as ground giving way to ground — and it moved the art off
 * the tile whose height the geometry was drawn at, so a patch of high ground appeared
 * in a hollow. The seam is handled by `transitionsFor` below, so this can be honest.
 */
function bandFor(map: Heightmap, ground: Uint8Array, tileX: number, tileY: number, shift: number): number {
  return groundBand(ground[tileY * map.width + tileX]!, shift, map.levels);
}

function variantFor(tiles: readonly TerrainTile[], tileX: number, tileY: number): TerrainTile {
  return tiles[tileHash(tileX, tileY, 3) % tiles.length]!;
}

/**
 * A cliff face, drawn as strata rather than as one flat quad.
 *
 * Faces are NOT textured, and the measurement is the reason. Sprites would add about a
 * sixth again to a scene already near its p99 budget, and worse, a face is anywhere
 * from one to seven levels tall, so a single texture would have to stretch (which
 * smears) or tile vertically. The cost is real and the gain is a surface most often
 * seen edge-on and in shadow.
 *
 * A band per elevation step costs no new display objects, because it is more geometry
 * in the Graphics that was being drawn anyway. It reads as rock bedding, and it does
 * something the flat quad could not: the number of bands IS the height, so how far a
 * drop goes is legible without counting tiles.
 *
 * **It is a trapezoid now, not a rectangle.** The ground above it is a mesh whose
 * corners carry their own heights, so the two ends of a face are rarely the same
 * length: it is the gap between one surface and the next, and taking its top and bottom
 * from those surfaces is what guarantees it fills the gap exactly rather than
 * approximately.
 */
function drawFace(
  graphics: Graphics,
  nearX: number,
  nearTopY: number,
  nearBottomY: number,
  farX: number,
  farTopY: number,
  farBottomY: number,
  base: number,
  faceShade: number,
  tileX: number,
  tileY: number,
): void {
  const nearDrop = nearBottomY - nearTopY;
  const farDrop = farBottomY - farTopY;
  const deepest = nearDrop > farDrop ? nearDrop : farDrop;
  if (deepest <= 0) return;

  // A little per-tile variation so a long escarpment does not read as one printed sheet.
  // Hashed off the tile so it holds still between frames.
  let hash = (tileX * 0x27d4eb2d) ^ (tileY * 0x165667b1);
  hash = Math.imul(hash ^ (hash >>> 13), 0x85ebca6b);
  const jitter = (((hash >>> 16) & 0xff) / 255 - 0.5) * 0.06;

  const bands = Math.ceil(deepest / ELEV_STEP);
  for (let band = 0; band < bands; band++) {
    const from = band * ELEV_STEP;
    const to = from + ELEV_STEP;
    // Each end is clipped to its OWN drop, so a face that runs out on one side tapers
    // to a point there instead of hanging past the ground it is supposed to meet.
    const nearFrom = from < nearDrop ? from : nearDrop;
    const nearTo = to < nearDrop ? to : nearDrop;
    const farFrom = from < farDrop ? from : farDrop;
    const farTo = to < farDrop ? to : farDrop;
    if (nearTo <= nearFrom && farTo <= farFrom) continue;

    // Darker with depth: less sky reaches the bottom of a cut, and the gradient is what
    // stops a tall face reading as a painted wall.
    const depth = 1 - (band / bands) * 0.34;
    graphics.moveTo(nearX, nearTopY + nearFrom);
    graphics.lineTo(farX, farTopY + farFrom);
    graphics.lineTo(farX, farTopY + farTo);
    graphics.lineTo(nearX, nearTopY + nearTo);
    graphics.closePath();
    graphics.fill({ color: shade(base, faceShade * depth + jitter) });
  }

  // The lip, and only on a real cliff.
  //
  // A hard bright edge where the ground breaks away is most of what says "cliff" rather
  // than "slope" at this size — which is exactly why it must not appear on a slope. The
  // mesh leaves small faces behind wherever a snapped corner meets an averaged one, a
  // few pixels tall and no part of any cliff, and lipping those would put back the
  // bright line at every contour that this whole change exists to remove.
  if (deepest <= MAX_CLIMB * ELEV_STEP) return;
  graphics.moveTo(nearX, nearTopY);
  graphics.lineTo(farX, farTopY);
  graphics.stroke({ width: 1, color: shade(base, 1.18), alpha: 0.7 });
}

/** Vertex and index arrays under construction for one chunk's mesh. */
interface MeshBuild {
  readonly positions: number[];
  readonly uvs: number[];
  readonly indices: number[];
}

function emptyBuild(): MeshBuild {
  return { positions: [], uvs: [], indices: [] };
}

/**
 * Append one tile's quad.
 *
 * Two triangles off the shared north-south diagonal. A quad whose four corners are not
 * coplanar has to fold somewhere; folding it along the diamond's long axis puts the
 * seam where the slope is already changing rather than across it.
 */
function pushQuad(build: MeshBuild, corners: Float32Array, uv: Float32Array): void {
  const first = build.positions.length / 2;
  for (let i = 0; i < QUAD_FLOATS; i++) {
    build.positions.push(corners[i]!);
    build.uvs.push(uv[i]!);
  }
  build.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
}

/**
 * The seam blends appended after every tile top, in one set of buffers.
 *
 * Index order is draw order inside a single mesh, so this is the whole of the layering:
 * every base quad is rasterised before every overlay quad, and a blend is therefore
 * always over the ground it bleeds onto rather than under it.
 */
function concat(base: MeshBuild, overlay: MeshBuild): MeshBuild {
  const offset = base.positions.length / 2;
  for (const value of overlay.positions) base.positions.push(value);
  for (const value of overlay.uvs) base.uvs.push(value);
  for (const index of overlay.indices) base.indices.push(index + offset);
  return base;
}

function buildMesh(build: MeshBuild, tiles: TerrainTiles): Mesh | null {
  if (build.indices.length === 0) return null;
  const geometry = new MeshGeometry({
    positions: new Float32Array(build.positions),
    uvs: new Float32Array(build.uvs),
    indices: new Uint32Array(build.indices),
  });
  return new Mesh({ geometry, texture: tiles.page });
}

/**
 * Draw one tile: the gaps between it and the neighbours in front of it, then its top.
 *
 * Only the east and south sides can show a face. Both +x and +y move down-screen in
 * this projection, so those are the two turned toward the viewer; the north and west
 * sides are always hidden behind the tile's own top.
 */
function drawTile(
  graphics: Graphics,
  map: Heightmap,
  tileX: number,
  tileY: number,
  tiles: TerrainTiles | null,
  base: MeshBuild,
  overlay: MeshBuild,
  scratch: TileScratch,
  bandShift: number,
  ground: Uint8Array,
): void {
  const level = map.data[tileY * map.width + tileX]!;
  const { corners, positions, neighbourCorners, bleed, corner } = scratch;
  // Which cut of each mask this tile uses. One cut per configuration stamps the same
  // meander tile after tile along a straight seam, which reads as a scalloped sawtooth.
  // Hoisted above the water branch, which needs it too now that a bank creeps in.
  const cut = blendVariant(tileX, tileY);

  tileCorners(map, tileX, tileY, corners);
  cornerPositions(tileX, tileY, corners, positions);

  const northX = positions[0]!;
  const northY = positions[1]!;
  const eastX = positions[2]!;
  const eastY = positions[3]!;
  const southX = positions[4]!;
  const southY = positions[5]!;
  const westX = positions[6]!;
  const westY = positions[7]!;

  /*
   * Water is painted, not textured.
   *
   * Every terrain band has generated art behind it; water has none, and inventing a
   * riverbed texture for it would be worse than a flat colour — at this scale a river
   * reads as a colour and a shape, and a textured one would read as more dry ground.
   * Shallows at the margin so a bank has an edge rather than a hard seam against it.
   */
  if (isWater(map, tileX, tileY)) {
    graphics.moveTo(northX, northY);
    graphics.lineTo(eastX, eastY);
    graphics.lineTo(southX, southY);
    graphics.lineTo(westX, westY);
    graphics.closePath();
    graphics.fill({ color: waterFill(smoothWaterDepth(map, tileX, tileY)) });

    /*
     * Ripples over the fill, as an overlay in the top mesh.
     *
     * The fill alone was a plastic sheet — a luminance spread of 1.5 against 15 to 21
     * for land. Varying the fill per tile brings back the quilt of blue lozenges that
     * `smoothWaterDepth` was written to remove, so the variation is inside the tile:
     * white glints and dark troughs at low alpha, from one continuous field that repeats
     * every few tiles. The depth-shaded colour underneath is untouched. Into `base`, so
     * the banks bleeding in below still draw over it.
     */
    const surface = tiles?.waterSurface(tileX, tileY) ?? null;
    if (surface !== null) pushQuad(base, positions, surface.uv);

    /*
     * And the bank creeping in over it.
     *
     * A shore is two grounds meeting. The land beside water already gets a bank drawn
     * on it, and nothing was ever drawn on the water — so its own edge stayed a dead
     * diamond and a river read as a staircase of blue lozenges however good the far
     * side was. These are the same dissolving masks every other seam uses, carrying the
     * neighbour's OWN ground, so the margin matches the country standing behind it.
     */
    if (tiles !== null) {
      bleed.length = 0;
      if (landSeams(map, ground, tileX, tileY, bleed) > 0) {
        for (let band = 0; band < bleed.length; band++) {
          const mask = bleed[band];
          if (mask === undefined) continue;
          const blend = tiles.transition(groundBand(band, bandShift, map.levels), mask, cut);
          if (blend !== null) pushQuad(overlay, positions, blend.uv);
        }
      }
    }
    return;
  }

  const tile =
    tiles === null
      ? null
      : (variantFor(tiles.variants(bandFor(map, ground, tileX, tileY, bandShift)), tileX, tileY) ?? null);
  // The faces take the tile's own average colour rather than the palette's, so a flat
  // shaded cliff matches the textured surface it drops away from.
  const faceColour = tile === null ? colourForLevel(level) : tile.colour;

  // East side: shared edge with (tileX+1, tileY), the lower-right one. This tile's east
  // and south corners meet that tile's north and west corners at the same two world
  // points, so any disagreement between them is a gap to be filled.
  faceAgainst(
    graphics, map, tileX, tileY, 1, 0,
    eastX, eastY, southX, southY,
    corners[1]!, corners[2]!, 0, 3,
    faceColour, eastFaceShade, neighbourCorners,
  );

  // South side: shared edge with (tileX, tileY+1), the lower-left one. This tile's
  // south and west corners meet that tile's east and north corners.
  faceAgainst(
    graphics, map, tileX, tileY, 0, 1,
    southX, southY, westX, westY,
    corners[2]!, corners[3]!, 1, 0,
    faceColour, southFaceShade, neighbourCorners,
  );

  if (tile === null || tiles === null) {
    graphics.moveTo(northX, northY);
    graphics.lineTo(eastX, eastY);
    graphics.lineTo(southX, southY);
    graphics.lineTo(westX, westY);
    graphics.closePath();
    graphics.fill({ color: faceColour });
    graphics.stroke({ width: 1, color: 0x000000, alpha: gridAlpha });
    return;
  }

  pushQuad(base, positions, tile.uv);

  /*
   * No bank on the land side of water (plan V5).
   *
   * There was one: a pebbled riverbed ground laid over every land tile touching water,
   * written when water had no blend of its own and a waterline's whole softness had to
   * live on the land. Water has since had the land's own ground bleeding in over its
   * edge ("the bank creeping in", above), and the pebble bank became the defect: a
   * grey-olive lozenge on every tile beside a river, stepping down each bank in whole
   * diamonds. Measured on the changed pixels, it took the ground from saturation 0.63
   * to 0.42 on the veld and 0.50 to 0.39 on uMfolozi. Without it the ground runs to the
   * water in its own colour and the waterline is the dissolve's meander.
   */

  // Higher ground bleeding over the seams. Same page as the tile under it, so these
  // cost vertices but not a draw call, and only boundary tiles have any.
  bleed.length = 0;
  if (edgeSeams(map, ground, tileX, tileY, bleed) > 0) {
    for (let band = 0; band < bleed.length; band++) {
      const mask = bleed[band];
      if (mask === undefined) continue;
      // Shifted like the base tile: a seam is the neighbouring GROUND bleeding over,
      // and it has to be the same ground the neighbour is actually drawn with.
      const blend = tiles.transition(groundBand(band, bandShift, map.levels), mask, cut);
      if (blend === null) continue;
      pushQuad(overlay, positions, blend.uv);
    }
  }

  // And the diagonals. Ground that meets this tile at a single point contributed
  // nothing before, so every diagonal boundary on the map ended in a sharp notch where
  // the two edge blends beside it stopped.
  if (cornerSeams(map, ground, tileX, tileY, corner) > 0) {
    for (let at = 0; at < SEAM_CORNERS; at++) {
      const band = corner[at]!;
      if (band < 0) continue;
      const wedge = tiles.corner(groundBand(band, bandShift, map.levels), at, cut);
      if (wedge === null) continue;
      pushQuad(overlay, positions, wedge.uv);
    }
  }
}

/**
 * Fill the gap between one edge of this tile and the neighbour across it.
 *
 * The neighbour's corners are recomputed rather than cached. It is four height lookups
 * and an average, it happens once when a chunk is built and never again, and the
 * alternative — a second surface array the size of the map, kept in step with this one
 * — is a cache that can go stale in a renderer that has no other mutable state.
 */
function faceAgainst(
  graphics: Graphics,
  map: Heightmap,
  tileX: number,
  tileY: number,
  stepX: number,
  stepY: number,
  nearX: number,
  nearTopY: number,
  farX: number,
  farTopY: number,
  ourNearH: number,
  ourFarH: number,
  theirNear: number,
  theirFar: number,
  colour: number,
  faceShade: number,
  neighbourCorners: Float64Array,
): void {
  const neighbourX = tileX + stepX;
  const neighbourY = tileY + stepY;
  const own = heightAt(map, tileX, tileY);

  let nearBottomY: number;
  let farBottomY: number;

  if (heightAt(map, neighbourX, neighbourY) < 0) {
    // Off the map. The ground has to end somewhere and a floating slab reads worse than
    // a skirt, so the edge drops to level zero.
    nearBottomY = nearTopY + own * ELEV_STEP;
    farBottomY = farTopY + own * ELEV_STEP;
  } else {
    tileCorners(map, neighbourX, neighbourY, neighbourCorners);
    // Their corner heights against ours at the SAME two world points. A face exists
    // exactly where the two surfaces disagree, which is what keeps it from ever being
    // too short (a crack) or too long (an apron over the ground in front).
    if (!faceTrapezoid(ourNearH, ourFarH, neighbourCorners[theirNear]!, neighbourCorners[theirFar]!)) {
      return;
    }
    nearBottomY = nearTopY + (ourNearH - neighbourCorners[theirNear]!) * ELEV_STEP;
    farBottomY = farTopY + (ourFarH - neighbourCorners[theirFar]!) * ELEV_STEP;
  }

  drawFace(
    graphics,
    nearX, nearTopY, nearBottomY,
    farX, farTopY, farBottomY,
    colour, faceShade, tileX, tileY,
  );
}

/** Buffers reused across every tile in a chunk, so building one allocates nothing per tile. */
interface TileScratch {
  readonly corners: Float64Array;
  readonly neighbourCorners: Float64Array;
  readonly positions: Float32Array;
  readonly bleed: number[];
  readonly corner: Int8Array;
}

function buildChunk(
  map: Heightmap,
  chunkX: number,
  chunkY: number,
  tiles: TerrainTiles | null,
  bandShift: number,
  ground: Uint8Array,
): Chunk {
  const graphics = new Graphics();
  const base = emptyBuild();
  const overlay = emptyBuild();
  const scratch: TileScratch = {
    corners: new Float64Array(CORNER_COUNT),
    neighbourCorners: new Float64Array(CORNER_COUNT),
    positions: new Float32Array(QUAD_FLOATS),
    bleed: [],
    corner: new Int8Array(SEAM_CORNERS),
  };
  const startX = chunkX * chunkSize;
  const startY = chunkY * chunkSize;
  const endX = Math.min(startX + chunkSize, map.width);
  const endY = Math.min(startY + chunkSize, map.height);

  // Painter's order within the chunk, for the FACES. The tops no longer need it: every
  // tile shares its corners exactly with the tiles beside it, so the quads tessellate
  // the screen and none of them overlaps another. Faces still drop into the ground in
  // front of them and still have to be drawn behind it.
  for (let sum = startX + startY; sum <= endX + endY - 2; sum++) {
    for (let tileX = startX; tileX < endX; tileX++) {
      const tileY = sum - tileX;
      if (tileY < startY || tileY >= endY) continue;
      drawTile(graphics, map, tileX, tileY, tiles, base, overlay, scratch, bandShift, ground);
    }
  }

  const maxLift = (map.levels - 1) * ELEV_STEP;
  return {
    graphics,
    tops: tiles === null ? null : buildMesh(concat(base, overlay), tiles),
    minX: worldToScreenX(startX, endY) - HALF_TILE_W,
    maxX: worldToScreenX(endX, startY) + HALF_TILE_W,
    minY: worldToScreenY(startX, startY, 0) - HALF_TILE_H - maxLift,
    maxY: worldToScreenY(endX, endY, 0) + HALF_TILE_H,
  };
}

/**
 * @param bandShift Moves this map's ART along the wet-to-dry ramp without touching a
 * single height — see `terrainBand.ts`. Zero for the unnamed default generator, which
 * is the map the golden replay runs on.
 */
export function createTerrain(
  map: Heightmap,
  tiles: TerrainTiles | null = null,
  bandShift = 0,
  /**
   * Which ground each tile wears — no longer simply its height. Passed in rather than
   * derived here because the field layer needs the same answer, and two derivations of
   * one fact is how they come to disagree.
   */
  ground: Uint8Array = createGroundField(map, 0, map.levels),
): TerrainRenderer {
  const container = new Container();
  const chunksX = Math.ceil(map.width / chunkSize);
  const chunksY = Math.ceil(map.height / chunkSize);
  const chunks: Chunk[] = [];

  // Two layers spanning every chunk, not two inside each chunk.
  //
  // Every face belongs under every top. A face drops down-screen, into the ground of
  // the tiles in FRONT of it, and those are exactly the tops that must cover it;
  // nothing behind a face is ever occluded by it. So the split can be global, and it
  // has to be: interleaving a Graphics with the meshes chunk by chunk would break the
  // batch at every chunk boundary.
  const faceLayer = new Container();
  const topLayer = new Container();
  container.addChild(faceLayer, topLayer);

  // Chunks are added back to front for the faces' sake.
  for (let sum = 0; sum <= chunksX + chunksY - 2; sum++) {
    for (let chunkX = 0; chunkX < chunksX; chunkX++) {
      const chunkY = sum - chunkX;
      if (chunkY < 0 || chunkY >= chunksY) continue;
      const chunk = buildChunk(map, chunkX, chunkY, tiles, bandShift, ground);
      chunks.push(chunk);
      faceLayer.addChild(chunk.graphics);
      if (chunk.tops !== null) topLayer.addChild(chunk.tops);
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
        if (chunk.tops !== null) chunk.tops.visible = onScreen;
        if (onScreen) visible++;
      }
      renderer.visibleChunks = visible;
    },

    setSeason(position: number): void {
      tiles?.setSeason(position);
      const tints = presentation.terrain.seasonRamp.faceTint.map(parseColour);
      const clamped = position < 0 ? 0 : position > 2 ? 2 : position;
      const lower = Math.min(Math.floor(clamped), 1);
      faceLayer.tint = blendColour(tints[lower]!, tints[lower + 1]!, clamped - lower);
    },
  };

  return renderer;
}
