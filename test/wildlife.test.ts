import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/shared/events.js';
import { heightmapFrom, heightmapWithWater, isWater, type Heightmap } from '../src/shared/heightmap.js';
import { derivePassability } from '../src/shared/passability.js';
import { SPECIES, Species, speciesInfo, Habitat, isQuarry } from '../src/shared/wildlife.js';
import { createMovementSystem } from '../src/sim/movement.js';
import { createSpatialGrid, type SpatialGrid } from '../src/sim/spatial/grid.js';
import { largestRegion } from '../src/sim/terrain/placement.js';
import { tuning } from '../src/sim/tuning.js';
import {
  createWildlifeSystem,
  fleeRadiusOf,
  planWildlife,
  rangeAt,
  spawnWild,
  speciesTuning,
} from '../src/sim/wildlife.js';
import { createWorld, EntityKind, handleIndex, spawn, type World } from '../src/sim/world.js';

/**
 * Game on the veld (ADR-0022).
 *
 * The rules that make a hunt a stalk rather than a chase — game bolts from people inside
 * its flight distance, faster than they can follow — and the ones that keep it on the
 * map: it holds to its band and its range, breeds back slowly, and never walks into a
 * river, up a cliff or off the edge. The last is tested on ground that HAS a river and a
 * cliff in it, because a world without the constraint cannot see it broken (CLAUDE.md).
 */

const SIZE = 48;

const flat = (): Heightmap =>
  heightmapFrom(Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 2)), 8);

/** Flat ground with a river down column 20 and a cliff wall down column 32. */
function riverAndCliff(): Heightmap {
  const rows = Array.from({ length: SIZE }, () =>
    Array.from({ length: SIZE }, (_, x) => (x === 20 ? 0 : x >= 32 ? 6 : 2)),
  );
  const wet = rows.map((row) => row.map((_, x) => (x === 20 ? 1 : 0)));
  return heightmapWithWater(rows, 8, wet);
}

function rebuild(world: World, grid: SpatialGrid): void {
  grid.clear();
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] === 1) grid.insert(i, world.posX[i]!, world.posY[i]!);
  }
}

function makeVeld(map: Heightmap = flat()) {
  const world = createWorld(512, 99);
  const grid = createSpatialGrid(map.width, map.height, 2);
  const wildlife = createWildlifeSystem(map);
  const { displace } = createMovementSystem(map);
  const events: SimEvent[] = [];
  const tick = (): void => {
    rebuild(world, grid);
    events.length = 0;
    wildlife.update(world, grid, events, displace);
    world.tick++;
  };
  return { world, tick, events, map };
}

function distance(world: World, a: number, x: number, y: number): number {
  const dx = world.posX[a]! - x;
  const dy = world.posY[a]! - y;
  return Math.sqrt(dx * dx + dy * dy);
}

describe('the catalogue', () => {
  it('lists every species at its own value, with tuning for each', () => {
    SPECIES.forEach((info, index) => {
      expect(info.species).toBe(index);
      expect(speciesTuning(info.species)).toBeDefined();
    });
  });

  it('asks the owner\'s roster for: elephant, kudu and impala among the game', () => {
    for (const species of [Species.Elephant, Species.Kudu, Species.Impala]) expect(isQuarry(species)).toBe(true);
  });

  it('never makes a predator or scenery quarry', () => {
    for (const species of [Species.Lion, Species.Leopard, Species.Hyena, Species.GuineaFowl, Species.Ostrich, Species.Baboon]) {
      expect(isQuarry(species)).toBe(false);
    }
  });

  it('pays far more for big game than small, and ivory only from the ones that carry it', () => {
    expect(speciesTuning(Species.Elephant).meat).toBeGreaterThan(speciesTuning(Species.Impala).meat * 5);
    expect(speciesTuning(Species.Elephant).ivory).toBeGreaterThan(0);
    expect(speciesTuning(Species.Impala).ivory).toBe(0);
  });

  it('makes most hunts fail', () => {
    for (const info of SPECIES) if (isQuarry(info.species)) expect(speciesTuning(info.species).huntChance).toBeLessThan(0.35);
  });
});

describe('an animal', () => {
  it('is a neutral Wild entity of its species and band', () => {
    const { world } = makeVeld();
    const handle = spawnWild(world, 10, 10, Species.Kudu, 7);
    const index = handleIndex(handle);
    expect(world.kind[index]).toBe(EntityKind.Wild);
    expect(world.species[index]).toBe(Species.Kudu);
    expect(world.band[index]).toBe(7);
    expect(world.faction[index]).toBe(2);
  });

  it('bolts from a person inside its flight distance, faster than a person walks', () => {
    const { world, tick } = makeVeld();
    const impala = handleIndex(spawnWild(world, 24, 24, Species.Impala, 1));
    const flee = fleeRadiusOf(Species.Impala);
    spawn(world, 24 - flee * 0.6, 24, 0);

    const before = distance(world, impala, 24 - flee * 0.6, 24);
    for (let t = 0; t < 40; t++) tick(); // two seconds
    const after = distance(world, impala, 24 - flee * 0.6, 24);

    // A person walks 3 tiles a second; the impala put more than that between them.
    expect(after - before).toBeGreaterThan(tuning.movement.maxSpeed * 2);
  });

  it('ignores a person outside its flight distance', () => {
    const { world, tick } = makeVeld();
    const kudu = handleIndex(spawnWild(world, 24, 24, Species.Kudu, 1));
    spawn(world, 24 - fleeRadiusOf(Species.Kudu) - 3, 24, 0);
    for (let t = 0; t < 40; t++) tick();
    // Grazing, not running: it has not gone far.
    expect(distance(world, kudu, 24, 24)).toBeLessThan(2);
  });

  it('is not frightened by one person if it is a predator', () => {
    const { world, tick } = makeVeld();
    const lion = handleIndex(spawnWild(world, 24, 24, Species.Lion, 1));
    spawn(world, 22, 24, 0);
    for (let t = 0; t < 40; t++) tick();
    expect(distance(world, lion, 24, 24)).toBeLessThan(2);
  });
});

describe('a band', () => {
  it('keeps together and near its range over a long spell', () => {
    const { world, tick } = makeVeld();
    const members: number[] = [];
    for (let n = 0; n < 8; n++) members.push(handleIndex(spawnWild(world, 24 + (n % 3), 24 + Math.floor(n / 3), Species.Zebra, 3)));
    for (let t = 0; t < 2400; t++) tick(); // two minutes of grazing

    const range = rangeAt(3, 24, 24, world.tick);
    for (const member of members) {
      expect(distance(world, member, range.x, range.y)).toBeLessThan(tuning.wildlife.rangeRadius + 6);
    }
  });

  it('breeds back toward full strength, and never past it', () => {
    const { world, tick } = makeVeld();
    const s = speciesTuning(Species.Warthog);
    spawnWild(world, 24, 24, Species.Warthog, 5);
    // Warthogs only: over this long a spell, species absent from the map return to it
    // from an edge, which is a different rule with its own test below.
    const count = (): number => {
      let n = 0;
      for (let i = 0; i < world.capacity; i++) {
        if (world.alive[i] === 1 && world.kind[i] === EntityKind.Wild && world.species[i] === Species.Warthog) n++;
      }
      return n;
    };
    for (let t = 0; t < tuning.wildlife.birthEveryTicks * 20 + 1; t++) tick();
    expect(count()).toBeGreaterThan(1);
    expect(count()).toBeLessThanOrEqual(s.bandMax);
  });
});

describe('a species hunted off the map', () => {
  it('returns from an edge on the long cycle — but never to a map without its country', () => {
    const { world, tick } = makeVeld(flat());
    const kinds = new Set<number>();
    for (let t = 0; t <= tuning.wildlife.returnAfterTicks; t++) tick();
    for (let i = 0; i < world.capacity; i++) if (world.alive[i] === 1) kinds.add(world.species[i]!);
    expect(kinds.has(Species.Zebra)).toBe(true);
    // The flat test ground has no water.
    expect(kinds.has(Species.Hippo)).toBe(false);
    expect(kinds.has(Species.Buffalo)).toBe(false);
  });
});

describe('the terrain', () => {
  it('holds: no animal ever stands in the river, beyond the cliff or off the map', () => {
    const map = riverAndCliff();
    const flags = derivePassability(map);
    const { world, tick } = makeVeld(map);
    // Game between the river and the cliff, and a line of people driving it at each.
    for (let n = 0; n < 10; n++) spawnWild(world, 24 + (n % 4), 16 + n * 1.5, Species.Impala, 1);
    for (let n = 0; n < 6; n++) spawn(world, 27, 14 + n * 4, 0);

    for (let t = 0; t < 1200; t++) {
      tick();
      for (let i = 0; i < world.capacity; i++) {
        if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Wild) continue;
        const x = Math.floor(world.posX[i]!);
        const y = Math.floor(world.posY[i]!);
        expect(x >= 0 && y >= 0 && x < SIZE && y < SIZE).toBe(true);
        expect(isWater(map, x, y)).toBe(false);
        expect(x).toBeLessThan(32);
        expect(flags[y * SIZE + x]).not.toBe(0);
      }
    }
  });
});

describe('determinism', () => {
  it('runs the same twice', () => {
    const run = (): number[] => {
      const { world, tick } = makeVeld(riverAndCliff());
      for (let n = 0; n < 12; n++) spawnWild(world, 10 + n, 10 + (n % 4), n % 3 === 0 ? Species.Zebra : Species.Impala, 1 + (n % 3));
      spawn(world, 14, 12, 0);
      for (let t = 0; t < tuning.wildlife.birthEveryTicks + 400; t++) tick();
      const out: number[] = [];
      for (let i = 0; i < world.capacity; i++) if (world.alive[i] === 1) out.push(world.posX[i]!, world.posY[i]!);
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('the opening', () => {
  const map = riverAndCliff();
  const walkable = largestRegion(map);
  const village = { x: 10, y: 10 };
  const plan = planWildlife(map, 1234, village, walkable);

  it('puts game on the map', () => {
    expect(plan.length).toBeGreaterThan(20);
  });

  it('keeps it out of the water and clear of the village', () => {
    const clear = tuning.wildlife.clearOfVillage - tuning.wildlife.bandSpread - 1;
    for (const animal of plan) {
      expect(isWater(map, Math.floor(animal.x), Math.floor(animal.y))).toBe(false);
      const dx = animal.x - village.x;
      const dy = animal.y - village.y;
      expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(clear);
    }
  });

  it('puts water-loving game only near water, and none on a dry map', () => {
    for (const animal of plan) {
      if (speciesInfo(animal.species).habitat !== Habitat.Water) continue;
      let near = false;
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (isWater(map, Math.floor(animal.x) + dx, Math.floor(animal.y) + dy)) near = true;
      expect(near).toBe(true);
    }
    const dry = flat();
    const dryPlan = planWildlife(dry, 1234, village, largestRegion(dry));
    expect(dryPlan.some((animal) => animal.species === Species.Hippo)).toBe(false);
  });

  it('is the same every time for the same map and seed', () => {
    expect(planWildlife(map, 1234, village, walkable)).toEqual(plan);
  });
});
