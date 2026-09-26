import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import { isQuarry, Role, speciesInfo } from '../shared/wildlife.js';
import { Resource, type Economy } from './economy/ledger.js';
import { Work } from './labour.js';
import { mixSeed } from './math/rng.js';
import type { MovementSystem } from './movement.js';
import { tuning } from './tuning.js';
import { speciesTuning } from './wildlife.js';
import { atan2 } from './math/trig.js';
import {
  destroy,
  EntityKind,
  HerdState,
  isAlive,
  NULL_HANDLE,
  packHandle,
  type Handle,
  type World,
} from './world.js';

/**
 * The hunt (ADR-0022).
 *
 * A person with a quarry walks out to it, and game notices a stalking hunter far later
 * than anybody else (wildlife.ts, `stalkFactor`) — which is the only reason a hunter can
 * get within a spear's throw of an impala at all. At the strike there is one attempt:
 * most fail, and the animal bolts; a kill puts meat, hides and, from an elephant or a
 * hippo, ivory straight into the village's stores. Buffalo, hippo and elephant may turn
 * on the hunter, who is laid up rather than killed, as a predator's victim is.
 *
 * Two ways to be a hunter, as the owner asked, with equal weight. People drawn to a
 * hunters' camp (labour.ts `Work.Hunt`) set out on their own, rest at the camp between
 * hunts and only chase what is within its range. Anybody can also be sent after one
 * particular animal with a direct order (`CommandKind.Hunt`); they go after it and stop
 * when it is done, one way or the other.
 *
 * The roll comes from a hash of the hunter, the quarry and the tick of the strike, not
 * from the world's RNG, so a hunt cannot shift any other system's draws.
 */

export interface HuntingSystem {
  update(world: World, movement: MovementSystem, economy: Economy, events: SimEvent[]): void;
}

function roll(a: number, b: number, c: number): number {
  return mixSeed(mixSeed(a >>> 0, b >>> 0), c >>> 0) / 4294967296;
}

/** Whether a handle still names the animal it named when the hunt began. */
function quarryAlive(world: World, handle: Handle): boolean {
  return handle !== NULL_HANDLE && isAlive(world, handle) && world.kind[handle & 0xffffff] === EntityKind.Wild;
}

/**
 * Send somebody after one animal: the direct order, and the camp's choice alike.
 * Returns false for anybody who cannot go — the laid-up, and non-people.
 */
export function setOnQuarry(world: World, movement: MovementSystem, hunter: number, quarry: Handle): boolean {
  if (world.kind[hunter] !== EntityKind.Unit || world.injured[hunter]! > 0) return false;
  if (!quarryAlive(world, quarry) || !isQuarry(world.species[quarry & 0xffffff]!)) return false;
  world.quarry[hunter] = quarry;
  world.huntTicks[hunter] = 0;
  const at = quarry & 0xffffff;
  movement.order(world, packHandle(hunter, world.generation[hunter]!), world.posX[at]!, world.posY[at]!);
  return true;
}

export function createHuntingSystem(): HuntingSystem {
  /** Back to the camp, and a spell of rest before the next hunt. */
  function comeHome(world: World, movement: MovementSystem, hunter: number, rest: number): void {
    world.quarry[hunter] = NULL_HANDLE;
    world.huntTicks[hunter] = rest;
    if (world.workKind[hunter] !== Work.Hunt) {
      // A direct order ends where it ends: they stand, and the hold runs out as usual.
      world.hasTarget[hunter] = 0;
      return;
    }
    const camp = world.workAt[hunter]!;
    if (camp < 0 || world.alive[camp] !== 1) return;
    movement.order(world, packHandle(hunter, world.generation[hunter]!), world.posX[camp]! + 1, world.posY[camp]!);
  }

  /** The nearest huntable animal within a camp's range, or NULL_HANDLE. Ties keep the lower index. */
  function choose(world: World, hunter: number, campX: number, campY: number): Handle {
    const h = tuning.wildlife.hunting;
    const rangeSq = h.huntRange * h.huntRange;
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Wild) continue;
      if (!isQuarry(world.species[i]!)) continue;
      const cx = world.posX[i]! - campX;
      const cy = world.posY[i]! - campY;
      if (cx * cx + cy * cy > rangeSq) continue;
      const dx = world.posX[i]! - world.posX[hunter]!;
      const dy = world.posY[i]! - world.posY[hunter]!;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best === -1 ? NULL_HANDLE : packHandle(best, world.generation[best]!);
  }

  /** The strike: one attempt, most of them misses. */
  function strike(world: World, movement: MovementSystem, economy: Economy, events: SimEvent[], hunter: number, quarry: Handle): void {
    const h = tuning.wildlife.hunting;
    const at = quarry & 0xffffff;
    const species = world.species[at]!;
    const s = speciesTuning(species);
    const owner = world.faction[hunter]!;
    world.hasTarget[hunter] = 0;

    if (roll(hunter, quarry, world.tick) < s.huntChance) {
      if (owner < economy.players) {
        economy.add(owner, Resource.Meat, s.meat);
        economy.add(owner, Resource.Skins, s.skins);
        economy.add(owner, Resource.Ivory, s.ivory);
      }
      const x = world.posX[at]!;
      const y = world.posY[at]!;
      destroy(world, quarry);
      events.push(
        makeEvent(world.tick, EventType.Hunted, packHandle(hunter, world.generation[hunter]!), x, y, owner + 16 * species),
      );
      comeHome(world, movement, hunter, h.restTicks);
      return;
    }

    // A miss. The animal is off — away from the hunter, at full pace.
    world.stampedeTicks[at] = tuning.wildlife.fleeTicks;
    world.herdState[at] = HerdState.Alarmed;
    world.facing[at] = atan2(world.posY[at]! - world.posY[hunter]!, world.posX[at]! - world.posX[hunter]!);

    // And the big ones may not run. Laid up, not killed, as a predator's victim is.
    if (speciesInfo(species).role === Role.Dangerous && roll(quarry, hunter, world.tick ^ 0x60e) < s.fightBack) {
      const hp = world.hp[hunter]!;
      world.hp[hunter] = hp > h.goreDamage + 1 ? hp - h.goreDamage : 1;
      world.injured[hunter] = tuning.wildlife.predators.injuredTicks;
      world.quarry[hunter] = NULL_HANDLE;
      world.huntTicks[hunter] = h.restTicks;
      events.push(
        makeEvent(world.tick, EventType.Mauled, packHandle(hunter, world.generation[hunter]!), world.posX[hunter]!, world.posY[hunter]!, owner),
      );
      return;
    }
    comeHome(world, movement, hunter, h.restTicks >> 1);
  }

  return {
    update(world, movement, economy, events) {
      const h = tuning.wildlife.hunting;
      const strikeSq = h.strikeRange * h.strikeRange;

      for (let hunter = 0; hunter < world.capacity; hunter++) {
        if (world.alive[hunter] !== 1 || world.kind[hunter] !== EntityKind.Unit) continue;
        const quarry = world.quarry[hunter]!;
        const fromCamp = world.workKind[hunter] === Work.Hunt;
        if (quarry === NULL_HANDLE && !fromCamp) continue;
        if (world.injured[hunter]! > 0) continue;

        // --- at the camp: rest, then set out --------------------------------------
        if (quarry === NULL_HANDLE) {
          if (world.huntTicks[hunter]! > 0) {
            world.huntTicks[hunter] = world.huntTicks[hunter]! - 1;
            continue;
          }
          const camp = world.workAt[hunter]!;
          if (camp < 0 || world.alive[camp] !== 1) continue;
          const chosen = choose(world, hunter, world.posX[camp]!, world.posY[camp]!);
          if (chosen === NULL_HANDLE) {
            // Nothing in range: look again after a rest rather than every tick.
            world.huntTicks[hunter] = h.restTicks;
            continue;
          }
          setOnQuarry(world, movement, hunter, chosen);
          continue;
        }

        // --- out after it -----------------------------------------------------------
        if (!quarryAlive(world, quarry)) {
          // Somebody else got it — another hunter, a lion — or it is gone.
          comeHome(world, movement, hunter, h.restTicks >> 1);
          continue;
        }
        const elapsed = world.huntTicks[hunter]! + 1;
        world.huntTicks[hunter] = elapsed;
        if (elapsed > h.pursueTicks) {
          // It has got away for good. Every hunt costs time whether or not it pays.
          comeHome(world, movement, hunter, h.restTicks >> 1);
          continue;
        }

        const at = quarry & 0xffffff;
        const dx = world.posX[at]! - world.posX[hunter]!;
        const dy = world.posY[at]! - world.posY[hunter]!;
        if (dx * dx + dy * dy <= strikeSq) {
          strike(world, movement, economy, events, hunter, quarry);
          continue;
        }
        // Follow it as it moves. Not every tick: a path per hunter per tick is what the
        // pathing budget exists to refuse.
        if (elapsed % h.repathTicks === 0) {
          movement.order(world, packHandle(hunter, world.generation[hunter]!), world.posX[at]!, world.posY[at]!);
        }
      }
    },
  };
}
