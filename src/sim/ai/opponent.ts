import { BuildingType, buildingSpec } from '../../shared/buildings/index.js';
import { TECH_IDS } from '../../shared/tech/index.js';
import type { TechState } from '../tech.js';
import { CommandKind } from '../commands.js';
import { Resource, type Economy } from '../economy/ledger.js';
import { alliesOf, hasOffered, standingOf, type Alliance } from '../alliance.js';
import { cos, sin, TWO_PI } from '../math/trig.js';
import { isVisible, type FogState } from '../vision/fog.js';
import { tuning } from '../tuning.js';
import { MovementClass } from '../pathing/costs.js';
import { trainingCost } from '../production.js';
import { EntityKind, HerdState, packHandle, type World } from '../world.js';

/**
 * A computer neighbour.
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
  buildsOrdered: number;
  techsOrdered: number;
  herdsOrdered: number;
  troopsOrdered: number;
  alliancesSought: number;
}

export interface AiController {
  readonly stats: AiStats;
  /** Emits commands. Must not mutate the world — see the test that pins this. */
  decide(
    world: World,
    fog: FogState,
    economy: Economy,
    alliance: Alliance,
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
    buildsOrdered: 0,
    techsOrdered: 0,
    herdsOrdered: 0,
    troopsOrdered: 0,
    alliancesSought: 0,
  };

  /** Where the next building goes. Walked outward so sites do not pile up. */
  let buildSlot = 0;

  return {
    stats,

    decide(world, fog, economy, alliance, tech, emit): void {
      const ai = tuning.ai;
      if (world.tick % ai.decideEveryTicks !== 0) return;
      stats.decisions++;

      const own: Sighting[] = [];
      const cattle: Sighting[] = [];
      /** Our finished homesteads — where replacements come from. */
      const trainers: number[] = [];
      /** Our unfinished buildings. Somebody has to go and stand at them. */
      const sites: Sighting[] = [];
      let homesteads = 0;
      let pits = 0;
      let folds = 0;
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
        if (mine) {
          if (world.kind[index] !== EntityKind.Building) continue;
          const spec = buildingSpec(world.buildingType[index]!);
          const finished = world.buildProgress[index]! >= spec.work;
          // Every unfinished building, not just the homesteads — a granary left half
          // raised is grain the AI never earns.
          if (!finished) sites.push({ index, x, y });
          // Counted whether or not it is finished. A site already placed is a decision
          // already taken, and counting only finished ones would have the AI order a
          // second pit every decision until the first one was raised.
          if (spec.type === BuildingType.Umgodi) pits++;
          if (spec.type === BuildingType.IsibayaSezimbuzi) folds++;
          if (!spec.trains) continue;
          homesteads++;
          if (finished) trainers.push(index);
          continue;
        }

        // Everything else has to be seen to be acted on.
        if (!isVisible(fog, player, Math.floor(x), Math.floor(y))) continue;

        // Only cattle are worth noting on somebody else's ground now. A neighbour's
        // villagers are neither a threat nor an opportunity — see ADR-0019 and the
        // trade and alliance branches below, which are what dealing with them looks
        // like in this game.
        if (world.kind[index] === EntityKind.Cattle) {
          if (world.herdState[index] !== HerdState.Stampeding) cattle.push({ index, x, y });
        }
      }

      if (own.length === 0) return;
      homeX /= own.length;
      homeY /= own.length;

      // --- raise troops ----------------------------------------------------
      // Replacements before anything else discretionary. An army that cannot replace
      // losses is on a one-way path to zero however well it fights.
      if (trainers.length > 0) {
        const cost = trainingCost(MovementClass.Infantry);
        if (
          economy.balance(player, Resource.Grain) > ai.trainFloor + cost.grain &&
          economy.balance(player, Resource.Cattle) > cost.cattle
        ) {
          const trainer = trainers[stats.decisions % trainers.length]!;
          emit({
            kind: CommandKind.Train,
            a: packHandle(trainer, world.generation[trainer]!),
            b: MovementClass.Infantry,
            c: 0,
            d: 0,
          });
          stats.troopsOrdered++;
        }
      }

      // --- build ----------------------------------------------------------
      // A homestead before granaries: grain with nowhere to spend it wins nothing.
      //
      // Held back by whatever a replacement costs, once there is anywhere to train one.
      // The two floors overlapped the wrong way round — building fires at grainFloor
      // and training needs trainFloor plus the unit's own cost, which is higher — so
      // every grain that arrived was spent on a site just before it could reach the bar
      // for a soldier. That inverts the priority stated above it, and an army that
      // cannot replace losses is on a one-way path to zero however much it builds.
      const reserve =
        trainers.length > 0 ? ai.trainFloor + trainingCost(MovementClass.Infantry).grain : 0;
      const buildFloor = ai.grainFloor + reserve;

      /*
       * What to raise next, in order of what a village most needs.
       *
       * Homesteads first: grain with nowhere to spend it wins nothing, and people are
       * what everything else is for. Then the fold, which is the cheapest thing in the
       * catalogue and the only income a drought does not touch — a neighbour that keeps
       * eating through a dry year is the one worth racing. Then the pit, which protects
       * what the granaries are about to store. Then granaries without limit, which is
       * what the AI did before any of this and remains the endless sink for a surplus.
       *
       * The repertoire was Umuzi and GrainStore alone: two of the eight types in the
       * catalogue, with the ikhanda and the indlunkulu never built either. The pit and
       * the fold are added here and the weir is deliberately not — siting one needs a
       * shore tile and the AI picks its spots by arithmetic around its own homestead,
       * so it would order the same refusal every decision for the rest of the match.
       */
      const wanted: BuildingType | null =
        homesteads < ai.wantedHomesteads
          ? BuildingType.Umuzi
          : folds < ai.wantedFolds
            ? BuildingType.IsibayaSezimbuzi
            : pits < ai.wantedPits
              ? BuildingType.Umgodi
              : BuildingType.GrainStore;

      /*
       * Ordered only if it can actually be paid for, IN TIMBER AS WELL AS GRAIN.
       *
       * Timber was never checked. The AI ordered on its grain balance alone and
       * `construction.place` refused every one of those orders for want of wood — and a
       * decision spent being refused is a decision not spent herding, trading or asking
       * a neighbour for help. It is the sort of waste that never shows up as a bug
       * because the AI simply appears a little slow.
       */
      const spec = buildingSpec(wanted);
      const affordable =
        economy.balance(player, Resource.Grain) > buildFloor + spec.grainCost &&
        economy.balance(player, Resource.Wood) >= spec.woodCost &&
        economy.balance(player, Resource.Cattle) >= spec.cattleCost;

      if (affordable) {
        // A homestead sits close in; everything else rings outward, so a village grows
        // around its people rather than sprawling from the first slot chosen.
        const close = wanted === BuildingType.Umuzi;
        const spacing = ai.buildSpacing;
        const ring = close ? 1 : 1 + Math.floor(buildSlot / 4);
        const corner = buildSlot % 4;
        const offsetX = (corner === 0 || corner === 3 ? -1 : 1) * (close ? 3 : ring * spacing);
        const offsetY = (corner < 2 ? -1 : 1) * (close ? 3 : ring * spacing);

        emit({
          kind: CommandKind.Build,
          a: Math.floor(homeX + offsetX),
          b: Math.floor(homeY + offsetY),
          c: wanted,
          d: player,
        });
        buildSlot = (buildSlot + 1) % 16;
        stats.buildsOrdered++;
      }

      // --- trade ------------------------------------------------------------
      //
      // A village no longer proposes trades, and that is a fix rather than a cut.
      //
      // A Trade command does not just give — it TAKES from the other side's stores, at a
      // rate their own books set but without their agreeing to the moment. Measured in
      // play, a neighbour executed 173 trades in one match against a player who never
      // touched the panel, and timber left that player's stores while they were looking
      // elsewhere. It is the same consent gap that let a neighbour tie somebody into an
      // alliance they never asked for, sitting one branch away from it.
      //
      // The cheap and complete answer, now that trade is a side mechanic rather than the
      // centre of the game: only a village that ASKS may trade. The player still has the
      // whole panel — `offersFor` publishes what each neighbour will give, and clicking
      // one takes them up on it — and nothing can reach into a village that did not act.
      // An offer-and-accept protocol would close the same gap and cost a round trip on
      // every deal, which is a lot of machinery for a mechanic being de-emphasised.

      // --- alliances --------------------------------------------------------
      //
      // Sought when it went hungry and has nobody to fall back on, which is the only
      // circumstance in which a village would part with cattle every season for a
      // promise. It asks whoever thinks best of it, since that is who will say yes.
      //
      // It never walks out on a tie. Breaking one is a player's move: an AI that broke
      // faith whenever the tithe looked expensive would spend its reputation on nothing
      // and trade worse with everybody afterwards, which is exactly the cost the
      // mechanic exists to impose.
      if (alliesOf(alliance, player).length === 0) {
        // Answering first, and on every decision rather than the slow cadence: somebody
        // is waiting on it, and a neighbour who takes ten minutes to say yes is a
        // neighbour the offer expired on. A tie now needs both sides to ask, so without
        // this the computer never ties itself to anyone.
        let answered = false;
        for (let neighbour = 0; neighbour < economy.players; neighbour++) {
          if (neighbour === player || !hasOffered(alliance, neighbour, player)) continue;
          // Judged by what IT thinks of them, which is the direction consent runs in.
          if (standingOf(alliance, player, neighbour) < tuning.alliance.minStandingToAlly) continue;
          emit({ kind: CommandKind.Ally, a: neighbour, b: 0, c: 0, d: 0 });
          stats.alliancesSought++;
          answered = true;
          break;
        }

        // Asking is the slow half: a village that offered a tie every ten seconds would
        // be begging, and it only asks at all when it has gone hungry with nobody to
        // fall back on.
        if (
          !answered &&
          (economy.shortfall[player] ?? 0) > 0 &&
          stats.decisions % ai.tradeEveryDecisions === 0
        ) {
          let best = -1;
          let bestStanding = -Infinity;
          for (let neighbour = 0; neighbour < economy.players; neighbour++) {
            if (neighbour === player || hasOffered(alliance, player, neighbour)) continue;
            const regard = standingOf(alliance, neighbour, player);
            // Ties break on the lower index, so two identical neighbours are always
            // approached in the same order and a replay reproduces.
            if (regard > bestStanding) {
              bestStanding = regard;
              best = neighbour;
            }
          }
          if (best !== -1) {
            emit({ kind: CommandKind.Ally, a: best, b: 0, c: 0, d: 0 });
            stats.alliancesSought++;
          }
        }
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

      // --- finish what we started -------------------------------------------
      // A site is raised by whoever stands near it, and nothing here ever told anyone
      // to go and stand there. Sites finished anyway only because the builder check
      // counted units up to twice the real build radius away; once that was corrected
      // the AI completed nothing, never trained a replacement, and its economy never
      // started.
      //
      // A detachment rather than the whole army, and it does not return: the rest fall
      // through to the herd and the scout below. An AI that downed tools to build every
      // time it had grain for a granary would never take a cow.
      let assigned = 0;
      if (sites.length > 0) {
        let site = sites[0]!;
        let bestDistance = Infinity;
        for (const candidate of sites) {
          const dx = candidate.x - homeX;
          const dy = candidate.y - homeY;
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance || (distance === bestDistance && candidate.index < site.index)) {
            bestDistance = distance;
            site = candidate;
          }
        }

        assigned = Math.min(own.length, ai.builders);
        for (let i = 0; i < assigned; i++) {
          const unit = own[i]!;
          emit({
            kind: CommandKind.MoveTo,
            a: packHandle(unit.index, world.generation[unit.index]!),
            b: site.x,
            c: site.y,
            d: 0,
          });
        }
        stats.ordersIssued += assigned;
      }

      // --- herd -----------------------------------------------------------
      // Nothing to fight: go and take cattle, which is what the war is about.
      if (cattle.length > 0 && assigned < own.length) {
        const herders = Math.min(own.length, assigned + cattle.length);
        for (let i = assigned; i < herders; i++) {
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
        stats.ordersIssued += herders - assigned;
        return;
      }

      // --- scout ----------------------------------------------------------
      // Nothing seen at all. Push outward so the fog recedes rather than sitting still.
      // Owned trig, not Math.sin: AI decisions feed the replay hash, so they have to
      // reproduce bit-for-bit across engines like everything else in src/sim.
      const step = ((stats.decisions % 8) / 8) * TWO_PI;
      for (let i = assigned; i < own.length; i++) {
        const unit = own[i]!;
        emit({
          kind: CommandKind.MoveTo,
          a: packHandle(unit.index, world.generation[unit.index]!),
          b: homeX + cos(step) * ai.herdRadius,
          c: homeY + sin(step) * ai.herdRadius,
          d: 0,
        });
      }
      stats.ordersIssued += own.length - assigned;
    },
  };
}
