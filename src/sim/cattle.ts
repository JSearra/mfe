import type { SimEvent } from '../shared/events.js';
import { EventType, makeEvent } from '../shared/events.js';
import { angleDelta, atan2 } from './math/trig.js';
import { nextSigned } from './math/rng.js';
import type { SpatialGrid } from './spatial/grid.js';
import { Modifier } from '../shared/tech/index.js';
import type { TechState } from './tech.js';
import { tuning } from './tuning.js';
import { buildingSpec } from '../shared/buildings/index.js';
import {
  ANIM_IDLE,
  ANIM_STAMPEDE,
  ANIM_WALK,
  EntityKind,
  HerdState,
  handleIndex,
  isAlive,
  NULL_HANDLE,
  packHandle,
  type Handle,
  type World,
} from './world.js';

/**
 * Cattle: flocking, herding, stress, and the stampede.
 *
 * The mechanic the game is named for, and the one part of it whose difficulty is design
 * rather than engineering. Three things here were flagged as risks before a line was
 * written, and two of them were real:
 *
 * 1. Boids integrated once per 20Hz tick overshoot. Steering forces applied at a 50ms
 *    step make a herd oscillate around its target rather than settle on it, so cattle
 *    substep — three passes of 16.7ms per tick — and acceleration is clamped.
 *
 * 2. A stampeding cow covers about a third of a tile per tick against a crush radius of
 *    just over half that, so a discrete position check misses infantry it passed
 *    straight through. Crush uses a swept segment test instead. "Sometimes the stampede
 *    goes through people" is exactly the bug that makes a mechanic feel broken while
 *    being almost impossible to attribute.
 *
 * 3. RVO would have been the conventional choice for avoidance and is unusable here: it
 *    is reciprocal by definition, and this is the case where reciprocity must fail.
 *    Cattle plough through infantry; infantry do not get a vote. See ADR-0003.
 */

export interface CattleStats {
  stampedes: number;
  crushes: number;
  leashed: number;
}

/** Moves a unit to a proposed position, refusing what it could not occupy. */
export type Displace = (world: World, index: number, toX: number, toY: number) => void;

export interface CattleSystem {
  readonly stats: CattleStats;
  /** Tether a cow to a herder. Right-clicking a neutral herd is what issues this. */
  leash(world: World, herder: Handle, cow: Handle): boolean;
  release(world: World, cow: Handle): void;
  /**
   * `displace` applies knockback. It is required rather than optional on purpose: the
   * crush is the only thing in the simulation that moves a unit it does not own, and a
   * default that wrote the position directly is exactly how the unchecked version
   * survived — every test would have quietly agreed with it.
   */
  update(
    world: World,
    grid: SpatialGrid,
    events: SimEvent[],
    tech: TechState | undefined,
    displace: Displace,
  ): void;
}

/** Squared distance from a point to the segment a->b. The swept crush test. */
function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;

  let t = 0;
  if (lengthSq > 1e-12) {
    t = ((px - ax) * abx + (py - ay) * aby) / lengthSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }

  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return dx * dx + dy * dy;
}

/** Kraal centres and half-footprints, rebuilt each tick. Flat, so it never allocates. */
const pens: number[] = [];

export function createCattleSystem(): CattleSystem {
  const stats: CattleStats = { stampedes: 0, crushes: 0, leashed: 0 };
  const neighbours: number[] = [];

  return {
    stats,

    leash(world, herder, cow): boolean {
      if (!isAlive(world, herder) || !isAlive(world, cow)) return false;
      const cowIndex = handleIndex(cow);
      if (world.kind[cowIndex] !== EntityKind.Cattle) return false;
      if (world.herdState[cowIndex] === HerdState.Stampeding) return false;

      world.tetheredTo[cowIndex] = herder;
      world.herdState[cowIndex] = HerdState.Leashed;
      stats.leashed++;
      return true;
    },

    release(world, cow): void {
      const index = handleIndex(cow);
      world.tetheredTo[index] = NULL_HANDLE;
      if (world.herdState[index] === HerdState.Leashed) {
        world.herdState[index] = HerdState.Grazing;
      }
    },

    update(world, grid, events, tech, displace): void {
      const c = tuning.cattle;

      /*
       * Where the kraals are.
       *
       * Gathered once a tick rather than asked per beast, and it is a handful of
       * buildings against a herd that can be hundreds. A pen that cattle can merely walk
       * through is not a pen: with the footprint opened to them they wandered straight
       * out the far side, which looked worse than being unable to get in at all.
       */
      pens.length = 0;
      for (let i = 0; i < world.capacity; i++) {
        if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Building) continue;
        const spec = buildingSpec(world.buildingType[i]!);
        if (!spec.holdsCattle) continue;
        // Reach past the wall, not just to it. Measured from the centre, a beast that
        // drifted a hair beyond the footprint stopped counting as penned and went back
        // to wandering — so the herd leaked out one animal at a time from the edge. The
        // margin is what pulls a stray at the wall back in rather than letting it go.
        pens.push(world.posX[i]!, world.posY[i]!, spec.footprint / 2 + c.pennedReach);
      }
      const dt = tuning.movement.dt / c.substeps;

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Cattle) continue;

        world.prevX[index] = world.posX[index]!;
        world.prevY[index] = world.posY[index]!;

        const posX = world.posX[index]!;
        const posY = world.posY[index]!;

        // --- threat and stress ------------------------------------------------
        // Neighbours come back sorted by index, so accumulated pressure is identical
        // on every machine regardless of insertion order.
        const radius = Math.max(c.stressRadius, c.cohesionRadius, c.herderRadius);
        const count = grid.query(posX, posY, radius, neighbours);

        let threatX = 0;
        let threatY = 0;
        let threatWeight = 0;
        /**
         * Who is already driving this beast, if anybody.
         *
         * Its own people do not frighten it. Before this, walking a herd home was a
         * fight against the mechanic: the herders holding the tethers were themselves
         * the largest source of stress, so the act of driving cattle steadily wound
         * them toward bolting, and a player who sent a dozen villagers to fetch a herd
         * reliably stampeded it instead. A beast under somebody's hand is used to that
         * hand. A STRANGER still frightens it, so raiding is untouched — which is the
         * half of the mechanic worth protecting (ADR-0014).
         */
        const tether = world.tetheredTo[index]!;
        const driver =
          tether !== NULL_HANDLE && isAlive(world, tether)
            ? world.faction[handleIndex(tether)]!
            : -1;
        /** Proximity-weighted count of neighbours already running. */
        let panicWeight = 0;

        let separationX = 0;
        let separationY = 0;
        let cohesionX = 0;
        let cohesionY = 0;
        let cohesionCount = 0;
        let alignX = 0;
        let alignY = 0;
        let alignCount = 0;

        for (let n = 0; n < count; n++) {
          const other = neighbours[n]!;
          if (other === index || world.alive[other] !== 1) continue;

          const dx = posX - world.posX[other]!;
          const dy = posY - world.posY[other]!;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq < 1e-12) continue;
          const distance = Math.sqrt(distanceSq);

          if (world.kind[other] === EntityKind.Cattle) {
            // Panic spreads. A beast running past frightens the ones it passes, which
            // is the entire difference between "a stampede" and "several cattle
            // independently deciding to bolt" — and until this existed, chasing a herd
            // saturated exactly one animal at a time however hard it was pressed.
            //
            // Linear falloff, deliberately NOT the square law the threat curve uses.
            // That curve exists to make approach distance a thing the player plays
            // against; this is a beast noticing that its neighbours are running, which
            // is closer to binary. Squared it was worth about 0.03 stress a tick at a
            // realistic neighbour distance — arithmetically incapable of spreading
            // anything before the bolter, at speed 8, had left the radius.
            if (
              world.herdState[other] === HerdState.Stampeding &&
              distance < c.panicRadius
            ) {
              panicWeight += (c.panicRadius - distance) / c.panicRadius;
            }
            if (distance < c.separationRadius) {
              const strength = (c.separationRadius - distance) / c.separationRadius;
              separationX += (dx / distance) * strength;
              separationY += (dy / distance) * strength;
            }
            if (distance < c.cohesionRadius) {
              cohesionX += world.posX[other]!;
              cohesionY += world.posY[other]!;
              cohesionCount++;
            }
            if (distance < c.alignmentRadius) {
              alignX += world.velX[other]!;
              alignY += world.velY[other]!;
              alignCount++;
            }
            continue;
          }

          /*
           * A PERSON. Not a building, and not anything else that is merely not a cow.
           *
           * This tested "is it cattle?" and treated everything else as a herder, so a
           * building frightened cattle and shoved them away — which meant the kraal, the
           * one structure whose entire purpose is to hold a herd, repelled it from the
           * centre outwards and held it in a ring three tiles off. Opening the footprint
           * so cattle could walk in achieved nothing while the building standing in it
           * was pushing them back out, and no amount of tuning the pen was ever going to
           * fix that.
           *
           * Herders push cattle away and raise their stress — unless they are the people
           * already driving it, who do neither.
           */
          if (world.kind[other] !== EntityKind.Unit) continue;
          if (driver !== -1 && world.faction[other] === driver) continue;
          if (distance < c.herderRadius) {
            const strength = (c.herderRadius - distance) / c.herderRadius;
            threatX += (dx / distance) * strength;
            threatY += (dy / distance) * strength;
            // Stress rises with the SQUARE of proximity while the avoidance push stays
            // linear. That gap is the mechanic: herding from a couple of tiles away
            // steers cattle and calms faster than it frightens, while crowding them
            // panics the herd. A linear curve makes every approach equally dangerous
            // and there is nothing to play.
            // Cattle-lore widens the band a herder can work in, by making the same
            // proximity frighten the beast less. The modifier belongs to the herder,
            // not the cow: the herd is neutral and has no research of its own.
            const lore = tech?.modifier(world.faction[other]!, Modifier.HerdStress) ?? 1;
            threatWeight += strength * strength * lore;
          }
        }

        // How readily this beast catches its neighbours' panic, as a function of how
        // wound up it already is.
        //
        // This curve is doing the same job for contagion that the square law does for
        // approach distance, and for the same reason. A shallow version of it — a high
        // floor, so even calm cattle catch easily — makes the cascade turn on herd
        // GEOMETRY, which the player cannot see or influence: measured over twelve
        // seeds it gave anywhere from 1 to 23 of 30, on identical input. That is the
        // coin flip ADR-0014 exists to prevent.
        //
        // Steep, with a low floor, the cascade turns on herd STRESS instead: a calm
        // herd shrugs off a single bolter, a herd that has been pressed hard goes with
        // it. Stress is the thing the player controls by how closely they work the
        // herd, and the thing the stress rings already display, so the outcome follows
        // something visible and chosen rather than something hidden and arbitrary.
        const wound = world.stress[index]! / c.stressMax;
        const nerve = 0.06 + 0.94 * wound * wound;
        const panic = panicWeight * c.panicGain * nerve;

        /*
         * Inside its own kraal a beast settles.
         *
         * This is what makes an enclosure an enclosure rather than open ground somebody
         * drew a fence on: a penned animal stops wandering off and calms faster than one
         * out on the veld. It is also simply true — a kraal is where cattle are put to be
         * quiet overnight, and the whole homestead is built around that.
         *
         * NOT a wall. Nothing traps a beast here: a stampede still carries it straight
         * out, and a herder can still drive it wherever they like. It just has no reason
         * of its own to leave.
         */
        let penned = false;
        let pennedX = 0;
        let pennedY = 0;
        for (let p = 0; p < pens.length; p += 3) {
          const dx = posX - pens[p]!;
          const dy = posY - pens[p + 1]!;
          const reach = pens[p + 2]!;
          if (dx * dx + dy * dy <= reach * reach) {
            penned = true;
            pennedX = pens[p]!;
            pennedY = pens[p + 1]!;
            break;
          }
        }

        const stressed = threatWeight > 0 || panic > 0;
        let stress = world.stress[index]!;
        stress += stressed
          ? (c.stressGain * threatWeight + panic) * tuning.movement.dt
          : -c.stressDecay * (penned ? c.pennedCalm : 1) * tuning.movement.dt;
        if (stress < 0) stress = 0;
        else if (stress > c.stressMax) stress = c.stressMax;
        world.stress[index] = stress;

        // --- state transitions -------------------------------------------------
        let state = world.herdState[index]! as HerdState;

        if (state === HerdState.Stampeding) {
          if (world.stampedeTicks[index]! > 0) world.stampedeTicks[index]!--;
          if (world.stampedeTicks[index] === 0 && stress <= c.stampedeCalmStress) {
            state = HerdState.Grazing;
          }
        } else if (stress >= c.stressMax) {
          state = HerdState.Stampeding;
          world.stampedeTicks[index] = c.stampedeTicks;
          world.tetheredTo[index] = NULL_HANDLE;
          stats.stampedes++;
          events.push(
            makeEvent(
              world.tick,
              EventType.StampedeBegan,
              packHandle(index, world.generation[index]!),
              posX,
              posY,
            ),
          );
        } else if (world.tetheredTo[index] !== NULL_HANDLE) {
          state = isAlive(world, world.tetheredTo[index]!) ? HerdState.Leashed : HerdState.Grazing;
          if (state === HerdState.Grazing) world.tetheredTo[index] = NULL_HANDLE;
        } else {
          state = stressed ? HerdState.Alarmed : HerdState.Grazing;
        }
        world.herdState[index] = state;

        // --- desired velocity ---------------------------------------------------
        let desiredX = 0;
        let desiredY = 0;

        if (state === HerdState.Stampeding) {
          // Away from the threat, flat out. If the threat has gone, keep the heading:
          // a stampede that stops the instant its cause leaves is not a stampede.
          const length = Math.sqrt(threatX * threatX + threatY * threatY);
          if (length > 1e-9) {
            desiredX = (threatX / length) * c.stampedeSpeed;
            desiredY = (threatY / length) * c.stampedeSpeed;
          } else {
            const speed = Math.sqrt(
              world.velX[index]! * world.velX[index]! + world.velY[index]! * world.velY[index]!,
            );
            if (speed > 1e-9) {
              desiredX = (world.velX[index]! / speed) * c.stampedeSpeed;
              desiredY = (world.velY[index]! / speed) * c.stampedeSpeed;
            }
          }
        } else {
          /*
           * Penned cattle crowd, which is what a kraal IS.
           *
           * Twelve beasts that shove each other apart at a tile and a half cannot fit in
           * a two-tile pen: they pushed each other past the wall and, once outside the
           * pen's reach, went back to wandering and drifted away one at a time. Standing
           * shoulder to shoulder overnight is the actual behaviour and it is the only
           * thing that makes an enclosure of this size hold a herd of this size.
           */
          const crowding = penned ? c.pennedCrowd : 1;
          desiredX = separationX * c.separationWeight * crowding + threatX * c.herderWeight;
          desiredY = separationY * c.separationWeight * crowding + threatY * c.herderWeight;

          if (cohesionCount > 0) {
            const centreX = cohesionX / cohesionCount - posX;
            const centreY = cohesionY / cohesionCount - posY;
            desiredX += centreX * c.cohesionWeight;
            desiredY += centreY * c.cohesionWeight;
          }
          if (alignCount > 0) {
            desiredX += (alignX / alignCount) * c.alignmentWeight;
            desiredY += (alignY / alignCount) * c.alignmentWeight;
          }

          if (state === HerdState.Leashed) {
            const herder = handleIndex(world.tetheredTo[index]!);
            const dx = world.posX[herder]! - posX;
            const dy = world.posY[herder]! - posY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            // Only pulls once the tether is taut, so a herded beast still grazes.
            if (distance > c.leashRadius) {
              desiredX += (dx / distance) * c.leashWeight * (distance - c.leashRadius);
              desiredY += (dy / distance) * c.leashWeight * (distance - c.leashRadius);
            }
          } else if (state === HerdState.Grazing && !penned) {
            desiredX += nextSigned(world.rng) * c.wanderWeight;
            desiredY += nextSigned(world.rng) * c.wanderWeight;
          } else if (state === HerdState.Grazing) {
            // Penned: settle toward the middle rather than drift out through the wall.
            desiredX += (pennedX - posX) * c.pennedSettle;
            desiredY += (pennedY - posY) * c.pennedSettle;
          }

          const speed = Math.sqrt(desiredX * desiredX + desiredY * desiredY);
          if (speed > c.maxSpeed) {
            desiredX = (desiredX / speed) * c.maxSpeed;
            desiredY = (desiredY / speed) * c.maxSpeed;
          }
        }

        // --- integrate, substepped ---------------------------------------------
        // Steering integrated once per 50ms tick overshoots and the herd oscillates.
        // Three substeps plus an acceleration clamp settles it.
        for (let sub = 0; sub < c.substeps; sub++) {
          let vx = world.velX[index]!;
          let vy = world.velY[index]!;

          const accelX = desiredX - vx;
          const accelY = desiredY - vy;
          const accel = Math.sqrt(accelX * accelX + accelY * accelY);
          const limit = c.accelClamp * dt;

          if (accel > limit && accel > 1e-9) {
            vx += (accelX / accel) * limit;
            vy += (accelY / accel) * limit;
          } else {
            vx = desiredX;
            vy = desiredY;
          }

          world.velX[index] = vx;
          world.velY[index] = vy;
          // Through displace like everything else that moves. Cattle steer themselves —
          // the movement system skips anything that is not a Unit — and for a long time
          // that meant they were the only entities in the simulation with no terrain
          // underneath them at all: a stampede ran off the edge of the map and kept
          // going, and walked through cliffs on the way.
          displace(world, index, world.posX[index]! + vx * dt, world.posY[index]! + vy * dt);
        }

        const vx = world.velX[index]!;
        const vy = world.velY[index]!;
        const speed = Math.sqrt(vx * vx + vy * vy);
        if (speed > 1e-6) {
          const desiredFacing = atan2(vy, vx);
          const delta = angleDelta(world.facing[index]!, desiredFacing);
          const maxTurn = tuning.movement.turnRate * tuning.movement.dt;
          world.facing[index] =
            world.facing[index]! +
            (delta > maxTurn ? maxTurn : delta < -maxTurn ? -maxTurn : delta);
        }

        world.animState[index] =
          state === HerdState.Stampeding ? ANIM_STAMPEDE : speed > 0.05 ? ANIM_WALK : ANIM_IDLE;
      }

      crush(world, grid, events, stats, neighbours, displace);
    },
  };
}

/**
 * Stampede crush, tested against the swept path rather than the end position.
 *
 * At full speed a cow moves further in one tick than its crush radius, so a discrete
 * check misses people it ran straight over. The cost of getting this wrong is not a
 * crash but a mechanic that works four times in five, which reads as bad luck.
 */
function crush(
  world: World,
  grid: SpatialGrid,
  events: SimEvent[],
  stats: CattleStats,
  neighbours: number[],
  displace: Displace,
): void {
  const c = tuning.cattle;
  const radiusSq = c.crushRadius * c.crushRadius;

  for (let index = 0; index < world.capacity; index++) {
    if (world.alive[index] !== 1 || world.kind[index] !== EntityKind.Cattle) continue;
    if (world.herdState[index] !== HerdState.Stampeding) continue;

    const fromX = world.prevX[index]!;
    const fromY = world.prevY[index]!;
    const toX = world.posX[index]!;
    const toY = world.posY[index]!;

    // Query around the midpoint, wide enough to cover the whole swept segment.
    const travel = Math.sqrt((toX - fromX) * (toX - fromX) + (toY - fromY) * (toY - fromY));
    const count = grid.query(
      (fromX + toX) / 2,
      (fromY + toY) / 2,
      travel / 2 + c.crushRadius + 1,
      neighbours,
    );

    for (let n = 0; n < count; n++) {
      const victim = neighbours[n]!;
      if (world.alive[victim] !== 1) continue;
      if (world.kind[victim] === EntityKind.Cattle) continue;

      const distanceSq = pointSegmentDistanceSq(
        world.posX[victim]!,
        world.posY[victim]!,
        fromX,
        fromY,
        toX,
        toY,
      );
      if (distanceSq > radiusSq) continue;

      const hp = world.hp[victim]!;
      world.hp[victim] = hp > c.crushDamage ? hp - c.crushDamage : 0;

      // Knocked along the cow's travel, not away from it: being run over throws you
      // forward. Through displace, so a charge at the map edge or a cliff cannot put
      // the victim somewhere it could not have walked.
      if (travel > 1e-9) {
        displace(
          world,
          victim,
          world.posX[victim]! + ((toX - fromX) / travel) * c.knockback,
          world.posY[victim]! + ((toY - fromY) / travel) * c.knockback,
        );
      }

      stats.crushes++;
      events.push(
        makeEvent(
          world.tick,
          EventType.Crushed,
          packHandle(victim, world.generation[victim]!),
          world.posX[victim]!,
          world.posY[victim]!,
          c.crushDamage,
        ),
      );
    }
  }
}
