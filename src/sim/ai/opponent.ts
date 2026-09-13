import { BuildingType } from '../../shared/buildings/index.js';
import { TECH_IDS } from '../../shared/tech/index.js';
import type { TechState } from '../tech.js';
import { CommandKind } from '../commands.js';
import { Resource, type Economy } from '../economy/ledger.js';
import { cos, sin, TWO_PI } from '../math/trig.js';
import { isVisible, type FogState } from '../vision/fog.js';
import { tuning } from '../tuning.js';
import { EntityKind, HerdState, packHandle, type World } from '../world.js';

/**
 * A computer opponent.
 *
 * ARCHITECTURE section 6 predicted this would be cheap so long as one invariant held —
 * that all state change originates from a command — because then the AI is simply
 * another command source rather than a second way to mutate the world. It held. This
 * file emits commands and touches nothing, and a test asserts exactly that by hashing
 * the world either side of a decision.
 *
 * It also reads the world THROUGH ITS OWN FOG. That is partly fairness — an AI that sees
 * through terrain is not playing the same game — and partly that it exercises the
 * per-viewer information model, which is otherwise only used by the renderer.
 *
 * No randomness. Decisions follow from observable state with explicit tie-breaks, so an
 * AI-vs-AI match reproduces exactly, which is what makes it usable as a soak test.
 */

export interface AiCommand {
  readonly kind: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

export interface AiStats {
  decisions: number;
  ordersIssued: number;
  attacksOrdered: number;
  buildsOrdered: number;
  techsOrdered: number;
  herdsOrdered: number;
}

export interface AiController {
  readonly stats: AiStats;
  /** Emits commands. Must not mutate the world — see the test that pins this. */
  decide(
    world: World,
    fog: FogState,
    economy: Economy,
    tech: TechState,
    emit: (command: AiCommand) => void,
  ): void;
}

interface Sighting {
  index: number;
  x: number;
  y: number;
}

export function createAi(player: number): AiController {
  const stats: AiStats = {
    decisions: 0,
    ordersIssued: 0,
    attacksOrdered: 0,
    buildsOrdered: 0,
    techsOrdered: 0,
    herdsOrdered: 0,
  };

  /** Where the next building goes. Walked outward so sites do not pile up. */
  let buildSlot = 0;

  return {
    stats,

    decide(world, fog, economy, tech, emit): void {
      const ai = tuning.ai;
      if (world.tick % ai.decideEveryTicks !== 0) return;
      stats.decisions++;

      const own: Sighting[] = [];
      const foes: Sighting[] = [];
      const cattle: Sighting[] = [];
      let homeX = 0;
      let homeY = 0;

      for (let index = 0; index < world.capacity; index++) {
        if (world.alive[index] !== 1) continue;

        const x = world.posX[index]!;
        const y = world.posY[index]!;
        const mine = world.faction[index] === player;

        if (mine && world.kind[index] === EntityKind.Unit) {
          own.push({ index, x, y });
          homeX += x;
          homeY += y;
          continue;
        }
        if (mine) continue;

        // Everything else has to be seen to be acted on.
        if (!isVisible(fog, player, Math.floor(x), Math.floor(y))) continue;

        if (world.kind[index] === EntityKind.Cattle) {
          if (world.herdState[index] !== HerdState.Stampeding) cattle.push({ index, x, y });
        } else if (world.kind[index] === EntityKind.Unit) {
          foes.push({ index, x, y });
        }
      }

      if (own.length === 0) return;
      homeX /= own.length;
      homeY /= own.length;

      // --- build ----------------------------------------------------------
      // Grain first. An army that starves loses without anyone fighting it.
      if (economy.balance(player, Resource.Grain) > ai.grainFloor) {
        const spacing = ai.buildSpacing;
        const ring = 1 + Math.floor(buildSlot / 4);
        const corner = buildSlot % 4;
        const offsetX = (corner === 0 || corner === 3 ? -1 : 1) * ring * spacing;
        const offsetY = (corner < 2 ? -1 : 1) * ring * spacing;

        emit({
          kind: CommandKind.Build,
          a: Math.floor(homeX + offsetX),
          b: Math.floor(homeY + offsetY),
          c: BuildingType.GrainStore,
          d: player,
        });
        buildSlot = (buildSlot + 1) % 16;
        stats.buildsOrdered++;
      }

      // --- research -------------------------------------------------------
      // One advance at a time, in a fixed order, and only from surplus. An AI that
      // researches itself into starvation loses to one that never researches at all.
      if (economy.balance(player, Resource.Grain) > ai.grainFloor * 2) {
        for (let i = 0; i < TECH_IDS.length; i++) {
          if (!tech.canResearch(player, TECH_IDS[i]!)) continue;
          emit({ kind: CommandKind.Research, a: i, b: player, c: 0, d: 0 });
          stats.techsOrdered++;
          break;
        }
      }

      // --- fight ----------------------------------------------------------
      if (foes.length > 0) {
        const strongEnough = own.length >= foes.length * ai.attackStrengthRatio;

        if (strongEnough) {
          // Concentrate: everyone onto one target rather than spreading thin. The
          // target is the nearest to our centre, with the index tie-break every
          // argmin in this project carries.
          let target = foes[0]!;
          let bestDistance = Infinity;
          for (const foe of foes) {
            const dx = foe.x - homeX;
            const dy = foe.y - homeY;
            const distance = dx * dx + dy * dy;
            if (distance < bestDistance || (distance === bestDistance && foe.index < target.index)) {
              bestDistance = distance;
              target = foe;
            }
          }

          const targetHandle = packHandle(target.index, world.generation[target.index]!);
          for (const unit of own) {
            emit({
              kind: CommandKind.Attack,
              a: packHandle(unit.index, world.generation[unit.index]!),
              b: targetHandle,
              c: 0,
              d: 0,
            });
          }
          stats.attacksOrdered++;
          stats.ordersIssued += own.length;
          return;
        }

        // Outnumbered: pull back together rather than feeding units in piecemeal.
        for (const unit of own) {
          emit({
            kind: CommandKind.MoveTo,
            a: packHandle(unit.index, world.generation[unit.index]!),
            b: homeX,
            c: homeY,
            d: 0,
          });
        }
        stats.ordersIssued += own.length;
        return;
      }

      // --- herd -----------------------------------------------------------
      // Nothing to fight: go and take cattle, which is what the war is about.
      if (cattle.length > 0) {
        const herders = Math.min(own.length, cattle.length);
        for (let i = 0; i < herders; i++) {
          const unit = own[i]!;
          const cow = cattle[i % cattle.length]!;
          const dx = cow.x - unit.x;
          const dy = cow.y - unit.y;
          const near = dx * dx + dy * dy < 4;

          emit(
            near
              ? {
                  kind: CommandKind.Leash,
                  a: packHandle(unit.index, world.generation[unit.index]!),
                  b: packHandle(cow.index, world.generation[cow.index]!),
                  c: 0,
                  d: 0,
                }
              : {
                  kind: CommandKind.MoveTo,
                  a: packHandle(unit.index, world.generation[unit.index]!),
                  b: cow.x,
                  c: cow.y,
                  d: 0,
                },
          );
        }
        stats.herdsOrdered++;
        stats.ordersIssued += herders;
        return;
      }

      // --- scout ----------------------------------------------------------
      // Nothing seen at all. Push outward so the fog recedes rather than sitting still.
      // Owned trig, not Math.sin: AI decisions feed the replay hash, so they have to
      // reproduce bit-for-bit across engines like everything else in src/sim.
      const step = ((stats.decisions % 8) / 8) * TWO_PI;
      for (const unit of own) {
        emit({
          kind: CommandKind.MoveTo,
          a: packHandle(unit.index, world.generation[unit.index]!),
          b: homeX + cos(step) * ai.herdRadius,
          c: homeY + sin(step) * ai.herdRadius,
          d: 0,
        });
      }
      stats.ordersIssued += own.length;
    },
  };
}
