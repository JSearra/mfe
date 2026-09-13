import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { createCombatSystem, weaponOf, Weapon } from '../src/sim/combat.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { createTechState } from '../src/sim/tech.js';
import { FactionId } from '../src/shared/factions/index.js';
import { createSpatialGrid, type SpatialGrid } from '../src/sim/spatial/grid.js';
import { tuning } from '../src/sim/tuning.js';
import {
  EntityKind,
  createWorld,
  flushDestroys,
  handleIndex,
  isAlive,
  spawn,
  type World,
} from '../src/sim/world.js';

const C = tuning.combat;

function rebuild(world: World, grid: SpatialGrid): void {
  grid.clear();
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] === 1) grid.insert(i, world.posX[i]!, world.posY[i]!);
  }
}

function arena() {
  const world = createWorld(64, 3);
  const grid = createSpatialGrid(64, 64, 2);
  const combat = createCombatSystem();
  const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], 1);
  const tech = createTechState(2);
  const events: SimEvent[] = [];
  const tick = () => {
    rebuild(world, grid);
    combat.update(world, grid, economy, tech, events);
    flushDestroys(world);
    world.tick++;
  };
  return { world, grid, combat, economy, tech, events, tick };
}

describe('weapons', () => {
  it('gives mounted troops firearms and everyone else arm’s length', () => {
    expect(weaponOf(0)).toBe(Weapon.Melee);
    expect(weaponOf(2)).toBe(Weapon.Ranged);
  });
});

describe('target acquisition', () => {
  it('engages the nearest enemy and ignores its own side', () => {
    const { world, combat, grid, economy, tech, events } = arena();
    const attacker = spawn(world, 10, 10, 0);
    spawn(world, 10.5, 10, 0); // a friend, closer than the enemy
    const enemy = spawn(world, 10.8, 10, 1);

    rebuild(world, grid);
    combat.update(world, grid, economy, tech, events);
    expect(world.attackTarget[handleIndex(attacker)]).toBe(enemy);
  });

  it('never targets cattle', () => {
    const { world, combat, grid, economy, tech, events } = arena();
    const attacker = spawn(world, 10, 10, 0);
    spawn(world, 10.4, 10, 1, 1, EntityKind.Cattle);

    rebuild(world, grid);
    combat.update(world, grid, economy, tech, events);
    // A herd is taken by herding it away, not by shooting it.
    expect(world.attackTarget[handleIndex(attacker)]).toBe(0);
  });

  // The single most common source of lockstep desync in shipped RTS games.
  it('breaks a distance tie on entity index, not on traversal order', () => {
    const build = (spawnOrder: readonly number[]): number => {
      const world = createWorld(64, 3);
      const grid = createSpatialGrid(64, 64, 2);
      const combat = createCombatSystem();
      const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], 1);
      const tech = createTechState(2);

      const attacker = spawn(world, 10, 10, 0);
      // Two enemies at exactly equal distance, spawned in the given order.
      const slots = [
        { x: 9, y: 10 },
        { x: 11, y: 10 },
      ];
      for (const which of spawnOrder) spawn(world, slots[which]!.x, slots[which]!.y, 1);

      rebuild(world, grid);
      combat.update(world, grid, economy, tech, []);
      return world.attackTarget[handleIndex(attacker)]!;
    };

    // Same geometry, opposite spawn order: the chosen slot index must be the same.
    expect(handleIndex(build([0, 1]))).toBe(handleIndex(build([1, 0])));
  });

  it('drops a target that dies', () => {
    const { world, combat, grid, economy, tech, events, tick } = arena();
    const attacker = spawn(world, 10, 10, 0);
    const enemy = spawn(world, 10.5, 10, 1);

    rebuild(world, grid);
    combat.update(world, grid, economy, tech, events);
    expect(world.attackTarget[handleIndex(attacker)]).toBe(enemy);

    world.hp[handleIndex(enemy)] = 0;
    tick();
    expect(isAlive(world, enemy)).toBe(false);
    expect(world.attackTarget[handleIndex(attacker)]).toBe(0);
  });

  it('lets a unit under orders march past a fight', () => {
    const { world, combat, grid, economy, tech, events } = arena();
    const marcher = spawn(world, 10, 10, 0);
    spawn(world, 10.5, 10, 1);
    world.hasTarget[handleIndex(marcher)] = 1;

    rebuild(world, grid);
    combat.update(world, grid, economy, tech, events);
    expect(world.attackTarget[handleIndex(marcher)]).toBe(0);
  });
});

describe('strikes', () => {
  it('damages on a cooldown rather than every tick', () => {
    const { world, tick } = arena();
    spawn(world, 10, 10, 0);
    const enemy = spawn(world, 10.5, 10, 1);
    const enemyIndex = handleIndex(enemy);

    tick();
    const afterFirst = world.hp[enemyIndex]!;
    expect(afterFirst).toBe(tuning.unit.maxHp - C.meleeDamage);

    tick();
    expect(world.hp[enemyIndex]).toBe(afterFirst);

    for (let i = 0; i < C.meleeCooldownTicks; i++) tick();
    expect(world.hp[enemyIndex]!).toBeLessThan(afterFirst);
  });

  it('will not strike beyond reach', () => {
    const { world, tick } = arena();
    spawn(world, 10, 10, 0);
    const enemy = spawn(world, 10 + C.meleeRange + 0.5, 10, 1);

    tick();
    expect(world.hp[handleIndex(enemy)]).toBe(tuning.unit.maxHp);
  });

  it('lets firearms reach where a spear cannot', () => {
    const { world, economy, tick } = arena();
    spawn(world, 10, 10, 0, 2); // mounted, so armed
    const enemy = spawn(world, 14, 10, 1);
    // amaZulu start with no powder, so a shot has to be paid for before it can be fired.
    economy.add(0, Resource.Ammunition, 10);

    tick();
    expect(world.hp[handleIndex(enemy)]!).toBeLessThan(tuning.unit.maxHp);
  });

  it('spends powder per shot and withholds fire when it runs out', () => {
    const { world, economy, tick, combat } = arena();
    spawn(world, 10, 10, 0, 2);
    const enemy = spawn(world, 13, 10, 1);

    economy.spend(0, Resource.Ammunition, economy.balance(0, Resource.Ammunition));
    tick();
    expect(world.hp[handleIndex(enemy)]).toBe(tuning.unit.maxHp);
    expect(combat.stats.shotsWithheld).toBeGreaterThan(0);

    economy.add(0, Resource.Ammunition, 10);
    tick();
    expect(world.hp[handleIndex(enemy)]!).toBeLessThan(tuning.unit.maxHp);
    expect(economy.balance(0, Resource.Ammunition)).toBe(10 - C.ammunitionPerShot);
  });

  it('announces hits', () => {
    const { world, events, tick } = arena();
    spawn(world, 10, 10, 0);
    spawn(world, 10.5, 10, 1);
    tick();
    expect(events.some((e) => e.type === EventType.Hit)).toBe(true);
  });
});

describe('death', () => {
  it('removes anything whose health runs out, whatever emptied it', () => {
    const { world, events, tick } = arena();
    // Starvation and crushing both reduce health without killing; before reaping
    // existed, a starved unit sat at zero indefinitely.
    const starved = spawn(world, 30, 30, 0);
    world.hp[handleIndex(starved)] = 0;

    tick();
    expect(isAlive(world, starved)).toBe(false);
    expect(events.some((e) => e.type === EventType.Died && e.handle === starved)).toBe(true);
  });

  it('resolves a duel and leaves one side standing', () => {
    const { world, tick } = arena();
    const a = spawn(world, 10, 10, 0);
    const b = spawn(world, 10.5, 10, 1);
    world.hp[handleIndex(b)] = C.meleeDamage;

    for (let i = 0; i < 5; i++) tick();
    expect(isAlive(world, b)).toBe(false);
    expect(isAlive(world, a)).toBe(true);
  });
});
