import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import type { CattleSystem } from './cattle.js';
import type { CombatSystem } from './combat.js';
import type { ConstructionSystem } from './construction.js';
import type { ProductionSystem } from './production.js';
import type { Economy } from './economy/ledger.js';
import type { BuildingType } from '../shared/buildings/index.js';
import { TECH_IDS } from '../shared/tech/index.js';
import type { TechState } from './tech.js';
import type { MovementSystem } from './movement.js';
import { fell, type Woodland } from './woodland.js';
import {
  clearOrderQueue,
  destroy,
  enqueueOrder,
  EntityKind,
  handleIndex,
  isAlive,
  OrderMode,
  Stance,
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
  Attack: 5,
  Build: 6,
  Research: 7,
  Train: 8,
  SetRally: 9,
  /** Move, but engage what you meet on the way. */
  AttackMove: 10,
  /** Set how far a unit will go to fight. */
  SetStance: 11,
  /** Walk between here and there until told otherwise. */
  Patrol: 12,
  /** Cut a standing tree for its timber. `a` is the index into the woodland. */
  Fell: 13,
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
  readonly cattle: CattleSystem;
  readonly combat: CombatSystem;
  readonly construction: ConstructionSystem;
  readonly production: ProductionSystem;
  readonly economy: Economy;
  readonly tech: TechState;
}

export function applyCommand(
  world: World,
  command: Command,
  events: SimEvent[],
  context: CommandContext,
): boolean {
  const { movement, cattle, combat, construction, production, economy, woodland, tech } = context;
  switch (command.kind) {
    case CommandKind.Spawn: {
      const handle = spawn(world, command.a, command.b, command.c, command.d);
      if (handle === 0) return false;
      events.push(makeEvent(world.tick, EventType.Spawned, handle, command.a, command.b));
      return true;
    }

    case CommandKind.MoveTo:
    case CommandKind.AttackMove: {
      const handle = command.a as Handle;
      const mode =
        command.kind === CommandKind.AttackMove ? OrderMode.AttackMove : OrderMode.Move;

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

    case CommandKind.SetStance: {
      const handle = command.a as Handle;
      if (!isAlive(world, handle)) return false;
      const stance = command.b;
      if (stance !== Stance.Aggressive && stance !== Stance.Defensive && stance !== Stance.HoldGround) {
        return false;
      }
      const index = handleIndex(handle);
      if (world.kind[index] !== EntityKind.Unit) return false;
      world.stance[index] = stance;
      // The post moves with the order to hold here, not to wherever the unit was last
      // told to go: a unit set to hold ground holds THIS ground.
      world.postX[index] = world.posX[index]!;
      world.postY[index] = world.posY[index]!;
      return true;
    }

    case CommandKind.Fell:
      // Felling is a command and picking fruit is not, deliberately: standing under a
      // tree to eat is reversible and cutting it down is not. A village should not
      // level a wood by walking through it. See src/sim/woodland.ts.
      return fell(woodland, economy, command.playerId, command.a) > 0;

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

    case CommandKind.Attack:
      return combat.attack(world, command.a as Handle, command.b as Handle);

    case CommandKind.Destroy:
      return destroy(world, command.a as Handle);

    default:
      return false;
  }
}
