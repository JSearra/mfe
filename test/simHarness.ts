import { heightmapFrom, type Heightmap } from '../src/shared/heightmap.js';
import { createLoop, type SimLoop } from '../src/sim/loop.js';
import { createCattleSystem, type CattleSystem } from '../src/sim/cattle.js';
import { createMovementSystem, type MovementSystem } from '../src/sim/movement.js';
import { createWorld, type World } from '../src/sim/world.js';
import type { Command } from '../src/sim/commands.js';

/** A flat, fully walkable map. Terrain is not what most tests are about. */
export function flatMap(size: number, level = 0): Heightmap {
  return heightmapFrom(
    Array.from({ length: size }, () => Array.from({ length: size }, () => level)),
    8,
  );
}

export interface Harness {
  world: World;
  movement: MovementSystem;
  cattle: CattleSystem;
  loop: SimLoop;
  map: Heightmap;
}

export function makeSim(
  capacity = 64,
  seed = 1,
  map: Heightmap = flatMap(32),
  commands: readonly Command[] = [],
): Harness {
  const world = createWorld(capacity, seed);
  const movement = createMovementSystem(map);
  const cattle = createCattleSystem();
  return { world, movement, cattle, loop: createLoop(world, movement, cattle, commands), map };
}
