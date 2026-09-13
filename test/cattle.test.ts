import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { createCattleSystem } from '../src/sim/cattle.js';
import { createSpatialGrid, type SpatialGrid } from '../src/sim/spatial/grid.js';
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
    cattle.update(world, grid, events);
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
      cattle.update(world, grid, events);

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
    cattle.update(world, grid, []);
    expect(world.posX[victimIndex]!).toBeGreaterThan(10.2);
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
    cattle.update(world, grid, []);
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
