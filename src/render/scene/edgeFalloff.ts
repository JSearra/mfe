import { Container, FillGradient, Graphics } from 'pixi.js';
import type { Heightmap } from '../../shared/heightmap.js';
import type { Camera } from '../camera.js';
import { worldToScreenX, worldToScreenY } from '../../shared/iso.js';
import { presentation } from '../presentation.js';

/**
 * The world going dark at the map boundary, instead of being cut off with a knife.
 *
 * Every other abrupt ending in the terrain has been dealt with — tile against tile,
 * height against height, land against water — and this was the last one: pan to a corner
 * and the veld stops at a razor-sharp diamond point against the background, which is the
 * one edge in the game that is not a place at all. It is the map running out.
 *
 * Nothing can be drawn BEYOND the boundary to soften it. Land past the edge would be
 * outside the fog array, so it would be lit while the map it rings was still dark, and a
 * bright border around an unexplored map is a worse lie than a clean cut. What can be
 * done is the opposite: take light AWAY near the boundary until the ground has reached
 * the background colour by the time it ends. Subtracting light composes correctly with
 * fog — over ground that is already dark it changes nothing — where adding it would not.
 *
 * Drawn above everything in the world layer for the same reason fog is: a tree standing
 * on faded ground has to fade with it, or it hangs in the dark with nothing underneath.
 */

const { tiles, exponent, stops } = presentation.terrain.edgeFalloff;

/**
 * How dark the world is `depth` tiles in from the boundary, from 1 at the edge to 0.
 *
 * Steep at the edge and long in the tail on purpose. A straight ramp over the same
 * distance dims a band of perfectly good ground the player might be farming; this hides
 * little more than the outermost tile or two and still leaves no step at the end, which
 * is the whole point — alpha has to reach 1 exactly where the geometry stops or there is
 * a cut again, just a fainter one.
 */
export function falloffAlpha(depth: number): number {
  if (depth <= 0) return 1;
  if (depth >= tiles) return 0;
  const remaining = 1 - depth / tiles;
  let alpha = remaining;
  for (let i = 1; i < exponent; i++) alpha *= remaining;
  return alpha;
}

/** One side of the map, in tile space. */
export interface MapEdge {
  /** A tile-space point on the boundary. */
  readonly originX: number;
  readonly originY: number;
  /** One tile along the boundary. */
  readonly alongX: number;
  readonly alongY: number;
  /** One tile inward from it. */
  readonly inX: number;
  readonly inY: number;
  /** Length of the boundary in tiles. */
  readonly length: number;
}

/**
 * The four sides, each walked so that `in` points at the middle of the map.
 *
 * Every entry has `in` equal to `along` turned ninety degrees the same way, which is
 * what makes all four frames agree on which way is inward — see `edgeFrame`.
 */
export function mapEdges(width: number, height: number): readonly MapEdge[] {
  return [
    { originX: 0, originY: 0, alongX: 1, alongY: 0, inX: 0, inY: 1, length: width },
    { originX: width, originY: 0, alongX: 0, alongY: 1, inX: -1, inY: 0, length: height },
    { originX: width, originY: height, alongX: -1, alongY: 0, inX: 0, inY: -1, length: width },
    { originX: 0, originY: height, alongX: 0, alongY: -1, inX: 1, inY: 0, length: height },
  ];
}

/**
 * An edge's own coordinate frame: local x runs along the boundary, local y across it.
 *
 * The strip is drawn inside a rotated container rather than straight into world space,
 * and that is not tidiness — it is the only way to get a correct gradient out of Pixi.
 * `FillGradient` mishandles a diagonal axis twice over. Under its default
 * `clamp-to-edge` it swaps the axis endpoints' x and y INDEPENDENTLY, which mirrors a
 * mixed-sign axis onto the other diagonal instead of reversing it; and it flips the
 * gradient texture whenever `dx < 0 || dy < 0` without the transform following suit.
 * Every isometric perpendicular has mixed signs — one tile along the northern boundary
 * is (32, 16) on screen, so the perpendicular is (-16, 32) — and negating it only moves
 * the negative from y to x, so neither direction escapes. The first attempt at this
 * rendered the entire band at flat full opacity with a hard cut at its inner edge, which
 * is the defect it was written to remove.
 *
 * In a frame aligned to the edge the axis is (0, +something): dx is zero rather than
 * negative, dy is positive, and both misbehaviours are simply not reached.
 *
 * Local y is also, by construction, the screen-space PERPENDICULAR of the edge, which is
 * the other thing that has to be right. A linear gradient is constant along lines at
 * right angles to its axis, so running it along the inward direction instead would shear
 * the band — the isometric axes are not at right angles once projected, and (32, 16)
 * against (-32, 16) has a dot product of -768 — leaving the fade twice as deep at one
 * end of an edge as at the other.
 */
export interface EdgeFrame {
  /** Rotation of the frame, and the screen point its origin sits at. */
  readonly rotation: number;
  readonly originX: number;
  readonly originY: number;
  /** Local x per tile along the boundary. */
  readonly alongPerTile: number;
  /** Local x per tile of depth. The isometric axes are sheared, so this is not zero. */
  readonly depthSkew: number;
  /**
   * Local y per tile of depth. Positive on every side of the map, because `mapEdges`
   * turns each `in` the same way out of its `along`: the map is always BELOW its own
   * boundary in the frame. That is worth having rather than handling both cases — it
   * lets one gradient, with one texture and one set of stops, serve all four strips.
   */
  readonly depthPerTile: number;
}

export function edgeFrame(edge: MapEdge): EdgeFrame {
  // Projection is linear at ground level, so a tile-space direction projects as a vector.
  const alongX = worldToScreenX(edge.alongX, edge.alongY);
  const alongY = worldToScreenY(edge.alongX, edge.alongY, 0);
  const inX = worldToScreenX(edge.inX, edge.inY);
  const inY = worldToScreenY(edge.inX, edge.inY, 0);

  const alongPerTile = Math.sqrt(alongX * alongX + alongY * alongY);
  const unitX = alongX / alongPerTile;
  const unitY = alongY / alongPerTile;
  // Pixi's rotation carries local (0, 1) to (-sin, cos), so that is the local y axis.
  const acrossX = -unitY;
  const acrossY = unitX;

  return {
    rotation: Math.atan2(unitY, unitX),
    originX: worldToScreenX(edge.originX, edge.originY),
    originY: worldToScreenY(edge.originX, edge.originY, 0),
    alongPerTile,
    depthSkew: inX * unitX + inY * unitY,
    depthPerTile: inX * acrossX + inY * acrossY,
  };
}

/**
 * The line the gradient runs along, in the frame's own coordinates.
 *
 * Straight down it, always: `dx` of zero rather than negative, and `dy` positive. That
 * is the whole reason the strip is drawn rotated — see the note on EdgeFrame for what
 * Pixi does to an axis that is diagonal or points the other way.
 */
export function gradientAxis(frame: EdgeFrame): {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
} {
  const reach = Math.abs(frame.depthPerTile) * tiles;
  return { startX: 0, startY: -reach, endX: 0, endY: reach };
}

/** Where the tile-space point `depth` tiles in and `along` tiles over sits in the frame. */
export function framePoint(frame: EdgeFrame, along: number, depth: number): [number, number] {
  return [along * frame.alongPerTile + depth * frame.depthSkew, depth * frame.depthPerTile];
}

/**
 * The static darkening overlay. Built once: the map does not change shape.
 *
 * Four strips, one per side, each overhanging its corners and reaching `tiles` OUTSIDE
 * the boundary as well as in. The outside half costs nothing — it is background painted
 * over background — and it is what covers terrain that stands above the ground plane: a
 * tile lifted by the full fifteen levels draws its top 120px higher than the point the
 * overlay was laid out at, and rising 120px on screen is the same as moving 3.75 tiles
 * outward and 3.75 tiles back along the edge. Both are inside an overhang of `tiles`, so
 * a peak on the boundary fades with the ground it stands on.
 */
export interface EdgeFalloff {
  readonly container: Container;
  /** Hide the strips the viewport cannot see. */
  update(camera: Camera): void;
}

export function createEdgeFalloff(map: Heightmap, colour: number): EdgeFalloff {
  const container = new Container();

  const red = (colour >> 16) & 0xff;
  const green = (colour >> 8) & 0xff;
  const blue = colour & 0xff;
  const rgba = (alpha: number): string => `rgba(${red},${green},${blue},${alpha})`;

  const edges = mapEdges(map.width, map.height);
  // Every frame has the same local axis, so the gradient is built once and shared. Four
  // strips off one texture batch together; four textures would not.
  const frames = edges.map(edgeFrame);
  const axis = gradientAxis(frames[0]!);

  // The boundary sits at the middle of the axis, with the outward half flat: everything
  // past the edge is background painted over background.
  const colorStops = [{ offset: 0, color: rgba(1) }];
  for (let i = 0; i <= stops; i++) {
    const depth = (tiles * i) / stops;
    colorStops.push({ offset: 0.5 + depth / (2 * tiles), color: rgba(falloffAlpha(depth)) });
  }

  const gradient = new FillGradient({
    type: 'linear',
    start: { x: axis.startX, y: axis.startY },
    end: { x: axis.endX, y: axis.endY },
    colorStops,
    textureSpace: 'global',
  });

  const strips = edges.map((edge, index) => {
    const frame = frames[index]!;
    const graphics = new Graphics();
    const corners = stripCorners(edge);

    corners.forEach(([along, depth], corner) => {
      const [x, y] = framePoint(frame, along, depth);
      if (corner === 0) graphics.moveTo(x, y);
      else graphics.lineTo(x, y);
    });
    graphics.closePath();
    graphics.fill(gradient);

    graphics.rotation = frame.rotation;
    graphics.position.set(frame.originX, frame.originY);
    container.addChild(graphics);

    return { graphics, frame, bounds: stripBounds(frame, corners) };
  });

  return {
    container,

    update(camera: Camera): void {
      /*
       * Three draw calls that are only worth anything near a boundary.
       *
       * Standing in the middle of a 128x128 map, no edge of it is within several
       * viewports, and all four strips still went to the GPU every frame — 58 draw
       * calls against a ceiling of 60, for nothing anybody could see.
       *
       * The test is done in each strip's OWN frame rather than against a screen-aligned
       * box, because these are long diagonals: the axis-aligned bounding box of the
       * northern strip covers most of the map's bounding box too, and culling on it
       * changed the draw count by nothing at all. In the frame the strip is a plain
       * rectangle and the viewport is the rotated thing, which is the way round that
       * actually separates them.
       */
      const halfWidth = camera.viewportWidth / 2 / camera.zoom;
      const halfHeight = camera.viewportHeight / 2 / camera.zoom;

      for (const strip of strips) {
        const { frame, bounds } = strip;
        const cos = Math.cos(frame.rotation);
        const sin = Math.sin(frame.rotation);

        // The viewport's half-extents once turned into the strip's frame.
        const reachU = halfWidth * Math.abs(cos) + halfHeight * Math.abs(sin);
        const reachV = halfWidth * Math.abs(sin) + halfHeight * Math.abs(cos);

        const offsetX = camera.x - frame.originX;
        const offsetY = camera.y - frame.originY;
        const centreU = offsetX * cos + offsetY * sin;
        const centreV = -offsetX * sin + offsetY * cos;

        strip.graphics.visible =
          centreU + reachU >= bounds.minU &&
          centreU - reachU <= bounds.maxU &&
          centreV + reachV >= bounds.minV &&
          centreV - reachV <= bounds.maxV;
      }
    },
  };
}

/** The strip's four corners in (along, depth) tiles, overhanging both ends and both sides. */
export function stripCorners(edge: MapEdge): readonly (readonly [number, number])[] {
  return [
    [-tiles, -tiles],
    [edge.length + tiles, -tiles],
    [edge.length + tiles, tiles],
    [-tiles, tiles],
  ];
}

/** The strip's extent in its own frame, where it is a rectangle rather than a diagonal. */
export function stripBounds(
  frame: EdgeFrame,
  corners: readonly (readonly [number, number])[],
): { minU: number; maxU: number; minV: number; maxV: number } {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  for (const [along, depth] of corners) {
    const [u, v] = framePoint(frame, along, depth);
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  return { minU, maxU, minV, maxV };
}
