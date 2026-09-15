import { heightmapFrom, type Heightmap } from '../src/shared/heightmap.js';
import { createLoop, type SimLoop } from '../src/sim/loop.js';
import { createCattleSystem, type CattleSystem } from '../src/sim/cattle.js';
import { createCombatSystem, type CombatSystem } from '../src/sim/combat.js';
import { createTechState, type TechState } from '../src/sim/tech.js';
import { createVictoryState, type VictoryState } from '../src/sim/victory.js';
import { createProductionSystem, type ProductionSystem } from '../src/sim/production.js';
import { createConstructionSystem, type ConstructionSystem } from '../src/sim/construction.js';
import { createEconomy, type Economy } from '../src/sim/economy/ledger.js';
import { createWoodland, type Woodland } from '../src/sim/woodland.js';
import { createStartingFarmland } from '../src/sim/economy/plots.js';
import type { Farmland } from '../src/sim/economy/farmland.js';

import { createFog, type FogState } from '../src/sim/vision/fog.js';
import { FactionId } from '../src/shared/factions/index.js';
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
  combat: CombatSystem;
  construction: ConstructionSystem;
  production: ProductionSystem;
  economy: Economy;
  woodland: Woodland;
  farmland: Farmland;
  tech: TechState;
  victory: VictoryState;
  fog: FogState;
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
  const combat = createCombatSystem();
  const construction = createConstructionSystem(map, movement.pathing);
  const production = createProductionSystem(movement);
  const woodland = createWoodland(map, seed);
  const farmland = createStartingFarmland(map, [{ x: 8, y: 8 }, { x: 24, y: 24 }], seed);
  const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], seed);
  const tech = createTechState(2);
  const victory = createVictoryState(2);
  const fog = createFog(2, map);
  return {
    world,
    movement,
    cattle,
    combat,
    construction,
    production,
    economy,
    woodland,
    farmland,
    tech,
    victory,
    fog,
    loop: createLoop(
      { world, movement, cattle, combat, construction, production, economy, woodland, farmland, tech, victory, fog, map },
      commands,
    ),
    map,
  };
}
