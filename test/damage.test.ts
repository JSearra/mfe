import { describe, expect, it } from 'vitest';
import { createDamageFlashes } from '../src/render/scene/damage.js';
import { createEntityLayer } from '../src/render/scene/entities.js';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { heightmapFrom } from '../src/shared/heightmap.js';
import type { InterpolatedView } from '../src/render/interpolation.js';

/**
 * Combat feedback. `hpPct` crossed the boundary in every snapshot and was interpolated on
 * arrival, and nothing ever drew it — a player could hear a blow land and had no way to
 * see who was hurt or which of two engagements to reinforce.
 */

const map = heightmapFrom([[0, 0], [0, 0]], 8);

function viewWith(hp: number, handle = 0x0101): InterpolatedView {
  return {
    count: 1,
    handle: new Uint32Array([handle]),
    x: new Float32Array([1]),
    y: new Float32Array([1]),
    facing: new Float32Array([0]),
    animState: new Uint8Array([0]),
    animPhase: new Float32Array([0]),
    faction: new Uint8Array([0]),
    hpPct: new Uint8Array([hp]),
    flags: new Uint8Array([0]),
    kind: new Uint8Array([0]),
    stressPct: new Uint8Array([0]),
    progressPct: new Uint8Array([0]),
    subtype: new Uint8Array([0]),
  } as unknown as InterpolatedView;
}

/** Pixi records what a Graphics was told to draw; nothing drawn means no instructions. */
function drawn(layer: ReturnType<typeof createEntityLayer>): number {
  const health = layer.container.children[layer.container.children.length - 1] as unknown as {
    context: { instructions: unknown[] };
  };
  return health.context.instructions.length;
}

describe('health bars', () => {
  it('draws nothing for an unhurt entity', () => {
    const layer = createEntityLayer();
    layer.update(viewWith(255), map, new Set());
    // A bar over every unit is noise that hides the one thing it exists to say. A herd
    // of forty at full health would be a wall of green.
    expect(drawn(layer)).toBe(0);
  });

  it('draws for a wounded one', () => {
    const layer = createEntityLayer();
    layer.update(viewWith(120), map, new Set());
    expect(drawn(layer)).toBeGreaterThan(0);
  });

  it('draws without an atlas, since a wound is a wound either way', () => {
    // The first version put this inside the textured branch, so the bars disappeared
    // whenever the atlas failed to load — precisely when a player most needs to know
    // what is happening.
    const layer = createEntityLayer(null);
    layer.update(viewWith(60), map, new Set());
    expect(drawn(layer)).toBeGreaterThan(0);
  });

  it('clears between frames rather than accumulating', () => {
    const layer = createEntityLayer();
    layer.update(viewWith(120), map, new Set());
    const first = drawn(layer);
    layer.update(viewWith(120), map, new Set());
    expect(drawn(layer)).toBe(first);
  });
});

describe('damage flashes', () => {
  const hit = (handle: number): SimEvent =>
    ({ tick: 0, type: EventType.Hit, handle, x: 0, y: 0, payload: 0 }) as SimEvent;

  it('lights a struck entity and then stops', () => {
    const flashes = createDamageFlashes();
    flashes.handle([hit(7)], 1000);
    expect(flashes.isFlashing(7, 1000)).toBe(true);
    expect(flashes.isFlashing(7, 1100)).toBe(true);
    expect(flashes.isFlashing(7, 2000)).toBe(false);
  });

  it('ignores entities that were not hit', () => {
    const flashes = createDamageFlashes();
    flashes.handle([hit(7)], 1000);
    expect(flashes.isFlashing(8, 1000)).toBe(false);
  });

  it('does not grow without bound', () => {
    const flashes = createDamageFlashes();
    for (let i = 0; i < 500; i++) flashes.handle([hit(i)], i);
    flashes.expire(10_000);
    // Every entry is long expired, so none should survive the sweep.
    for (let i = 0; i < 500; i++) expect(flashes.isFlashing(i, 10_000)).toBe(false);
  });
});
