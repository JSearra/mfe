import { UPDATE_PRIORITY } from 'pixi.js';
import { t } from './core/i18n/index.js';
import { heightAt } from './shared/heightmap.js';
import { worldToScreenX, worldToScreenY } from './shared/iso.js';
import { NO_TILE, pickTileIndex, tileX, tileY } from './shared/picking.js';
import { BuildingType } from './shared/buildings/index.js';
import { CommandKind } from './sim/commands.js';
import { TECH_IDS } from './shared/tech/index.js';
import { createDirectSimHost, type SimHost } from './host/directHost.js';
import { createWorkerSimHost } from './host/worker/workerHost.js';
import { createHeightmap } from './sim/terrain/generate.js';
import { MAP_SCRIPTS, generateMap, type MapScript } from './sim/terrain/maps.js';
import { FactionId } from './shared/factions/index.js';
import { createWorld } from './sim/world.js';
import { largestRegion, snapToRegion } from './sim/terrain/placement.js';
import { createRenderer } from './render/app.js';
import { createAudioEngine } from './render/audio.js';
import {
  createCamera,
  createCameraInput,
  setViewport,
  updateCamera,
  clampCamera,
  mapBounds,
  worldToViewportX,
  worldToViewportY,
} from './render/camera.js';
import { bindInput } from './render/input.js';
import { createInterpolator, type InterpolatedView } from './render/interpolation.js';
import { installPerfHarness } from './render/perfHarness.js';
import { createEntityLayer } from './render/scene/entities.js';
import { planDecorations } from './render/scene/decoration.js';
import { createDamageFlashes } from './render/scene/damage.js';
import { loadSpriteAtlas, loadTerrainTiles } from './render/assets.js';
import { presentation } from './render/presentation.js';
import { createTileCursor, placeTileCursor } from './render/scene/cursor.js';
import { createFogRenderer } from './render/scene/fog.js';
import { createTerrain } from './render/scene/terrain.js';
import {
  createMarqueeGraphics,
  createSelection,
  drawMarquee,
  entitiesNear,
  pickEnemy,
  pickEntity,
  type Rect,
} from './render/selection.js';
import { createRenderStats } from './render/stats.js';
import { createDebugOverlay } from './ui/debugOverlay.js';
import { createCommandPanel } from './ui/commandPanel.js';
import { createMinimap } from './ui/minimap.js';
import { createAlerts } from './ui/alerts.js';
import { showSetup } from './ui/setup.js';
import { createOutcomeBanner } from './ui/outcomeBanner.js';
import { createResourceBar } from './ui/resourceBar.js';

/**
 * Phase 3 entry point: the simulation now runs behind a boundary.
 *
 * This module is the composition root, and the only place that touches both sides. The
 * renderer below it reads snapshots and events; it never reads the world. That rule is
 * enforced by ESLint rather than discipline, because it is what makes the eventual
 * worker flip a transport change instead of a UI rewrite — see ADR-0004.
 */

const BACKGROUND = 0x14110d;
const MAP_SIZE = 128;
const MAP_SEED = 0x4d666563;
const WORLD_SEED = 0x5eedcafe;
const PLAYER = 0;
const STARTING_UNITS = 24;
/**
 * Cattle per grazing herd. Six herds, so seventy-two head on the veld.
 *
 * There were thirty, in a single blob within sight of the player, and that was the whole
 * raidable supply of a game about raiding cattle. Against the eighty head a player needs
 * to win it meant a raid could never be the fastest route: building kraals out-produced
 * the entire veld. Seventy-two, in six herds, makes sweeping the map worth roughly what
 * winning costs — and still not quite enough on its own, so the last stretch has to come
 * from breeding or from the enemy.
 */
const HERD_SIZE = 12;
const ENEMY = 1;
const ENEMY_UNITS = 16;

const KIND_UNIT = 0;
const KIND_CATTLE = 1;
const KIND_BUILDING = 2;
const MOVEMENT_INFANTRY = 0;
const HERD_LEASHED = 1;
const HERD_STAMPEDING = 3;

/** Right-clicking one cow leashes the beasts around it, not just that one. */
const HERD_GRAB_RADIUS = 3.5;

/** Herd readout for the debug overlay, counted from what is actually on screen. */
function herdCounts(view: InterpolatedView | null): {
  cattleCount: number;
  leashedCount: number;
  stampedingCount: number;
} {
  let cattleCount = 0;
  let leashedCount = 0;
  let stampedingCount = 0;

  if (view !== null) {
    for (let i = 0; i < view.count; i++) {
      if (view.kind[i] !== KIND_CATTLE) continue;
      cattleCount++;
      const state = view.flags[i]! & 0x0f;
      if (state === HERD_LEASHED) leashedCount++;
      else if (state === HERD_STAMPEDING) stampedingCount++;
    }
  }
  return { cattleCount, leashedCount, stampedingCount };
}

/**
 * Everything the current game owns that must be released before another can start.
 *
 * Collected as the game is built rather than reconstructed at teardown, so a listener
 * added without a matching release is a visible omission at the point it is added. The
 * failure this prevents is quiet: window listeners survive a restart, so a second game
 * fires every hotkey twice and a third three times, and nothing about that looks like a
 * lifecycle bug when you meet it.
 */
type Teardown = (() => void)[];

let teardown: Teardown = [];

declare global {
  interface Window {
    /**
     * Restart, for tooling. Same hook shape as `window.__perf`.
     *
     * Exposed because the only in-game route to a restart is winning or losing, and
     * "play a match to completion" is not a way to test that the teardown releases what
     * it claims to. The hazard being tested for is quiet: window listeners outlive a
     * restart, so a second game fires every hotkey twice.
     */
    __restart?: () => Promise<void>;
  }
}

/** What a match is set up with. */
export interface GameOptions {
  /** One of the four scripted landscapes, or null for the generated heightmap. */
  readonly mapScript: MapScript | null;
  readonly mapSeed: number;
  readonly playerFaction: FactionId;
  readonly enemyFaction: FactionId;
  /** How the player's own troops are turned out. Purely presentational. */
  readonly shieldColour: string;
  readonly markingColour: string;
}

/**
 * The options in force. Restart reuses them, so "play again" means the same match
 * rather than dropping the player back into a menu they have already answered.
 */
let currentOptions: GameOptions | null = null;

async function restart(options: GameOptions | null = currentOptions): Promise<void> {
  for (const release of teardown.reverse()) release();
  teardown = [];
  await main(options ?? defaultOptions());
}

function defaultOptions(): GameOptions {
  // The query parameters still work and still win. They predate the setup screen, they
  // are how the perf harness and the screenshot tooling ask for a specific match, and a
  // menu that ignored them would break both.
  const params = new URLSearchParams(location.search);
  const requested = params.get('map');
  const seed = Number(params.get('seed'));
  return {
    mapScript: MAP_SCRIPTS.includes(requested as MapScript) ? (requested as MapScript) : null,
    mapSeed: Number.isFinite(seed) && seed !== 0 ? seed : MAP_SEED,
    playerFaction: FactionId.Zulu,
    enemyFaction: FactionId.Sotho,
    shieldColour: '#e8e2d4',
    markingColour: '#2b2723',
  };
}

async function main(options: GameOptions): Promise<void> {
  currentOptions = options;
  document.title = t('app.title');

  const root = document.getElementById('app') ?? document.body;
  root.textContent = '';

  // The renderer needs the heightmap for terrain, picking and the fog overlay. It
  // generates its own from the seed rather than receiving one: terrain generation is
  // deterministic, so both sides arrive at the same map without transferring it.
  // ?map=karoo and friends pick one of the four scripted landscapes. Both sides build
  // it from the same seed, so nothing has to be transferred.
  const { mapScript, mapSeed } = options;

  const map =
    mapScript === null
      ? createHeightmap(MAP_SIZE, MAP_SIZE, mapSeed)
      : generateMap(mapScript, MAP_SIZE, MAP_SIZE, mapSeed);

  // Where each side begins. The hosts lay arable land out around these, and the unit
  // seeding below uses the same numbers, so the fields are where the people are.
  const centre = MAP_SIZE / 2;
  const starts = [
    { x: centre, y: centre },
    { x: centre + 34, y: centre + 26 },
  ];

  // Worker by default now that the boundary discipline has held. ?sim=direct keeps the
  // main-thread host one query parameter away, because stepping through a simulation in
  // a debugger is worth a great deal when something is wrong.
  const useWorker = new URLSearchParams(location.search).get('sim') !== 'direct';
  const sim: SimHost = useWorker
    ? createWorkerSimHost({
        mapSize: MAP_SIZE,
        mapSeed,
        mapScript,
        worldSeed: WORLD_SEED,
        capacity: 512,
        viewerId: PLAYER,
        playerId: PLAYER,
        factions: [options.playerFaction, options.enemyFaction],
        aiPlayers: [ENEMY],
        starts,
      })
    : createDirectSimHost({
        world: createWorld(512, WORLD_SEED),
        map,
        viewerId: PLAYER,
        playerId: PLAYER,
        aiPlayers: [ENEMY],
        factions: [options.playerFaction, options.enemyFaction],
        starts,
      });

  /**
   * Everything a match places goes through here first.
   *
   * A generated map is not one walkable surface, and a position chosen by arithmetic
   * lands wherever the terrain happens to put it. On the Magaliesberg that dropped the
   * player's whole force onto a ridge flank in a contour ribbon of eighty tiles it could
   * never leave — it could not reach the one herd in the game, so the map could not be
   * won. See src/sim/terrain/placement.ts.
   *
   * On an unbroken map — the default veld, thaba-bosiu — this changes nothing at all.
   */
  const walkable = largestRegion(map);
  const place = (x: number, y: number): { x: number; y: number } =>
    snapToRegion(map, walkable, x, y);

  // Seed a small force near the centre. Spawning through commands rather than touching
  // the world directly keeps the invariant that commands are the only mutation path.
  const home = place(centre - 2, centre);
  for (let i = 0; i < STARTING_UNITS; i++) {
    const column = i % 6;
    const row = Math.floor(i / 6);
    const at = place(home.x + column * 1.4 - 4, home.y + row * 1.4 - 2);
    sim.sendCommand(CommandKind.Spawn, at.x, at.y, PLAYER, KIND_UNIT);
  }

  // An opposing force, far enough off that first contact is something the player walks
  // into rather than something that happens to them at load.
  const enemyHome = place(centre + 34, centre + 26);
  for (let i = 0; i < ENEMY_UNITS; i++) {
    const at = place(enemyHome.x + (i % 4) * 1.3, enemyHome.y + Math.floor(i / 4) * 1.3);
    sim.sendCommand(CommandKind.Spawn, at.x, at.y, ENEMY, KIND_UNIT);
  }

  // Where the herds graze, as offsets from the centre of the map.
  //
  // The first is on the player's doorstep and deliberately stays there: the herd once
  // sat sixteen tiles out against a vision radius of eight, so a game about cattle
  // opened with no cattle on screen and the player had to go looking for the mechanic.
  // It is still far enough off that the troops do not frighten it — nothing stampedes
  // in the opening minute.
  //
  // The rest are mirrored about the midpoint between the two starts, so neither side is
  // handed a herd the other cannot reach on the same terms. Each gets one on its
  // doorstep at about eleven tiles, one close by at twelve, and one out at twenty-eight
  // that has to be ranged for. A raid means driving a herd home over ground the other
  // side also wants, and holding it once you have — which is the game this project is
  // named for.
  //
  // Measured rather than eyeballed: with the player at the centre and the enemy at
  // (+36, +28), these sit at 10.8 / 12.2 / 27.9 tiles from each start respectively.
  const HERD_SITES: readonly (readonly [number, number])[] = [
    [9, 6], // the player's doorstep
    [27, 22], // the enemy's, its mirror
    [2, -12], // near the player
    [34, 40], // near the enemy, its mirror
    [-10, 26], // out in open country, player's side
    [46, 2], // out in open country, enemy's side
  ];

  for (const [rawX, rawY] of HERD_SITES) {
    const anchor = place(centre + rawX, centre + rawY);
    // A cluster, not a ring: cattle graze together, and a hollow ring has no centre to
    // click on or drive into. The radius follows the separation distance — at 1.5 units
    // apart a dozen beasts need about three units of room, and spawning them tighter
    // than they will stand just makes them shove each other apart on tick one.
    for (let i = 0; i < HERD_SIZE; i++) {
      const angle = i * 2.399963; // golden angle, so the blob fills evenly
      const spread = 3.2 * Math.sqrt((i + 0.5) / HERD_SIZE);
      const at = place(anchor.x + Math.cos(angle) * spread, anchor.y + Math.sin(angle) * spread);
      sim.sendCommand(CommandKind.SpawnCattle, at.x, at.y);
    }
  }

  const { app } = await createRenderer(root, BACKGROUND);
  const camera = createCamera(app.renderer.width, app.renderer.height);
  const input = createCameraInput();

  camera.x = 0;
  camera.y = MAP_SIZE * 16;
  // The camera may not leave the map. Without this, a held pan key walks the view into
  // empty space and nothing is relative enough to the map to bring it back.
  const cameraBounds = mapBounds(map.width, map.height, map.levels - 1);

  const terrainTiles = await loadTerrainTiles();
  const terrain = createTerrain(map, terrainTiles);
  const cursor = createTileCursor();
  // Null if the atlas is missing or malformed, and the entity layer then falls back to
  // drawing shapes. Art is not worth failing to start over, and the build runs without
  // the pipeline ever having been run.
  const atlas = await loadSpriteAtlas(presentation.sprites.pixelsPerWorldUnit);
  // Scenery is derived from the map seed rather than stored: identical on every machine
  // that builds the same map, and nothing to transmit or save.
  const entities = createEntityLayer(atlas, planDecorations(map, mapSeed), {
    shield: Number.parseInt(options.shieldColour.slice(1), 16),
    marking: Number.parseInt(options.markingColour.slice(1), 16),
    faction: PLAYER,
  });
  const damage = createDamageFlashes();
  const fog = createFogRenderer(map);
  terrain.container.addChild(cursor);
  terrain.container.addChild(entities.container);
  // Fog goes on top of everything in the world layer: it hides terrain as well as what
  // stands on it.
  terrain.container.addChild(fog.container);
  app.stage.addChild(terrain.container);

  const marquee = createMarqueeGraphics();
  app.stage.addChild(marquee);

  const interpolator = createInterpolator();
  const selection = createSelection();
  const audio = createAudioEngine();
  // Browsers refuse to start audio without a gesture, so the first click starts it.
  const startAudio = (): void => audio.resume();
  const lifetime = new AbortController();
  const { signal } = lifetime;
  app.canvas.addEventListener('pointerdown', startAudio, { once: true, signal });
  window.addEventListener('keydown', startAudio, { once: true, signal });

  const stats = createRenderStats();
  const overlay = createDebugOverlay(root);
  const resourceBar = createResourceBar(root);
  const outcomeBanner = createOutcomeBanner(root, { onRestart: () => void restart() });
  const alerts = createAlerts();
  root.appendChild(alerts.element);
  const minimap = createMinimap(root, map, {
    onSeek(worldX, worldY) {
      // Centre the camera on the clicked point, in isometric space.
      camera.x = worldToScreenX(worldX, worldY);
      camera.y = worldToScreenY(worldX, worldY, 0);
    },
  });
  let latestFog: Uint8Array | null = null;
  let armed: BuildingType | null = null;

  const panel = createCommandPanel(root, {
    onTrain(buildingHandle, movementClass) {
      sim.sendCommand(CommandKind.Train, buildingHandle, movementClass);
    },
    onArmBuild(type) {
      armed = type;
    },
    onResearch(techIndex) {
      sim.sendCommand(CommandKind.Research, techIndex, PLAYER);
    },
  });

  let view: InterpolatedView | null = null;
  const herdScratch: number[] = [];

  /** Viewport point -> the world position of the tile under it. */
  function worldPointAt(viewportX: number, viewportY: number): { x: number; y: number } | null {
    const isoX = (viewportX - camera.viewportWidth / 2) / camera.zoom + camera.x;
    const isoY = (viewportY - camera.viewportHeight / 2) / camera.zoom + camera.y;
    const index = pickTileIndex(map, isoX, isoY);
    if (index === NO_TILE) return null;
    return { x: tileX(map, index) + 0.5, y: tileY(map, index) + 0.5 };
  }

  // Build mode: a number key arms a type, the next left-click sites it. Kept in the
  // composition root rather than in input.ts because it is a game rule about what a
  // click means, not a fact about the pointer.
  let researchCursor = 0;
  // Armed by A, spent on the next order click. Client state: which ORDER a click will
  // issue is not something the simulation has any business knowing.
  let attackMoveArmed = false;
  let patrolArmed = false;

  // Only the first three have a digit. Control groups own 4-9, and making the most-used
  // keys in the game ambiguous is a worse trade than reaching for the panel to place a
  // structure you build once a match. The command panel lists every building type
  // automatically, so the new ones are not hidden — just not on a digit.
  const buildKeys: Readonly<Record<string, BuildingType>> = {
    '1': BuildingType.Isibaya,
    '2': BuildingType.Umuzi,
    '3': BuildingType.GrainStore,
  };

  window.addEventListener('keydown', (event) => {
    // Control groups. Ctrl (or Cmd) assigns, the bare digit recalls. Entirely client
    // state — no command is sent and the simulation never learns any of it happened.
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9 && (event.ctrlKey || event.metaKey)) {
      selection.assignGroup(digit);
      event.preventDefault();
      return;
    }
    if (Number.isInteger(digit) && digit >= 4 && digit <= 9 && view !== null) {
      // 1-3 are build hotkeys, so groups start at 4. Colliding with build mode would
      // make the most-used keys in the game ambiguous.
      selection.recallGroup(digit, view);
      return;
    }

    if (event.key === 'Escape' && sim.speed === 0) {
      sim.speed = 1;
      return;
    }
    if (event.key === '`' || event.key === 'Pause') {
      sim.speed = sim.speed === 0 ? 1 : 0;
      return;
    }
    if (event.key === '+' || event.key === '=') {
      // Capped. Past a point the simulation cannot keep up and the catch-up limiter
      // silently eats the difference, which looks like the game ignoring the key.
      sim.speed = Math.min(4, (sim.speed === 0 ? 1 : sim.speed) * 2);
      return;
    }
    if (event.key === '-' || event.key === '_') {
      sim.speed = Math.max(0.5, (sim.speed === 0 ? 1 : sim.speed) / 2);
      return;
    }
    if (event.key === 'p' || event.key === 'P') {
      patrolArmed = true;
      attackMoveArmed = false;
      return;
    }
    if (event.key === 'a' || event.key === 'A') {
      // Arm, then click — the genre's convention, and the reason it is a mode rather
      // than a modifier is that the click may be a long way from the key press.
      attackMoveArmed = true;
      return;
    }
    if (event.key === ' ') {
      // Go to the last thing that happened out of view. Deliberately a key rather than
      // the camera moving itself: having the view yanked away mid-order is worse than
      // missing the event, and a stampede fires precisely when you are busy elsewhere.
      if (alerts.jump(camera, performance.now())) event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      attackMoveArmed = false;
      patrolArmed = false;
      armed = null;
      return;
    }
    // R cycles through the tree, starting whatever is next available. A proper
    // research panel is UI work the game does not have yet; this is enough to reach
    // the mechanic.
    if (event.key === 'r' || event.key === 'R') {
      sim.sendCommand(CommandKind.Research, researchCursor % TECH_IDS.length, PLAYER);
      researchCursor++;
      return;
    }

    // T raises a spearman at every homestead we own. Buildings are not selectable yet
    // — that needs the selection panel — so this broadcasts, and anything that is not a
    // trainer refuses harmlessly.
    if ((event.key === 't' || event.key === 'T') && view !== null) {
      for (let i = 0; i < view.count; i++) {
        if (view.kind[i] !== KIND_BUILDING || view.faction[i] !== PLAYER) continue;
        sim.sendCommand(CommandKind.Train, view.handle[i]!, MOVEMENT_INFANTRY);
      }
      return;
    }

    const type = buildKeys[event.key];
    if (type !== undefined) armed = type;
  }, { signal });

  const boundInput = bindInput(app.canvas, camera, input, {
    onClickSelect(x, y, additive) {
      if (armed !== null) {
        const isoX = (x - camera.viewportWidth / 2) / camera.zoom + camera.x;
        const isoY = (y - camera.viewportHeight / 2) / camera.zoom + camera.y;
        const index = pickTileIndex(map, isoX, isoY);
        if (index !== NO_TILE) {
          sim.sendCommand(CommandKind.Build, tileX(map, index), tileY(map, index), armed, PLAYER);
        }
        armed = null;
        return;
      }
      if (view !== null) selection.selectAt(view, map, camera, entities, x, y, PLAYER, additive);
    },
    onMarqueeSelect(rect, additive) {
      if (view !== null)
        selection.selectInRect(view, map, camera, entities, rect, PLAYER, additive);
    },
    onMarqueeChange(rect: Rect | null) {
      drawMarquee(marquee, rect);
    },
    onOrder(x, y, queued) {
      if (selection.handles.size === 0 || view === null) return;

      // Right-clicking a cow herds it; right-clicking ground is a move order. Same
      // button, read from what is under it, as the genre expects.
      // Right-click reads what is under it: an enemy is attacked, a cow is herded,
      // bare ground is a move order. One button, three meanings, as the genre expects.
      const foe = pickEnemy(view, map, camera, entities, x, y, PLAYER);
      if (foe !== -1) {
        // Answer the click now. The order will not execute for another tick or three,
        // and a renderer running 75ms behind the simulation only feels instant because
        // the local half of the feedback does not wait for it.
        audio.acknowledge('attack');
        for (const handle of selection.handles) {
          sim.sendCommand(CommandKind.Attack, handle, foe);
        }
        return;
      }

      const cow = pickEntity(view, map, camera, entities, x, y, KIND_CATTLE);
      if (cow !== -1) {
        const slot = view.handle.indexOf(cow);
        const herd = entitiesNear(
          view,
          view.x[slot]!,
          view.y[slot]!,
          HERD_GRAB_RADIUS,
          KIND_CATTLE,
          herdScratch,
        );
        audio.acknowledge('herd');
        const herders = [...selection.handles];
        for (let i = 0; i < herd.length; i++) {
          sim.sendCommand(CommandKind.Leash, herders[i % herders.length]!, herd[i]!);
        }
        return;
      }

      const target = worldPointAt(x, y);
      if (target === null) return;
      // Orders carry a handle, never a position: by the time this executes the target
      // may be dead, and the handle's generation is what says so.
      audio.acknowledge('move');
      const kind = patrolArmed
        ? CommandKind.Patrol
        : attackMoveArmed
          ? CommandKind.AttackMove
          : CommandKind.MoveTo;
      attackMoveArmed = false;
      patrolArmed = false;
      for (const handle of selection.handles) {
        sim.sendCommand(kind, handle, target.x, target.y, queued ? 1 : 0);
      }
    },
  });

  // Dev-only inspection hook for browser-driven verification. Exposes render-side
  // state only — the interpolated view and the selection — never the world, which
  // would be exactly the synchronous simulation read the boundary exists to prevent.
  if (import.meta.env?.DEV) {
    (window as unknown as Record<string, unknown>).__debug = {
      renderTick: () => interpolator.renderTick,
      camera: () => [Math.round(camera.x), Math.round(camera.y)],
      simTick: () => sim.tick,
      count: () => view?.count ?? 0,
      selected: () => [...selection.handles],
      handles: () => (view === null ? [] : Array.from(view.handle.subarray(0, view.count))),
      audio: () => ({ running: audio.running, voices: audio.voicesPlayed }),
      herd: () => {
        const counts = herdCounts(view);
        let maxStress = 0;
        if (view !== null) {
          for (let i = 0; i < view.count; i++) {
            if (view.kind[i] === KIND_CATTLE) maxStress = Math.max(maxStress, view.stressPct[i]!);
          }
        }
        return { ...counts, maxStress };
      },
      /** Viewport position of one cow, for driving clicks at something that exists. */
      cowViewport: (n = 0) => {
        if (view === null) return null;
        let seen = 0;
        for (let i = 0; i < view.count; i++) {
          if (view.kind[i] !== KIND_CATTLE) continue;
          if (seen++ < n) continue;
          const height = heightAt(map, Math.floor(view.x[i]!), Math.floor(view.y[i]!));
          return [
            worldToViewportX(camera, view.x[i]!, view.y[i]!),
            worldToViewportY(camera, view.x[i]!, view.y[i]!, height < 0 ? 0 : height),
          ];
        }
        return null;
      },
      /** Viewport position of the herd's centre of mass, for driving the camera at it. */
      herdCentre: () => {
        if (view === null) return null;
        let sumX = 0;
        let sumY = 0;
        let n = 0;
        for (let i = 0; i < view.count; i++) {
          if (view.kind[i] !== KIND_CATTLE) continue;
          sumX += view.x[i]!;
          sumY += view.y[i]!;
          n++;
        }
        if (n === 0) return null;
        const worldX = sumX / n;
        const worldY = sumY / n;
        const height = heightAt(map, Math.floor(worldX), Math.floor(worldY));
        return [
          worldToViewportX(camera, worldX, worldY),
          worldToViewportY(camera, worldX, worldY, height < 0 ? 0 : height),
        ];
      },
      positions: () =>
        view === null
          ? []
          : Array.from({ length: view.count }, (_, i) => [view!.x[i]!, view!.y[i]!]),
    };
  }

  if (new URLSearchParams(location.search).has('perf')) {
    installPerfHarness(app, camera, stats, terrain, MAP_SIZE);
  }

  let frameStart = 0;

  app.ticker.add(
    () => {
      stats.beginFrame();
      frameStart = performance.now();
    },
    undefined,
    UPDATE_PRIORITY.HIGH,
  );

  app.ticker.add((ticker) => {
    if (
      camera.viewportWidth !== app.renderer.width ||
      camera.viewportHeight !== app.renderer.height
    ) {
      setViewport(camera, app.renderer.width, app.renderer.height);
    }

    updateCamera(camera, input, ticker.deltaMS / 1000);
    // One clamp per frame covers every way the camera moves: keys, edge pan, drag,
    // wheel zoom, a minimap seek and an alert jump all land before the next frame.
    clampCamera(camera, cameraBounds);

    sim.pump(ticker.deltaMS);
    const message = sim.receive();
    if (message !== null) {
      interpolator.push(message.snapshot);
      resourceBar.update(message.player);
      outcomeBanner.update(message.player, PLAYER);
      fog.setFog(message.fog);
      if (message.fog !== null) latestFog = message.fog;
      // Sound comes from events, never from diffing snapshots: a death simply stops
      // appearing, and there is nothing in a state diff that says it happened.
      audio.handle(message.events, camera);
      // Same event stream, different consumer: a stampede that starts off-screen is
      // exactly the thing a player needs told about, and it cannot be seen in a snapshot
      // diff any more than a death can.
      alerts.handle(message.events, performance.now());
      // Same stream again. A blow that lands and leaves a unit standing is an event, not
      // a state change worth diffing for — and one that kills removes the entity from the
      // next snapshot entirely, so a diff would show nothing at all.
      damage.handle(message.events, performance.now());
    }
    view = interpolator.sample(ticker.deltaMS);

    terrain.container.scale.set(camera.zoom);
    terrain.container.position.set(
      -camera.x * camera.zoom + camera.viewportWidth / 2,
      -camera.y * camera.zoom + camera.viewportHeight / 2,
    );
    terrain.update(camera);
    alerts.update(performance.now());
    fog.update(camera);

    if (view !== null) {
      const at = performance.now();
      damage.expire(at);
      // Casualties leave the selection. Everything downstream — the panel, the readout,
      // the order dispatch — reads this set, so it has to mean what it says.
      selection.retain(view);
      entities.update(view, map, selection.handles, damage, at);
      // What the field sounds like, as opposed to what just happened. Read from the same
      // interpolated view the renderer draws, so the audio agrees with the picture.
      audio.ambience(view, camera);
    }

    const isoX = (input.pointerX - camera.viewportWidth / 2) / camera.zoom + camera.x;
    const isoY = (input.pointerY - camera.viewportHeight / 2) / camera.zoom + camera.y;
    const index = input.pointerInside ? pickTileIndex(map, isoX, isoY) : NO_TILE;

    const hoverX = index === NO_TILE ? 0 : tileX(map, index);
    const hoverY = index === NO_TILE ? 0 : tileY(map, index);
    if (index === NO_TILE) cursor.visible = false;
    else placeTileCursor(cursor, map, hoverX, hoverY);

    minimap.update(view, latestFog, camera);
    panel.update(view, selection.handles);

    overlay.update({
      cameraX: camera.x,
      cameraY: camera.y,
      zoom: camera.zoom,
      fps: ticker.FPS,
      frameP99: stats.p99(),
      drawCalls: stats.drawCalls,
      visibleChunks: terrain.visibleChunks,
      totalChunks: terrain.chunkCount,
      tileX: hoverX,
      tileY: hoverY,
      tileHeight: index === NO_TILE ? 0 : heightAt(map, hoverX, hoverY),
      pointerOnMap: index !== NO_TILE,
      entityCount: view?.count ?? 0,
      selectedCount: selection.handles.size,
      ...herdCounts(view),
      simTick: sim.tick,
      renderTick: interpolator.renderTick,
    });
  });

  app.ticker.add(
    (ticker) => stats.endFrame(ticker.deltaMS, performance.now() - frameStart),
    undefined,
    UPDATE_PRIORITY.UTILITY,
  );

  // Order matters on the way out: stop input and the clock before destroying what they
  // read, or a ticker callback runs against a destroyed renderer.
  window.__restart = () => restart();

  teardown.push(
    () => lifetime.abort(),
    () => boundInput.dispose(),
    () => minimap.dispose(),
    // Browsers cap AudioContexts at around six, so leaking one per restart means audio
    // silently stops working on the sixth game and never comes back. This teardown list
    // exists precisely so an acquisition without a release is visible where it is made —
    // and audio was acquired without one anyway, which is the argument for reading the
    // list rather than trusting the pattern.
    () => audio.dispose(),
    () => sim.dispose(),
    () => app.destroy(true, { children: true }),
    () => root.replaceChildren(),
  );
}

/**
 * Ask for a match, then play it.
 *
 * The setup screen is skipped when the URL already names a map, so the perf harness and
 * the screenshot tooling — both of which drive the page unattended — still land straight
 * in a game rather than waiting on a menu nobody is there to answer.
 */
async function boot(): Promise<void> {
  const defaults = defaultOptions();
  const root = document.getElementById('app') ?? document.body;

  const params = new URLSearchParams(location.search);
  if (params.has('map') || params.has('perf')) {
    await main(defaults);
    return;
  }

  const chosen = await showSetup(root, defaults);
  await main({ ...defaults, ...chosen });
}

void boot();
