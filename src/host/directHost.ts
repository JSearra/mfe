import type { Command, CommandKind } from '../sim/commands.js';
import { makeCommand } from '../sim/commands.js';
import { compactLoop, createLoop, enqueueCommand, step, TICK_MS, type SimLoop } from '../sim/loop.js';
import { buildSnapshot } from '../sim/snapshot.js';
import type { SimEvent } from '../shared/events.js';
import type { Heightmap } from '../shared/heightmap.js';
import { createCattleSystem, type CattleSystem } from '../sim/cattle.js';
import { createCombatSystem, type CombatSystem } from '../sim/combat.js';
import { createAi } from '../sim/ai/opponent.js';
import { createTechState, type TechState } from '../sim/tech.js';
import { createVictoryState, type VictoryState } from '../sim/victory.js';
import { createProductionSystem, type ProductionSystem } from '../sim/production.js';
import { createConstructionSystem, type ConstructionSystem } from '../sim/construction.js';
import { createEconomy, Resource, type Economy, type GrainPlot } from '../sim/economy/ledger.js';
import { createStartingPlots } from '../sim/economy/plots.js';
import { tuning } from '../sim/tuning.js';
import { FactionId } from '../shared/factions/index.js';
import { createFog, type FogState } from '../sim/vision/fog.js';
import { createMovementSystem, type MovementSystem } from '../sim/movement.js';
import type { World } from '../sim/world.js';

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
export interface PlayerState {
  readonly cattle: number;
  readonly grain: number;
  readonly ammunition: number;
  /** Grain owed but unpaid at the last upkeep. Non-zero means troops are starving. */
  readonly shortfall: number;
  /** 0 (wet) to 1 (parched). */
  readonly drought: number;
  readonly droughtSevere: boolean;

  /** Cattle this player holds, ledger plus driven herd. */
  readonly cattleHeld: number;
  readonly cattleToWin: number;
  /** 0 to 1: how much of the hold requirement has elapsed. */
  readonly holdProgress: number;
  /** 0 ongoing, 1 cattle victory, 2 last standing. */
  readonly outcome: number;
  /** -1 while undecided. */
  readonly winner: number;
  readonly eliminated: boolean;
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
  dispose(): void;
}

export interface DirectSimHostOptions {
  world: World;
  /** Terrain the simulation moves over. Pathing cost layers derive from it. */
  map: Heightmap;
  factions?: readonly FactionId[];
  /** Players driven by the computer. Each is simply another command source. */
  aiPlayers?: readonly number[];
  plots?: readonly GrainPlot[];
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
  readonly combat: CombatSystem;
  readonly construction: ConstructionSystem;
  readonly production: ProductionSystem;
  readonly economy: Economy;
  readonly tech: TechState;
  readonly victory: VictoryState;
  readonly fog: FogState;
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
    plots,
    starts = [],
    seed = 0,
  } = options;

  const movement = createMovementSystem(map);
  const cattle = createCattleSystem();
  const combat = createCombatSystem();
  const construction = createConstructionSystem(map, movement.pathing);
  const production = createProductionSystem(movement);
  // Explicit plots win; otherwise lay them out around the starts. Without either,
  // grain income is zero and every player starves — see sim/economy/plots.ts.
  const economy = createEconomy(factions, seed, plots ?? createStartingPlots(map, starts, seed));
  const tech = createTechState(Math.max(factions.length, viewerId + 1));
  const victory = createVictoryState(Math.max(factions.length, viewerId + 1));
  const fog = createFog(Math.max(factions.length, viewerId + 1), map);
  const loop: SimLoop = createLoop({
    world,
    movement,
    cattle,
    combat,
    construction,
    production,
    economy,
    tech,
    victory,
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
    combat,
    construction,
    production,
    economy,
    tech,
    victory,
    fog,

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
        ammunition: economy.balance(viewerId, Resource.Ammunition),
        shortfall: economy.shortfall[viewerId] ?? 0,
        drought: droughtNow,
        droughtSevere: droughtNow >= tuning.economy.droughtThreshold,
        cattleHeld: victory.cattleHeld[viewerId] ?? 0,
        cattleToWin: tuning.victory.cattleToWin,
        holdProgress: Math.min(1, (victory.holdTicks[viewerId] ?? 0) / tuning.victory.holdTicks),
        outcome: victory.outcome,
        winner: victory.winner,
        eliminated: victory.eliminated[viewerId] === 1,
      };

      let fogSlice: Uint8Array | null = null;
      if (fog.version !== sentFogVersion) {
        const tiles = fog.width * fog.height;
        fogSlice = fog.tiles.slice(viewerId * tiles, (viewerId + 1) * tiles);
        sentFogVersion = fog.version;
      }

      return { snapshot, events, droppedEvents: dropped, player, fog: fogSlice };
    },

    dispose(): void {
      pendingSnapshot = null;
      pendingEvents = [];
    },
  };

  return host;
}
