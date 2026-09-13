import { applyCommand, compareCommands, type Command } from './commands.js';
import { tuning } from './tuning.js';
import { flushDestroys, integrate, type World } from './world.js';

/** Simulation rate. Fixed, and independent of render framerate. */
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;

export interface SimLoop {
  readonly world: World;
  /** Command log, sorted by (tick, playerId, seq). */
  readonly log: readonly Command[];
  cursor: number;
  /** Commands that arrived naming a tick already simulated. Non-zero means a bug upstream. */
  lateCommands: number;
}

export function createLoop(world: World, commands: readonly Command[]): SimLoop {
  const log = [...commands].sort(compareCommands);
  return { world, log, cursor: 0, lateCommands: 0 };
}

/**
 * Advance exactly one tick.
 *
 * Order matters and is fixed: commands, then systems, then the destroy flush. Systems
 * therefore see a stable entity set for the whole tick, and anything destroyed during
 * it survives until the boundary.
 */
export function step(loop: SimLoop): void {
  const { world, log } = loop;
  const { dt, damping, maxSpeed, wanderStrength } = tuning.movement;

  while (loop.cursor < log.length) {
    const command = log[loop.cursor]!;
    if (command.tick > world.tick) break;
    if (command.tick < world.tick) loop.lateCommands++;
    applyCommand(world, command);
    loop.cursor++;
  }

  integrate(world, dt, damping, maxSpeed, wanderStrength);
  flushDestroys(world);

  world.tick++;
}

export function runTicks(loop: SimLoop, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(loop);
}
