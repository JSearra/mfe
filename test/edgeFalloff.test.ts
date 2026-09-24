import { describe, expect, it } from 'vitest';
import {
  edgeFrame,
  falloffAlpha,
  framePoint,
  gradientAxis,
  mapEdges,
  stripBounds,
  stripCorners,
} from '../src/render/scene/edgeFalloff.js';
import { worldToScreenX, worldToScreenY } from '../src/shared/iso.js';
import { presentation } from '../src/render/presentation.js';

const { tiles } = presentation.terrain.edgeFalloff;

describe('edge falloff ramp', () => {
  it('is opaque where the geometry stops and clear where the band ends', () => {
    // Both ends matter and for different reasons. Short of 1 at the boundary leaves a
    // step against the background — the hard cut again, only fainter. Short of 0 at the
    // inner end puts a visible line across perfectly ordinary ground.
    expect(falloffAlpha(0)).toBe(1);
    expect(falloffAlpha(-3)).toBe(1);
    expect(falloffAlpha(tiles)).toBe(0);
    expect(falloffAlpha(tiles + 3)).toBe(0);
  });

  it('never brightens as it goes inward', () => {
    let previous = Infinity;
    for (let depth = 0; depth <= tiles; depth += tiles / 64) {
      const alpha = falloffAlpha(depth);
      expect(alpha).toBeLessThanOrEqual(previous);
      previous = alpha;
    }
  });

  it('spends most of its depth nearly clear, so it hides little playable ground', () => {
    // The point of the curve. Two tiles in it is already mostly out of the way; a
    // straight ramp would still be at three quarters strength there.
    expect(falloffAlpha(2)).toBeLessThan(0.5);
    expect(falloffAlpha(tiles / 2)).toBeLessThan(0.2);
  });
});

describe('edge falloff frame', () => {
  const edges = mapEdges(128, 96);

  it('covers all four sides', () => {
    expect(edges).toHaveLength(4);
  });

  /** What Pixi does with a rotated display object, so the frame can be checked against it. */
  function toScreen(edge: number, along: number, depth: number): [number, number] {
    const frame = edgeFrame(edges[edge]!);
    const [localX, localY] = framePoint(frame, along, depth);
    const cos = Math.cos(frame.rotation);
    const sin = Math.sin(frame.rotation);
    return [
      frame.originX + localX * cos - localY * sin,
      frame.originY + localX * sin + localY * cos,
    ];
  }

  it.each([0, 1, 2, 3])('lands where the tile it describes lands (side %i)', (index) => {
    // The round trip, and the test that actually pins the frame down: a point named in
    // tiles along and tiles deep has to come out at the screen position of that tile,
    // once Pixi has applied the rotation. A sign error anywhere in the frame — the
    // perpendicular facing the wrong way, the skew dropped, the rotation negated —
    // moves the strip somewhere else on the map and this is what notices.
    const edge = edges[index]!;
    for (const [along, depth] of [[0, 0], [7, 0], [0, 5], [13, -4], [edge.length, 2]] as const) {
      const tileX = edge.originX + edge.alongX * along + edge.inX * depth;
      const tileY = edge.originY + edge.alongY * along + edge.inY * depth;
      const [screenX, screenY] = toScreen(index, along, depth);
      expect(screenX).toBeCloseTo(worldToScreenX(tileX, tileY), 6);
      expect(screenY).toBeCloseTo(worldToScreenY(tileX, tileY, 0), 6);
    }
  });

  it.each([0, 1, 2, 3])('holds the ramp level along the boundary (side %i)', (index) => {
    /*
     * The shearing trap. A linear gradient is constant along lines at right angles to
     * its axis, so the axis has to be the screen-space PERPENDICULAR of the edge — and
     * the obvious choice, the inward direction, is not perpendicular to it, because the
     * isometric axes stop being at right angles once projected. One tile along the
     * northern boundary is (32, 16) and one tile inward is (-32, 16): their dot product
     * is -768. Getting this wrong leaves the band visibly deeper at one end of an edge
     * than at the other.
     *
     * In the frame that is the claim that walking along the boundary does not change
     * local y at all.
     */
    const frame = edgeFrame(edges[index]!);
    expect(framePoint(frame, 0, 0)[1]).toBeCloseTo(0, 6);
    expect(framePoint(frame, 40, 0)[1]).toBeCloseTo(0, 6);
    expect(framePoint(frame, -13, 0)[1]).toBeCloseTo(0, 6);
  });

  it.each([0, 1, 2, 3])('keeps the gradient axis vertical in the frame (side %i)', (index) => {
    /*
     * Pixi's own constraint, and it is load-bearing. FillGradient swaps a
     * clamp-to-edge axis's x and y INDEPENDENTLY, mirroring a mixed-sign axis onto the
     * other diagonal rather than reversing it, and separately flips the gradient
     * texture whenever dx < 0 || dy < 0 without moving the transform to match. An axis
     * of (0, +something) reaches neither path. Every isometric perpendicular has mixed
     * signs, so drawing straight into world space cannot avoid them — the first attempt
     * did exactly that and rendered the whole band at flat full opacity.
     */
    const axis = gradientAxis(edgeFrame(edges[index]!));
    expect(axis.endX - axis.startX).toBe(0);
    expect(axis.endY - axis.startY).toBeGreaterThan(0);
  });

  it.each([0, 1, 2, 3])('spans the whole band on both sides of the edge (side %i)', (index) => {
    // The stops put the boundary at the middle of the axis, so the axis has to be
    // centred on it and reach a full band width each way, or the ramp lands elsewhere.
    const frame = edgeFrame(edges[index]!);
    const axis = gradientAxis(frame);
    expect(axis.startY + axis.endY).toBeCloseTo(0, 6);
    expect(axis.endY).toBeCloseTo(Math.abs(framePoint(frame, 0, tiles)[1]), 6);
  });

  it.each([0, 1, 2, 3])('moves a whole band width for a band of depth (side %i)', (index) => {
    // A tile of depth does not carry a tile's distance across the band, because the
    // across direction is not the inward direction.
    const frame = edgeFrame(edges[index]!);
    expect(Math.abs(frame.depthPerTile)).toBeCloseTo(1024 / Math.sqrt(1280), 6);
  });

  it('puts the map below its own boundary on every side', () => {
    // What lets one gradient serve all four strips: mapEdges turns each `in` the same
    // way out of its `along`, so inward is local +y everywhere and the stops never need
    // reversing for half the sides. A new edge written the other way round would fade
    // the wrong direction, and this is what says so.
    for (const edge of edges) {
      expect(edgeFrame(edge).depthPerTile).toBeGreaterThan(0);
    }
  });

  it('gives every side the same axis, so they can share one gradient', () => {
    const first = gradientAxis(edgeFrame(edges[0]!));
    for (const edge of edges) {
      expect(gradientAxis(edgeFrame(edge))).toEqual(first);
    }
  });

  it.each([0, 1, 2, 3])('bounds the strip across the whole band and along the whole edge (side %i)', (index) => {
    /*
     * What the culling is tested against. These strips are long diagonals, so a
     * screen-aligned bounding box round one covers most of the map's own bounding box
     * and culls nothing — the draw count did not move at all when it was tried. In the
     * frame the strip is a plain rectangle, and these are its sides.
     */
    const edge = edges[index]!;
    const frame = edgeFrame(edge);
    const bounds = stripBounds(frame, stripCorners(edge));

    expect(bounds.maxV - bounds.minV).toBeCloseTo(2 * tiles * frame.depthPerTile, 6);
    // Long enough for the edge itself and an overhang at each end, plus the skew the
    // depth contributes because the isometric axes are not square.
    expect(bounds.maxU - bounds.minU).toBeGreaterThan((edge.length + 2 * tiles) * frame.alongPerTile);
  });

  it('overhangs far enough to catch terrain standing above the ground plane', () => {
    // The overlay is laid out on the ground plane, but a tile lifted by the full range
    // of levels draws its top 120px higher. Rising L pixels on screen is the same as
    // moving L/32 tiles outward and L/32 back along the edge, so both the outward reach
    // and the corner overhang have to be at least that, or a peak on the boundary stays
    // lit while the ground it stands on has faded.
    const MAX_LIFT_PX = 15 * 8;
    expect(tiles).toBeGreaterThanOrEqual(MAX_LIFT_PX / 32);
  });
});
