import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import { destroy, orderMove, spawn, type Handle, type World } from './world.js';

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

export const CommandKind = {
  Spawn: 0,
  MoveTo: 1,
  Destroy: 2,
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
export function applyCommand(world: World, command: Command, events: SimEvent[]): boolean {
  switch (command.kind) {
    case CommandKind.Spawn: {
      const handle = spawn(world, command.a, command.b, command.c);
      if (handle === 0) return false;
      events.push(makeEvent(world.tick, EventType.Spawned, handle, command.a, command.b));
      return true;
    }

    case CommandKind.MoveTo: {
      const handle = command.a as Handle;
      if (!orderMove(world, handle, command.b, command.c)) return false;
      events.push(makeEvent(world.tick, EventType.OrderIssued, handle, command.b, command.c));
      return true;
    }

    case CommandKind.Destroy:
      return destroy(world, command.a as Handle);

    default:
      return false;
  }
}
