import { Container, Graphics } from 'pixi.js';
import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import { worldToScreenX, worldToScreenY } from '../../shared/iso.js';
import type { InterpolatedView } from '../interpolation.js';
import { presentation } from '../presentation.js';

/**
 * Draws entities from the interpolated view.
 *
 * Depth sorting uses the INTERPOLATED position, not the snapshot position. Sorting from
 * one set of positions while drawing from another pops sprites at the exact frame two
 * units cross — a flicker that is maddening to attribute after the fact. The comparator
 * falls back to entity id so the order is stable and deterministic on ties.
 *
 * Known gap, deliberate: entities are a layer above terrain rather than interleaved with
 * cliff faces in one pass, so a unit behind a tall cliff draws in front of it. Merging
 * the two into a single depth-sorted pass is the Phase 4+ work described in
 * docs/ARCHITECTURE.md section 4; it needs the cliff faces pulled out of the terrain
 * chunks first.
 */

const { radius, factionColours, selectedColour } = presentation.entities;

const FACTION = factionColours.map((hex) => Number.parseInt(hex.slice(1), 16));
const SELECTED = Number.parseInt(selectedColour.slice(1), 16);

export interface EntityLayer {
  readonly container: Container;
  update(view: InterpolatedView, map: Heightmap, selected: ReadonlySet<number>): void;
  /** Screen position of each drawn entity, for hit-testing against what is on screen. */
  screenPosition(view: InterpolatedView, index: number, map: Heightmap): { x: number; y: number };
}

interface Marker {
  readonly graphics: Graphics;
  faction: number;
  selected: boolean;
}

function drawMarker(graphics: Graphics, faction: number, selected: boolean): void {
  graphics.clear();

  if (selected) {
    graphics.ellipse(0, 0, radius + 5, (radius + 5) / 2);
    graphics.stroke({ width: 2, color: SELECTED, alpha: 0.9 });
  }

  // A body offset upward from the tile, plus a foot ellipse so it reads as standing on
  // the ground rather than floating.
  graphics.ellipse(0, 0, radius * 0.8, radius * 0.4);
  graphics.fill({ color: 0x000000, alpha: 0.3 });

  graphics.moveTo(0, -radius * 2.2);
  graphics.lineTo(radius * 0.75, 0);
  graphics.lineTo(-radius * 0.75, 0);
  graphics.closePath();
  graphics.fill({ color: FACTION[faction % FACTION.length] ?? FACTION[0]! });
  graphics.stroke({ width: 1, color: 0x1a1610, alpha: 0.8 });
}

function groundHeight(map: Heightmap, worldX: number, worldY: number): number {
  const height = heightAt(map, Math.floor(worldX), Math.floor(worldY));
  return height < 0 ? 0 : height;
}

export function createEntityLayer(): EntityLayer {
  const container = new Container();
  const markers: Marker[] = [];
  // Reused across frames so sorting allocates nothing in the render loop.
  let order: number[] = [];

  return {
    container,

    screenPosition(view: InterpolatedView, index: number, map: Heightmap) {
      const worldX = view.x[index]!;
      const worldY = view.y[index]!;
      const height = groundHeight(map, worldX, worldY);
      return {
        x: worldToScreenX(worldX, worldY),
        y: worldToScreenY(worldX, worldY, height),
      };
    },

    update(view: InterpolatedView, map: Heightmap, selected: ReadonlySet<number>): void {
      const count = view.count;

      while (markers.length < count) {
        const graphics = new Graphics();
        container.addChild(graphics);
        markers.push({ graphics, faction: -1, selected: false });
      }
      for (let i = count; i < markers.length; i++) markers[i]!.graphics.visible = false;

      if (order.length < count) order = new Array<number>(count);
      for (let i = 0; i < count; i++) order[i] = i;

      // Depth order: back to front along the isometric axis, entity id breaking ties.
      order.length = count;
      order.sort((a, b) => {
        const depthA = view.x[a]! + view.y[a]!;
        const depthB = view.x[b]! + view.y[b]!;
        if (depthA !== depthB) return depthA - depthB;
        return view.handle[a]! - view.handle[b]!;
      });

      for (let slot = 0; slot < count; slot++) {
        const index = order[slot]!;
        const marker = markers[slot]!;
        const faction = view.faction[index]!;
        const isSelected = selected.has(view.handle[index]!);

        if (marker.faction !== faction || marker.selected !== isSelected) {
          drawMarker(marker.graphics, faction, isSelected);
          marker.faction = faction;
          marker.selected = isSelected;
        }

        const position = this.screenPosition(view, index, map);
        marker.graphics.position.set(position.x, position.y);
        marker.graphics.visible = true;
      }
    },
  };
}
