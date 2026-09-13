import { applyCommand, compareCommands, type Command } from './commands.js';
import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import { flushDestroys, moveUnits, packHandle, type World } from './world.js';

export { TICK_HZ, TICK_MS } from '../shared/timing.js';

export interface SimLoop {
  readonly world: World;
  /** Sorted by (tick, playerId, seq) from `cursor` onward. */
  readonly pending: Command[];
  cursor: number;
  /** Set when a command arrives after sorting, so the tail is re-sorted before use. */
  dirty: boolean;
  /** Commands naming a tick already simulated. Non-zero means a bug upstream. */
  lateCommands: number;
  /** Drained by the host each pump. */
  readonly events: SimEvent[];
}

export function createLoop(world: World, commands: readonly Command[] = []): SimLoop {
  const pending = [...commands].sort(compareCommands);
  return { world, pending, cursor: 0, dirty: false, lateCommands: 0, events: [] };
}

/** Queue a command issued during play. */
export function enqueueCommand(loop: SimLoop, command: Command): void {
  loop.pending.push(command);
  loop.dirty = true;
}

/**
 * Advance exactly one tick.
 *
 * Order is fixed: commands, then systems, then the destroy flush. Systems therefore
 * see a stable entity set for the whole tick, and anything destroyed during it
 * survives until the boundary.
 */
export function step(loop: SimLoop): void {
  const { world, pending, events } = loop;

  if (loop.dirty) {
    // Only the unconsumed tail can be out of order.
    const tail = pending.splice(loop.cursor).sort(compareCommands);
    for (const command of tail) pending.push(command);
    loop.dirty = false;
  }

  while (loop.cursor < pending.length) {
    const command = pending[loop.cursor]!;
    if (command.tick > world.tick) break;
    if (command.tick < world.tick) loop.lateCommands++;
    applyCommand(world, command, events);
    loop.cursor++;
  }

  moveUnits(world);

  // Emitted before the flush, while the entities still have positions to report.
  for (let i = 0; i < world.pendingDestroyCount; i++) {
    const index = world.pendingDestroy[i]!;
    events.push(
      makeEvent(
        world.tick,
        EventType.Destroyed,
        packHandle(index, world.generation[index]!),
        world.posX[index]!,
        world.posY[index]!,
      ),
    );
  }
  flushDestroys(world);

  world.tick++;
}

export function runTicks(loop: SimLoop, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(loop);
}

/** Drop consumed commands so a long-running session does not grow the array forever. */
export function compactLoop(loop: SimLoop): void {
  if (loop.cursor === 0) return;
  loop.pending.splice(0, loop.cursor);
  loop.cursor = 0;
}
