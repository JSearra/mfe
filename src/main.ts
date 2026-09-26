import { Graphics, UPDATE_PRIORITY } from 'pixi.js';
import { t, type MessageKey } from './core/i18n/index.js';
import { EventType, refusalOwner, refusalReason } from './shared/events.js';
import { heightAt, isWater } from './shared/heightmap.js';
import { worldToScreenX, worldToScreenY } from './shared/iso.js';
import { NO_TILE, pickTileIndex, tileX, tileY } from './shared/picking.js';
import {
  FARMLAND_STRIDE,
  fieldCondition,
  fieldEstablished,
  fieldFallow,
  fieldHands,
  fieldHandsWanted,
  fieldOwner,
  fieldSlot,
} from './shared/farmland.js';
import { BuildingType, buildingSpec } from './shared/buildings/index.js';
import { CommandKind } from './sim/commands.js';
import { TECH_IDS } from './shared/tech/index.js';
import { createDirectSimHost, type PlayerState, type SimHost } from './host/directHost.js';
import { createWorkerSimHost } from './host/worker/workerHost.js';
import { createHeightmap } from './sim/terrain/generate.js';
import { MAP_SCRIPTS, generateMap, type MapScript } from './sim/terrain/maps.js';
import { bandShiftFor } from './render/scene/terrainBand.js';
import { createGroundField } from './render/scene/ground.js';
import { FACTIONS, FactionId } from './shared/factions/index.js';
import { createWorld } from './sim/world.js';
import { treeSlot, WOODLAND_STRIDE } from './shared/woodland.js';
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
import { createFieldLayer } from './render/scene/fields.js';
import { loadSpriteAtlas, loadTerrainTiles } from './render/assets.js';
import { presentation } from './render/presentation.js';
import { createTileCursor, drawFootprint, footprintFits, placeTileCursor } from './render/scene/cursor.js';
import { createEdgeFalloff } from './render/scene/edgeFalloff.js';
import { createFogRenderer } from './render/scene/fog.js';
import { createTerrain, seasonPosition } from './render/scene/terrain.js';
import {
  createMarqueeGraphics,
  createSelection,
  drawMarquee,
  entitiesNear,
  pickBuildSite,
  pickEntity,
  type Rect,
} from './render/selection.js';
import { createRenderStats } from './render/stats.js';
import { createDebugOverlay } from './ui/debugOverlay.js';
import { createCommandPanel, type FieldReading } from './ui/commandPanel.js';
import { createMinimap } from './ui/minimap.js';
import { createAlerts } from './ui/alerts.js';
import { showSetup } from './ui/setup.js';
import { loadStoredGame, storeGame } from './ui/savedGame.js';
import { SAVE_VERSION, type SaveGame } from './sim/persistence/save.js';
import { createEmptiedBanner } from './ui/emptiedBanner.js';
import { createResourceBar } from './ui/resourceBar.js';
import { createHelp } from './ui/help.js';
import { isQuarry } from './shared/wildlife.js';
import { installTooltips } from './ui/tooltip.js';
import { matchSeed, NEIGHBOUR, PLAYER, seedOpening } from './host/opening.js';

/**
 * Phase 3 entry point: the simulation now runs behind a boundary.
 *
 * This module is the composition root, and the only place that touches both sides. The
 * renderer below it reads snapshots and events; it never reads the world. That rule is
 * enforced by ESLint rather than discipline, because it is what makes the eventual
 * worker flip a transport change instead of a UI rewrite — see ADR-0004.
 */

const BACKGROUND = 0x14110d;
/**
 * What to say when a site or a field is refused, by `refusalReason` — a PlacementResult
 * below 8, 8 + a PlantResult from 8 up. See EventType.PlacementRefused.
 */
const REFUSALS: Readonly<Record<number, MessageKey>> = {
  1: 'refused.offMap',
  2: 'refused.occupied',
  3: 'refused.tooSteep',
  4: 'refused.unaffordable',
  5: 'refused.noRoom',
  6: 'refused.noWater',
  9: 'refused.offMap',
  10: 'refused.fieldUnsuitable',
  11: 'refused.fieldOccupied',
  12: 'refused.fieldUnaffordable',
  13: 'refused.fieldFull',
};
/** How often the village is kept without being asked. */
const AUTOSAVE_MS = 60_000;
const MAP_SIZE = 128;
/**
 * Entity slots in the world. 1024 since the veld has game on it (ADR-0022): a map opens
 * with about 155 wild animals beside the village and its herds, bands breed back to full
 * strength, and a village has no cap on the households it raises.
 */
const WORLD_CAPACITY = 1024;
const MAP_SEED = 0x4d666563;
const KIND_CATTLE = 1;
/** An animal nobody owns. See src/shared/wildlife.ts. */
const KIND_WILD = 3;

/** The species of a wild animal in the view, by handle, or -1 if it is not there. */
function speciesOfHandle(view: InterpolatedView, handle: number): number {
  for (let i = 0; i < view.count; i++) if (view.handle[i] === handle) return view.subtype[i]!;
  return -1;
}
const KIND_BUILDING = 2;
const MOVEMENT_INFANTRY = 0;
const HERD_LEASHED = 1;
const HERD_STAMPEDING = 3;

/** Right-clicking one cow leashes the beasts around it, not just that one. */
/**
 * How much of a herd one click on one animal takes.
 *
 * Generous on purpose. At 6.5 a click took five beasts out of nine and left the rest
 * standing in the middle of the drovers: those four were not under anybody's hand, so
 * they took the full stress of people arriving, panicked, and pulled the calm five into
 * it through the contagion. Taking the herd means taking the herd.
 */
const HERD_GRAB_RADIUS = 9.0;
/**
 * How near a click has to land when it did NOT hit an animal for it to still mean
 * "gather that herd" rather than "walk there". Forgiving, but not so wide that ordinary
 * movement near a herd becomes impossible.
 */
const HERD_NEAR_MISS = 2.5;
/**
 * How many of the selected people actually go and fetch a herd.
 *
 * Sending everyone was tried and it is the wrong shape: two dozen people converging on a
 * herd is exactly the crowding the stress curve exists to punish, and the herd bolted
 * within fifteen seconds every time. That is the mechanic working, not a bug in it — so
 * the gesture obeys it instead of fighting it and details a few drovers, nearest first.
 * The rest of the village carries on with what it was doing, which is also what a player
 * ordering "go and fetch that herd" means.
 */
const HERD_DROVERS = 4;
/**
 * How far clear of the OUTERMOST animal the drovers stop.
 *
 * Measured from the edge of the herd, not its centre, and that distinction is the whole
 * of it: a standoff from the centre still put drovers within frightening distance of the
 * beasts on the near side, so the animals under hand stayed calm and their unleashed
 * neighbours panicked and took them along through the contagion. Comfortably outside
 * tuning.cattle.herderRadius, so nothing is frightened at all; the tether does the
 * gathering, which is what it is for.
 */
const HERD_CLEARANCE = 4.8;
/** Sideways spacing between drovers on the approach, in world units. */
const HERD_FAN = 1.2;
/**
 * How far from a site's centre the builders are told to stand.
 *
 * All inside tuning.buildings.buildRadius so everyone standing on them counts as working
 * the site, and all clear of the footprint so the orders are to ground they can reach —
 * the foundation blocks movement from the moment it is placed.
 */
const BUILD_STAND_ARCS = [2.0, 2.5, 3.0] as const;

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

/**
 * The tree standing at a world point, as an index into the packed wood, or -1.
 *
 * Tested in WORLD space against the ground a tree stands on, not in screen space
 * against its canopy. The first version measured pixels to the canopy and missed
 * constantly: a tree is drawn far larger than its footprint, its sprite is anchored at
 * the foot, and the offset between the two is a property of the art rather than
 * something the caller knows. Comparing tiles is what the simulation will do with the
 * index a moment later anyway.
 *
 * Tight — about a tile — because this is the one right-click meaning that destroys
 * something. Clicking bare ground beside a tree must be a move order, not a felling.
 */
export function pickTree(wood: Float32Array | null, worldX: number, worldY: number): number {
  if (wood === null) return -1;

  const reach = 0.9;
  let best = -1;
  let bestDistance = reach * reach;

  for (let at = 0; at + WOODLAND_STRIDE - 1 < wood.length; at += WOODLAND_STRIDE) {
    const dx = wood[at]! - worldX;
    const dy = wood[at + 1]! - worldY;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      // The tree's own slot, not its place in the packed array — see WOODLAND_STRIDE.
      best = treeSlot(wood, at);
    }
  }
  return best;
}

async function main(options: GameOptions, restoreFrom: SaveGame | null = null): Promise<void> {
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
  // One start: the neighbour is off the map (ADR-0021) and has no fields here.
  const starts = [{ x: centre, y: centre }];

  // Worker by default now that the boundary discipline has held. ?sim=direct keeps the
  // main-thread host one query parameter away, because stepping through a simulation in
  // a debugger is worth a great deal when something is wrong.
  const useWorker = new URLSearchParams(location.search).get('sim') !== 'direct';
  const worldSeed = matchSeed(mapSeed);
  const sim: SimHost = useWorker
    ? createWorkerSimHost({
        mapSize: MAP_SIZE,
        mapSeed,
        mapScript,
        worldSeed,
        capacity: WORLD_CAPACITY,
        viewerId: PLAYER,
        playerId: PLAYER,
        factions: [options.playerFaction, options.enemyFaction],
        neighbours: [NEIGHBOUR],
        starts,
      })
    : createDirectSimHost({
        world: createWorld(WORLD_CAPACITY, worldSeed),
        map,
        seed: worldSeed,
        viewerId: PLAYER,
        playerId: PLAYER,
        neighbours: [NEIGHBOUR],
        factions: [options.playerFaction, options.enemyFaction],
        starts,
      });

  // The village and the herds each side opens with. Shared with the soak harness so
  // that what is measured is what is played — see src/host/opening.ts.
  // Or the village the player kept, restored into a host built on the same map, peoples
  // and seed — in place of an opening, never on top of one.
  if (restoreFrom !== null) sim.restore(restoreFrom);
  else seedOpening((kind, a, b, c, d) => sim.sendCommand(kind, a, b, c, d), map, centre, mapSeed);

  const { app } = await createRenderer(root, BACKGROUND);
  const camera = createCamera(app.renderer.width, app.renderer.height);
  const input = createCameraInput();

  camera.x = 0;
  camera.y = MAP_SIZE * 16;
  // The camera may not leave the map. Without this, a held pan key walks the view into
  // empty space and nothing is relative enough to the map to bring it back.
  const cameraBounds = mapBounds(map.width, map.height);

  const terrainTiles = await loadTerrainTiles();
  // How dry this country is drawn. A statement about the landscape, which is the one
  // thing a heightmap was never able to make — see render/scene/terrainBand.ts.
  const bandShift = bandShiftFor(options.mapScript);
  /**
   * Which ground each tile is drawn with, worked out once for the whole map.
   *
   * Not the tile's height, which is what it used to be — see render/scene/ground.ts for
   * the 18%-of-all-adjacent-pairs measurement that changed it. Held here because both
   * the terrain and the fields need the same answer.
   */
  const groundField = createGroundField(map, mapSeed, map.levels);
  const terrain = createTerrain(map, terrainTiles, bandShift, groundField);
  const cursor = createTileCursor();
  /** The armed building's footprint under the pointer, and the tiles buildings hold. */
  const footprint = new Graphics();
  footprint.visible = false;
  const taken = new Set<number>();
  // Null if the atlas is missing or malformed, and the entity layer then falls back to
  // drawing shapes. Art is not worth failing to start over, and the build runs without
  // the pipeline ever having been run.
  const atlas = await loadSpriteAtlas(presentation.sprites.pixelsPerWorldUnit);
  // Scenery is derived from the map seed rather than stored: identical on every machine
  // that builds the same map, and nothing to transmit or save.
  const entities = createEntityLayer(
    atlas,
    planDecorations(map, mapSeed),
    {
      shield: Number.parseInt(options.shieldColour.slice(1), 16),
      marking: Number.parseInt(options.markingColour.slice(1), 16),
      faction: PLAYER,
    },
    map,
  );
  const damage = createDamageFlashes();
  const fields = createFieldLayer(map, terrainTiles, groundField, bandShift);
  const fog = createFogRenderer(map);
  // Above the ground and below everything that stands on it.
  terrain.container.addChild(fields.container);
  terrain.container.addChild(cursor);
  terrain.container.addChild(entities.container);
  // The armed building's footprint goes OVER what stands on the ground: it exists to
  // show a site is taken, and under the kraal it was hidden by the kraal. Below the fog,
  // which still hides what the village cannot see.
  terrain.container.addChild(footprint);
  // Fog goes on top of everything in the world layer: it hides terrain as well as what
  // stands on it.
  terrain.container.addChild(fog.container);
  // ?reveal draws the whole map, for looking at terrain without walking it. Dev builds
  // only: it hides the overlay and nothing else, so the simulation still has its fog.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('reveal')) fog.container.visible = false;
  // And the world going dark where the map runs out goes on top of the fog, for the same
  // reason: a tree at the boundary has to fade with the ground under it. Static, so it is
  // built once and never touched again.
  const edgeFalloff = createEdgeFalloff(map, BACKGROUND);
  terrain.container.addChild(edgeFalloff.container);
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

  /*
   * Keep the village without being asked: every minute, and when the tab is hidden.
   *
   * One slot and a game with no end means the first closed tab without Ctrl+S loses
   * everything, and nobody remembers to save a game that never stops. Quiet — the
   * notice is for a save the player asked for. Hiding is best effort: a worker save is
   * a round trip and a closing tab may not wait for it, which is what the minute is for.
   */
  const autosave = (): void => {
    void sim.save().then((save) => storeGame(options, save));
  };
  const autosaveTimer = setInterval(autosave, AUTOSAVE_MS);
  signal.addEventListener('abort', () => clearInterval(autosaveTimer));
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'hidden') autosave();
    },
    { signal },
  );

  const stats = createRenderStats();
  const overlay = createDebugOverlay(root);
  /**
   * The stats are off until asked for, and the controls are open until read.
   *
   * A frame counter welded to the corner of a shipped game is a choice nobody made on
   * purpose; a player who cannot find out what the keys do has been given a worse one.
   */
  let statsVisible = false;
  let controlsOpen = true;
  const resourceBar = createResourceBar(root);
  /**
   * How to play. The game stands still while it is read: a village that starved behind
   * the rules explaining how not to starve would be a poor first lesson.
   */
  let speedBeforeHelp = 1;
  const help = createHelp(root, {
    onOpen() {
      speedBeforeHelp = sim.speed;
      sim.speed = 0;
    },
    onClose() {
      sim.speed = speedBeforeHelp;
    },
  });
  const emptiedBanner = createEmptiedBanner(root, { onRestart: () => void restart() });

  /** A line of news that is not the simulation's — "saved", and the like. */
  function notice(text: string): void {
    const element = document.createElement('div');
    element.className = 'notice';
    element.textContent = text;
    root.appendChild(element);
    setTimeout(() => element.remove(), 2600);
  }
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
  /** The standing wood as last received, for hit-testing a right-click against it. */
  let standingWood: Float32Array | null = null;
  let armed: BuildingType | null = null;
  /** Planting mode: the next left-click breaks ground rather than selecting. */
  let planting = false;

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
    onTrade(partner, offered, wanted, amount) {
      sim.sendCommand(CommandKind.Trade, partner, offered, wanted, amount);
    },
    onAlly(partner) {
      sim.sendCommand(CommandKind.Ally, partner);
    },
    onBreak(partner) {
      sim.sendCommand(CommandKind.Break, partner);
    },
    onCull() {
      sim.sendCommand(CommandKind.Cull);
    },
    onRation(short) {
      sim.sendCommand(CommandKind.SetRation, short ? 1 : 0);
    },
    onDemolish(buildingHandle) {
      sim.sendCommand(CommandKind.Demolish, buildingHandle);
    },
  });
  // The neighbour by the people it is, not "Village 2" (ADR-0021).
  panel.setVillageNames(
    [options.playerFaction, options.enemyFaction].map((id) => t(FACTIONS[id].nameKey as MessageKey)),
  );

  let view: InterpolatedView | null = null;
  /**
   * The fields as the simulation last sent them, for the gestures that act on one.
   *
   * Held rather than re-read from the renderer, because the render layer keeps sprites
   * and not records — and because the packed array is exactly what a command needs: a
   * field's SLOT, which is its index in the simulation and not its place in the packed
   * array. Packing drops abandoned fields, so the two stop agreeing the moment one is
   * given up.
   */
  let lastFarmland: Float32Array | null = null;

  /** The index into `lastFarmland` of the player's field under the pointer, or -1. */
  function fieldUnderCursor(): number {
    if (lastFarmland === null || !input.pointerInside) return -1;
    const isoX = (input.pointerX - camera.viewportWidth / 2) / camera.zoom + camera.x;
    const isoY = (input.pointerY - camera.viewportHeight / 2) / camera.zoom + camera.y;
    const index = pickTileIndex(map, isoX, isoY);
    if (index === NO_TILE) return -1;

    const cursorX = tileX(map, index);
    const cursorY = tileY(map, index);
    for (let at = 0; at + FARMLAND_STRIDE <= lastFarmland.length; at += FARMLAND_STRIDE) {
      if (fieldOwner(lastFarmland, at) !== PLAYER) continue;
      if (lastFarmland[at] === cursorX && lastFarmland[at + 1] === cursorY) return at;
    }
    return -1;
  }
  /** A field X was pressed on once, awaiting the second press that gives it up. */
  let abandonArmed: { slot: number; at: number } | null = null;
  /** The player's field under the pointer, for the panel when nothing is selected. */
  function fieldReading(): FieldReading | null {
    const at = fieldUnderCursor();
    if (at < 0) return null;
    const packed = lastFarmland!;
    return {
      condition: fieldCondition(packed, at),
      established: fieldEstablished(packed, at),
      resting: fieldFallow(packed, at),
      hands: fieldHands(packed, at),
      wanted: fieldHandsWanted(packed, at),
    };
  }
  /** Dev-only: a season ramp position to show instead of the weather's. See __debug. */
  let seasonOverride: number | null = null;
  /** The last PlayerState that crossed the boundary, for the dev inspection hook. */
  let lastPlayer: PlayerState | null = null;
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
    if (event.key === '?') {
      help.open();
      event.preventDefault();
      return;
    }
    // Keep the village (ADR-0020: a game has no end, so it has to outlast the tab).
    // Ctrl or Cmd with S, which the browser would otherwise take as "save this page".
    if ((event.key === 's' || event.key === 'S') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sim.save().then((save) => notice(t(storeGame(options, save) ? 'game.saved' : 'game.saveFailed')));
      return;
    }
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
      patrolArmed = false;
      armed = null;
      planting = false;
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

    // T raises a household at every homestead we own. It broadcasts rather than acting
    // on a selection, and anything that is not a homestead refuses harmlessly.
    if ((event.key === 't' || event.key === 'T') && view !== null) {
      for (let i = 0; i < view.count; i++) {
        if (view.kind[i] !== KIND_BUILDING || view.faction[i] !== PLAYER) continue;
        sim.sendCommand(CommandKind.Train, view.handle[i]!, MOVEMENT_INFANTRY);
      }
      return;
    }

    const type = buildKeys[event.key];
    if (type !== undefined) {
      armed = type;
      planting = false;
    }
    if (event.key === 'f' || event.key === 'F') {
      planting = true;
      armed = null;
    }

    // F1 brings the stats back; H folds the controls away once they have been read.
    // Neither touches the simulation, so neither is a command.
    if (event.key === 'F1') {
      statsVisible = !statsVisible;
      overlay.setStatsVisible(statsVisible);
      event.preventDefault();
    }
    if (event.key === 'h' || event.key === 'H') {
      controlsOpen = !controlsOpen;
      overlay.setControlsOpen(controlsOpen);
    }

    /*
     * Rest the field under the cursor, or put it back to work.
     *
     * Under the CURSOR rather than under a selection, because fields are not selectable
     * — there is no field-selection UI and `CommandKind.Abandon` has sat without a
     * caller since it was written for want of one. Felling a tree already works this
     * way, so a player who has learned one gesture has learned this one.
     */
    /*
     * Give up the field under the cursor. X, twice: the seed is not refunded, and a
     * field that took a season to break is not a thing to lose to a stray key. The
     * first press says what the second will do.
     */
    if (event.key === 'x' || event.key === 'X') {
      const at = fieldUnderCursor();
      if (at < 0) return;
      const slot = fieldSlot(lastFarmland!, at);
      const now = performance.now();
      if (abandonArmed !== null && abandonArmed.slot === slot && now - abandonArmed.at < 2000) {
        sim.sendCommand(CommandKind.Abandon, slot);
        abandonArmed = null;
      } else {
        abandonArmed = { slot, at: now };
        notice(t('game.abandonConfirm'));
      }
      return;
    }
    if (event.key === 'g' || event.key === 'G') {
      const at = fieldUnderCursor();
      if (at >= 0) {
        sim.sendCommand(
          CommandKind.Fallow,
          fieldSlot(lastFarmland!, at),
          fieldFallow(lastFarmland!, at) ? 0 : 1,
        );
      }
    }
  }, { signal });

  const boundInput = bindInput(app.canvas, camera, input, {
    onClickSelect(x, y, additive) {
      if (armed !== null || planting) {
        const isoX = (x - camera.viewportWidth / 2) / camera.zoom + camera.x;
        const isoY = (y - camera.viewportHeight / 2) / camera.zoom + camera.y;
        const index = pickTileIndex(map, isoX, isoY);
        if (index !== NO_TILE) {
          if (planting) sim.sendCommand(CommandKind.Plant, tileX(map, index), tileY(map, index));
          else sim.sendCommand(CommandKind.Build, tileX(map, index), tileY(map, index), armed!, 0);
        }
        // Shift keeps the tool in hand, so a row of fields is a row of clicks rather than
        // F, click, F, click. The builder convention, and the same key that queues orders.
        if (!additive) {
          armed = null;
          planting = false;
        }
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
      const ground = worldPointAt(x, y);
      // An animal under the cursor outranks everything. A herd standing in a wood used
      // to be unherdable — the tree on that tile answered first and the click felled it
      // — and "I am pointing at that cow" is not ambiguous to the person doing it.
      const cow = pickEntity(view, map, camera, entities, x, y, KIND_CATTLE);

      /*
       * Game: the selected people go after it (ADR-0022). Only what can be hunted —
       * pointing at a lion does not send anybody to fight one; it falls through to a
       * move order, which is what walking toward it would have been anyway.
       */
      const game = cow === -1 ? pickEntity(view, map, camera, entities, x, y, KIND_WILD) : -1;
      const gameSpecies = game === -1 ? -1 : speciesOfHandle(view, game);
      if (gameSpecies >= 0 && isQuarry(gameSpecies)) {
        audio.acknowledge('move');
        for (const handle of selection.handles) sim.sendCommand(CommandKind.Hunt, handle, game);
        return;
      }

      // Then a tree. Felling is the one right-click meaning that destroys something, so
      // it is the most specific of what is left: a tree on the tile actually clicked,
      // where the others accept anything within a grab radius.
      const tree = cow !== -1 || ground === null ? -1 : pickTree(standingWood, ground.x, ground.y);
      if (tree !== -1) {
        audio.acknowledge('move');
        sim.sendCommand(CommandKind.Fell, tree);
        return;
      }

      // A site of our own that is not finished: send the selected people to raise it.
      // Build speed has always scaled with how many hands are standing there; this is
      // the gesture that lets a player USE that, instead of discovering it by accident.
      const site = pickBuildSite(view, map, camera, entities, x, y, PLAYER);
      if (site !== -1) {
        const slot = view.handle.indexOf(site);
        audio.acknowledge('move');
        // Ringed round the footprint, not stacked on its centre: the foundation blocks
        // movement the moment it is placed, so an order into the middle of it is an
        // order to a tile nobody can stand on.
        //
        // Three concentric arcs rather than one circle. On a single ring a crowd shoves
        // itself tangentially until most of it is outside the radius that counts as
        // working the site — measured in play, twenty-one people sent to one ring had
        // one of them building. Arcs give the same crowd about three times the standing
        // room inside tuning.buildings.buildRadius, which is what makes "more people
        // build it faster" true in practice and not just in the arithmetic.
        const handles = [...selection.handles];
        const arcs = BUILD_STAND_ARCS;
        const perArc = Math.ceil(handles.length / arcs.length);
        for (let i = 0; i < handles.length; i++) {
          const ring = arcs[i % arcs.length]!;
          const angle = (Math.floor(i / arcs.length) / perArc) * Math.PI * 2;
          sim.sendCommand(
            CommandKind.MoveTo,
            handles[i]!,
            view.x[slot]! + Math.cos(angle) * ring,
            view.y[slot]! + Math.sin(angle) * ring,
            queued ? 1 : 0,
          );
        }
        return;
      }

      // Cattle. Pointing at one beast takes the herd around it, because a player aiming
      // at forty animals is aiming at the herd and not at one of them. Missing the herd
      // entirely is still a move order — the wide grab is what a click ON an animal
      // means, not what any click near one means, or right-clicking open ground six
      // tiles from a herd would gather it instead of walking there.
      const herdAt =
        cow !== -1
          ? { x: view.x[view.handle.indexOf(cow)]!, y: view.y[view.handle.indexOf(cow)]! }
          : ground;
      const grab = cow !== -1 ? HERD_GRAB_RADIUS : HERD_NEAR_MISS;
      const herd =
        herdAt === null
          ? []
          : entitiesNear(view, herdAt.x, herdAt.y, grab, KIND_CATTLE, herdScratch);
      if (herd.length > 0 && herdAt !== null) {
        audio.acknowledge('herd');
        // Bound locally: `view` is a reassignable let, so its narrowing does not survive
        // into a closure.
        const seen = view;
        const at = herdAt;
        // The nearest few of the selection, not all of it.
        const herders = [...selection.handles]
          .map((handle) => {
            const slot = seen.handle.indexOf(handle);
            if (slot === -1) return { handle, away: Infinity };
            const dx = seen.x[slot]! - at.x;
            const dy = seen.y[slot]! - at.y;
            return { handle, away: dx * dx + dy * dy };
          })
          .sort((a, b) => a.away - b.away)
          .slice(0, HERD_DROVERS)
          .map((entry) => entry.handle);
        // Each beast to the NEAREST selected herder, not round-robin. Round-robin tore a
        // herd apart the moment it was taken: twelve cattle split between twelve people
        // each walked off after a different one, so the thing the player had just
        // gathered promptly stopped being a herd. Nearest keeps the animals that were
        // standing together following the same person, and the flocking does the rest.
        for (const beast of herd) {
          const slot = view.handle.indexOf(beast);
          let best = herders[0]!;
          let bestDistance = Infinity;
          for (const handle of herders) {
            const at = view.handle.indexOf(handle);
            if (at === -1) continue;
            const dx = view.x[at]! - view.x[slot]!;
            const dy = view.y[at]! - view.y[slot]!;
            const distance = dx * dx + dy * dy;
            if (distance < bestDistance) {
              bestDistance = distance;
              best = handle;
            }
          }
          sim.sendCommand(CommandKind.Leash, best, beast);
        }
        // How far out the herd actually reaches, so the standoff clears its edge rather
        // than its middle.
        let spread = 0;
        for (const beast of herd) {
          const slot = seen.handle.indexOf(beast);
          if (slot === -1) continue;
          const dx = seen.x[slot]! - at.x;
          const dy = seen.y[slot]! - at.y;
          const away = Math.sqrt(dx * dx + dy * dy);
          if (away > spread) spread = away;
        }
        const standoff = spread + HERD_CLEARANCE;

        // Each drover closes on the edge of the herd NEAREST TO ITSELF and stops there.
        // Ringing the herd was tried and it is about the worst thing you can do to one:
        // to reach the far side a drover walks straight through the middle, which is
        // exactly the crowding that panics cattle — measured, seventeen of twenty-three
        // bolted. Coming in from the side you are already on touches nothing on the way.
        for (let i = 0; i < herders.length; i++) {
          const slot = seen.handle.indexOf(herders[i]!);
          if (slot === -1) continue;
          const awayX = seen.x[slot]! - at.x;
          const awayY = seen.y[slot]! - at.y;
          const span = Math.sqrt(awayX * awayX + awayY * awayY);
          // Already standing among them: leave it be rather than shoving it outward.
          if (span < 1e-3) continue;
          // Fanned a little, so drovers coming from the same direction do not stack.
          const fan = ((i - (herders.length - 1) / 2) * HERD_FAN) / standoff;
          const cosF = Math.cos(fan);
          const sinF = Math.sin(fan);
          const unitX = awayX / span;
          const unitY = awayY / span;
          sim.sendCommand(
            CommandKind.MoveTo,
            herders[i]!,
            at.x + (unitX * cosF - unitY * sinF) * standoff,
            at.y + (unitX * sinF + unitY * cosF) * standoff,
            queued ? 1 : 0,
          );
        }
        return;
      }

      const target = worldPointAt(x, y);
      if (target === null) return;
      // Orders carry a handle, never a position: by the time this executes the target
      // may be dead, and the handle's generation is what says so.
      audio.acknowledge('move');
      const kind = patrolArmed ? CommandKind.Patrol : CommandKind.MoveTo;
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
      // The PlayerState as it crossed the boundary — render-side state, not a read into
      // the world. Without it a browser-driven session can see that a match ended but
      // not what ended it, which cost an afternoon.
      player: () => lastPlayer,
      // Centre the camera on a tile, for looking at a particular piece of ground.
      lookAt: (tileX: number, tileY: number) => {
        camera.x = worldToScreenX(tileX + 0.5, tileY + 0.5);
        camera.y = worldToScreenY(tileX + 0.5, tileY + 0.5, heightAt(map, tileX, tileY));
      },
      // The tile nearest the map's centre wearing this ground band, surrounded by it, for
      // photographing one kind of ground. Read from the renderer's own ground field.
      nearestGround: (band: number) => {
        let best: [number, number] | null = null;
        let bestDistance = Infinity;
        for (let y = 3; y < map.height - 3; y++) {
          for (let x = 3; x < map.width - 3; x++) {
            let all = true;
            for (let dy = -3; dy <= 3 && all; dy++) {
              for (let dx = -3; dx <= 3 && all; dx++) {
                if (groundField[(y + dy) * map.width + x + dx] !== band) all = false;
              }
            }
            if (!all) continue;
            const d = (x - map.width / 2) ** 2 + (y - map.height / 2) ** 2;
            if (d < bestDistance) {
              bestDistance = d;
              best = [x, y];
            }
          }
        }
        return best;
      },
      // The open-water tile nearest the camera's tile with water on every side, from the
      // renderer's own copy of the map, or null on a dry map.
      nearestWater: () => {
        let best: [number, number] | null = null;
        let bestDistance = Infinity;
        for (let y = 1; y < map.height - 1; y++) {
          for (let x = 1; x < map.width - 1; x++) {
            if (!isWater(map, x, y) || !isWater(map, x + 1, y) || !isWater(map, x - 1, y)) continue;
            if (!isWater(map, x, y + 1) || !isWater(map, x, y - 1)) continue;
            const d = (x - map.width / 2) ** 2 + (y - map.height / 2) ** 2;
            if (d < bestDistance) {
              bestDistance = d;
              best = [x, y];
            }
          }
        }
        return best;
      },
      // Show the veld at a season ramp position (0 wet, 1 dry, 2 drought), or null to
      // follow the weather again. Render-side only; the simulation's weather is untouched.
      season: (position: number | null) => {
        seasonOverride = position;
        const season = position ?? seasonPosition(lastPlayer?.drought ?? 0);
        terrain.setSeason(season);
        entities.setSeason(season);
      },
      count: () => view?.count ?? 0,
      // The fields as they last crossed the boundary, counted rather than listed. A
      // browser-driven session needs to be able to see that a gesture reached the
      // simulation and came back, and "how many are resting" is the whole of that.
      fields: () => {
        if (lastFarmland === null) return { mine: 0, resting: 0 };
        let mine = 0;
        let resting = 0;
        for (let at = 0; at + FARMLAND_STRIDE <= lastFarmland.length; at += FARMLAND_STRIDE) {
          if (fieldOwner(lastFarmland, at) !== PLAYER) continue;
          mine++;
          if (fieldFallow(lastFarmland, at)) resting++;
        }
        return { mine, resting };
      },
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
      /**
       * Viewport positions of this player's unfinished building sites.
       *
       * Through the entity layer's own screen position, which is where the sprite is
       * DRAWN and therefore where the player clicks — the flat world-to-viewport
       * transform lands somewhere else for a multi-tile building, and a helper that
       * disagrees with the picker is worse than no helper: it made a working gesture
       * look broken for an hour.
       */
      siteViewports: () => {
        if (view === null) return [];
        const out: [number, number][] = [];
        for (let i = 0; i < view.count; i++) {
          if (view.kind[i] !== KIND_BUILDING || view.faction[i] !== PLAYER) continue;
          if (view.progressPct[i]! >= 255) continue;
          const at = entities.screenPosition(view, i, map);
          out.push([
            (at.x - camera.x) * camera.zoom + camera.viewportWidth / 2,
            (at.y - camera.y) * camera.zoom + camera.viewportHeight / 2,
          ]);
        }
        return out;
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
      panel.setOffers(message.player.offers);
      panel.setRelations(message.player.relations);
      panel.setHerd(message.player.cullHead);
      panel.setSiteHands(message.player.siteHands);
      // The veld follows the season (Phase B5). Cheap to call every message: the page
      // only redraws when the ground would visibly change.
      const season = seasonOverride ?? seasonPosition(message.player.drought);
      terrain.setSeason(season);
      entities.setSeason(season);
      // Hungry means grain was actually owed last season, not merely that the year is
      // dry: the button turns amber when cutting the ration would have helped.
      panel.setRation(message.player.shortRation, message.player.shortfall > 0);
      panel.setPurse(
        { grain: message.player.grain, wood: message.player.wood, cattle: message.player.cattle },
        message.player.techStatus,
        message.player.trainCosts,
      );
      lastPlayer = message.player;
      emptiedBanner.update(message.player);
      fog.setFog(message.fog);
      // The wood arrives only when it has changed, which is the upkeep cycle rather
      // than the frame — the same contract the fog beside it uses.
      entities.setWoodland(message.woodland);
      if (message.woodland !== null) standingWood = message.woodland;
      fields.setFarmland(message.farmland);
      if (message.farmland !== null) lastFarmland = message.farmland;
      if (message.fog !== null) latestFog = message.fog;
      // Sound comes from events, never from diffing snapshots: a death simply stops
      // appearing, and there is nothing in a state diff that says it happened.
      audio.handle(message.events, camera);
      // Same event stream, different consumer: a stampede that starts off-screen is
      // exactly the thing a player needs told about, and it cannot be seen in a snapshot
      // diff any more than a death can.
      alerts.handle(message.events, performance.now(), PLAYER);
      // Why a site or a field did not appear — this player's own requests only.
      for (const event of message.events) {
        if (event.type !== EventType.PlacementRefused || refusalOwner(event) !== PLAYER) continue;
        const key = REFUSALS[refusalReason(event)];
        if (key !== undefined) notice(t(key));
      }
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
    edgeFalloff.update(camera);

    if (view !== null) {
      const at = performance.now();
      damage.expire(at);
      // Casualties leave the selection. Everything downstream — the panel, the readout,
      // the order dispatch — reads this set, so it has to mean what it says.
      selection.retain(view);
      // Before update, which is what runs the depth sort: the stock have to be in the
      // prop list by the time draw order is decided or they sort against a stale set.
      entities.setLivestock(view);
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

    // An armed building shows its whole footprint, green where it can stand and red
    // where it cannot, in place of the one-tile cursor.
    if (armed !== null && index !== NO_TILE) {
      const spec = buildingSpec(armed);
      taken.clear();
      if (view !== null) {
        for (let i = 0; i < view.count; i++) {
          if (view.kind[i] !== KIND_BUILDING) continue;
          const size = buildingSpec(view.subtype[i]!).footprint;
          const originX = Math.round(view.x[i]! - size / 2);
          const originY = Math.round(view.y[i]! - size / 2);
          for (let dy = 0; dy < size; dy++) {
            for (let dx = 0; dx < size; dx++) taken.add((originY + dy) * map.width + originX + dx);
          }
        }
      }
      const purse = lastPlayer;
      const affordable =
        purse !== null &&
        purse.grain >= spec.grainCost &&
        purse.wood >= spec.woodCost &&
        purse.cattle >= spec.cattleCost;
      const fits = footprintFits(map, hoverX, hoverY, {
        size: spec.footprint,
        maxHeightVariation: spec.maxHeightVariation,
        needsWater: spec.needsWater,
        affordable,
      }, taken);
      drawFootprint(footprint, map, hoverX, hoverY, spec.footprint, fits);
      cursor.visible = false;
    } else if (planting && index !== NO_TILE && lastPlayer !== null) {
      // The same for a field: ground that takes a crop, clear of every other field, and
      // grain to seed it. The rules cross the boundary in PlayerState.fieldRules.
      const rules = lastPlayer.fieldRules;
      const level = heightAt(map, hoverX, hoverY);
      let fits =
        level >= rules.minBand &&
        level <= rules.maxBand &&
        !isWater(map, hoverX, hoverY) &&
        lastPlayer.grain >= rules.seedGrain;
      if (fits && lastFarmland !== null) {
        for (let at = 0; at + FARMLAND_STRIDE <= lastFarmland.length; at += FARMLAND_STRIDE) {
          const dx = lastFarmland[at]! - hoverX;
          const dy = lastFarmland[at + 1]! - hoverY;
          if (dx * dx + dy * dy < rules.minSpacing * rules.minSpacing) {
            fits = false;
            break;
          }
        }
      }
      drawFootprint(footprint, map, hoverX, hoverY, 1, fits);
      cursor.visible = false;
    } else {
      footprint.visible = false;
    }

    minimap.update(view, latestFog, camera);
    panel.update(view, selection.handles, fieldReading());

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
  // Once, for the page rather than for a match: the tip lives on the body and outlasts
  // a restart, and the setup screen's controls want explaining too.
  installTooltips({ delayMs: presentation.hud.tooltipDelayMs });

  const params = new URLSearchParams(location.search);
  // The asset gallery, local development only; its own chunk, never in a production build.
  if (import.meta.env.DEV && params.has('gallery')) {
    const { showGallery } = await import('./ui/gallery.js');
    await showGallery(root);
    return;
  }
  if (params.has('map') || params.has('perf')) {
    await main(defaults);
    return;
  }

  // A kept village is offered first — but only one this build can read. An older save
  // format is not offered at all, rather than offered and then refused.
  const stored = loadStoredGame();
  const readable = stored !== null && stored.save.version === SAVE_VERSION ? stored : null;
  const chosen = await showSetup(root, defaults, readable);
  if (chosen === 'continue' && readable !== null) {
    await main({ ...defaults, ...readable.options }, readable.save);
    return;
  }
  await main({ ...defaults, ...(chosen === 'continue' ? {} : chosen) });
}

void boot();
