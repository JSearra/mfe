import { applyCommand, compareCommands, type Command } from './commands.js';
import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import type { CattleSystem } from './cattle.js';
import type { Economy } from './economy/ledger.js';
import { updateFog, type FogState } from './vision/fog.js';
import type { Heightmap } from '../shared/heightmap.js';
import type { MovementSystem } from './movement.js';
import { flushDestroys, packHandle, type World } from './world.js';

export { TICK_HZ, TICK_MS } from '../shared/timing.js';

export interface SimLoop {
  readonly world: World;
  readonly movement: MovementSystem;
  readonly cattle: CattleSystem;
  readonly economy: Economy;
  readonly fog: FogState;
  readonly map: Heightmap;
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

export function createLoop(
  world: World,
  movement: MovementSystem,
  cattle: CattleSystem,
  economy: Economy,
  fog: FogState,
  map: Heightmap,
  commands: readonly Command[] = [],
): SimLoop {
  const pending = [...commands].sort(compareCommands);
  return {
    world,
    movement,
    cattle,
    economy,
    fog,
    map,
    pending,
    cursor: 0,
    dirty: false,
    lateCommands: 0,
    events: [],
  };
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
  const { world, movement, cattle, economy, fog, map, pending, events } = loop;

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
    applyCommand(world, command, events, movement, cattle);
    loop.cursor++;
  }

  movement.update(world);
  // Cattle read the grid movement just built, so they see this tick's unit positions.
  cattle.update(world, movement.grid, events);
  // Upkeep lands on exact tick multiples. It reads world.tick before the increment
  // below, so the first cycle is tick 200, not 199.
  economy.update(world, events);
  updateFog(world, map, fog);

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
    movement.forget(index);
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
