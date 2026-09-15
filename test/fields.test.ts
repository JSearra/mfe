import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import { createFieldLayer } from '../src/render/scene/fields.js';
import { FARMLAND_STRIDE } from '../src/shared/farmland.js';
import { HALF_TILE_H, HALF_TILE_W, worldToScreenX, worldToScreenY } from '../src/shared/iso.js';
import type { TerrainTile, TerrainTiles } from '../src/render/assets.js';
import { flatMap } from './simHarness.js';

/**
 * Fields have to be visible or the phase is pointless: a decision whose result the
 * player cannot see is not a decision. These cover the layer's own logic — which tile,
 * where, and how dim — without a browser, because the browser turned out to be the
 * slowest possible way to find out that a sprite was in the wrong place.
 */

const broken: TerrainTile = { texture: Texture.EMPTY, colour: 0x111111 };
const crop: TerrainTile = { texture: new Texture(), colour: 0x222222 };

const tiles: TerrainTiles = {
  variants: () => [],
  transition: () => null,
  field: (_band, isCrop) => (isCrop ? crop : broken),
};

/** One packed field record. */
function packed(
  entries: readonly { x: number; y: number; owner: number; established: boolean; condition: number }[],
): Float32Array {
  const out = new Float32Array(entries.length * FARMLAND_STRIDE);
  entries.forEach((e, i) => {
    const at = i * FARMLAND_STRIDE;
    out[at] = e.x;
    out[at + 1] = e.y;
    out[at + 2] = e.owner;
    out[at + 3] = e.established ? 1 : 0;
    out[at + 4] = e.condition;
    out[at + 5] = i;
  });
  return out;
}

const map = flatMap(32, 2);

describe('drawing the fields', () => {
  it('draws one sprite per field', () => {
    const layer = createFieldLayer(map, tiles);
    layer.setFarmland(
      packed([
        { x: 4, y: 5, owner: 0, established: true, condition: 1 },
        { x: 9, y: 2, owner: 1, established: false, condition: 1 },
      ]),
    );
    expect(layer.container.children.filter((c) => c.visible)).toHaveLength(2);
  });

  it('puts a field on its own tile', () => {
    const layer = createFieldLayer(map, tiles);
    layer.setFarmland(packed([{ x: 7, y: 3, owner: 0, established: true, condition: 1 }]));

    const sprite = layer.container.children[0]!;
    // The sprite's top-left corner is the diamond's west/north corner, which is how the
    // terrain places its own tiles.
    expect(sprite.position.x).toBeCloseTo(worldToScreenX(7.5, 3.5) - HALF_TILE_W, 5);
    expect(sprite.position.y).toBeCloseTo(worldToScreenY(7.5, 3.5, 2) - HALF_TILE_H, 5);
  });

  it('tells broken ground from a standing crop', () => {
    const layer = createFieldLayer(map, tiles);
    layer.setFarmland(
      packed([
        { x: 4, y: 4, owner: 0, established: false, condition: 1 },
        { x: 8, y: 8, owner: 0, established: true, condition: 1 },
      ]),
    );
    const [first, second] = layer.container.children as unknown as { texture: Texture }[];
    expect(first!.texture).toBe(broken.texture);
    expect(second!.texture).toBe(crop.texture);
  });

  it('dims a crop as its condition falls, and leaves broken ground alone', () => {
    const layer = createFieldLayer(map, tiles);
    layer.setFarmland(
      packed([
        { x: 4, y: 4, owner: 0, established: true, condition: 1 },
        { x: 8, y: 8, owner: 0, established: true, condition: 0 },
        { x: 12, y: 12, owner: 0, established: false, condition: 0 },
      ]),
    );
    const [whole, ruined, unbroken] = layer.container.children as unknown as { tint: number }[];
    expect(whole!.tint).toBe(0xffffff);
    expect(ruined!.tint).toBeLessThan(whole!.tint);
    // Nothing is growing on broken ground yet, so nothing has withered.
    expect(unbroken!.tint).toBe(0xffffff);
  });

  it('reuses sprites and hides the surplus when fields are given up', () => {
    const layer = createFieldLayer(map, tiles);
    layer.setFarmland(
      packed([
        { x: 4, y: 4, owner: 0, established: true, condition: 1 },
        { x: 8, y: 8, owner: 0, established: true, condition: 1 },
        { x: 12, y: 12, owner: 0, established: true, condition: 1 },
      ]),
    );
    const created = layer.container.children.length;

    layer.setFarmland(packed([{ x: 4, y: 4, owner: 0, established: true, condition: 1 }]));
    // Pixi's addChild removes-then-appends, so growing the list is the expensive part;
    // the layer must not do it again for a shrinking set.
    expect(layer.container.children.length).toBe(created);
    expect(layer.container.children.filter((c) => c.visible)).toHaveLength(1);
  });

  it('does nothing at all without terrain art, rather than failing to draw the map', () => {
    const layer = createFieldLayer(map, null);
    layer.setFarmland(packed([{ x: 4, y: 4, owner: 0, established: true, condition: 1 }]));
    expect(layer.container.children).toHaveLength(0);
  });

  it('ignores a null, which is what a host sends when nothing has changed', () => {
    const layer = createFieldLayer(map, tiles);
    layer.setFarmland(packed([{ x: 4, y: 4, owner: 0, established: true, condition: 1 }]));
    layer.setFarmland(null);
    expect(layer.container.children.filter((c) => c.visible)).toHaveLength(1);
  });
});
