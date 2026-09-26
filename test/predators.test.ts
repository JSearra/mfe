import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { heightmapFrom, type Heightmap } from '../src/shared/heightmap.js';
import { Species } from '../src/shared/wildlife.js';
import { createCattleSystem } from '../src/sim/cattle.js';
import { idleOf } from '../src/sim/labour.js';
import { createMovementSystem } from '../src/sim/movement.js';
import { createSpatialGrid, type SpatialGrid } from '../src/sim/spatial/grid.js';
import { tuning } from '../src/sim/tuning.js';
import { createWildlifeSystem, spawnWild } from '../src/sim/wildlife.js';
import {
  createWorld,
  EntityKind,
  flushDestroys,
  handleIndex,
  NULL_HANDLE,
  spawn,
  type World,
} from '../src/sim/world.js';

/**
 * Predators (ADR-0022): they take cattle and game, they maul a person caught alone, and
 * enough people together turn them. A mauling lays somebody up; it never kills.
 */

const P = tuning.wildlife.predators;
const SIZE = 64;
/** Long enough to cover a full hunting window whatever the band's clock. */
const A_HUNT = P.huntEveryTicks + P.huntWindowTicks;

const flat = (): Heightmap =>
  heightmapFrom(Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 2)), 8);

function rebuild(world: World, grid: SpatialGrid): void {
  grid.clear();
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] === 1) grid.insert(i, world.posX[i]!, world.posY[i]!);
  }
}

function makeVeld(withCattle = false) {
  const map = flat();
  const world = createWorld(256, 7);
  const grid = createSpatialGrid(SIZE, SIZE, 2);
  const wildlife = createWildlifeSystem(map);
  const cattle = createCattleSystem();
  const movement = createMovementSystem(map);
  const all: SimEvent[] = [];
  const events: SimEvent[] = [];
  const tick = (): void => {
    rebuild(world, grid);
    events.length = 0;
    if (withCattle) cattle.update(world, grid, events, undefined, movement.displace);
    wildlife.update(world, grid, events, movement.displace);
    all.push(...events);
    world.tick++;
    flushDestroys(world);
  };
  return { world, tick, all, movement };
}

describe('a predator', () => {
  it('takes a cow it can reach, and says so', () => {
    const { world, tick, all } = makeVeld();
    spawnWild(world, 20, 20, Species.Lion, 1);
    const cow = spawn(world, 28, 20, 2, 1, EntityKind.Cattle);
    for (let t = 0; t < A_HUNT && world.alive[handleIndex(cow)] === 1; t++) tick();
    expect(world.alive[handleIndex(cow)]).toBe(0);
    const kill = all.find((e) => e.type === EventType.PredatorKill);
    expect(kill?.payload).toBe(1);
  });

  it('terrifies the herd around the kill', () => {
    const { world, tick } = makeVeld();
    spawnWild(world, 20, 20, Species.Lion, 1);
    spawn(world, 27, 20, 2, 1, EntityKind.Cattle);
    const witness = handleIndex(spawn(world, 31, 22, 2, 1, EntityKind.Cattle));
    let peak = 0;
    for (let t = 0; t < A_HUNT; t++) {
      tick();
      peak = Math.max(peak, world.stress[witness]!);
    }
    expect(peak).toBeGreaterThanOrEqual(P.panicStress);
  });

  it('does not take what it cannot bring down: a leopard leaves an eland alone', () => {
    const { world, tick } = makeVeld();
    spawnWild(world, 20, 20, Species.Leopard, 1);
    const eland = spawnWild(world, 25, 20, Species.Eland, 2);
    for (let t = 0; t < A_HUNT; t++) tick();
    expect(world.alive[handleIndex(eland)]).toBe(1);
  });

  it('is turned by enough people together, gives up the hunt, and the village is told', () => {
    const { world, tick, all } = makeVeld();
    const lion = handleIndex(spawnWild(world, 30, 30, Species.Lion, 1));
    const cow = handleIndex(spawn(world, 30, 40, 2, 1, EntityKind.Cattle));
    // Caught mid-stalk, with three people standing close.
    world.quarry[lion] = ((world.generation[cow]! << 24) | cow) >>> 0;
    for (let n = 0; n < P.crowdToDriveOff; n++) spawn(world, 30 + n - 1, 32, 0);
    tick();
    expect(world.quarry[lion]).toBe(NULL_HANDLE);
    expect(all.some((e) => e.type === EventType.DrivenOff)).toBe(true);
    // And it does not come back through them for the cow.
    for (let t = 0; t < A_HUNT; t++) tick();
    expect(world.alive[cow]).toBe(1);
  });

  it('is not turned by two', () => {
    const { world, tick, all } = makeVeld();
    const lion = handleIndex(spawnWild(world, 30, 30, Species.Lion, 1));
    const cow = handleIndex(spawn(world, 30, 40, 2, 1, EntityKind.Cattle));
    world.quarry[lion] = ((world.generation[cow]! << 24) | cow) >>> 0;
    for (let n = 0; n < P.crowdToDriveOff - 1; n++) spawn(world, 30 + n, 32, 0);
    tick();
    expect(all.some((e) => e.type === EventType.DrivenOff)).toBe(false);
  });

  it('maul a person alone now and then — and never kills them', () => {
    let mauled = 0;
    for (let trial = 0; trial < 12; trial++) {
      const { world, tick, all } = makeVeld();
      spawnWild(world, 20, 20, Species.Lion, trial + 1);
      const person = handleIndex(spawn(world, 21.5, 20, 0));
      for (let t = 0; t < A_HUNT; t++) {
        tick();
        expect(world.alive[person]).toBe(1);
        expect(world.hp[person]).toBeGreaterThanOrEqual(1);
      }
      if (all.some((e) => e.type === EventType.Mauled)) mauled++;
    }
    // A small chance, not a certainty and not never.
    expect(mauled).toBeGreaterThan(0);
    expect(mauled).toBeLessThan(12);
  });
});

describe('game', () => {
  it('grazes beside a predator at rest', () => {
    const { world, tick } = makeVeld();
    const lion = handleIndex(spawnWild(world, 20, 20, Species.Lion, 1));
    const impala = handleIndex(spawnWild(world, 24, 20, Species.Impala, 2));
    // Sated, so it is not hunting whatever its clock says.
    world.sated[lion] = 400;
    for (let t = 0; t < 200; t++) tick();
    expect(Math.abs(world.posX[impala]! - 24)).toBeLessThan(3);
    expect(world.quarry[lion]).toBe(NULL_HANDLE);
  });

  it('runs from one on the hunt', () => {
    const { world, tick } = makeVeld();
    const lion = handleIndex(spawnWild(world, 20, 20, Species.Lion, 1));
    const impala = handleIndex(spawnWild(world, 24, 20, Species.Impala, 2));
    // Through a whole hunting window: once the lion is stalking, the impala bolts.
    let fledWhileHunted = false;
    for (let t = 0; t < A_HUNT && !fledWhileHunted; t++) {
      tick();
      if (world.quarry[lion] !== NULL_HANDLE && world.stampedeTicks[impala]! > 0) fledWhileHunted = true;
    }
    expect(fledWhileHunted).toBe(true);
  });
});

describe('a mauled person', () => {
  function mauledPerson() {
    const veld = makeVeld();
    const person = handleIndex(spawn(veld.world, 10, 10, 0));
    veld.world.injured[person] = P.injuredTicks;
    return { ...veld, person };
  }

  it('takes no orders while laid up', () => {
    const { world, movement, person } = mauledPerson();
    const handle = (world.generation[person]! << 24) | person;
    expect(movement.order(world, handle >>> 0, 20, 20)).toBe(false);
  });

  it('is not counted as a free pair of hands', () => {
    const { world, person } = mauledPerson();
    expect(world.injured[person]).toBeGreaterThan(0);
    expect(idleOf(world, 0)).toBe(0);
  });

  it('mends, and can be sent again', () => {
    const { world, tick, movement, person } = mauledPerson();
    for (let t = 0; t < P.injuredTicks; t++) tick();
    expect(world.injured[person]).toBe(0);
    const handle = (world.generation[person]! << 24) | person;
    expect(movement.order(world, handle >>> 0, 20, 20)).toBe(true);
  });
});

describe('cattle', () => {
  /** A cow's peak stress with something pinned 2.5 tiles off it for two seconds. */
  function peakStress(what: 'lion' | 'stranger' | 'resting lion'): number {
    const { world, tick } = makeVeld(true);
    const cow = handleIndex(spawn(world, 30, 30, 2, 1, EntityKind.Cattle));
    const other =
      what === 'stranger' ? handleIndex(spawn(world, 32.5, 30, 1)) : handleIndex(spawnWild(world, 32.5, 30, Species.Lion, 1));
    let peak = 0;
    for (let t = 0; t < 40; t++) {
      if (what === 'lion') world.quarry[other] = (world.generation[cow]! << 24) | cow;
      if (what === 'resting lion') world.sated[other] = 100;
      world.posX[other] = world.posX[cow]! + 2.5;
      world.posY[other] = world.posY[cow]!;
      tick();
      peak = Math.max(peak, world.stress[cow]!);
    }
    return peak;
  }

  it('fear a hunting predator more than a stranger at the same distance', () => {
    expect(peakStress('lion')).toBeGreaterThan(peakStress('stranger') * 1.5);
  });

  it('pay no mind to one at rest', () => {
    expect(peakStress('resting lion')).toBe(0);
  });
});

