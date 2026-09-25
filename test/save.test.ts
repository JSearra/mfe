import { describe, expect, it } from 'vitest';
import { breakBond, propose, standingOf } from '../src/sim/alliance.js';
import { CommandKind, makeCommand } from '../src/sim/commands.js';
import { runTicks, step } from '../src/sim/loop.js';
import {
  captureState,
  restoreState,
  SAVE_VERSION,
  SaveVersionError,
} from '../src/sim/persistence/save.js';
import { hashWorld } from '../src/sim/replay.js';
import { Resource } from '../src/sim/economy/ledger.js';
import { Modifier, TechId, TECHS } from '../src/shared/tech/index.js';
import { createHeightmap } from '../src/sim/terrain/generate.js';
import { makeSim } from './simHarness.js';
import { BuildingType, buildingSpec } from '../src/shared/buildings/index.js';
import { createWorld, EntityKind } from '../src/sim/world.js';
import { IMPASSABLE, MovementClass } from '../src/sim/pathing/costs.js';
import { createDirectSimHost } from '../src/host/directHost.js';
import { matchSeed, NEIGHBOUR, PLAYER, seedOpening } from '../src/host/opening.js';
import { FactionId } from '../src/shared/factions/index.js';

/** A scenario with movement, cattle, orders and an economy all in flight. */
function busyScenario(seed: number) {
  const map = createHeightmap(48, 48, 0x51ee);
  const commands = [];
  let seq = 0;

  for (let i = 0; i < 12; i++) {
    commands.push(makeCommand(0, 0, seq++, CommandKind.Spawn, 10 + (i % 4), 10 + (i >> 2), 0, 0));
  }
  for (let i = 0; i < 10; i++) {
    commands.push(makeCommand(0, 0, seq++, CommandKind.SpawnCattle, 14 + (i % 5) * 0.6, 14));
  }
  for (let tick = 20; tick < 400; tick += 40) {
    commands.push(
      makeCommand(tick, 0, seq++, CommandKind.MoveTo, (1 << 24) | 0, 20 + (tick % 17), 22),
    );
    commands.push(
      makeCommand(tick, 0, seq++, CommandKind.MoveTo, (1 << 24) | 1, 12, 30 - (tick % 11)),
    );
  }

  return makeSim(128, seed, map, commands);
}

describe('save and load', () => {
  // The decisive test. Anything the save left behind — RNG state, a path cursor, the
  // fog, the ledger — shows up as divergence when both halves run on.
  it('restores into a fresh simulation that then runs identically', () => {
    const original = busyScenario(0xabc);
    runTicks(original.loop, 300);

    const save = captureState(original.loop);

    const restored = busyScenario(0xabc);
    // Advance the fresh one to a *different* state first, so a pass cannot come from
    // the two simply having the same history.
    runTicks(restored.loop, 57);
    expect(hashWorld(restored.world)).not.toBe(hashWorld(original.world));

    restoreState(restored.loop, save);
    expect(hashWorld(restored.world)).toBe(hashWorld(original.world));

    for (let tick = 0; tick < 400; tick++) {
      step(original.loop);
      step(restored.loop);
      expect(hashWorld(restored.world), `diverged at tick ${tick}`).toBe(hashWorld(original.world));
    }
  });

  it('carries the RNG state, not just the seed', () => {
    const original = busyScenario(0xdef);
    runTicks(original.loop, 137);
    const save = captureState(original.loop);

    const restored = busyScenario(0xdef);
    restoreState(restored.loop, save);
    expect(Array.from(restored.world.rng.state)).toEqual(Array.from(original.world.rng.state));
  });

  it('carries the ledger and the fog', () => {
    const original = busyScenario(0x123);
    runTicks(original.loop, 420); // past two upkeep cycles

    original.economy.add(0, Resource.Grain, 777);
    const save = captureState(original.loop);

    const restored = busyScenario(0x123);
    restoreState(restored.loop, save);

    expect(restored.economy.balance(0, Resource.Grain)).toBe(
      original.economy.balance(0, Resource.Grain),
    );
    expect(restored.economy.upkeepCount).toBe(original.economy.upkeepCount);
    expect(Array.from(restored.fog.tiles)).toEqual(Array.from(original.fog.tiles));
  });

  it('carries who was tied to whom, and what it cost to walk away', () => {
    const original = busyScenario(0x321);
    // Both sides ask, so there is a real tie to walk out of.
    propose(original.alliance, 0, 1);
    propose(original.alliance, 1, 0);
    breakBond(original.alliance, 0, 1, [], original.world.tick);
    const save = captureState(original.loop);

    const restored = busyScenario(0x321);
    // Prove the fresh simulation does not already look like the saved one, or this
    // asserts nothing — which is exactly how a save that dropped nine world arrays
    // passed for as long as it did.
    expect(standingOf(restored.alliance, 1, 0)).not.toBeCloseTo(
      standingOf(original.alliance, 1, 0),
    );

    restoreState(restored.loop, save);

    expect(standingOf(restored.alliance, 1, 0)).toBeCloseTo(standingOf(original.alliance, 1, 0));
    expect(Array.from(restored.alliance.bond)).toEqual(Array.from(original.alliance.bond));
  });

  it('carries research, including the multipliers derived from it', () => {
    const original = busyScenario(0x66);
    original.economy.add(0, Resource.Grain, 5000);
    original.economy.add(0, Resource.Cattle, 200);
    original.tech.begin(0, TechId.Amabutho, original.economy);
    runTicks(original.loop, TECHS[TechId.Amabutho].researchTicks + 10);
    expect(original.tech.isComplete(0, TechId.Amabutho)).toBe(true);

    // And one still in progress, which is the case a status-only save would lose.
    original.tech.begin(0, TechId.Umkhosi, original.economy);
    runTicks(original.loop, 40);

    const restored = busyScenario(0x66);
    restoreState(restored.loop, captureState(original.loop));

    expect(restored.tech.isComplete(0, TechId.Amabutho)).toBe(true);
    // Multipliers are derived, so this proves the rebuild happened rather than the
    // save carrying a second copy free to disagree with the first.
    expect(restored.tech.modifier(0, Modifier.Labour)).toBeCloseTo(
      original.tech.modifier(0, Modifier.Labour),
      9,
    );
    expect(Array.from(restored.tech.progress)).toEqual(Array.from(original.tech.progress));
  });

  it('carries unfinished orders so they still execute after loading', () => {
    const original = busyScenario(0x55);
    runTicks(original.loop, 100);

    const save = captureState(original.loop);
    expect(save.commands.length).toBeGreaterThan(0);

    const restored = busyScenario(0x55);
    restoreState(restored.loop, save);
    expect(restored.loop.pending.length).toBe(save.commands.length);
  });

  it('is stable: saving the same state twice produces the same bytes', () => {
    const sim = busyScenario(0x99);
    runTicks(sim.loop, 250);
    expect(JSON.stringify(captureState(sim.loop))).toBe(JSON.stringify(captureState(sim.loop)));
  });

  it('survives a JSON round trip', () => {
    const original = busyScenario(0x77);
    runTicks(original.loop, 180);

    const text = JSON.stringify(captureState(original.loop));
    const restored = busyScenario(0x77);
    restoreState(restored.loop, JSON.parse(text));

    runTicks(original.loop, 120);
    runTicks(restored.loop, 120);
    expect(hashWorld(restored.world)).toBe(hashWorld(original.world));
  });

  it('refuses a save from a different version rather than misreading it', () => {
    const sim = busyScenario(0x11);
    const save = { ...captureState(sim.loop), version: SAVE_VERSION + 1 };
    expect(() => restoreState(sim.loop, save)).toThrow(SaveVersionError);
  });

  it('refuses a save whose capacity does not match', () => {
    const big = busyScenario(0x22);
    const save = captureState(big.loop);
    const small = makeSim(16, 0x22);
    expect(() => restoreState(small.loop, save)).toThrow(RangeError);
  });
});

describe('what a save actually carries', () => {
  /**
   * WORLD_FIELDS is a hand-written list of the world arrays a save copies, and it had
   * drifted nine fields behind the world it describes. The round-trip test could not see
   * it: that test compares `hashWorld`, which covers ten of the world's fifty-three
   * arrays, so a save that dropped every building's type and progress diverged from
   * nothing and passed.
   *
   * These assert the state directly instead of through a hash, which is the only way a
   * missing field is visible.
   */
  it('saves every typed array the world holds', () => {
    const { world } = makeSim(32, 1);
    const save = captureState(makeSim(32, 1).loop);

    const held = Object.keys(world).filter((key) =>
      ArrayBuffer.isView((world as unknown as Record<string, unknown>)[key] as object),
    );

    const missing = held.filter((key) => save.world[key] === undefined);
    expect(missing, `world state absent from the save: ${missing.join(', ')}`).toEqual([]);
  });

  it('restores a finished building as the building it was', () => {
    const origin = makeSim(64, 5);
    origin.construction.place(origin.world, origin.economy, 0, BuildingType.Umuzi, 10, 10, []);
    const site = origin.world.kind.findIndex(
      (kind, i) => kind === EntityKind.Building && origin.world.alive[i] === 1,
    );
    const spec = buildingSpec(origin.world.buildingType[site]!);
    origin.world.buildProgress[site] = spec.work;

    const save = captureState(origin.loop);

    const restored = makeSim(64, 5);
    restoreState(restored.loop, save);

    expect(restored.world.buildingType[site]).toBe(BuildingType.Umuzi);
    expect(restored.world.buildProgress[site]).toBe(spec.work);
  });
});

describe('a builder game survives a save (the fields, the wood, the ground under buildings)', () => {
  /**
   * The game has no end since ADR-0020, so a save is how a village is kept. These are the
   * pieces the save left out while nothing but tests ever called it: the fields and the
   * woodland (both simulation state, neither in the world arrays), the census, which
   * villages live off the map, and the ground a building stands on — a building blocks
   * its footprint on the pathing layers, and a restored world had the building and not
   * the block, so people walked through huts after loading.
   */
  it('carries the fields', () => {
    const origin = makeSim(64, 5);
    origin.farmland.condition[0] = 0.31;
    origin.farmland.fallow[1] = 1;
    origin.farmland.work[2] = 3.5;
    const save = captureState(origin.loop);
    const restored = makeSim(64, 5);
    restored.farmland.condition[0] = 0.99;
    restoreState(restored.loop, JSON.parse(JSON.stringify(save)));
    expect(restored.farmland.count).toBe(origin.farmland.count);
    expect(restored.farmland.condition[0]).toBe(0.31);
    expect(restored.farmland.fallow[1]).toBe(1);
    expect(restored.farmland.work[2]).toBe(3.5);
  });

  it('carries the woodland', () => {
    const origin = makeSim(64, 5, createHeightmap(64, 64, 0x51ee));
    expect(origin.woodland.count).toBeGreaterThan(0);
    origin.woodland.age[0] = 77;
    origin.woodland.alive[1] = 0;
    const save = captureState(origin.loop);
    const restored = makeSim(64, 5, createHeightmap(64, 64, 0x51ee));
    restoreState(restored.loop, JSON.parse(JSON.stringify(save)));
    expect(restored.woodland.count).toBe(origin.woodland.count);
    expect(restored.woodland.age[0]).toBe(77);
    expect(restored.woodland.alive[1]).toBe(0);
  });

  it('carries last season\'s harvest, upkeep and what the land feeds', () => {
    // The autoplayer raises households on `feeds`, and the HUD shows harvest against
    // upkeep: both went blank after a load until the next season.
    const origin = makeSim(64, 5);
    origin.economy.harvested[0] = 123;
    origin.economy.upkeep[0] = 45;
    origin.economy.feeds[0] = 67;
    const save = captureState(origin.loop);
    const restored = makeSim(64, 5);
    restoreState(restored.loop, JSON.parse(JSON.stringify(save)));
    expect(restored.economy.harvested[0]).toBe(123);
    expect(restored.economy.upkeep[0]).toBe(45);
    expect(restored.economy.feeds[0]).toBe(67);
  });

  it('carries the census and which villages are off the map', () => {
    const origin = makeSim(64, 5);
    origin.census.emptied[1] = 1;
    origin.economy.offMap[1] = 1;
    const save = captureState(origin.loop);
    const restored = makeSim(64, 5);
    restoreState(restored.loop, JSON.parse(JSON.stringify(save)));
    expect(restored.census.emptied[1]).toBe(1);
    expect(restored.economy.offMap[1]).toBe(1);
  });

  it('restores the ground a building stands on as ground nobody can walk through', () => {
    const origin = makeSim(64, 5);
    origin.construction.place(origin.world, origin.economy, 0, BuildingType.GrainStore, 10, 10, [], true);
    const save = captureState(origin.loop);
    const restored = makeSim(64, 5);
    const layer = restored.movement.pathing.layer(MovementClass.Infantry);
    const at = 10 * restored.map.width + 10;
    expect(layer.tileCost[at]).not.toBe(IMPASSABLE);
    restoreState(restored.loop, save);
    expect(layer.tileCost[at]).toBe(IMPASSABLE);
  });

  it('restores a real opening into a fresh game that then runs identically', () => {
    // The opening a player gets, through the same function main.ts calls, run for a
    // while so work has found its people, fields have moved and the season has turned.
    const make = () => {
      const map = createHeightmap(128, 128, 0x4d666563);
      const world = createWorld(512, matchSeed(0x4d666563));
      const host = createDirectSimHost({
        world,
        map,
        viewerId: PLAYER,
        playerId: PLAYER,
        neighbours: [NEIGHBOUR],
        factions: [FactionId.Zulu, FactionId.Sotho],
        starts: [{ x: 64, y: 64 }],
        seed: matchSeed(0x4d666563),
      });
      return { host, world };
    };
    const original = make();
    seedOpening((kind, a, b, c, d) => original.host.sendCommand(kind, a, b, c, d), createHeightmap(128, 128, 0x4d666563), 64);
    runTicks(original.host.loop, 2400);

    const save = JSON.parse(JSON.stringify(captureState(original.host.loop)));
    const restored = make();
    restoreState(restored.host.loop, save);
    expect(hashWorld(restored.world)).toBe(hashWorld(original.world));

    for (let tick = 0; tick < 1200; tick++) {
      step(original.host.loop);
      step(restored.host.loop);
      if (tick % 100 !== 99) continue;
      expect(hashWorld(restored.world), `world diverged by tick ${tick}`).toBe(hashWorld(original.world));
      expect(Array.from(restored.host.economy.amounts), `ledger diverged by tick ${tick}`).toEqual(
        Array.from(original.host.economy.amounts),
      );
      expect(Array.from(restored.host.farmland.condition), `fields diverged by tick ${tick}`).toEqual(
        Array.from(original.host.farmland.condition),
      );
      // Where the fields ARE, too: founding a village moves the fields it lands on, and a
      // fresh game that never ran the opening has them somewhere else.
      expect(Array.from(restored.host.farmland.tileX), `field sites differ by tick ${tick}`).toEqual(
        Array.from(original.host.farmland.tileX),
      );
      expect(Array.from(restored.host.woodland.age), `woodland diverged by tick ${tick}`).toEqual(
        Array.from(original.host.woodland.age),
      );
    }
  }, 120_000);
});
