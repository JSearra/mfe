import { describe, expect, it } from 'vitest';
import { BuildingType } from '../src/shared/buildings/index.js';
import { Role, roleOf, updateRoles } from '../src/sim/roles.js';
import { plant, PlantResult } from '../src/sim/economy/farmland.js';
import { tuning } from '../src/sim/tuning.js';
import { EntityKind, handleIndex, spawn } from '../src/sim/world.js';
import { flatMap, makeSim } from './simHarness.js';
import { NEUTRAL_FACTION } from '../src/sim/commands.js';
import { Work } from '../src/sim/labour.js';

/**
 * Roles describe what somebody is doing so the renderer can draw them doing it. They
 * decide nothing, so what these pin is that the description is accurate — and, just as
 * importantly, that computing it does not disturb the simulation.
 */
const AT = tuning.roles.intervalTicks;

describe('what a villager is doing', () => {
  it('is nobody in particular by default', () => {
    const sim = makeSim(64, 3, flatMap(32));
    const idle = spawn(sim.world, 20, 20, 0);
    updateRoles(sim.world, sim.farmland, AT);
    expect(roleOf(sim.world, handleIndex(idle))).toBe(Role.None);
  });

  it('is a herder while holding a tether', () => {
    const sim = makeSim(64, 3, flatMap(32));
    const herder = spawn(sim.world, 20, 20, 0);
    const beast = spawn(sim.world, 20.4, 20, NEUTRAL_FACTION, 1, EntityKind.Cattle);
    sim.cattle.leash(sim.world, herder, beast);

    updateRoles(sim.world, sim.farmland, AT);
    expect(roleOf(sim.world, handleIndex(herder))).toBe(Role.Herder);

    // And stops being one when the tether goes.
    sim.cattle.release(sim.world, beast);
    updateRoles(sim.world, sim.farmland, AT);
    expect(roleOf(sim.world, handleIndex(herder))).toBe(Role.None);
  });

  it('is a field hand while standing in one of its own established fields', () => {
    const sim = makeSim(64, 3, flatMap(32));
    const map = flatMap(32);
    expect(plant(sim.farmland, sim.economy, map, 0, 12, 12)).toBe(PlantResult.Planted);
    sim.farmland.work[sim.farmland.count - 1] = tuning.farmland.establishWork;

    const hand = spawn(sim.world, 12.5, 12.5, 0);
    const stranger = spawn(sim.world, 12.5, 12.5, 1);
    updateRoles(sim.world, sim.farmland, AT);

    expect(roleOf(sim.world, handleIndex(hand))).toBe(Role.FieldHand);
    // Somebody else's field is not your work.
    expect(roleOf(sim.world, handleIndex(stranger))).toBe(Role.None);
  });

  it('is a field hand while breaking ground it was sent to, even beside the great house', () => {
    const sim = makeSim(128, 3, flatMap(48));
    sim.economy.add(0, 1 as never, 4000);
    sim.construction.place(sim.world, sim.economy, 0, BuildingType.Indlunkulu, 30, 30, [], true);
    expect(plant(sim.farmland, sim.economy, flatMap(48), 0, 33, 31)).toBe(PlantResult.Planted);
    const field = sim.farmland.count - 1;

    const breaker = spawn(sim.world, 33.5, 31.5, 0);
    sim.world.workKind[handleIndex(breaker)] = Work.Field;
    sim.world.workAt[handleIndex(breaker)] = field;
    // Standing in the same unbroken field without being sent to it is not the work.
    const passer = spawn(sim.world, 33.5, 31.5, 0);
    updateRoles(sim.world, sim.farmland, AT);

    expect(roleOf(sim.world, handleIndex(breaker))).toBe(Role.FieldHand);
    expect(roleOf(sim.world, handleIndex(passer))).not.toBe(Role.FieldHand);
  });

  it('tells the grain store from the great house', () => {
    const sim = makeSim(128, 3, flatMap(48));
    const place = (type: BuildingType, x: number, y: number) => {
      sim.economy.add(0, 1 as never, 4000);
      sim.construction.place(sim.world, sim.economy, 0, type, x, y, [], true);
    };
    place(BuildingType.GrainStore, 10, 10);
    place(BuildingType.Indlunkulu, 30, 30);

    const atStore = spawn(sim.world, 11, 11, 0);
    const atHouse = spawn(sim.world, 31, 31, 0);
    updateRoles(sim.world, sim.farmland, AT);

    expect(roleOf(sim.world, handleIndex(atStore))).toBe(Role.Carrier);
    expect(roleOf(sim.world, handleIndex(atHouse))).toBe(Role.Elder);
  });

  it('prefers the tether to the hut, because driving cattle is visibly being done', () => {
    const sim = makeSim(128, 3, flatMap(48));
    sim.economy.add(0, 1 as never, 4000);
    sim.construction.place(sim.world, sim.economy, 0, BuildingType.GrainStore, 10, 10, [], true);

    const both = spawn(sim.world, 11, 11, 0);
    const beast = spawn(sim.world, 11.3, 11, NEUTRAL_FACTION, 1, EntityKind.Cattle);
    sim.cattle.leash(sim.world, both, beast);

    updateRoles(sim.world, sim.farmland, AT);
    expect(roleOf(sim.world, handleIndex(both))).toBe(Role.Herder);
  });

  it('runs on its interval and not every tick', () => {
    const sim = makeSim(64, 3, flatMap(32));
    const herder = spawn(sim.world, 20, 20, 0);
    const beast = spawn(sim.world, 20.4, 20, NEUTRAL_FACTION, 1, EntityKind.Cattle);
    sim.cattle.leash(sim.world, herder, beast);

    updateRoles(sim.world, sim.farmland, AT + 1);
    expect(roleOf(sim.world, handleIndex(herder))).toBe(Role.None);
  });

  it('leaves the herd state in the low nibble alone', () => {
    // The snapshot packs both into one byte. Trampling the low nibble would make every
    // cow read as calm, which is the readout the stampede mechanic hangs on.
    const sim = makeSim(64, 3, flatMap(32));
    const unit = spawn(sim.world, 20, 20, 0);
    const index = handleIndex(unit);
    sim.world.flags[index] = 0x0d;

    updateRoles(sim.world, sim.farmland, AT);
    expect(sim.world.flags[index]! & 0x0f).toBe(0x0d);
  });
});
