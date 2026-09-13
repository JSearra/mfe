import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import type { Economy } from './economy/ledger.js';
import { Resource } from './economy/ledger.js';
import type { SpatialGrid } from './spatial/grid.js';
import { tuning } from './tuning.js';
import {
  EntityKind,
  NULL_HANDLE,
  destroy,
  handleIndex,
  isAlive,
  packHandle,
  type Handle,
  type World,
} from './world.js';

/**
 * Combat: target acquisition, strikes, and death.
 *
 * The dangerous part here is not the damage arithmetic, it is target selection. "Attack
 * the nearest enemy" is the single most common source of lockstep desync in shipped RTS
 * games: two enemies at equal distance, and the answer falls out of whatever order the
 * spatial hash happened to return. Every argmin in this file therefore ends on an
 * explicit entity-index tie-break, and a test pins it. See ARCHITECTURE section 1.
 */

export const Weapon = {
  Melee: 0,
  Ranged: 1,
} as const;

export interface CombatStats {
  strikes: number;
  kills: number;
  shotsWithheld: number;
}

export interface CombatSystem {
  readonly stats: CombatStats;
  /** Order a unit onto a specific target. */
  attack(world: World, attacker: Handle, target: Handle): boolean;
  update(world: World, grid: SpatialGrid, economy: Economy, events: SimEvent[]): void;
}

/**
 * Mounted troops carry firearms; everyone else closes to arm's length.
 *
 * Derived from movement class rather than stored, because the two travel together — the
 * Griqua are mounted gunmen, and that is one fact about them, not two.
 */
export function weaponOf(movementClass: number): number {
  return movementClass === 2 ? Weapon.Ranged : Weapon.Melee;
}

export function createCombatSystem(): CombatSystem {
  const stats: CombatStats = { strikes: 0, kills: 0, shotsWithheld: 0 };
  const neighbours: number[] = [];

  /**
   * Nearest hostile unit, or -1.
   *
   * Cattle are never targets. A herd is taken by herding it away, not by shooting it,
   * and making cattle shootable would turn every raid into a slaughter — which is both
   * bad play and a depiction we do not want.
   */
  function acquire(world: World, grid: SpatialGrid, index: number): number {
    const c = tuning.combat;
    const posX = world.posX[index]!;
    const posY = world.posY[index]!;
    const faction = world.faction[index]!;

    const count = grid.query(posX, posY, c.acquireRadius, neighbours);
    let best = -1;
    let bestDistanceSq = c.acquireRadius * c.acquireRadius;

    for (let n = 0; n < count; n++) {
      const other = neighbours[n]!;
      if (world.alive[other] !== 1) continue;
      if (world.kind[other] !== EntityKind.Unit) continue;
      if (world.faction[other] === faction) continue;

      const dx = world.posX[other]! - posX;
      const dy = world.posY[other]! - posY;
      const distanceSq = dx * dx + dy * dy;

      // Strictly nearer wins; equal distance falls to the lower entity index. Without
      // that second clause the answer depends on spatial-hash traversal order, and two
      // machines diverge on the first tick of contact.
      if (distanceSq < bestDistanceSq || (distanceSq === bestDistanceSq && other < best)) {
        bestDistanceSq = distanceSq;
        best = other;
      }
    }
    return best;
  }

  return {
    stats,

    attack(world, attacker, target): boolean {
      if (!isAlive(world, attacker) || !isAlive(world, target)) return false;
      const index = handleIndex(attacker);
      if (world.kind[index] !== EntityKind.Unit) return false;
      if (world.kind[handleIndex(target)] !== EntityKind.Unit) return false;

      world.attackTarget[index] = target;
      return true;
    },

    update(world, grid, economy, events): void {
      const c = tuning.combat;

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Unit) continue;
        if (world.attackCooldown[index]! > 0) world.attackCooldown[index]!--;

        // Drop a target that has died or wandered out of reach.
        let target = world.attackTarget[index]!;
        if (target !== NULL_HANDLE && !isAlive(world, target)) {
          target = NULL_HANDLE;
          world.attackTarget[index] = NULL_HANDLE;
        }

        if (target === NULL_HANDLE) {
          // Units under orders keep marching; idle ones look for a fight.
          if (world.hasTarget[index] === 1) continue;
          const found = acquire(world, grid, index);
          if (found === -1) continue;
          target = packHandle(found, world.generation[found]!);
          world.attackTarget[index] = target;
        }

        const targetIndex = handleIndex(target);
        const dx = world.posX[targetIndex]! - world.posX[index]!;
        const dy = world.posY[targetIndex]! - world.posY[index]!;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > c.chaseRange) {
          world.attackTarget[index] = NULL_HANDLE;
          continue;
        }

        const ranged = weaponOf(world.movementClass[index]!) === Weapon.Ranged;
        const reach = ranged ? c.rangedRange : c.meleeRange;
        if (distance > reach) continue;
        if (world.attackCooldown[index]! > 0) continue;

        // Powder is a resource, so a shot that cannot be paid for is not fired. That is
        // what makes the Griqua's ammunition column something the player must watch.
        const owner = world.faction[index]!;
        if (ranged && owner < economy.players) {
          if (!economy.spend(owner, Resource.Ammunition, c.ammunitionPerShot)) {
            stats.shotsWithheld++;
            continue;
          }
        }

        const damage = ranged ? c.rangedDamage : c.meleeDamage;
        const hp = world.hp[targetIndex]!;
        world.hp[targetIndex] = hp > damage ? hp - damage : 0;
        world.attackCooldown[index] = ranged ? c.rangedCooldownTicks : c.meleeCooldownTicks;
        stats.strikes++;

        events.push(
          makeEvent(
            world.tick,
            EventType.Hit,
            target,
            world.posX[targetIndex]!,
            world.posY[targetIndex]!,
            damage,
          ),
        );
      }

      reap(world, stats, events);
    },
  };
}

/**
 * Remove anything whose health has run out.
 *
 * Deliberately separate from whatever did the damage. Crushing, starvation and combat
 * all reduce health and none of them should each carry their own copy of the rules for
 * dying — before this existed, a starved unit sat at zero health indefinitely.
 */
function reap(world: World, stats: CombatStats, events: SimEvent[]): void {
  let died = false;

  for (let index = 0; index < world.capacity; index++) {
    if (world.alive[index] !== 1 || world.hp[index]! > 0) continue;
    if (world.destroyPending[index] === 1) continue;

    const handle = packHandle(index, world.generation[index]!);
    events.push(
      makeEvent(world.tick, EventType.Died, handle, world.posX[index]!, world.posY[index]!),
    );
    destroy(world, handle);
    stats.kills++;
    died = true;
  }

  if (!died) return;

  // Clear targets that just died, so the invariant "no unit ends a tick holding a dead
  // target" holds. Leaving it to the next tick works, but it means a save taken between
  // the two restores a unit aiming at a corpse.
  for (let index = 0; index < world.capacity; index++) {
    if (world.alive[index] !== 1) continue;
    const target = world.attackTarget[index]!;
    if (target === NULL_HANDLE) continue;
    if (world.destroyPending[handleIndex(target)] === 1) world.attackTarget[index] = NULL_HANDLE;
  }
}
