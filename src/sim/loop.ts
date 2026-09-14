import { applyCommand, compareCommands, type Command } from './commands.js';
import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import type { CattleSystem } from './cattle.js';
import type { CombatSystem } from './combat.js';
import type { ConstructionSystem } from './construction.js';
import type { ProductionSystem } from './production.js';
import type { VictoryState } from './victory.js';
import type { AiController } from './ai/opponent.js';
import { Modifier } from '../shared/tech/index.js';
import type { TechState } from './tech.js';
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
  readonly combat: CombatSystem;
  readonly construction: ConstructionSystem;
  readonly production: ProductionSystem;
  /** Computer players, each simply another source of commands. */
  readonly ai: { player: number; controller: AiController }[];
  readonly economy: Economy;
  readonly tech: TechState;
  readonly victory: VictoryState;
  readonly fog: FogState;
  readonly map: Heightmap;
  /** Sorted by (tick, playerId, seq) from `cursor` onward. */
  readonly pending: Command[];
  cursor: number;
  /** Set when a command arrives after sorting, so the tail is re-sorted before use. */
  dirty: boolean;
  /** Commands naming a tick already simulated. Non-zero means a bug upstream. */
  lateCommands: number;
  /** Sequence numbers for AI-issued commands, keeping their ordering total. */
  aiSequence: number;
  /** Drained by the host each pump. */
  readonly events: SimEvent[];
}

/**
 * Everything the loop drives.
 *
 * Named rather than positional. This was ten positional parameters of near-identical
 * shape, which is a transposition waiting to happen — swap two systems and the code
 * still compiles, still runs, and is quietly wrong. Adding one more was the point at
 * which that stopped being tolerable.
 */
export interface SimSystems {
  world: World;
  movement: MovementSystem;
  cattle: CattleSystem;
  combat: CombatSystem;
  construction: ConstructionSystem;
  production: ProductionSystem;
  economy: Economy;
  tech: TechState;
  victory: VictoryState;
  fog: FogState;
  map: Heightmap;
}

export function createLoop(systems: SimSystems, commands: readonly Command[] = []): SimLoop {
  const pending = [...commands].sort(compareCommands);
  return {
    ...systems,
    ai: [],
    pending,
    cursor: 0,
    dirty: false,
    lateCommands: 0,
    aiSequence: 0,
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
  const { world, movement, cattle, combat, construction, production, economy, tech, victory, fog, map, pending, events } =
    loop;

  // Computer players act first, through exactly the same queue a human's clicks use.
  // Nothing here reaches into world state — that invariant is what made an AI a day's
  // work rather than a second mutation path to keep in step.
  for (const { player, controller } of loop.ai) {
    controller.decide(world, fog, economy, tech, (command) => {
      enqueueCommand(loop, {
        tick: world.tick,
        playerId: player,
        seq: loop.aiSequence++,
        kind: command.kind as Command['kind'],
        a: command.a,
        b: command.b,
        c: command.c,
        d: command.d,
      });
    });
  }

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
    applyCommand(world, command, events, {
      movement,
      cattle,
      combat,
      construction,
      production,
      economy,
      tech,
    });
    loop.cursor++;
  }

  movement.update(world, tech);
  // Cattle read the grid movement just built, so they see this tick's unit positions.
  cattle.update(world, movement.grid, events, tech, movement.displace);
  // Upkeep lands on exact tick multiples. It reads world.tick before the increment
  // below, so the first cycle is tick 200, not 199.
  // Combat after movement and cattle, so a strike lands on where things ended up
  // this tick rather than where they started.
  construction.update(world, movement.grid, events);
  production.update(world, events);
  combat.update(world, movement.grid, economy, tech, events);
  economy.update(
    world,
    events,
    (owner) => construction.yieldFor(world, owner),
    (player) => tech.modifier(player, Modifier.GrainYield),
  );
  tech.update(world.tick, events);
  victory.update(world, economy, events);
  updateFog(world, map, fog, tech);

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
