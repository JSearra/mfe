import type { Command, CommandKind } from '../sim/commands.js';
import { makeCommand } from '../sim/commands.js';
import { compactLoop, createLoop, enqueueCommand, step, TICK_MS, type SimLoop } from '../sim/loop.js';
import { captureState, restoreState, type SaveGame } from '../sim/persistence/save.js';
import { buildSnapshot } from '../sim/snapshot.js';
import { trendOf, yearOf } from '../shared/calendar.js';
import { Ration } from '../sim/economy/ledger.js';
import { TRAIN_COSTS, techStatusFor } from './playerRules.js';
import type { SimEvent } from '../shared/events.js';
import type { Heightmap } from '../shared/heightmap.js';
import { createCattleSystem, type CattleSystem } from '../sim/cattle.js';
import { createAi } from '../sim/ai/opponent.js';
import { createTechState, type TechState } from '../sim/tech.js';
import { createCensus, type Census } from '../sim/census.js';
import { createLabour, idleOf, type Labour } from '../sim/labour.js';
import { createProductionSystem, type ProductionSystem } from '../sim/production.js';
import { createConstructionSystem, type ConstructionSystem } from '../sim/construction.js';
import { createEconomy, Resource, type Economy } from '../sim/economy/ledger.js';
import { createWoodland, packWoodland, type Woodland } from '../sim/woodland.js';
import { packFarmland, type Farmland } from '../sim/economy/farmland.js';
import { createStartingFarmland } from '../sim/economy/plots.js';
import { tuning } from '../sim/tuning.js';
import { FactionId } from '../shared/factions/index.js';
import { createFog, type FogState } from '../sim/vision/fog.js';
import { createMovementSystem, type MovementSystem } from '../sim/movement.js';
import type { World } from '../sim/world.js';
import { offersFor, type TradeOffer } from '../sim/trade.js';
import { cullHead, drivenBy } from '../sim/herd.js';
import { createAlliance, relationsFor, type Alliance, type Relation } from '../sim/alliance.js';

/**
 * The boundary the renderer talks to.
 *
 * Two implementations are planned: this one, running on the main thread, and a worker
 * one later. Development happens against the direct host — see
 * docs/adr/0004-defer-the-simulation-worker.md — because what makes the eventual flip
 * expensive is never the message plumbing. It is the UI quietly accreting synchronous
 * reads of simulation state for hover, minimap, hit-testing and debug overlays.
 *
 * Hosts live outside src/sim deliberately. They are adapters: they translate real
 * elapsed time into ticks and marshal state across a transport, and neither of those is
 * simulation logic. Keeping them here means src/sim can stay under the determinism ban
 * without the worker's own clock needing an exception carved out of it.
 *
 * Two mechanisms stop the renderer reaching past the boundary. The import rule is
 * enforced by ESLint, and in strict mode this host structuredClones every snapshot that
 * crosses it, so a shared reference into simulation memory fails here and now rather
 * than at flip time.
 *
 * ADR-0004 also called for cloning commands. That turned out to be ceremony: sendCommand
 * accepts only numbers, so a command cannot carry a reference into simulation state in
 * the first place. The type signature enforces statically what the clone would have
 * checked at runtime, which is the stronger guarantee. If a command ever grows a payload
 * richer than a number, restore the clone along with it.
 */

/**
 * The viewing player's own economic position.
 *
 * Crosses the boundary with the snapshot rather than being read from the ledger,
 * because the ledger is simulation state and the renderer may not touch it. It is
 * per-viewer for the same reason entities are: in a real match you see your own
 * granary, not your enemy's.
 */
/**
 * How far ahead the weather trend looks: one twelfth of a year.
 *
 * Far enough that the answer is about the season rather than about the curve's own
 * slope at a point, and near enough that it is still about this year.
 */
const LOOKAHEAD_TICKS = Math.round(tuning.economy.seasonTicks / 12);

export interface PlayerState {
  readonly cattle: number;
  readonly grain: number;
  /** Timber in hand. Buildings need it, and only the woodland supplies it. */
  readonly wood: number;
  /**
   * Trades a neighbour would accept right now, and what each returns.
   *
   * Carried across the boundary because the rate is the NEIGHBOUR's private
   * information — their scarcity sets it, and the player cannot see their books. Asking
   * is free and changes nothing, so the simulation answers on the player's behalf
   * rather than making them discover it by trying. See src/sim/trade.ts.
   */
  readonly offers: readonly TradeOffer[];
  /**
   * Every neighbour, what they are to this village and what they make of it.
   *
   * Standing is their regard for the viewer rather than the viewer's for them, because
   * that is the number that decides whether an offer of alliance is taken and what rate
   * a trade comes back at. See src/sim/alliance.ts.
   */
  readonly relations: readonly Relation[];
  /**
   * What the last season cost to feed, and what came in to meet it.
   *
   * Both, side by side, because the decision the game kept springing on people is
   * whether to raise another household — and the only honest way to answer it is to see
   * the margin before committing. `shortfall` says the same thing one season too late.
   */
  readonly upkeep: number;
  readonly harvest: number;
  /**
   * Households the land would feed. Shown beside the settle target, because those two
   * numbers together are the whole of what a player needs to plan growth: a village
   * that feeds 38 and is asked for 60 needs more fields, not more people.
   */
  readonly feeds: number;
  /**
   * Head a slaughter would take right now, or 0 when there is nothing to take.
   *
   * The simulation reckons it rather than the panel, because how many beasts a cull
   * takes is a rule and the UI may not read tuning across the boundary.
   */
  readonly cullHead: number;
  /** Cattle this village has a hand on right now, as opposed to standing on its ledger. */
  readonly driving: number;
  /** Grain owed but unpaid at the last upkeep. Non-zero means troops are starving. */
  readonly shortfall: number;
  /** True while the village is on short commons. The panel's switch reads it. */
  readonly shortRation: boolean;
  /**
   * Per tech: 0 unknown, 1 being learned, 2 known.
   *
   * Carried so the panel can say WHY an action is unavailable rather than accepting a
   * click and doing nothing. `tasks/plan.md` section F has had that defect recorded
   * since September.
   */
  readonly techStatus: readonly number[];
  /**
   * What a soldier costs, indexed by movement class.
   *
   * Sent across rather than read from the tuning file, for the same reason `cullHead`
   * is: what a thing costs is a rule, and the UI may not read tuning across the
   * boundary.
   */
  readonly trainCosts: readonly { readonly grain: number; readonly cattle: number }[];
  /** 0 (wet) to 1 (parched). */
  readonly drought: number;
  readonly droughtSevere: boolean;
  /**
   * Whole years elapsed, and which way the weather is going: 1 drying, -1 easing.
   *
   * Named here rather than in the HUD because the trend needs the drought curve at a
   * tick the HUD does not have — it sees one reading a frame, some of them stale, and
   * differencing those would report the network's jitter as the weather's. The season
   * itself the HUD can name from `drought` alone.
   */
  readonly year: number;
  readonly droughtTrend: -1 | 0 | 1;

  /** Households standing in this player's village. */
  readonly households: number;
  /** Nobody has lived in this village for the whole grace period. Ends nothing. */
  readonly emptied: boolean;

  /**
   * Villagers free and standing about, with no work and no order.
   *
   * Work finds its own people now (src/sim/labour.ts), so the question a player asks is
   * no longer "who do I send" but "is anybody spare" — which decides whether to break
   * another field or raise another household.
   */
  readonly idle: number;
  /** Hands the village's places are asking for and cannot get. Non-zero means stretched. */
  readonly handsShort: number;
  /**
   * Hands a building site asks for, so the panel can say "2 of 4". Sent across rather
   * than read from tuning for the reason `cullHead` is.
   */
  readonly siteHands: number;
}

export interface SimMessage {
  readonly snapshot: ArrayBuffer;
  readonly events: readonly SimEvent[];
  /** Non-zero when the consumer stalled long enough to lose events. */
  readonly droppedEvents: number;
  readonly player: PlayerState;
  /**
   * The viewer's fog, or null when it has not changed since the last message.
   *
   * Sent as a copy rather than a view for the same reason snapshots are: the renderer
   * must not hold a window into simulation memory. It changes at the vision interval,
   * not every tick, so most messages carry nothing here.
   */
  readonly fog: Uint8Array | null;
  /**
   * The standing wood, or null when it has not changed since the last message.
   *
   * Sent whole rather than as a diff: it changes on the upkeep cycle rather than per
   * tick, and fourteen hundred trees is seventeen kilobytes — the same trade the fog
   * makes, and for the same reason.
   */
  readonly woodland: Float32Array | null;
  /** The fields, or null when unchanged. Same contract as the wood beside it. */
  readonly farmland: Float32Array | null;
}

/**
 * The contract both hosts meet.
 *
 * Deliberately narrow: no simulation systems are exposed, because anything the renderer
 * could reach for here is something that cannot cross a thread boundary. DirectSimHost
 * returns a wider type for tests, which run on the same thread by definition.
 */
export interface SimHost {
  readonly tick: number;
  sendCommand(kind: CommandKind, a?: number, b?: number, c?: number, d?: number): void;
  /** Advance by real elapsed time. A worker host will tick itself and ignore this. */
  pump(elapsedMs: number): void;
  /**
   * How fast wall-clock time is fed to the simulation. 0 pauses, 1 is real time.
   *
   * A host concern and nothing else. The tick is a fixed 50ms and stays one: changing
   * the tick rate would change what the simulation computes, and every determinism
   * guarantee in the project rests on it not doing that. This only changes how many of
   * those identical ticks a second of real time buys, so a paused or doubled game
   * produces exactly the state a normal one would, reached sooner or later.
   */
  speed: number;
  /** Take the newest snapshot and the events since the last take, or null if unchanged. */
  receive(): SimMessage | null;
  /**
   * The whole simulation as a save (src/sim/persistence/save.ts). A promise, because a
   * worker host has to ask its thread for it.
   */
  save(): Promise<SaveGame>;
  /**
   * Replace the simulation's state with a save. Call it on a freshly created host, in
   * place of seeding an opening — the host must have been built with the same map,
   * factions and seed the save was taken from.
   */
  restore(save: SaveGame): void;
  dispose(): void;
}

export interface DirectSimHostOptions {
  world: World;
  /** Terrain the simulation moves over. Pathing cost layers derive from it. */
  map: Heightmap;
  factions?: readonly FactionId[];
  /** Players driven by the computer. Each is simply another command source. */
  aiPlayers?: readonly number[];
  /**
   * Villages kept off the map: a ledger, a trade screen and a party to ties, with no
   * huts or people on the map (ADR-0021). src/sim/neighbours.ts runs their seasons.
   */
  neighbours?: readonly number[];
  /** Where each player begins. Arable land is laid out around these. */
  starts?: readonly { readonly x: number; readonly y: number }[];
  seed?: number;
  viewerId?: number;
  playerId?: number;
  /**
   * Ticks between issuing a command and executing it. Zero for single-player, where
   * the latency is pure cost. Lockstep needs 3-6 to absorb network jitter; the
   * mechanism is here so enabling it is a constant, not a redesign.
   */
  commandDelayTicks?: number;
  /** structuredClone snapshots crossing the boundary. Defaults to on outside production. */
  strict?: boolean;
  /** Event backlog before the oldest are dropped. Exposed so tests can reach the cap. */
  maxPendingEvents?: number;
}

/** Beyond this the consumer is not keeping up and the oldest events are dropped. */
const DEFAULT_MAX_PENDING_EVENTS = 4096;

/**
 * Cap on catch-up ticks per pump. Without it, a long stall (a breakpoint, a background
 * tab) produces a pump asking for hundreds of ticks, which takes longer than a frame,
 * which makes the next pump larger still.
 */
const MAX_CATCHUP_TICKS = 5;

function defaultStrict(): boolean {
  try {
    return import.meta.env?.DEV !== false;
  } catch {
    return true;
  }
}

/** DirectSimHost, with the systems exposed for tests and tooling. */
export interface DirectSimHost extends SimHost {
  readonly movement: MovementSystem;
  readonly cattle: CattleSystem;
  readonly construction: ConstructionSystem;
  readonly production: ProductionSystem;
  readonly economy: Economy;
  readonly woodland: Woodland;
  readonly farmland: Farmland;
  readonly alliance: Alliance;
  readonly tech: TechState;
  readonly census: Census;
  readonly labour: Labour;
  readonly fog: FogState;
  /**
   * The loop itself, for tooling that has to run faster than real time — the soak
   * harness runs years of a match, and `pump` caps catch-up at a handful of ticks.
   */
  readonly loop: SimLoop;
}

export function createDirectSimHost(options: DirectSimHostOptions): DirectSimHost {
  const {
    world,
    map,
    viewerId = 0,
    playerId = 0,
    commandDelayTicks = 0,
    strict = defaultStrict(),
    maxPendingEvents = DEFAULT_MAX_PENDING_EVENTS,
    factions = [FactionId.Zulu, FactionId.Sotho],
    aiPlayers = [],
    neighbours = [],
    starts = [],
    seed = 0,
  } = options;

  const movement = createMovementSystem(map);
  const cattle = createCattleSystem();
  const construction = createConstructionSystem(map, movement.pathing);
  const production = createProductionSystem(movement);
  // Explicit plots win; otherwise lay them out around the starts. Without either,
  // grain income is zero and every player starves — see sim/economy/plots.ts.
  const economy = createEconomy(factions, seed);
  for (const player of neighbours) economy.offMap[player] = 1;
  const woodland = createWoodland(map, seed);
  const farmland = createStartingFarmland(map, starts, seed);
  const tech = createTechState(Math.max(factions.length, viewerId + 1));
  const census = createCensus(Math.max(factions.length, viewerId + 1));
  const labour = createLabour(Math.max(factions.length, viewerId + 1));
  const fog = createFog(Math.max(factions.length, viewerId + 1), map);
  const alliance = createAlliance(Math.max(factions.length, viewerId + 1));
  const loop: SimLoop = createLoop({
    world,
    movement,
    cattle,
    construction,
    production,
    economy,
    woodland,
    farmland,
    alliance,
    tech,
    census,
    labour,
    fog,
    map,
  });
  for (const player of aiPlayers) loop.ai.push({ player, controller: createAi(player) });
  let accumulator = 0;
  let sequence = 0;

  // Coalesced: only the newest undelivered snapshot is kept. A backgrounded tab stops
  // consuming while the simulation keeps running, and an uncoalesced queue would grow
  // until the tab died.
  let pendingSnapshot: ArrayBuffer | null = null;
  let sentFogVersion = -1;
  let sentWoodVersion = -1;
  let sentFieldVersion = -1;
  let pendingEvents: SimEvent[] = [];
  let droppedEvents = 0;

  function drainLoopEvents(): void {
    if (loop.events.length === 0) return;

    for (const event of loop.events) {
      if (pendingEvents.length >= maxPendingEvents) {
        pendingEvents.shift();
        droppedEvents++;
      }
      pendingEvents.push(event);
    }
    loop.events.length = 0;
  }

  const host: DirectSimHost = {
    movement,
    cattle,
    construction,
    production,
    economy,
    woodland,
    farmland,
    alliance,
    tech,
    census,
    labour,
    fog,
    loop,

    get tick(): number {
      return world.tick;
    },

    sendCommand(kind, a = 0, b = 0, c = 0, d = 0): void {
      const command: Command = makeCommand(
        world.tick + commandDelayTicks,
        playerId,
        sequence++,
        kind,
        a,
        b,
        c,
        d,
      );
      enqueueCommand(loop, command);
    },

    speed: 1,

    pump(elapsedMs: number): void {
      if (host.speed <= 0) {
        // Drop the time rather than banking it, or unpausing fast-forwards by however
        // long the player stood still.
        accumulator = 0;
        return;
      }
      accumulator += elapsedMs * host.speed;

      let ticks = 0;
      while (accumulator >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
        step(loop);
        accumulator -= TICK_MS;
        ticks++;
      }
      if (accumulator > TICK_MS * MAX_CATCHUP_TICKS) accumulator = 0;

      if (ticks === 0) return;

      drainLoopEvents();
      compactLoop(loop);
      pendingSnapshot = buildSnapshot(world, viewerId, fog);
    },

    receive(): SimMessage | null {
      if (pendingSnapshot === null) return null;

      const snapshot = strict ? structuredClone(pendingSnapshot) : pendingSnapshot;
      const events = pendingEvents;
      const dropped = droppedEvents;

      pendingSnapshot = null;
      pendingEvents = [];
      droppedEvents = 0;

      const droughtNow = economy.drought(world.tick);
      const player: PlayerState = {
        cattle: economy.balance(viewerId, Resource.Cattle),
        grain: economy.balance(viewerId, Resource.Grain),
        wood: economy.balance(viewerId, Resource.Wood),
        offers: offersFor(economy, viewerId, alliance),
        relations: relationsFor(alliance, viewerId),
        shortfall: economy.shortfall[viewerId] ?? 0,
        upkeep: economy.upkeep[viewerId] ?? 0,
        harvest: economy.harvested[viewerId] ?? 0,
        feeds: economy.feeds[viewerId] ?? 0,
        cullHead: cullHead(economy, viewerId),
        driving: drivenBy(world, viewerId),
        shortRation: economy.ration[viewerId] === Ration.Short,
        techStatus: techStatusFor(loop.tech, viewerId),
        trainCosts: TRAIN_COSTS,
        drought: droughtNow,
        droughtSevere: droughtNow >= tuning.economy.droughtThreshold,
        year: yearOf(world.tick, tuning.economy.seasonTicks),
        // A season ahead, which is far enough that the answer is not noise and near
        // enough that it is still about this year.
        droughtTrend: trendOf(droughtNow, economy.drought(world.tick + LOOKAHEAD_TICKS)),
        households: census.households[viewerId] ?? 0,
        emptied: census.emptied[viewerId] === 1,
        idle: idleOf(world, viewerId),
        handsShort: labour.short[viewerId] ?? 0,
        siteHands: tuning.labour.siteHands,
      };

      let fogSlice: Uint8Array | null = null;
      if (fog.version !== sentFogVersion) {
        const tiles = fog.width * fog.height;
        fogSlice = fog.tiles.slice(viewerId * tiles, (viewerId + 1) * tiles);
        sentFogVersion = fog.version;
      }

      let trees: Float32Array | null = null;
      if (woodland.version !== sentWoodVersion) {
        trees = packWoodland(woodland);
        sentWoodVersion = woodland.version;
      }

      let fields: Float32Array | null = null;
      if (farmland.version !== sentFieldVersion) {
        fields = packFarmland(farmland);
        sentFieldVersion = farmland.version;
      }

      return {
        snapshot,
        events,
        droppedEvents: dropped,
        player,
        fog: fogSlice,
        woodland: trees,
        farmland: fields,
      };
    },

    save(): Promise<SaveGame> {
      return Promise.resolve(captureState(loop));
    },

    restore(save: SaveGame): void {
      restoreState(loop, save);
      // Everything restored is news to the renderer, whatever its version says.
      sentFogVersion = -1;
      sentWoodVersion = -1;
      sentFieldVersion = -1;
    },

    dispose(): void {
      pendingSnapshot = null;
      pendingEvents = [];
    },
  };

  return host;
}
