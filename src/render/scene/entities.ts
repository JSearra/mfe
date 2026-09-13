import { Container, Graphics } from 'pixi.js';
import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import { worldToScreenX, worldToScreenY } from '../../shared/iso.js';
import type { InterpolatedView } from '../interpolation.js';
import { presentation } from '../presentation.js';
import { createDepthOrder } from './depthOrder.js';

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
const cattleStyle = presentation.cattle;

const hex = (value: string): number => Number.parseInt(value.slice(1), 16);

const FACTION = factionColours.map(hex);
const SELECTED = hex(selectedColour);
const CATTLE_BODY = hex(cattleStyle.bodyColour);
const CALM = hex(cattleStyle.calmColour);
const ALARM = hex(cattleStyle.alarmColour);
const PANIC = hex(cattleStyle.panicColour);

const KIND_CATTLE = 1;
const KIND_BUILDING = 2;

const WALL = hex(presentation.buildings.wallColour);
const ROOF = hex(presentation.buildings.roofColour);
const SCAFFOLD = hex(presentation.buildings.scaffoldColour);
const HERD_STAMPEDING = 3;

/** Blend two packed RGB colours. */
function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

/**
 * Stress colour: green through amber to red.
 *
 * Gate 2 is a legibility question, and this is the answer to most of it. A player who
 * cannot see a herd approaching its limit cannot aim a stampede or avoid triggering one,
 * and the mechanic collapses into luck. The ring reads at a glance without needing a
 * number on screen.
 */
function stressColour(stressPct: number): number {
  const t = stressPct / 255;
  return t < 0.5 ? mix(CALM, ALARM, t * 2) : mix(ALARM, PANIC, (t - 0.5) * 2);
}

export interface EntityLayer {
  readonly container: Container;
  update(view: InterpolatedView, map: Heightmap, selected: ReadonlySet<number>): void;
  /** Screen position of each drawn entity, for hit-testing against what is on screen. */
  screenPosition(view: InterpolatedView, index: number, map: Heightmap): { x: number; y: number };
}

interface Marker {
  readonly graphics: Graphics;
  /** Everything the drawn shape depends on, so it is only redrawn when it changes. */
  signature: number;
}

function drawUnit(graphics: Graphics, faction: number, selected: boolean): void {
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

/**
 * A building, drawn as a block that rises as it is built.
 *
 * Growing upward from the foundation is the whole readout: a player can see at a glance
 * which sites are nearly done without a progress bar, which is one fewer thing competing
 * for the top of the screen.
 */
function drawBuilding(graphics: Graphics, progressPct: number, selected: boolean): void {
  const half = radius * 1.9;
  const complete = progressPct >= 255;
  const rise = radius * 2.6 * (0.18 + (progressPct / 255) * 0.82);

  if (selected) {
    graphics.ellipse(0, 0, half + 5, (half + 5) / 2);
    graphics.stroke({ width: 2, color: SELECTED, alpha: 0.9 });
  }

  // Footprint diamond.
  graphics.moveTo(0, -half / 2);
  graphics.lineTo(half, 0);
  graphics.lineTo(0, half / 2);
  graphics.lineTo(-half, 0);
  graphics.closePath();
  graphics.fill({ color: complete ? WALL : SCAFFOLD, alpha: complete ? 1 : 0.75 });
  graphics.stroke({ width: 1, color: 0x1a1610, alpha: 0.8 });

  // Body.
  graphics.moveTo(-half, 0);
  graphics.lineTo(-half, -rise);
  graphics.lineTo(0, -rise - half / 2);
  graphics.lineTo(half, -rise);
  graphics.lineTo(half, 0);
  graphics.lineTo(0, half / 2);
  graphics.closePath();
  graphics.fill({ color: WALL, alpha: complete ? 1 : 0.55 });
  graphics.stroke({ width: 1, color: 0x1a1610, alpha: 0.7 });

  if (complete) {
    graphics.moveTo(-half, -rise);
    graphics.lineTo(0, -rise - half / 2);
    graphics.lineTo(half, -rise);
    graphics.lineTo(0, -rise + half / 2);
    graphics.closePath();
    graphics.fill({ color: ROOF });
  }
}

function drawCow(graphics: Graphics, stressPct: number, stampeding: boolean, selected: boolean): void {
  const r = cattleStyle.radius;
  const colour = stressColour(stressPct);

  if (selected) {
    graphics.ellipse(0, 0, r + 5, (r + 5) / 2);
    graphics.stroke({ width: 2, color: SELECTED, alpha: 0.9 });
  }

  graphics.ellipse(0, 0, r * 0.9, r * 0.45);
  graphics.fill({ color: 0x000000, alpha: 0.3 });

  // A stampeding beast is tinted and trailed, not just ringed. The first browser pass
  // showed the ring alone reading as "stressed" but not as "this one is running you
  // down" — the state that matters most is the one that must be unmistakable.
  if (stampeding) {
    graphics.ellipse(r * 0.9, -r * 0.6, r * 1.2, r * 0.42);
    graphics.fill({ color: PANIC, alpha: 0.22 });
    graphics.ellipse(r * 1.7, -r * 0.5, r * 0.9, r * 0.3);
    graphics.fill({ color: PANIC, alpha: 0.12 });
  }

  // Low and broad, so a herd reads as a different thing from a formation of men even
  // when both are small on screen.
  graphics.ellipse(0, -r * 0.75, r * 1.05, r * 0.62);
  graphics.fill({ color: stampeding ? mix(CATTLE_BODY, PANIC, 0.45) : CATTLE_BODY });
  graphics.stroke({ width: stampeding ? 1.5 : 1, color: 0x1a1610, alpha: 0.85 });

  // Stress ring. Thickens as it rises so it is readable even when colour-blind.
  graphics.ellipse(0, -r * 0.75, r * 1.35, r * 0.9);
  graphics.stroke({
    width: stampeding ? 3.5 : 1 + (stressPct / 255) * 2,
    color: colour,
    alpha: stampeding ? 1 : 0.35 + (stressPct / 255) * 0.6,
  });
}

function groundHeight(map: Heightmap, worldX: number, worldY: number): number {
  const height = heightAt(map, Math.floor(worldX), Math.floor(worldY));
  return height < 0 ? 0 : height;
}

export function createEntityLayer(): EntityLayer {
  const container = new Container();
  const markers: Marker[] = [];
  // Persistent, hysteresis-damped order. See depthOrder.ts: a plain sort by depth is
  // correct and makes a dense herd shimmer.
  const depthOrder = createDepthOrder();

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
        markers.push({ graphics, signature: -1 });
      }
      for (let i = count; i < markers.length; i++) markers[i]!.graphics.visible = false;

      // Back to front along the isometric axis, computed from the INTERPOLATED
      // positions these markers are actually drawn at.
      const order = depthOrder.order(
        count,
        view.handle,
        (slot) => view.x[slot]! + view.y[slot]!,
        presentation.entities.depthHysteresis,
      );

      for (let slot = 0; slot < count; slot++) {
        const index = order[slot]!;
        const marker = markers[slot]!;
        const faction = view.faction[index]!;
        const isSelected = selected.has(view.handle[index]!);
        const kind = view.kind[index]!;
        const isCattle = kind === KIND_CATTLE;
        const isBuilding = kind === KIND_BUILDING;
        // Quantised for the same reason stress is: redrawing on every 1/255 of progress
        // would rebuild geometry every frame for no visible gain.
        const progressBand = isBuilding ? view.progressPct[index]! >> 4 : 0;
        const stampeding = (view.flags[index]! & 0x0f) === HERD_STAMPEDING;

        // Stress is quantised into bands: redrawing on every one-part-in-255 change
        // would rebuild geometry for the whole herd every frame for no visible gain.
        const stressBand = isCattle ? view.stressPct[index]! >> 4 : 0;
        const signature =
          kind |
          (isSelected ? 4 : 0) |
          (stampeding ? 8 : 0) |
          (faction << 4) |
          (stressBand << 9) |
          (progressBand << 14);

        if (marker.signature !== signature) {
          marker.graphics.clear();
          if (isBuilding) drawBuilding(marker.graphics, progressBand << 4, isSelected);
          else if (isCattle) drawCow(marker.graphics, stressBand << 4, stampeding, isSelected);
          else drawUnit(marker.graphics, faction, isSelected);
          marker.signature = signature;
        }

        const position = this.screenPosition(view, index, map);
        marker.graphics.position.set(position.x, position.y);
        marker.graphics.visible = true;
      }
    },
  };
}
