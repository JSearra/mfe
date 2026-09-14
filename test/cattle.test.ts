import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { createCattleSystem } from '../src/sim/cattle.js';
import { createMovementSystem } from '../src/sim/movement.js';
import { createSpatialGrid, type SpatialGrid } from '../src/sim/spatial/grid.js';
import { heightmapFrom } from '../src/shared/heightmap.js';
import { tuning } from '../src/sim/tuning.js';
import {
  EntityKind,
  HerdState,
  createWorld,
  handleIndex,
  spawn,
  type World,
} from '../src/sim/world.js';

const C = tuning.cattle;

const flat = (width: number, height: number) =>
  heightmapFrom(Array.from({ length: height }, () => Array.from({ length: width }, () => 0)), 8);

/** Open ground for the tests that are not about terrain at all. */
const openGround = createMovementSystem(flat(64, 64)).displace;

/** Flat ground with one unclimbable column of high tiles at `atX`. */
const withCliff = (width: number, height: number, atX: number) =>
  heightmapFrom(
    Array.from({ length: height }, () =>
      Array.from({ length: width }, (_, x) => (x === atX ? 7 : 0)),
    ),
    8,
  );

function rebuild(world: World, grid: SpatialGrid): void {
  grid.clear();
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] === 1) grid.insert(i, world.posX[i]!, world.posY[i]!);
  }
}

function makeHerd(cows: number, originX = 10, originY = 10) {
  const world = createWorld(128, 4242);
  const grid = createSpatialGrid(64, 64, 2);
  const cattle = createCattleSystem();
  const events: SimEvent[] = [];

  const handles: number[] = [];
  for (let i = 0; i < cows; i++) {
    handles.push(
      spawn(world, originX + (i % 5) * 0.7, originY + Math.floor(i / 5) * 0.7, 0, 1, EntityKind.Cattle),
    );
  }
  const tick = () => {
    rebuild(world, grid);
    cattle.update(world, grid, events, undefined, openGround);
    world.tick++;
  };
  return { world, grid, cattle, events, handles, tick };
}

describe('flocking', () => {
  // Boids integrated once per 50ms tick oscillate rather than settle. Substepping and
  // the acceleration clamp are what this asserts.
  it('settles a leashed herd without oscillating around the herder', () => {
    const { world, cattle, handles, tick } = makeHerd(12, 20, 20);
    const herder = spawn(world, 10, 10, 0);

    for (const cow of handles) expect(cattle.leash(world, herder, cow)).toBe(true);

    const distances: number[] = [];
    for (let t = 0; t < 400; t++) {
      tick();
      let total = 0;
      for (const cow of handles) {
        const i = handleIndex(cow);
        const dx = world.posX[i]! - 10;
        const dy = world.posY[i]! - 10;
        total += Math.sqrt(dx * dx + dy * dy);
      }
      distances.push(total / handles.length);
    }

    // It closed the distance...
    expect(distances[0]!).toBeGreaterThan(C.leashRadius);
    const settled = distances.slice(-120);
    const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
    expect(mean).toBeLessThan(C.leashRadius + 1.5);

    // ...and then stayed there. Oscillation would show as a large late swing.
    const swing = Math.max(...settled) - Math.min(...settled);
    expect(swing).toBeLessThan(1.0);
  });

  it('keeps a grazing herd together but not stacked', () => {
    const { world, handles, tick } = makeHerd(16, 30, 30);
    for (let t = 0; t < 300; t++) tick();

    let closest = Infinity;
    let farthest = 0;
    for (let a = 0; a < handles.length; a++) {
      for (let b = a + 1; b < handles.length; b++) {
        const i = handleIndex(handles[a]!);
        const j = handleIndex(handles[b]!);
        const dx = world.posX[i]! - world.posX[j]!;
        const dy = world.posY[i]! - world.posY[j]!;
        const distance = Math.sqrt(dx * dx + dy * dy);
        closest = Math.min(closest, distance);
        farthest = Math.max(farthest, distance);
      }
    }
    // Separation holds them apart; cohesion stops the herd dispersing.
    expect(closest).toBeGreaterThan(0.2);
    expect(farthest).toBeLessThan(14);
  });
});

describe('stress', () => {
  it('rises under sustained threat and falls without one', () => {
    const { world, handles, tick } = makeHerd(1, 10, 10);
    const cow = handleIndex(handles[0]!);
    const herder = spawn(world, 10.8, 10, 0);
    const herderIndex = handleIndex(herder);

    const rising: number[] = [];
    for (let t = 0; t < 25; t++) {
      tick();
      rising.push(world.stress[cow]!);
      // Hold the herder on top of the cow, whatever the cow does.
      world.posX[herderIndex] = world.posX[cow]! + 0.8;
      world.posY[herderIndex] = world.posY[cow]!;
    }
    for (let i = 1; i < rising.length; i++) {
      expect(rising[i]!).toBeGreaterThanOrEqual(rising[i - 1]!);
    }
    expect(rising[rising.length - 1]!).toBeGreaterThan(rising[0]!);

    // Remove the threat entirely.
    world.alive[herderIndex] = 0;
    const peak = world.stress[cow]!;
    for (let t = 0; t < 40; t++) tick();
    expect(world.stress[cow]!).toBeLessThan(peak);
  });

  it('never leaves the range', () => {
    const { world, handles, tick } = makeHerd(1, 10, 10);
    const cow = handleIndex(handles[0]!);
    const herder = spawn(world, 10.2, 10, 0);
    const herderIndex = handleIndex(herder);

    for (let t = 0; t < 300; t++) {
      tick();
      world.posX[herderIndex] = world.posX[cow]! + 0.2;
      world.posY[herderIndex] = world.posY[cow]!;
      expect(world.stress[cow]!).toBeGreaterThanOrEqual(0);
      expect(world.stress[cow]!).toBeLessThanOrEqual(C.stressMax);
    }
  });
});

describe('herding', () => {
  it('leashes and releases', () => {
    const { world, cattle, handles } = makeHerd(1);
    const cow = handles[0]!;
    const herder = spawn(world, 12, 12, 0);

    expect(cattle.leash(world, herder, cow)).toBe(true);
    expect(world.herdState[handleIndex(cow)]).toBe(HerdState.Leashed);

    cattle.release(world, cow);
    expect(world.herdState[handleIndex(cow)]).toBe(HerdState.Grazing);
  });

  it('refuses to leash a unit, or a beast already stampeding', () => {
    const { world, cattle, handles } = makeHerd(1);
    const herder = spawn(world, 12, 12, 0);
    const otherUnit = spawn(world, 13, 13, 0);

    expect(cattle.leash(world, herder, otherUnit)).toBe(false);

    world.herdState[handleIndex(handles[0]!)] = HerdState.Stampeding;
    expect(cattle.leash(world, herder, handles[0]!)).toBe(false);
  });

  it('drops the tether when the herder dies', () => {
    const { world, cattle, handles, tick } = makeHerd(1);
    const herder = spawn(world, 12, 12, 0);
    cattle.leash(world, herder, handles[0]!);

    world.alive[handleIndex(herder)] = 0;
    tick();
    expect(world.herdState[handleIndex(handles[0]!)]).toBe(HerdState.Grazing);
  });
});

describe('panic spreads', () => {
  /**
   * Contagion is what makes the word "stampede" accurate. Before it existed, chasing a
   * herd saturated exactly one animal at a time however hard it was pressed — measured
   * at every herd spacing from 0.9 to 1.8 and identical at all of them, so it was the
   * stress model rather than the packing. See ADR-0017.
   */
  function bolt(world: World, index: number): void {
    world.herdState[index] = HerdState.Stampeding;
    world.stress[index] = C.stressMax;
    world.stampedeTicks[index] = C.stampedeTicks;
    world.velX[index] = C.stampedeSpeed * 0.7;
    world.velY[index] = C.stampedeSpeed * 0.7;
  }

  function stampeding(world: World, handles: readonly number[]): number {
    let n = 0;
    for (const handle of handles) {
      if (world.herdState[handleIndex(handle)] === HerdState.Stampeding) n++;
    }
    return n;
  }

  it('does not cascade through a calm herd', () => {
    const { world, handles, tick } = makeHerd(20, 20, 20);
    for (let t = 0; t < 60; t++) tick();

    bolt(world, handleIndex(handles[10]!));
    for (let t = 0; t < 200; t++) tick();

    // The single most important property here. If a calm herd catches one animal's
    // panic, there is no state in which a player can work among cattle at all, and the
    // herd becomes a powder keg rather than a thing to be handled.
    expect(stampeding(world, handles)).toBeLessThanOrEqual(1);
  });

  it('cascades through a herd that is already frightened', () => {
    const { world, handles, tick } = makeHerd(20, 20, 20);
    for (let t = 0; t < 60; t++) tick();

    // Wound the whole herd up short of bolting, as sustained pressure would.
    for (const handle of handles) {
      world.stress[handleIndex(handle)] = C.stressMax * 0.85;
    }
    bolt(world, handleIndex(handles[10]!));
    for (let t = 0; t < 120; t++) tick();

    // The cascade turns on stress, which the player controls by how closely they work
    // the herd and can see in the stress rings — rather than on herd geometry, which
    // they can neither see nor influence. An earlier shallower curve turned on geometry
    // and gave anywhere from 1 to 23 of 30 on identical input.
    expect(stampeding(world, handles)).toBeGreaterThan(4);
  });
});

describe('stampede', () => {
  function panic(world: World, cowIndex: number, headingX: number, headingY: number): void {
    world.herdState[cowIndex] = HerdState.Stampeding;
    world.stress[cowIndex] = C.stressMax;
    world.stampedeTicks[cowIndex] = C.stampedeTicks;
    world.velX[cowIndex] = headingX * C.stampedeSpeed;
    world.velY[cowIndex] = headingY * C.stampedeSpeed;
  }

  it('triggers when stress saturates, and announces it', () => {
    const { world, events, handles, tick } = makeHerd(1, 10, 10);
    const cow = handleIndex(handles[0]!);
    const herder = spawn(world, 10.3, 10, 0);
    const herderIndex = handleIndex(herder);

    for (let t = 0; t < 400; t++) {
      tick();
      world.posX[herderIndex] = world.posX[cow]! + 0.3;
      world.posY[herderIndex] = world.posY[cow]!;
      if (world.herdState[cow] === HerdState.Stampeding) break;
    }

    expect(world.herdState[cow]).toBe(HerdState.Stampeding);
    expect(events.some((e) => e.type === EventType.StampedeBegan)).toBe(true);
  });

  it('runs away from the threat, not toward it', () => {
    const { world, handles, tick } = makeHerd(1, 20, 20);
    const cow = handleIndex(handles[0]!);
    const herder = spawn(world, 19, 20, 0); // to the west

    world.stress[cow] = C.stressMax;
    tick();
    for (let t = 0; t < 20; t++) {
      world.posX[handleIndex(herder)] = 19;
      world.posY[handleIndex(herder)] = 20;
      tick();
    }
    // Driven east, away from the herder.
    expect(world.posX[cow]!).toBeGreaterThan(20);
  });

  // A cow at full speed covers more ground per tick than its crush radius, so a
  // position check misses people it ran straight over.
  it('crushes at every sub-tile offset along its path', () => {
    const travelPerTick = C.stampedeSpeed * tuning.movement.dt;
    expect(travelPerTick).toBeGreaterThan(C.crushRadius);

    for (let offset = 0; offset <= 1; offset += 0.05) {
      const world = createWorld(16, 7);
      const grid = createSpatialGrid(64, 64, 2);
      const cattle = createCattleSystem();
      const events: SimEvent[] = [];

      const cow = spawn(world, 10, 10, 0, 1, EntityKind.Cattle);
      const cowIndex = handleIndex(cow);
      panic(world, cowIndex, 1, 0);

      // Directly on the swept line, at a fraction of this tick's travel.
      const victim = spawn(world, 10 + travelPerTick * offset, 10, 1);
      const victimIndex = handleIndex(victim);
      const hpBefore = world.hp[victimIndex]!;

      rebuild(world, grid);
      cattle.update(world, grid, events, undefined, openGround);

      expect(world.hp[victimIndex]!, `offset ${offset.toFixed(2)}`).toBeLessThan(hpBefore);
      expect(cattle.stats.crushes, `offset ${offset.toFixed(2)}`).toBeGreaterThan(0);
    }
  });

  it('knocks the victim along the charge', () => {
    const world = createWorld(16, 7);
    const grid = createSpatialGrid(64, 64, 2);
    const cattle = createCattleSystem();

    const cow = spawn(world, 10, 10, 0, 1, EntityKind.Cattle);
    panic(world, handleIndex(cow), 1, 0);
    const victim = spawn(world, 10.2, 10, 1);
    const victimIndex = handleIndex(victim);

    rebuild(world, grid);
    cattle.update(world, grid, [], undefined, openGround);
    expect(world.posX[victimIndex]!).toBeGreaterThan(10.2);
  });

  it('cannot stampede off the edge of the map', () => {
    // Cattle move themselves: movement.update skips everything that is not a Unit, and
    // this file knew nothing about terrain. A charge at the edge simply kept going —
    // measured at x=24 on a 16-wide map, and still accelerating. Cattle are the victory
    // condition, so a herd that leaves the map takes the match with it.
    const map = flat(16, 16);
    const movement = createMovementSystem(map);
    const world = createWorld(8, 7);
    const grid = createSpatialGrid(16, 16, 2);
    const cattle = createCattleSystem();

    const cow = spawn(world, 12, 8, 0, 1, EntityKind.Cattle);
    const cowIndex = handleIndex(cow);
    panic(world, cowIndex, 1, 0);

    for (let t = 0; t < 30; t++) {
      rebuild(world, grid);
      cattle.update(world, grid, [], undefined, movement.displace);
      world.tick++;
    }

    expect(world.posX[cowIndex]!).toBeLessThan(16);
    expect(world.posX[cowIndex]!).toBeGreaterThanOrEqual(0);
  });

  it('cannot stampede through a cliff', () => {
    const map = withCliff(16, 16, 12);
    const movement = createMovementSystem(map);
    const world = createWorld(8, 7);
    const grid = createSpatialGrid(16, 16, 2);
    const cattle = createCattleSystem();

    const cow = spawn(world, 9, 8, 0, 1, EntityKind.Cattle);
    const cowIndex = handleIndex(cow);
    panic(world, cowIndex, 1, 0);

    for (let t = 0; t < 30; t++) {
      rebuild(world, grid);
      cattle.update(world, grid, [], undefined, movement.displace);
      world.tick++;
    }

    expect(world.posX[cowIndex]!).toBeLessThan(12);
  });

  it('does not knock a victim off the map', () => {
    // Knockback wrote straight into posX/posY, the one position write in the whole
    // simulation that did not go through the movement system's occupancy check. A cow
    // charging the map edge threw people over it.
    const map = flat(16, 16);
    const movement = createMovementSystem(map);
    const world = createWorld(16, 7);
    const grid = createSpatialGrid(16, 16, 2);
    const cattle = createCattleSystem();

    // The cow sweeps 15.0 -> 15.4 this tick; the victim is 0.3 off the end of that
    // segment, inside the 0.35 crush radius, and 0.55 of knockback puts it past 16.
    const cow = spawn(world, 15.0, 8, 0, 1, EntityKind.Cattle);
    panic(world, handleIndex(cow), 1, 0);
    const victim = spawn(world, 15.7, 8, 1);
    const victimIndex = handleIndex(victim);

    rebuild(world, grid);
    cattle.update(world, grid, [], undefined, movement.displace);

    expect(world.posX[victimIndex]!).toBeLessThan(16);
    expect(world.posX[victimIndex]!).toBeGreaterThanOrEqual(0);
  });

  it('does not knock a victim through a cliff it could never walk out of', () => {
    // Worse than the map edge: an impassable tile has no outbound direction mask, so a
    // unit put inside one can never leave. A stampede removed it from the match.
    const map = withCliff(16, 16, 12);
    const movement = createMovementSystem(map);
    const world = createWorld(16, 7);
    const grid = createSpatialGrid(16, 16, 2);
    const cattle = createCattleSystem();

    const cow = spawn(world, 11.0, 8, 0, 1, EntityKind.Cattle);
    panic(world, handleIndex(cow), 1, 0);
    const victim = spawn(world, 11.7, 8, 1);
    const victimIndex = handleIndex(victim);

    rebuild(world, grid);
    cattle.update(world, grid, [], undefined, movement.displace);

    // The cliff column starts at x=12 and stands far above the ground beside it.
    expect(world.posX[victimIndex]!).toBeLessThan(12);
  });

  it('does not crush other cattle', () => {
    const world = createWorld(16, 7);
    const grid = createSpatialGrid(64, 64, 2);
    const cattle = createCattleSystem();

    const cow = spawn(world, 10, 10, 0, 1, EntityKind.Cattle);
    panic(world, handleIndex(cow), 1, 0);
    const bystander = spawn(world, 10.2, 10, 0, 1, EntityKind.Cattle);
    const bystanderIndex = handleIndex(bystander);
    const hpBefore = world.hp[bystanderIndex]!;

    rebuild(world, grid);
    cattle.update(world, grid, [], undefined, openGround);
    expect(world.hp[bystanderIndex]).toBe(hpBefore);
  });

  it('calms down once the timer runs out and stress has fallen', () => {
    const { world, handles, tick } = makeHerd(1, 30, 30);
    const cow = handleIndex(handles[0]!);
    panic(world, cow, 1, 0);

    for (let t = 0; t < C.stampedeTicks + 200; t++) tick();
    expect(world.herdState[cow]).toBe(HerdState.Grazing);
  });
});
