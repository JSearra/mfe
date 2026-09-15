import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import type { CattleSystem } from './cattle.js';
import type { ConstructionSystem } from './construction.js';
import type { ProductionSystem } from './production.js';
import type { Economy } from './economy/ledger.js';
import type { BuildingType } from '../shared/buildings/index.js';
import { TECH_IDS } from '../shared/tech/index.js';
import type { TechState } from './tech.js';
import type { MovementSystem } from './movement.js';
import { fell, type Woodland } from './woodland.js';
import { abandon, plant, type Farmland } from './economy/farmland.js';
import { trade, TradeResult } from './trade.js';
import { AllyResult, breakBond, propose, type Alliance } from './alliance.js';
import { Resource } from './economy/ledger.js';
import type { Heightmap } from '../shared/heightmap.js';
import {
  clearOrderQueue,
  destroy,
  enqueueOrder,
  EntityKind,
  handleIndex,
  isAlive,
  OrderMode,
  spawn,
  type Handle,
  type World,
} from './world.js';

/**
 * Commands are the sole path by which simulation state changes.
 *
 * Keeping that true is what makes three later things cheap rather than structural:
 * an AI opponent is just another command source, replays are a command log, and
 * lockstep needs only a canonical ordering. See docs/ARCHITECTURE.md section 1.
 *
 * Payload slots are numeric so a command serializes to a flat buffer without a
 * per-command object graph when the worker boundary lands.
 */

/** Cattle answer to nobody until somebody leashes them. */
export const NEUTRAL_FACTION = 2;

export const CommandKind = {
  Spawn: 0,
  MoveTo: 1,
  Destroy: 2,
  SpawnCattle: 3,
  /** Tether a cow to a herder — what right-clicking a neutral herd issues. */
  Leash: 4,
  /**
   * 5 was `Attack`. Retired with combat in Phase V6. Command values are durable — they
   * sit in recorded logs and cross the worker boundary — so retired ones are left as
   * gaps rather than renumbered.
   */
  Build: 6,
  Research: 7,
  Train: 8,
  SetRally: 9,
  /** 10 was `AttackMove`, 11 `SetStance`. Both retired with combat. */
  /**
   * Walk between here and there until told otherwise.
   *
   * Kept through the combat retirement. It was built as an attack-move that refuses to
   * finish, but nothing about walking a beat needs a fight at the end of it, and a
   * herder covering ground between two points wants exactly this.
   */
  Patrol: 12,
  /** Cut a standing tree for its timber. `a` is the index into the woodland. */
  Fell: 13,
  /** Break new ground for a field. `a`/`b` are the tile. */
  Plant: 14,
  /** Give a field up. `a` is its index in the farmland. */
  Abandon: 15,
  /**
   * Offer a neighbour `d` of resource `b` for whatever resource `c` they will give.
   *
   * `a` is the neighbour. The amount returned is not in the command because only the
   * neighbour knows it — see src/sim/trade.ts.
   */
  Trade: 16,
  /**
   * Ask neighbour `a` for a standing tie. They answer from their own regard for you;
   * see src/sim/alliance.ts.
   */
  Ally: 17,
  /** Walk away from the tie with neighbour `a`, and wear the cost of it. */
  Break: 18,
} as const;

export type CommandKind = (typeof CommandKind)[keyof typeof CommandKind];

export interface Command {
  /** Tick on which this command executes. */
  readonly tick: number;
  readonly playerId: number;
  /** Monotonic per player. (playerId, seq) is the tie-break that makes ordering total. */
  readonly seq: number;
  readonly kind: CommandKind;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

export function makeCommand(
  tick: number,
  playerId: number,
  seq: number,
  kind: CommandKind,
  a = 0,
  b = 0,
  c = 0,
  d = 0,
): Command {
  return { tick, playerId, seq, kind, a, b, c, d };
}

/**
 * Total order over commands. Two players acting on the same tick must resolve the
 * same way on every machine, so arrival order is never consulted.
 */
export function compareCommands(x: Command, y: Command): number {
  if (x.tick !== y.tick) return x.tick - y.tick;
  if (x.playerId !== y.playerId) return x.playerId - y.playerId;
  return x.seq - y.seq;
}

/**
 * Apply one command. A command naming a dead or recycled entity is dropped, not
 * applied and not thrown on: by the time a click reaches here its target may have
 * died, and that is ordinary, not exceptional.
 */
/** The systems a command may act on. Named for the same reason SimSystems is. */
export interface CommandContext {
  readonly movement: MovementSystem;
  readonly woodland: Woodland;
  readonly farmland: Farmland;
  /** Terrain, for siting decisions a command makes. */
  readonly map: Heightmap;
  readonly cattle: CattleSystem;
  readonly construction: ConstructionSystem;
  readonly production: ProductionSystem;
  readonly economy: Economy;
  readonly alliance: Alliance;
  readonly tech: TechState;
}

export function applyCommand(
  world: World,
  command: Command,
  events: SimEvent[],
  context: CommandContext,
): boolean {
  const { movement, cattle, construction, production, economy, woodland, farmland, map, alliance, tech } =
    context;
  switch (command.kind) {
    case CommandKind.Spawn: {
      const handle = spawn(world, command.a, command.b, command.c, command.d);
      if (handle === 0) return false;
      events.push(makeEvent(world.tick, EventType.Spawned, handle, command.a, command.b));
      return true;
    }

    case CommandKind.MoveTo: {
      const handle = command.a as Handle;
      const mode = OrderMode.Move;

      // `d` non-zero appends rather than replaces. It rides on the existing command
      // rather than doubling the command kinds, because queueing is a property of how an
      // order was issued and not a different order.
      if (command.d !== 0) {
        if (!isAlive(world, handle)) return false;
        const index = handleIndex(handle);
        if (world.kind[index] !== EntityKind.Unit) return false;
        // A unit standing idle has nothing to queue behind, so the first shift-click
        // starts the march instead of sitting in a queue nothing will ever drain.
        if (world.hasTarget[index] !== 1) {
          if (!movement.order(world, handle, command.b, command.c)) return false;
          world.orderMode[index] = mode;
          events.push(makeEvent(world.tick, EventType.OrderIssued, handle, command.b, command.c));
          return true;
        }
        return enqueueOrder(world, index, command.b, command.c, mode);
      }

      if (!movement.order(world, handle, command.b, command.c)) return false;
      clearOrderQueue(world, handleIndex(handle));
      // Set after the order is accepted, so a rejected order cannot leave a unit in a
      // mode it never entered.
      world.orderMode[handleIndex(handle)] = mode;
      events.push(makeEvent(world.tick, EventType.OrderIssued, handle, command.b, command.c));
      return true;
    }

    case CommandKind.SpawnCattle: {
      // Neutral faction: cattle belong to whoever can hold them, which is the point.
      const handle = spawn(world, command.a, command.b, NEUTRAL_FACTION, 1, EntityKind.Cattle);
      if (handle === 0) return false;
      events.push(makeEvent(world.tick, EventType.Spawned, handle, command.a, command.b));
      return true;
    }

    case CommandKind.Patrol: {
      const handle = command.a as Handle;
      if (!isAlive(world, handle)) return false;
      const index = handleIndex(handle);
      if (world.kind[index] !== EntityKind.Unit) return false;

      // The near end is wherever the unit is standing when the order arrives, so a
      // patrol is set with one click like every other order rather than two.
      world.patrolX[index] = world.posX[index]!;
      world.patrolY[index] = world.posY[index]!;
      if (!movement.order(world, handle, command.b, command.c)) return false;
      clearOrderQueue(world, index);
      world.orderMode[index] = OrderMode.Patrol;
      events.push(makeEvent(world.tick, EventType.OrderIssued, handle, command.b, command.c));
      return true;
    }

    case CommandKind.Fell:
      // Felling is a command and picking fruit is not, deliberately: standing under a
      // tree to eat is reversible and cutting it down is not. A village should not
      // level a wood by walking through it. See src/sim/woodland.ts.
      return fell(world, woodland, economy, command.playerId, command.a) > 0;

    case CommandKind.Plant:
      return plant(farmland, economy, map, command.playerId, command.a, command.b) === 0;

    case CommandKind.Abandon:
      return abandon(farmland, command.a);

    case CommandKind.Trade: {
      const result = trade(
        economy,
        command.playerId,
        command.a,
        command.b as Resource,
        command.c as Resource,
        command.d,
        alliance,
      );
      // A refusal is news. The player cannot see a neighbour's books, so silence would
      // be indistinguishable from the command going missing.
      events.push(
        makeEvent(
          world.tick,
          result === TradeResult.Traded ? EventType.Traded : EventType.TradeRefused,
          0,
          0,
          0,
          command.a,
        ),
      );
      return result === TradeResult.Traded;
    }

    case CommandKind.Ally: {
      const result = propose(alliance, command.playerId, command.a);
      // Both outcomes are news for the same reason a refused trade is: the player cannot
      // see what a neighbour makes of them, so silence would read as a lost command.
      if (result === AllyResult.Allied || result === AllyResult.Refused) {
        events.push(
          makeEvent(
            world.tick,
            result === AllyResult.Allied ? EventType.AllianceFormed : EventType.AllianceRefused,
            0,
            command.playerId,
            command.a,
          ),
        );
      }
      return result === AllyResult.Allied;
    }

    case CommandKind.Break:
      return breakBond(alliance, command.playerId, command.a, events, world.tick);

    case CommandKind.Leash:
      return cattle.leash(world, command.a as Handle, command.b as Handle);

    // The acting player is who SENT the command, never a player named in its payload.
    // Both read command.d / command.b once. Every caller passes its own id, so the two
    // have always agreed and nothing was visibly wrong — but the payload is data a
    // client controls and playerId is provenance, and under the lockstep this project
    // keeps possible the payload version lets any client build with a rival's grain.
    case CommandKind.Build:
      return (
        construction.place(
          world,
          economy,
          command.playerId,
          command.c as BuildingType,
          command.a,
          command.b,
          events,
        ) === 0
      );

    case CommandKind.Research: {
      const id = TECH_IDS[command.a];
      if (id === undefined) return false;
      // Provenance, not payload — see the note on Build above.
      return tech.begin(command.playerId, id, economy);
    }

    case CommandKind.Train:
      return production.train(world, economy, command.a as Handle, command.b) === 0;

    case CommandKind.SetRally:
      return production.setRally(world, command.a as Handle, command.b, command.c);

    case CommandKind.Destroy:
      return destroy(world, command.a as Handle);

    default:
      return false;
  }
}
