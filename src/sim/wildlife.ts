import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import { isWater, type Heightmap } from '../shared/heightmap.js';
import { Habitat, Role, SPECIES, speciesInfo, type Species } from '../shared/wildlife.js';
import type { Displace } from './cattle.js';
import { mixSeed } from './math/rng.js';
import { angleDelta, atan2, cos, sin, TWO_PI } from './math/trig.js';
import type { SpatialGrid } from './spatial/grid.js';
import { tuning } from './tuning.js';
import {
  ANIM_IDLE,
  ANIM_STAMPEDE,
  ANIM_WALK,
  EntityKind,
  HerdState,
  NULL_HANDLE,
  destroy,
  packHandle,
  spawn,
  type Handle,
  type World,
} from './world.js';

/**
 * The animals nobody owns (ADR-0022).
 *
 * Game grazes in bands, keeps loosely to a home range that wanders over the seasons, and
 * bolts from people who come within its flight distance — at a pace people cannot match,
 * which is why a hunt is a stalk and not a chase. Bands breed back toward full strength
 * a season at a time, so a range that is hunted hard thins and slowly recovers; a
 * species hunted off the map entirely comes back, eventually, from its edge.
 *
 * Steering follows the cattle's: a desired velocity from a handful of weighted urges,
 * reached under an acceleration clamp, integrated through `displace` so that no animal
 * walks off the map, into a river or up a cliff (ADR-0018). Nothing here draws from the
 * world's RNG. The small randomness a grazing animal needs — when to amble, which way to
 * turn — comes from a hash of the animal and the tick, so this system can be added to,
 * reordered or skipped without shifting a single draw anybody else makes.
 *
 * Predators (phase 3) and the hunt (phase 4) build on this; neither exists yet, so a
 * predator here only roams with its pride and ignores everything.
 */

/**
 * The faction nobody is. The same value as `NEUTRAL_FACTION` in commands.ts, restated
 * rather than imported because commands.ts imports this module to spawn game.
 */
const NEUTRAL = 2;

interface SpeciesTuning {
  readonly bands: number;
  readonly bandMin: number;
  readonly bandMax: number;
  readonly walkSpeed: number;
  readonly runSpeed: number;
  readonly fleeRadius: number;
  readonly meat: number;
  readonly skins: number;
  readonly ivory: number;
  readonly huntChance: number;
  readonly fightBack: number;
}

/** A species' numbers, by its name in the catalogue. */
export function speciesTuning(species: number): SpeciesTuning {
  const table = tuning.wildlife.species as Readonly<Record<string, SpeciesTuning>>;
  return table[speciesInfo(species).name]!;
}

/** A hash in [0, 1) of three integers. Stateless, so it perturbs nobody's RNG. */
function unit(a: number, b: number, c: number): number {
  return mixSeed(mixSeed(a >>> 0, b >>> 0), c >>> 0) / 4294967296;
}

/**
 * Where a band's range is centred at a tick: its home, drifted round a slow loop.
 *
 * A function rather than state, so a band's movement over the years costs nothing to
 * store and nothing to save. Two harmonics at unrelated rates, so the loop does not
 * close on itself in any span a player would notice.
 */
export function rangeAt(band: number, homeX: number, homeY: number, tick: number): { x: number; y: number } {
  const w = tuning.wildlife;
  const phase = unit(band, 0x5a17, 1) * TWO_PI;
  const t = (tick / w.rangeDriftPeriodTicks) * TWO_PI;
  return {
    x: homeX + sin(t + phase) * w.rangeDrift,
    y: homeY + cos(t * 0.71 + phase * 1.3) * w.rangeDrift,
  };
}

export interface WildlifeSystem {
  update(world: World, grid: SpatialGrid, events: SimEvent[], displace: Displace): void;
}

/** Put one animal on the map. Returns its handle, or 0 if the world is full. */
export function spawnWild(
  world: World,
  x: number,
  y: number,
  species: number,
  band: number,
  homeX = x,
  homeY = y,
): Handle {
  const handle = spawn(world, x, y, NEUTRAL, 0, EntityKind.Wild);
  if (handle === 0) return 0;
  const index = handle & 0xffffff;
  world.species[index] = species;
  world.band[index] = band & 0xffff;
  world.homeX[index] = homeX;
  world.homeY[index] = homeY;
  // Facing from the hash, so a band does not open with every head turned the same way.
  world.facing[index] = unit(index, species, band) * TWO_PI;
  return handle;
}

export function createWildlifeSystem(map: Heightmap): WildlifeSystem {
  const neighbours: number[] = [];
  /** Per band, reused each census: [firstIndex, count, species]. Keyed by band. */
  const census = new Map<number, [number, number, number]>();
  const perSpecies = new Int32Array(SPECIES.length);
  /** Which species this map has country for, and so which may ever return to it. */
  const native = SPECIES.map((info) => habitatPresent(map, info.habitat));

  function standable(x: number, y: number): boolean {
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    if (tileX < 1 || tileY < 1 || tileX >= map.width - 1 || tileY >= map.height - 1) return false;
    return !isWater(map, tileX, tileY);
  }

  /**
   * Bands breed back toward full strength, and a species gone from the map returns.
   *
   * One birth per band per breeding season at most, and only below the band's full size,
   * so recovery is slow and bounded: a range hunted to a handful takes years to fill,
   * and nothing here can grow a band past what the map started with.
   */
  function breed(world: World, events: SimEvent[]): void {
    const w = tuning.wildlife;
    const epoch = Math.floor(world.tick / w.birthEveryTicks);
    census.clear();
    perSpecies.fill(0);

    // Ascending index, so the first member recorded for a band is the same everywhere.
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Wild) continue;
      const species = world.species[i]!;
      perSpecies[species] = perSpecies[species]! + 1;
      const key = world.band[i]! * 32 + species;
      const entry = census.get(key);
      if (entry === undefined) census.set(key, [i, 1, species]);
      else entry[1]++;
    }

    // Map iteration is insertion order, which was index order: deterministic.
    for (const [key, [first, count, species]] of census) {
      const s = speciesTuning(species);
      if (count >= s.bandMax) continue;
      if (unit(key, epoch, 0xb1b7) >= w.birthChance) continue;
      const angle = unit(key, epoch, 7) * TWO_PI;
      const x = world.posX[first]! + cos(angle) * 0.8;
      const y = world.posY[first]! + sin(angle) * 0.8;
      if (!standable(x, y)) continue;
      const handle = spawnWild(world, x, y, species, world.band[first]!, world.homeX[first]!, world.homeY[first]!);
      if (handle !== 0) events.push(makeEvent(world.tick, EventType.Spawned, handle, x, y));
    }

    // A species hunted off the map entirely comes back from an edge — but only on the
    // long cycle, so that emptying a range is a real cost and not a reset.
    if (world.tick % w.returnAfterTicks !== 0) return;
    for (const info of SPECIES) {
      if (perSpecies[info.species]! > 0) continue;
      // Not onto a map that never had its country: no hippo returns to the Karoo.
      if (!native[info.species]) continue;
      const s = speciesTuning(info.species);
      const band = (mixSeed(info.species, epoch) & 0x7fff) | 0x8000;
      const side = Math.floor(unit(info.species, epoch, 3) * 4);
      const along = 4 + unit(info.species, epoch, 5) * (map.width - 8);
      const x = side === 0 ? 3 : side === 1 ? map.width - 4 : along;
      const y = side === 2 ? 3 : side === 3 ? map.height - 4 : along;
      for (let n = 0; n < s.bandMin; n++) {
        const angle = n * 2.399963;
        const spread = w.bandSpread * Math.sqrt((n + 0.5) / s.bandMin);
        const at = { x: x + cos(angle) * spread, y: y + sin(angle) * spread };
        if (!standable(at.x, at.y)) continue;
        const handle = spawnWild(world, at.x, at.y, info.species, band, x, y);
        if (handle !== 0) events.push(makeEvent(world.tick, EventType.Spawned, handle, at.x, at.y));
      }
    }
  }

  /** Scratch for a predator's search, separate from the per-animal neighbour list. */
  const prey: number[] = [];

  /**
   * One predator's hunt this tick. Returns the velocity it wants, or null to rest.
   *
   * A band hunts in a window on its own clock — the pride is out at dusk, not all day —
   * and rests between. In the window it takes the nearest thing it can bring down,
   * stalks it at a walk and sprints the last few tiles; on the kill it is sated for a
   * long spell. A person alone within its reach may be mauled instead: laid up, not
   * killed, and once in a window at most, from a hash of the two of them, so the same
   * encounter always ends the same way.
   */
  function hunt(
    world: World,
    index: number,
    species: number,
    band: number,
    lone: number,
    grid: SpatialGrid,
    events: SimEvent[],
  ): { x: number; y: number } | null {
    const p = tuning.wildlife.predators;
    const s = speciesTuning(species);
    if (world.sated[index]! > 0) {
      world.sated[index] = world.sated[index]! - 1;
      world.quarry[index] = NULL_HANDLE;
      return null;
    }
    const clock = world.tick + Math.floor(unit(band, species, 0xc10c) * p.huntEveryTicks);
    if (clock % p.huntEveryTicks >= p.huntWindowTicks) {
      world.quarry[index] = NULL_HANDLE;
      return null;
    }
    const window = Math.floor(clock / p.huntEveryTicks);
    const posX = world.posX[index]!;
    const posY = world.posY[index]!;

    if (lone !== -1 && unit(lone, window, index) < p.maulChance) {
      maul(world, lone, events);
      world.sated[index] = p.satedTicks;
      world.quarry[index] = NULL_HANDLE;
      return null;
    }

    // Keep the quarry while it lives and has not got clean away.
    let quarry = world.quarry[index]!;
    if (quarry !== NULL_HANDLE) {
      const at = quarry & 0xffffff;
      const alive = world.alive[at] === 1 && packHandle(at, world.generation[at]!) === quarry;
      const dx = world.posX[at]! - posX;
      const dy = world.posY[at]! - posY;
      if (!alive || dx * dx + dy * dy > p.stalkRadius * p.stalkRadius * 2.25) quarry = NULL_HANDLE;
    }
    if (quarry === NULL_HANDLE) {
      const limit = (p.preyMeatMax as Readonly<Record<string, number>>)[speciesInfo(species).name] ?? 0;
      const found = grid.query(posX, posY, p.stalkRadius, prey);
      let best = -1;
      let bestDistance = Infinity;
      for (let n = 0; n < found; n++) {
        const other = prey[n]!;
        if (world.alive[other] !== 1) continue;
        const kind = world.kind[other];
        let takeable = kind === EntityKind.Cattle;
        if (kind === EntityKind.Wild) {
          const role = speciesInfo(world.species[other]!).role;
          takeable = (role === Role.Game || role === Role.Scenery) && speciesTuning(world.species[other]!).meat <= limit;
        }
        if (!takeable) continue;
        const dx = world.posX[other]! - posX;
        const dy = world.posY[other]! - posY;
        const distance = dx * dx + dy * dy;
        // Strictly nearer, so a tie keeps the lower index: the total-order rule.
        if (distance < bestDistance) {
          bestDistance = distance;
          best = other;
        }
      }
      quarry = best === -1 ? NULL_HANDLE : packHandle(best, world.generation[best]!);
    }
    world.quarry[index] = quarry;
    if (quarry === NULL_HANDLE) return null;

    const at = quarry & 0xffffff;
    const dx = world.posX[at]! - posX;
    const dy = world.posY[at]! - posY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < p.killRadius) {
      kill(world, index, at, events);
      world.sated[index] = p.satedTicks;
      world.quarry[index] = NULL_HANDLE;
      return null;
    }
    const pace = distance < p.pounceRadius ? s.runSpeed : s.walkSpeed * 1.2;
    return { x: (dx / distance) * pace, y: (dy / distance) * pace };
  }

  /** The kill. Cattle lost to it spread the terror to every beast that saw it. */
  function kill(world: World, predator: number, prey: number, events: SimEvent[]): void {
    const p = tuning.wildlife.predators;
    const cattle = world.kind[prey] === EntityKind.Cattle;
    const x = world.posX[prey]!;
    const y = world.posY[prey]!;
    destroy(world, packHandle(prey, world.generation[prey]!));
    events.push(makeEvent(world.tick, EventType.PredatorKill, packHandle(predator, world.generation[predator]!), x, y, cattle ? 1 : 0));
    if (!cattle) return;
    // Feeds the stampede straight through the mechanic that already exists: stress
    // at its ceiling is a stampede, and the cattle system does the rest (ADR-0014).
    const max = tuning.cattle.stressMax;
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Cattle || i === prey) continue;
      const dx = world.posX[i]! - x;
      const dy = world.posY[i]! - y;
      if (dx * dx + dy * dy > p.panicRadius * p.panicRadius) continue;
      const next = world.stress[i]! + p.panicStress;
      world.stress[i] = next > max ? max : next;
    }
  }

  /** Laid up, not killed: never below one hit point from this, however often it happens. */
  function maul(world: World, person: number, events: SimEvent[]): void {
    const p = tuning.wildlife.predators;
    const hp = world.hp[person]!;
    world.hp[person] = hp > p.maulDamage + 1 ? hp - p.maulDamage : 1;
    world.injured[person] = p.injuredTicks;
    world.hasTarget[person] = 0;
    // Whatever they were after, they are not after it now.
    world.quarry[person] = NULL_HANDLE;
    world.velX[person] = 0;
    world.velY[person] = 0;
    events.push(
      makeEvent(
        world.tick,
        EventType.Mauled,
        packHandle(person, world.generation[person]!),
        world.posX[person]!,
        world.posY[person]!,
        world.faction[person]!,
      ),
    );
  }

  return {
    update(world, grid, events, displace) {
      const w = tuning.wildlife;
      const dt = tuning.movement.dt;
      const radius = w.cohesionRadius > w.maxFleeRadius ? w.cohesionRadius : w.maxFleeRadius;

      // The laid-up mend. Here because this is the system that lays them up; movement
      // and labour only have to ask whether somebody is.
      for (let i = 0; i < world.capacity; i++) {
        if (world.alive[i] !== 1 || world.injured[i] === 0) continue;
        world.injured[i] = world.injured[i]! - 1;
      }

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Wild) continue;

        const species = world.species[index]!;
        const info = speciesInfo(species);
        const s = speciesTuning(species);
        const band = world.band[index]!;
        const posX = world.posX[index]!;
        const posY = world.posY[index]!;
        world.prevX[index] = posX;
        world.prevY[index] = posY;

        // --- what is near ------------------------------------------------------
        const count = grid.query(posX, posY, radius, neighbours);
        let threatX = 0;
        let threatY = 0;
        let threats = 0;
        let cohesionX = 0;
        let cohesionY = 0;
        let mates = 0;
        let separationX = 0;
        let separationY = 0;
        const predator = info.role === Role.Predator;
        const p = w.predators;
        /** People close enough to a predator to turn it, and where they stand. */
        let crowd = 0;
        let crowdX = 0;
        let crowdY = 0;
        /** The nearest person within a predator's ambush reach, or -1. */
        let lone = -1;
        let loneDistance = p.ambushRadius;

        for (let n = 0; n < count; n++) {
          const other = neighbours[n]!;
          if (other === index || world.alive[other] !== 1) continue;
          const dx = posX - world.posX[other]!;
          const dy = posY - world.posY[other]!;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq < 1e-12) continue;
          const distance = Math.sqrt(distanceSq);

          /*
           * People frighten game, within its flight distance. Predators do not run
           * from a single person — that is phase 3's crowd rule — and a flight distance
           * of nought in the tuning says so without a special case.
           */
          if (world.kind[other] === EntityKind.Unit) {
            if (predator && world.injured[other] === 0) {
              if (distance < p.crowdRadius) {
                crowd++;
                crowdX += dx;
                crowdY += dy;
              }
              if (distance < loneDistance) {
                loneDistance = distance;
                lone = other;
              }
            }
            // A hunter stalking is noticed far later than somebody walking past: that is
            // the whole of the craft, and the only way anyone gets close to an impala.
            const noticed =
              world.quarry[other] !== NULL_HANDLE ? s.fleeRadius * w.stalkFactor : s.fleeRadius;
            if (distance < noticed) {
              const weight = (noticed - distance) / noticed;
              threatX += (dx / distance) * weight;
              threatY += (dy / distance) * weight;
              threats++;
            }
            continue;
          }

          if (world.kind[other] !== EntityKind.Wild) continue;
          // A predator on the hunt frightens game as a person does. One at rest does
          // not — game grazes in sight of a sleeping pride, and a veld where every lion
          // kept everything running would be a veld with nothing standing still in it.
          if (!predator && world.quarry[other] !== NULL_HANDLE && distance < s.fleeRadius) {
            const weight = (s.fleeRadius - distance) / s.fleeRadius;
            threatX += (dx / distance) * weight;
            threatY += (dy / distance) * weight;
            threats++;
            continue;
          }
          if (world.species[other] !== species || world.band[other] !== band) {
            if (distance < w.separationRadius) {
              separationX += (dx / distance) * ((w.separationRadius - distance) / w.separationRadius);
              separationY += (dy / distance) * ((w.separationRadius - distance) / w.separationRadius);
            }
            continue;
          }
          if (distance < w.cohesionRadius) {
            cohesionX += world.posX[other]!;
            cohesionY += world.posY[other]!;
            mates++;
          }
          if (distance < w.separationRadius) {
            separationX += (dx / distance) * ((w.separationRadius - distance) / w.separationRadius);
            separationY += (dy / distance) * ((w.separationRadius - distance) / w.separationRadius);
          }
        }

        // --- a predator's day ----------------------------------------------------
        // Enough people together turn it: it gives up whatever it was stalking and
        // goes. That is the whole of what a village can do about a lion (ADR-0022).
        let chase: { x: number; y: number } | null = null;
        if (predator) {
          if (crowd >= p.crowdToDriveOff) {
            if (world.stampedeTicks[index] === 0 && world.quarry[index] !== NULL_HANDLE) {
              events.push(makeEvent(world.tick, EventType.DrivenOff, packHandle(index, world.generation[index]!), posX, posY));
            }
            world.quarry[index] = NULL_HANDLE;
            world.stampedeTicks[index] = w.fleeTicks;
            world.herdState[index] = HerdState.Alarmed;
            world.facing[index] = atan2(crowdY, crowdX);
          } else if (world.stampedeTicks[index] === 0) {
            chase = hunt(world, index, species, band, lone, grid, events);
          }
        }

        // --- flight ------------------------------------------------------------
        // Once started it runs its course: an animal that stopped the instant the
        // hunter was a hair outside its flight distance would never get away.
        if (threats > 0) {
          world.stampedeTicks[index] = w.fleeTicks;
          world.herdState[index] = HerdState.Alarmed;
          const length = Math.sqrt(threatX * threatX + threatY * threatY);
          if (length > 1e-9) world.facing[index] = atan2(threatY, threatX);
        }
        const fleeing = world.stampedeTicks[index]! > 0;

        let desiredX: number;
        let desiredY: number;
        if (fleeing) {
          world.stampedeTicks[index] = world.stampedeTicks[index]! - 1;
          if (world.stampedeTicks[index] === 0) world.herdState[index] = HerdState.Grazing;
          const heading = world.facing[index]!;
          desiredX = cos(heading) * s.runSpeed + separationX * w.separationWeight;
          desiredY = sin(heading) * s.runSpeed + separationY * w.separationWeight;
        } else if (chase !== null) {
          desiredX = chase.x + separationX * w.separationWeight;
          desiredY = chase.y + separationY * w.separationWeight;
        } else {
          /*
           * Grazing: mostly standing, now and then an amble.
           *
           * In spells rather than tick by tick, so an animal walks a few paces and stops
           * rather than twitching. Which spells are walking comes from the hash — the
           * same animal at the same tick decides the same thing on every machine.
           */
          const spell = Math.floor(world.tick / 40);
          const ambling = unit(index, spell, species) < 0.3;
          let heading = world.facing[index]!;
          if (ambling) heading += (unit(index, world.tick, 0x7e) - 0.5) * w.wanderTurn;
          const wander = ambling ? s.walkSpeed * w.wanderWeight : 0;
          desiredX = cos(heading) * wander;
          desiredY = sin(heading) * wander;

          if (mates > 0) {
            desiredX += (cohesionX / mates - posX) * w.cohesionWeight;
            desiredY += (cohesionY / mates - posY) * w.cohesionWeight;
          }
          desiredX += separationX * w.separationWeight;
          desiredY += separationY * w.separationWeight;

          // Back toward the range once it has strayed from it.
          const range = rangeAt(band, world.homeX[index]!, world.homeY[index]!, world.tick);
          const awayX = range.x - posX;
          const awayY = range.y - posY;
          const away = Math.sqrt(awayX * awayX + awayY * awayY);
          if (away > w.rangeRadius) {
            desiredX += (awayX / away) * (away - w.rangeRadius) * w.rangeWeight;
            desiredY += (awayY / away) * (away - w.rangeRadius) * w.rangeWeight;
          }

          const speed = Math.sqrt(desiredX * desiredX + desiredY * desiredY);
          if (speed > s.walkSpeed) {
            desiredX = (desiredX / speed) * s.walkSpeed;
            desiredY = (desiredY / speed) * s.walkSpeed;
          }
        }

        // --- integrate ---------------------------------------------------------
        let vx = world.velX[index]!;
        let vy = world.velY[index]!;
        const accelX = desiredX - vx;
        const accelY = desiredY - vy;
        const accel = Math.sqrt(accelX * accelX + accelY * accelY);
        const limit = w.accelClamp * dt;
        if (accel > limit && accel > 1e-9) {
          vx += (accelX / accel) * limit;
          vy += (accelY / accel) * limit;
        } else {
          vx = desiredX;
          vy = desiredY;
        }
        world.velX[index] = vx;
        world.velY[index] = vy;
        displace(world, index, posX + vx * dt, posY + vy * dt);

        // A refused step (a riverbank, a cliff) turns it, rather than leaving it pressed
        // against the obstacle forever.
        const movedX = world.posX[index]! - posX;
        const movedY = world.posY[index]! - posY;
        const moved = Math.sqrt(movedX * movedX + movedY * movedY);
        const speed = Math.sqrt(vx * vx + vy * vy);
        if (speed > 0.2 && moved < speed * dt * 0.25) {
          world.velX[index] = 0;
          world.velY[index] = 0;
          world.facing[index] = world.facing[index]! + (unit(index, world.tick, 0x70) < 0.5 ? 1.9 : -1.9);
        } else if (speed > 1e-3 && (!fleeing || chase !== null)) {
          const delta = angleDelta(world.facing[index]!, atan2(vy, vx));
          const maxTurn = tuning.movement.turnRate * dt;
          world.facing[index] =
            world.facing[index]! + (delta > maxTurn ? maxTurn : delta < -maxTurn ? -maxTurn : delta);
        }

        const sprinting = fleeing || (chase !== null && speed > s.walkSpeed * 1.5);
        world.animState[index] = sprinting ? ANIM_STAMPEDE : speed > 0.05 ? ANIM_WALK : ANIM_IDLE;
        // Its role in the high nibble of the flags, beside the one roles.ts gives people,
        // so the renderer can tell a lion from an impala without a species table of its own.
        world.flags[index] = ((info.role & 0x0f) << 4) | (world.flags[index]! & 0x0f);
      }

      if (world.tick > 0 && world.tick % tuning.wildlife.birthEveryTicks === 0) breed(world, events);
    },
  };
}

/**
 * Where the opening puts the game: bands placed by habitat, clear of the village.
 *
 * Returned as a list rather than spawned here, because the opening goes through commands
 * like everything else a match places (src/host/opening.ts), so it is in the command log
 * and a replay reproduces it.
 *
 * Deterministic from the seed and the map: candidate sites come from a hash, and each
 * band takes the first candidate its habitat accepts. A species whose habitat the map
 * does not have — hippo on a map without water — is simply absent from it.
 */
export function planWildlife(
  map: Heightmap,
  seed: number,
  village: { x: number; y: number },
  walkable: Uint8Array,
): { x: number; y: number; species: Species; band: number }[] {
  const w = tuning.wildlife;
  const out: { x: number; y: number; species: Species; band: number }[] = [];
  let band = 1;


  for (const info of SPECIES) {
    const s = speciesTuning(info.species);
    for (let b = 0; b < s.bands; b++) {
      let site: { x: number; y: number } | null = null;
      for (let attempt = 0; attempt < 60 && site === null; attempt++) {
        const x = 3 + Math.floor(unit(seed, info.species * 97 + b, attempt) * (map.width - 6));
        const y = 3 + Math.floor(unit(seed ^ 0x1d, info.species * 97 + b, attempt) * (map.height - 6));
        const at = y * map.width + x;
        if (walkable[at] !== 1 || isWater(map, x, y)) continue;
        const dx = x - village.x;
        const dy = y - village.y;
        if (dx * dx + dy * dy < w.clearOfVillage * w.clearOfVillage) continue;
        if (!habitatSuits(map, info.habitat, x, y)) continue;
        site = { x: x + 0.5, y: y + 0.5 };
      }
      if (site === null) continue;

      const size = s.bandMin + Math.floor(unit(seed, band, 0x51) * (s.bandMax - s.bandMin + 1));
      for (let n = 0; n < size; n++) {
        const angle = n * 2.399963;
        const spread = w.bandSpread * Math.sqrt((n + 0.5) / size);
        const x = site.x + cos(angle) * spread;
        const y = site.y + sin(angle) * spread;
        const tileX = Math.floor(x);
        const tileY = Math.floor(y);
        if (tileX < 1 || tileY < 1 || tileX >= map.width - 1 || tileY >= map.height - 1) continue;
        if (walkable[tileY * map.width + tileX] !== 1 || isWater(map, tileX, tileY)) continue;
        out.push({ x, y, species: info.species, band });
      }
      band++;
    }
  }
  return out;
}

/** Whether this tile is the country a habitat wants. */
function habitatSuits(map: Heightmap, habitat: number, x: number, y: number): boolean {
  const level = map.data[y * map.width + x]!;
  if (habitat === Habitat.Water) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) if (isWater(map, x + dx, y + dy)) return true;
    }
    return false;
  }
  if (habitat === Habitat.Open) return level <= Math.floor(map.levels / 2);
  if (habitat === Habitat.Broken) return level > Math.floor(map.levels / 2) - 1;
  return true;
}

/** Whether a map has any of a habitat's country at all. Scanned coarsely; run once per map. */
function habitatPresent(map: Heightmap, habitat: number): boolean {
  for (let y = 2; y < map.height - 2; y += 2) {
    for (let x = 2; x < map.width - 2; x += 2) {
      if (!isWater(map, x, y) && habitatSuits(map, habitat, x, y)) return true;
    }
  }
  return false;
}

/** Whether a species is a predator. Here for the systems that will ask it in phase 3. */
export function isPredator(species: number): boolean {
  return speciesInfo(species).role === Role.Predator;
}

/** A species' flight distance: how close a person can come before it runs. */
export function fleeRadiusOf(species: number): number {
  return speciesTuning(species).fleeRadius;
}
