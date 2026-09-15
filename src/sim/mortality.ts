import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import { destroy, packHandle, type World } from './world.js';

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
 * move could be proved inert on its own: it ran at exactly the point in the tick it had
 * before, and the golden replay was unchanged by it. Combat is gone now and this is all
 * that is left of it — which is the point, because none of it was ever combat's.
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

  return died;
}
