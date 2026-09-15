import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import { destroy, handleIndex, NULL_HANDLE, packHandle, type World } from './world.js';

/**
 * Death, from whatever caused it.
 *
 * This lived inside `combat.ts` and was private to it, which was wrong in a way that had
 * already bitten once: starvation and stampede crush both reduce health and neither is
 * combat, so a game with the combat system removed — or simply not run — left starved
 * villagers sitting at zero health forever. Dying is not a combat rule. It is what
 * happens when health runs out, and the thing that took the health away does not get a
 * say in it.
 *
 * Rehomed here ahead of retiring combat (roadmap Phase V6) rather than during it, so the
 * move could be proved inert on its own: it runs at exactly the point in the tick it ran
 * at before, and the golden replay is unchanged by it.
 */

/** Remove anything whose health has run out. Returns how many died. */
export function reap(world: World, events: SimEvent[]): number {
  let died = 0;

  for (let index = 0; index < world.capacity; index++) {
    if (world.alive[index] !== 1 || world.hp[index]! > 0) continue;
    if (world.destroyPending[index] === 1) continue;

    const handle = packHandle(index, world.generation[index]!);
    events.push(
      makeEvent(world.tick, EventType.Died, handle, world.posX[index]!, world.posY[index]!),
    );
    destroy(world, handle);
    died++;
  }

  if (died === 0) return 0;

  // Clear targets that just died, so the invariant "no unit ends a tick holding a dead
  // target" holds. Leaving it to the next tick works, but it means a save taken between
  // the two restores a unit aiming at a corpse.
  for (let index = 0; index < world.capacity; index++) {
    if (world.alive[index] !== 1) continue;
    const target = world.attackTarget[index]!;
    if (target === NULL_HANDLE) continue;
    if (world.destroyPending[handleIndex(target)] === 1) world.attackTarget[index] = NULL_HANDLE;
  }

  return died;
}
