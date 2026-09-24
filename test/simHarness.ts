import { heightmapFrom, type Heightmap } from '../src/shared/heightmap.js';
import { createLoop, type SimLoop } from '../src/sim/loop.js';
import { createCattleSystem, type CattleSystem } from '../src/sim/cattle.js';
import { createTechState, type TechState } from '../src/sim/tech.js';
import { createCensus, type Census } from '../src/sim/census.js';
import { createLabour, type Labour } from '../src/sim/labour.js';
import { createProductionSystem, type ProductionSystem } from '../src/sim/production.js';
import {
  createConstructionSystem,
  PlacementResult,
  type ConstructionSystem,
} from '../src/sim/construction.js';
import { BuildingType } from '../src/shared/buildings/index.js';
import { createEconomy, type Economy } from '../src/sim/economy/ledger.js';
import { createWoodland, type Woodland } from '../src/sim/woodland.js';
import { createAlliance, type Alliance } from '../src/sim/alliance.js';
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
  construction: ConstructionSystem;
  production: ProductionSystem;
  economy: Economy;
  woodland: Woodland;
  farmland: Farmland;
  alliance: Alliance;
  tech: TechState;
  census: Census;
  labour: Labour;
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
  const construction = createConstructionSystem(map, movement.pathing);
  const production = createProductionSystem(movement);
  const woodland = createWoodland(map, seed);
  const farmland = createStartingFarmland(map, [{ x: 8, y: 8 }, { x: 24, y: 24 }], seed);
  const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], seed);
  const tech = createTechState(2);
  const census = createCensus(2);
  const labour = createLabour(2);
  const fog = createFog(2, map);
  const alliance = createAlliance(2);
  return {
    world,
    movement,
    cattle,
    construction,
    production,
    economy,
    woodland,
    farmland,
    alliance,
    tech,
    census,
    labour,
    fog,
    loop: createLoop(
      { world, movement, cattle, construction, production, economy, woodland, farmland, alliance, tech, census, labour, fog, map },
      commands,
    ),
    map,
  };
}

/**
 * Found a homestead near a start, already standing — the way main.ts opens a match.
 *
 * Work finds its own people only near a village's dwellings (src/sim/labour.ts), so a
 * harness that spawns villagers and no homestead has people nothing will ever put to
 * work. That is a ledger with a crowd in it, not the game — see the rule on seeding a
 * starting force in CLAUDE.md. Searches outward for ground flat enough to take it.
 */
export function foundHomestead(
  sim: Harness,
  owner: number,
  x: number,
  y: number,
  type: number = BuildingType.Umuzi,
): boolean {
  for (let ring = 2; ring < 12; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const result = sim.construction.place(
          sim.world,
          sim.economy,
          owner,
          type as BuildingType,
          Math.floor(x) + dx,
          Math.floor(y) + dy,
          [],
          true,
        );
        if (result === PlacementResult.Placed) return true;
      }
    }
  }
  return false;
}
