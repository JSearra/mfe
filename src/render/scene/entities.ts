import { Container, Graphics, Sprite } from 'pixi.js';
import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import { worldToScreenX, worldToScreenY } from '../../shared/iso.js';
import type { InterpolatedView } from '../interpolation.js';
import { presentation } from '../presentation.js';
import { createDepthOrder } from './depthOrder.js';
import type { SpriteAtlas } from '../assets.js';
import type { Decoration } from './decoration.js';
import type { DamageFlashes } from './damage.js';

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
/** Tint for an entity struck within the last fraction of a second. */
const HURT = 0xff8c78;
const CATTLE_BODY = hex(cattleStyle.bodyColour);
const CALM = hex(cattleStyle.calmColour);
const ALARM = hex(cattleStyle.alarmColour);
const PANIC = hex(cattleStyle.panicColour);

const KIND_CATTLE = 1;
const KIND_BUILDING = 2;

const spriteStyle = presentation.sprites;

/** Simulation animation states, from src/sim/world.ts. */
const ANIM_NAME = ['idle', 'walk', 'run'] as const;

/** Movement classes, from src/sim/pathing/costs.ts. Unit subtype is its movement class. */
const CLASS_MOUNTED = 2;

/**
 * Building sprite names by BuildingType, and their construction stages.
 *
 * A building does not turn, so there is one direction and the stage rides in the frame
 * index — which needed no new atlas format and no new loading code. Three stages: a
 * cleared footprint, a half-raised frame, and the finished thing.
 */
const BUILDING_KINDS = ['isibaya', 'umuzi', 'grain-store'] as const;
const BUILD_STAGES = 3;

const TAU = Math.PI * 2;

/**
 * Which sprite kind draws an entity.
 *
 * Cattle alternate between the two hide colourings by handle. A herd of one colour reads
 * as a texture rather than as animals, and the alternation is by handle rather than by
 * slot so a given beast does not change colour when the draw order shuffles.
 */
function spriteKind(kind: number, subtype: number, handle: number): string {
  if (kind === KIND_CATTLE) return (handle & 1) === 0 ? 'nguni' : 'nguni-dark';
  if (kind === KIND_BUILDING) return BUILDING_KINDS[subtype] ?? BUILDING_KINDS[0];
  return subtype === CLASS_MOUNTED ? 'commando' : 'impi';
}

/**
 * Ground decoration: the shadow that stops a sprite floating, the selection ring, and
 * the cattle stress readout.
 *
 * Separated from the body so that bodies are all Sprites sharing one texture and batch
 * into a single draw call. Mixing a Graphics between every pair of sprites would break
 * the batch on each switch, which at 500 units is the whole frame budget.
 */
function drawDecal(
  graphics: Graphics,
  isCattle: boolean,
  stressPct: number,
  stampeding: boolean,
  selected: boolean,
): void {
  const r = isCattle ? cattleStyle.radius : radius;

  if (selected) {
    graphics.ellipse(0, 0, r + 5, (r + 5) / 2);
    graphics.stroke({ width: 2, color: SELECTED, alpha: 0.9 });
  }

  graphics.ellipse(0, 0, r * 0.9, r * 0.45);
  graphics.fill({ color: 0x000000, alpha: 0.3 });

  if (!isCattle) return;

  if (stampeding) {
    graphics.ellipse(r * 0.9, -r * 0.3, r * 1.2, r * 0.42);
    graphics.fill({ color: PANIC, alpha: 0.22 });
    graphics.ellipse(r * 1.7, -r * 0.25, r * 0.9, r * 0.3);
    graphics.fill({ color: PANIC, alpha: 0.12 });
  }

  // The stress ring sits on the ground under the beast rather than around its body, so
  // it is never occluded by the sprite in front of it. Gate 2 turns on a player being
  // able to read stress across a whole herd at a glance.
  graphics.ellipse(0, 0, r * 1.5, r * 0.75);
  graphics.stroke({
    width: stampeding ? 3.5 : 1 + (stressPct / 255) * 2,
    color: stressColour(stressPct),
    alpha: stampeding ? 1 : 0.35 + (stressPct / 255) * 0.6,
  });
}

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
  update(
    view: InterpolatedView,
    map: Heightmap,
    selected: ReadonlySet<number>,
    damage?: DamageFlashes,
    now?: number,
  ): void;
  /** Screen position of each drawn entity, for hit-testing against what is on screen. */
  screenPosition(view: InterpolatedView, index: number, map: Heightmap): { x: number; y: number };
}

interface Marker {
  /** Ground decoration, below every body. */
  readonly decal: Graphics;
  /** Buildings, and the untextured fallback for everything else. */
  readonly graphics: Graphics;
  /** The textured body of a unit or a cow. */
  readonly sprite: Sprite;
  /** The player-colour marking, tinted per faction and drawn over the body. */
  readonly team: Sprite;
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

/**
 * A health bar, drawn only when there is something to say.
 *
 * Full health draws nothing. A bar over every unit on the field is noise that hides the
 * one piece of information it exists to carry — which of them is in trouble — and a herd
 * of forty would be a wall of green.
 */
function drawHealth(
  graphics: Graphics,
  hpPct: number,
  kind: number,
  screenX: number,
  screenY: number,
): void {
  if (hpPct >= 255) return;

  const isCattle = kind === KIND_CATTLE;
  const isBuilding = kind === KIND_BUILDING;
  const width = isBuilding ? 30 : isCattle ? 20 : 16;
  const lift = isBuilding ? 34 : isCattle ? 22 : 40;
  const left = screenX - width / 2;
  const top = screenY - lift;
  const fraction = hpPct / 255;

  graphics.rect(left - 1, top - 1, width + 2, 5);
  graphics.fill({ color: 0x000000, alpha: 0.55 });
  graphics.rect(left, top, width * fraction, 3);
  // Green through amber to red, so the colour says how bad it is without reading a
  // length — the same reason the cattle stress ring is coloured rather than sized.
  graphics.fill({ color: fraction > 0.5 ? CALM : fraction > 0.25 ? ALARM : PANIC });
}

function groundHeight(map: Heightmap, worldX: number, worldY: number): number {
  const height = heightAt(map, Math.floor(worldX), Math.floor(worldY));
  return height < 0 ? 0 : height;
}

export function createEntityLayer(
  atlas: SpriteAtlas | null = null,
  decorations: readonly Decoration[] = [],
): EntityLayer {
  const container = new Container();
  // Two layers, because batching depends on it. Ground decoration is all Graphics and
  // all of it draws below every body; bodies are Sprites off one atlas page and batch
  // into a single call. Buildings stay Graphics in the body layer so they keep sorting
  // correctly against units — there are few enough of them that the batch breaks they
  // cost are affordable, which is not true of units.
  const decals = new Container();
  const bodies = new Container();
  // Health bars go above everything, in one Graphics for the whole field. Drawing them
  // per entity would put a Graphics between every pair of sprites and break the batch;
  // one object redrawn each frame costs a single draw call, and only wounded entities
  // are in it.
  const health = new Graphics();
  container.addChild(decals);
  container.addChild(bodies);
  container.addChild(health);

  const markers: Marker[] = [];
  // Persistent, hysteresis-damped order. See depthOrder.ts: a plain sort by depth is
  // correct and makes a dense herd shimmer.
  const depthOrder = createDepthOrder();

  /**
   * Scenery, sorted in the same pass as the entities.
   *
   * It has to be the same pass. Drawing vegetation with the terrain would put every unit
   * in front of every tree, so troops would walk over a canopy instead of behind it —
   * and a tree that cannot be stood behind is a painted backdrop rather than part of the
   * scene. So each prop joins the depth sort as if it were an entity, with a synthetic
   * handle that cannot collide with a real one.
   *
   * They never move, so their depth is computed once. Positions are fixed, kinds are
   * fixed, and the only per-frame work is where the sort puts them.
   */
  const props: { sprite: Sprite; depth: number; x: number; y: number }[] = [];
  if (atlas !== null) {
    for (const decoration of decorations) {
      const frame = atlas.frame(decoration.kind, 'still', 0, decoration.variant);
      if (frame === null) continue;
      const sprite = new Sprite(frame.texture);
      sprite.scale.set(frame.scale);
      const screenX = worldToScreenX(decoration.worldX, decoration.worldY);
      const screenY = worldToScreenY(decoration.worldX, decoration.worldY, 0);
      sprite.position.set(
        screenX - frame.anchorX * frame.scale,
        screenY - frame.anchorY * frame.scale,
      );
      bodies.addChild(sprite);
      props.push({
        sprite,
        depth: decoration.worldX + decoration.worldY,
        x: decoration.worldX,
        y: decoration.worldY,
      });
    }
  }

  /**
   * Keys for the scenery in the depth sort, in a range no real handle can occupy.
   *
   * A handle packs a 24-bit index under an 8-bit GENERATION, so the generation owns bits
   * 24 to 31 — the top bit included. Tagging props with the high bit, which is what this
   * did first, collides with every real handle whose generation has reached 128, and
   * generations climb as slots are recycled. The collision would corrupt the draw order
   * rather than the simulation, since draw order is presentation, but a herd redrawing
   * itself in the wrong order after a long match is not a defect anyone would trace back
   * to here.
   *
   * The sound range is the one the allocator refuses to issue: generation zero. `spawn`
   * never assigns it — it skips from 255 to 1 on wrap, and world.test.ts asserts that
   * across a full cycle — so any value with zero in the top eight bits is a key no live
   * entity can ever hold. A plain index is exactly that, for any map with fewer than 16
   * million trees on it.
   */
  const propHandles = new Uint32Array(props.length);
  for (let i = 0; i < props.length; i++) propHandles[i] = i & 0x00ffffff;

  let handleScratch = new Uint32Array(0);
  let previousOrder = new Int32Array(0);

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

    update(
      view: InterpolatedView,
      map: Heightmap,
      selected: ReadonlySet<number>,
      damage?: DamageFlashes,
      now = 0,
    ): void {
      const count = view.count;
      health.clear();

      while (markers.length < count) {
        const decal = new Graphics();
        const graphics = new Graphics();
        const sprite = new Sprite();
        const team = new Sprite();
        decals.addChild(decal);
        bodies.addChild(graphics);
        bodies.addChild(sprite);
        // Immediately after its body, and off the same atlas page, so the pair still
        // batches with every other sprite rather than costing a draw call each.
        bodies.addChild(team);
        markers.push({ decal, graphics, sprite, team, signature: -1 });
      }
      for (let i = count; i < markers.length; i++) {
        const marker = markers[i]!;
        marker.decal.visible = false;
        marker.graphics.visible = false;
        marker.sprite.visible = false;
        marker.team.visible = false;
      }

      // Back to front along the isometric axis, computed from the INTERPOLATED
      // positions these markers are actually drawn at. Scenery joins the same sort,
      // appended after the entities, so a unit can stand behind a tree.
      const total = count + props.length;
      if (handleScratch.length !== total) handleScratch = new Uint32Array(total);
      handleScratch.set(view.handle.subarray(0, count));
      handleScratch.set(propHandles, count);

      const order = depthOrder.order(
        total,
        handleScratch,
        (slot) => (slot < count ? view.x[slot]! + view.y[slot]! : props[slot - count]!.depth),
        presentation.entities.depthHysteresis,
      );

      // Child order IS draw order, and markers are no longer contiguous now that scenery
      // is interleaved with them — so the sort is applied by re-parenting each object in
      // turn, rather than by relying on marker N being the Nth child.
      //
      // Only when something actually moved, though. Pixi's addChild removes before it
      // appends and the removal is a linear scan, so re-parenting every object every
      // frame is quadratic in the number of children — and with several hundred trees on
      // the map that is a bill paid on every frame for a draw order that, most frames,
      // has not changed.
      //
      // Compared against the previous order rather than trusting the comparator's swap
      // count. Zero swaps means it did not REORDER anything, which is not the same as
      // nothing having changed: one entity dying while another spawns leaves the count
      // identical and can leave the swap count at zero, while the mapping from sorted
      // position to marker has shifted underneath. Comparing the order itself is the
      // same O(n) the loop already costs and cannot be fooled.
      let settled = previousOrder.length === order.length;
      if (settled) {
        for (let i = 0; i < order.length; i++) {
          if (previousOrder[i] !== order[i]) {
            settled = false;
            break;
          }
        }
      }
      if (!settled) {
        if (previousOrder.length !== order.length) previousOrder = new Int32Array(order.length);
        previousOrder.set(order);
      }

      let markerSlot = 0;
      for (let place = 0; place < order.length; place++) {
        const sorted = order[place]!;
        if (sorted >= count) {
          if (!settled) bodies.addChild(props[sorted - count]!.sprite);
          continue;
        }
        const marker = markers[markerSlot++]!;
        if (settled) continue;
        decals.addChild(marker.decal);
        bodies.addChild(marker.graphics);
        bodies.addChild(marker.sprite);
        bodies.addChild(marker.team);
      }

      markerSlot = 0;
      for (let place = 0; place < order.length; place++) {
        const sorted = order[place]!;
        if (sorted >= count) continue;
        const index = sorted;
        const marker = markers[markerSlot++]!;
        const faction = view.faction[index]!;
        const handle = view.handle[index]!;
        const isSelected = selected.has(handle);
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

        const position = this.screenPosition(view, index, map);

        // Before the textured branch, not inside it. Health has nothing to do with
        // whether the body is a sprite or a fallback shape, and putting it in the
        // textured path meant the bars vanished entirely whenever the atlas failed to
        // load — which is exactly when a player would most need to know what is going on.
        drawHealth(health, view.hpPct[index]!, kind, position.x, position.y);

        const textured = atlas !== null;

        if (marker.signature !== signature) {
          marker.decal.clear();
          marker.graphics.clear();
          if (isBuilding && !textured) drawBuilding(marker.graphics, progressBand << 4, isSelected);
          else if (textured) drawDecal(marker.decal, isCattle, stressBand << 4, stampeding, isSelected);
          else if (isCattle) drawCow(marker.graphics, stressBand << 4, stampeding, isSelected);
          else drawUnit(marker.graphics, faction, isSelected);
          marker.signature = signature;
        }

        marker.decal.position.set(position.x, position.y);
        marker.decal.visible = textured;
        marker.graphics.position.set(position.x, position.y);
        marker.graphics.visible = !textured;
        marker.sprite.visible = false;
        marker.team.visible = false;

        if (!textured) continue;

        const name = spriteKind(kind, view.subtype[index]!, handle);
        const anim = isBuilding ? 'build' : (ANIM_NAME[view.animState[index]!] ?? 'idle');
        const frames = atlas!.frameCount(name, anim);
        if (frames === 0) continue;

        // Facing is a world angle about +Z from +X, and so is the sprite's direction
        // index: the model is built facing +X and rotated by an eighth turn per
        // direction. Rounding rather than flooring puts the boundary between two
        // directions halfway between them, so a unit turning on the spot switches at
        // the midpoint instead of a step early.
        const turn = TAU / atlas!.directions;
        let direction = isBuilding ? 0 : Math.round(view.facing[index]! / turn) % atlas!.directions;
        if (direction < 0) direction += atlas!.directions;

        // A building's "frame" is how far along it is, not how long it has been alive.
        // The last stage holds once complete rather than looping back to a foundation.
        const frameIndex = isBuilding
          ? Math.min(frames - 1, Math.floor((view.progressPct[index]! / 256) * BUILD_STAGES))
          : Math.floor(view.animPhase[index]! / spriteStyle.ticksPerFrame) % frames;
        const frame = atlas!.frame(name, anim, direction, frameIndex);
        if (!frame) continue;

        marker.sprite.texture = frame.texture;
        marker.sprite.scale.set(frame.scale);
        marker.sprite.position.set(
          position.x - frame.anchorX * frame.scale,
          position.y - frame.anchorY * frame.scale,
        );
        // A struck entity flashes. It takes precedence over the selection tint for the
        // fraction of a second it lasts, because "this one is being hurt right now" is
        // the more urgent of the two things to say.
        const struck = damage?.isFlashing(handle, now) === true;
        marker.sprite.tint = struck ? HURT : isSelected ? SELECTED : 0xffffff;
        marker.sprite.visible = true;

        // Player colour, as a tinted overlay rather than a recoloured atlas.
        // ARCHITECTURE section 9 rules out pre-tinted per-faction pages — they multiply
        // the art budget by faction count and every extra page breaks the batch — and
        // asks for a shader swap. A tinted sprite IS one: the tint is applied in the
        // renderer's own batch shader, so one set of art serves every faction and the
        // overlay batches with the body it sits on.
        const teamFrame = atlas!.frame(`${name}-team`, anim, direction, frameIndex);
        if (teamFrame !== null) {
          marker.team.texture = teamFrame.texture;
          marker.team.scale.set(teamFrame.scale);
          marker.team.position.set(
            position.x - teamFrame.anchorX * teamFrame.scale,
            position.y - teamFrame.anchorY * teamFrame.scale,
          );
          marker.team.tint = FACTION[faction % FACTION.length] ?? FACTION[0]!;
          marker.team.visible = true;
        }
      }
    },
  };
}
