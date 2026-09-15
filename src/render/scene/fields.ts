import { Container, Sprite } from 'pixi.js';
import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import {
  fieldCondition,
  fieldEstablished,
  fieldOwner,
  FARMLAND_STRIDE,
} from '../../shared/farmland.js';
import { HALF_TILE_H, HALF_TILE_W, worldToScreenX, worldToScreenY } from '../../shared/iso.js';
import type { TerrainTiles } from '../assets.js';

/**
 * The fields, drawn on the ground they were broken out of.
 *
 * A layer of its own, between the terrain and everything that stands on it. Not part of
 * the terrain chunks, because those are built once and a field changes — it is sited,
 * broken, grazed down and given up — and rebuilding a chunk to redraw one tile would
 * throw away the whole reason terrain is chunked.
 *
 * Fields have to be visible or the phase is pointless: a decision the player cannot see
 * the result of is not a decision. Broken earth reads dark and bare, a standing crop
 * reads green, and condition dims the crop toward the colour of the dirt under it, so a
 * field being eaten by the herd looks like a field being eaten by the herd.
 */

/** How dark a field at zero condition draws, as a fraction of a whole one. */
const RUINED_TINT = 0.45;

export interface FieldLayer {
  readonly container: Container;
  /** Replace the fields, packed as FARMLAND_STRIDE-wide records. */
  setFarmland(packed: Float32Array | null): void;
}

export function createFieldLayer(map: Heightmap, tiles: TerrainTiles | null): FieldLayer {
  const container = new Container();
  // Sprites are reused in place rather than rebuilt, for the reason the woodland's are:
  // Pixi's addChild removes-then-appends, so rebuilding a hundred fields to change one
  // is a hundred linear scans of the child list.
  const sprites: Sprite[] = [];

  return {
    container,

    setFarmland(packed: Float32Array | null): void {
      if (packed === null || tiles === null) return;

      const wanted = Math.floor(packed.length / FARMLAND_STRIDE);
      for (let i = 0; i < wanted; i++) {
        const at = i * FARMLAND_STRIDE;
        const tileX = packed[at]!;
        const tileY = packed[at + 1]!;
        const established = fieldEstablished(packed, at);
        const condition = fieldCondition(packed, at);

        const level = heightAt(map, tileX, tileY);
        const tile = tiles.field(level < 0 ? 0 : level, established);
        if (tile === null) continue;

        let sprite = sprites[i];
        if (sprite === undefined) {
          sprite = new Sprite(tile.texture);
          container.addChild(sprite);
          sprites.push(sprite);
        } else {
          sprite.texture = tile.texture;
          sprite.visible = true;
        }

        const centreX = worldToScreenX(tileX + 0.5, tileY + 0.5);
        const centreY = worldToScreenY(tileX + 0.5, tileY + 0.5, level < 0 ? 0 : level);
        sprite.position.set(centreX - HALF_TILE_W, centreY - HALF_TILE_H);

        // Broken ground does not wither — there is nothing on it yet — so only a crop
        // carries its condition in its colour.
        const shade = established ? RUINED_TINT + (1 - RUINED_TINT) * condition : 1;
        const channel = Math.round(255 * shade);
        sprite.tint = (channel << 16) | (channel << 8) | channel;
        // Somebody else's field is still a field and still worth seeing; whose it is
        // shows in the HUD rather than here, where a tint is already saying something.
        void fieldOwner(packed, at);
      }

      for (let i = wanted; i < sprites.length; i++) sprites[i]!.visible = false;
    },
  };
}
