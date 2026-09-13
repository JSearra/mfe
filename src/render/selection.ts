import { Graphics } from 'pixi.js';
import type { Heightmap } from '../shared/heightmap.js';
import type { Camera } from './camera.js';
import type { InterpolatedView } from './interpolation.js';
import { presentation } from './presentation.js';
import type { EntityLayer } from './scene/entities.js';

/**
 * Unit selection.
 *
 * Selection is client state and never enters the simulation. Every player selects
 * differently, so a selection in simulation state desyncs on the first frame of
 * multiplayer — see docs/ARCHITECTURE.md section 1.
 *
 * Hit-testing runs against INTERPOLATED screen positions and resolves to a handle. The
 * player clicks what they can see, which is ~75ms old; testing against current
 * simulation positions would select whatever has since moved under the cursor. And the
 * result must be a handle, never a position: by the time the order is applied the
 * target may have died, and a handle carries the generation that says so.
 */

const { radius, marqueeColour } = presentation.entities;
const MARQUEE = Number.parseInt(marqueeColour.slice(1), 16);

const KIND_UNIT = 0;
const KIND_BUILDING = 2;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function normaliseRect(rect: Rect): Rect {
  return {
    x0: Math.min(rect.x0, rect.x1),
    y0: Math.min(rect.y0, rect.y1),
    x1: Math.max(rect.x0, rect.x1),
    y1: Math.max(rect.y0, rect.y1),
  };
}

/** Viewport position of an entity as currently drawn. */
function viewportPosition(
  view: InterpolatedView,
  index: number,
  map: Heightmap,
  camera: Camera,
  layer: EntityLayer,
): { x: number; y: number } {
  const world = layer.screenPosition(view, index, map);
  // screenPosition returns unzoomed isometric space; apply the camera to reach the viewport.
  return {
    x: (world.x - camera.x) * camera.zoom + camera.viewportWidth / 2,
    y: (world.y - camera.y) * camera.zoom + camera.viewportHeight / 2,
  };
}

export interface SelectionModel {
  readonly handles: Set<number>;
  selectInRect(
    view: InterpolatedView,
    map: Heightmap,
    camera: Camera,
    layer: EntityLayer,
    rect: Rect,
    faction: number,
    additive: boolean,
  ): void;
  selectAt(
    view: InterpolatedView,
    map: Heightmap,
    camera: Camera,
    layer: EntityLayer,
    x: number,
    y: number,
    faction: number,
    additive: boolean,
  ): void;
  clear(): void;
  /**
   * Remember the current selection under a digit, and recall it later.
   *
   * Entirely client state. `CLAUDE.md` is explicit that selection never enters the
   * simulation, and control groups are selection — so no command, no world field, and
   * nothing here can move a hash. A group is stored as handles, which carry a
   * generation, so a member that dies and has its slot recycled is not silently
   * replaced by whatever now occupies it: recall drops it instead.
   */
  assignGroup(digit: number): void;
  recallGroup(digit: number, view: InterpolatedView): boolean;
}

/** Digits 1..9. Zero is not a group; it is the digit people press by accident. */
const GROUPS = 9;

export function createSelection(): SelectionModel {
  const handles = new Set<number>();
  const groups = new Map<number, number[]>();

  return {
    handles,
    clear(): void {
      handles.clear();
    },

    assignGroup(digit): void {
      if (digit < 1 || digit > GROUPS) return;
      groups.set(digit, [...handles]);
    },

    recallGroup(digit, view): boolean {
      const group = groups.get(digit);
      if (group === undefined || group.length === 0) return false;

      // Filter against what is actually in the view. A handle whose generation no
      // longer matches belongs to a dead unit whose slot has been reused, and recalling
      // it would hand the player someone else's troops — or the enemy's.
      const live = new Set<number>();
      for (let i = 0; i < view.count; i++) live.add(view.handle[i]!);

      const survivors = group.filter((handle) => live.has(handle));
      if (survivors.length !== group.length) groups.set(digit, survivors);
      if (survivors.length === 0) return false;

      handles.clear();
      for (const handle of survivors) handles.add(handle);
      return true;
    },

    selectInRect(view, map, camera, layer, rect, faction, additive): void {
      if (!additive) handles.clear();
      const bounds = normaliseRect(rect);

      for (let i = 0; i < view.count; i++) {
        // Kind as well as faction. Cattle are not troops, and a marquee that scoops up
        // the herd alongside the impi makes every subsequent order ambiguous.
        if (view.faction[i] !== faction || view.kind[i] !== KIND_UNIT) continue;
        const position = viewportPosition(view, i, map, camera, layer);
        if (
          position.x >= bounds.x0 &&
          position.x <= bounds.x1 &&
          position.y >= bounds.y0 &&
          position.y <= bounds.y1
        ) {
          handles.add(view.handle[i]!);
        }
      }
    },

    selectAt(view, map, camera, layer, x, y, faction, additive): void {
      if (!additive) handles.clear();

      // A click may land on a building. A marquee never selects one — dragging a box
      // over your base should gather the troops in it, not the walls around them.
      const building = pickOwnBuilding(view, map, camera, layer, x, y, faction);
      if (building !== -1) {
        handles.add(building);
        return;
      }

      // Nearest within the marker's own radius, so overlapping units resolve predictably.
      const reach = (radius * 2.2 + 4) * camera.zoom;
      let bestHandle = -1;
      let bestDistance = reach * reach;

      for (let i = 0; i < view.count; i++) {
        if (view.faction[i] !== faction || view.kind[i] !== KIND_UNIT) continue;
        const position = viewportPosition(view, i, map, camera, layer);
        const dx = position.x - x;
        // Markers stand up from their foot, so bias the test toward the body.
        const dy = position.y - radius * camera.zoom - y;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestHandle = view.handle[i]!;
        }
      }

      if (bestHandle !== -1) handles.add(bestHandle);
    },
  };
}

/**
 * Nearest entity of a given kind under the cursor, as a handle, or -1.
 *
 * Same rules as selection: hit-test the interpolated positions the player can actually
 * see, and resolve to a handle rather than a position.
 */
export function pickEntity(
  view: InterpolatedView,
  map: Heightmap,
  camera: Camera,
  layer: EntityLayer,
  x: number,
  y: number,
  kind: number,
): number {
  const reach = (radius * 2.2 + 6) * camera.zoom;
  let bestHandle = -1;
  let bestDistance = reach * reach;

  for (let i = 0; i < view.count; i++) {
    if (view.kind[i] !== kind) continue;
    const position = viewportPosition(view, i, map, camera, layer);
    const dx = position.x - x;
    const dy = position.y - radius * camera.zoom - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestHandle = view.handle[i]!;
    }
  }
  return bestHandle;
}

/** Handles of every entity of `kind` within `worldRadius` of a world point. */
export function entitiesNear(
  view: InterpolatedView,
  worldX: number,
  worldY: number,
  worldRadius: number,
  kind: number,
  out: number[],
): number[] {
  out.length = 0;
  const radiusSq = worldRadius * worldRadius;
  for (let i = 0; i < view.count; i++) {
    if (view.kind[i] !== kind) continue;
    const dx = view.x[i]! - worldX;
    const dy = view.y[i]! - worldY;
    if (dx * dx + dy * dy <= radiusSq) out.push(view.handle[i]!);
  }
  return out;
}

/** Nearest hostile unit under the cursor, as a handle, or -1. */
export function pickEnemy(
  view: InterpolatedView,
  map: Heightmap,
  camera: Camera,
  layer: EntityLayer,
  x: number,
  y: number,
  ownFaction: number,
): number {
  const reach = (radius * 2.2 + 6) * camera.zoom;
  let bestHandle = -1;
  let bestDistance = reach * reach;

  for (let i = 0; i < view.count; i++) {
    if (view.kind[i] !== KIND_UNIT || view.faction[i] === ownFaction) continue;
    const position = viewportPosition(view, i, map, camera, layer);
    const dx = position.x - x;
    const dy = position.y - radius * camera.zoom - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestHandle = view.handle[i]!;
    }
  }
  return bestHandle;
}

/** Nearest friendly building under the cursor, or -1. */
function pickOwnBuilding(
  view: InterpolatedView,
  map: Heightmap,
  camera: Camera,
  layer: EntityLayer,
  x: number,
  y: number,
  faction: number,
): number {
  const reach = (radius * 2.4) * camera.zoom;
  let best = -1;
  let bestDistance = reach * reach;

  for (let i = 0; i < view.count; i++) {
    if (view.kind[i] !== KIND_BUILDING || view.faction[i] !== faction) continue;
    const position = viewportPosition(view, i, map, camera, layer);
    const dx = position.x - x;
    const dy = position.y - radius * camera.zoom - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = view.handle[i]!;
    }
  }
  return best;
}

export function createMarqueeGraphics(): Graphics {
  const graphics = new Graphics();
  graphics.visible = false;
  return graphics;
}

export function drawMarquee(graphics: Graphics, rect: Rect | null): void {
  if (rect === null) {
    graphics.visible = false;
    return;
  }

  const bounds = normaliseRect(rect);
  graphics.visible = true;
  graphics.clear();
  graphics.rect(bounds.x0, bounds.y0, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0);
  graphics.fill({ color: MARQUEE, alpha: 0.08 });
  graphics.stroke({ width: 1, color: MARQUEE, alpha: 0.8 });
}
