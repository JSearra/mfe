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
import { Stage, stageOf, type Woodland } from '../woodland.js';
import { EntityKind, HerdState, packHandle, type World } from '../world.js';
import { Work } from '../labour.js';

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
    /**
     * The wood, so the neighbour can cut its own timber.
     *
     * Optional, because a good deal of this project's test harness builds an AI without
     * one and a village that cannot fell is still a village. Where it is absent the AI
     * simply never cuts, which is what it did before it was passed at all.
     */
    woodland?: Woodland,
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
  /** What the ration was last set to, so the AI only sends a command when it changes. */
  let onShortRations = false;

  return {
    stats,

    decide(world, fog, economy, alliance, tech, emit, woodland): void {
      const ai = tuning.ai;
      if (world.tick % ai.decideEveryTicks !== 0) return;
      stats.decisions++;

      const own: Sighting[] = [];
      const cattle: Sighting[] = [];
      /** Our finished homesteads — where replacements come from. */
      const trainers: number[] = [];
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

      /*
       * --- raise a household -----------------------------------------------
       *
       * Only if the land will carry one. `economy.feeds` is the number the HUD puts in
       * front of the human — "land feeds 63" — and the whole of the win path is to
       * break more ground rather than to raise more people. The neighbour was doing the
       * opposite as fast as it could afford to.
       *
       * Measured over a 24,000-tick match before this: 14 villagers became 63 on land
       * that feeds 64-77 in a good year, which pinned the granary at about 145 — just
       * above the training floor of 160 and nowhere near the build bar of 400 — so it
       * raised exactly ONE homestead in twenty minutes. Then the drought came, feeds
       * fell to 16 against 63 mouths, every villager starved, and the grain climbed to
       * 1,070 with nobody left to eat it.
       *
       * The rule this replaces — "replacements before anything else discretionary" —
       * was written when there were losses to replace. Nothing kills a villager now but
       * hunger, so training through a shortage is not replacing losses, it is causing
       * them.
       *
       * A MARGIN below `feeds`, not up to it. `feeds` is what the LAST harvest would
       * carry, and a village grown to exactly that has no room for the next season —
       * which is the definition of imprudence in this game. Capping at feeds alone was
       * tried and changed nothing at all: the village still grew to 63 in the good
       * years, because 63 was under the good years' limit, and the drought still killed
       * all of it. The number that matters is what the land carries in a BAD year.
       *
       * `feedsMargin` is 0.6, which is roughly what a village can carry on short
       * commons — and the branch below puts it on short commons when it needs to, so
       * the two numbers are the same decision seen from either end.
       *
       * Before the first upkeep `feeds` is nought and the floor of one lets the opening
       * spend through, which is what allows a village to get started at all.
       */
      const carries = Math.max((economy.feeds[player] ?? 0) * ai.feedsMargin, 1);
      if (trainers.length > 0 && own.length < carries) {
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

      /*
       * --- the ration ------------------------------------------------------
       *
       * The same move the player has, taken on the same evidence: grain was owed and
       * unpaid at the last upkeep. A village on short commons eats 60% and works at
       * 65%, which is the trade, and it comes off rations the moment the shortfall is
       * met rather than staying on them out of caution — a neighbour permanently at
       * two-thirds speed is not a neighbour worth racing.
       *
       * Emitted only on a CHANGE. A command every twenty ticks that sets the ration to
       * what it already is would be twelve hundred commands a match in the log and in
       * every replay of it.
       */
      const wantShort = (economy.shortfall[player] ?? 0) > 0;
      if (wantShort !== onShortRations) {
        onShortRations = wantShort;
        emit({ kind: CommandKind.SetRation, a: wantShort ? 1 : 0, b: 0, c: 0, d: player });
      }

      /*
       * --- work ------------------------------------------------------------
       *
       * The fields and the building sites used to be worked from here, by hand, every
       * decision — and the tending branch took four tries to get right, because every
       * other branch below re-ordered the same people away again. Work finds its own
       * people now (src/sim/labour.ts, Phase B2), for the computer exactly as for the
       * human, so what the neighbour decides is what exists and where. It orders only
       * the people nobody has put to work, which is what a player does too.
       */
      const free = own.filter((hand) => world.workKind[hand.index] === Work.None);

      /*
       * --- timber ----------------------------------------------------------
       *
       * A village opens with 90 timber, every building costs some, and until this
       * nothing in here ever cut a tree — the woodland was not even passed in.
       * Measured: a twenty-minute match ended with the AI holding 10 timber, 460 grain
       * and nothing it could spend the grain on. Timber is the one resource that cannot
       * be reliably traded for and cannot be grown by building; it has to be walked to
       * and cut, so an opponent that cannot do that has a ceiling two buildings above
       * where it starts.
       *
       * ONLY WHEN SHORT, and that is the whole of what keeps the wood a wood. A village
       * that fells everything within reach has taken the one renewable thing on the map
       * and made it not renewable — see src/sim/woodland.ts, where a standing wood is
       * what seeds the next one. It cuts to a ceiling and stops.
       */
      if (woodland !== undefined && economy.balance(player, Resource.Wood) < ai.timberFloor) {
        // The nearest standing tree to somebody who could swing at it. `fell` refuses
        // unless a villager is already within reach, so the order is: find the tree
        // closest to the village, send a few people, and cut it once they arrive. The
        // same two-step the builders use.
        let best = -1;
        let bestDistance = Infinity;
        for (let index = 0; index < woodland.count; index++) {
          if (woodland.alive[index] === 0) continue;
          // A sapling yields nothing to an axe, so cutting one is pure loss — it is the
          // tree that would have been worth cutting in a few seasons.
          if (stageOf(woodland, index) === Stage.Sapling) continue;

          const dx = woodland.x[index]! - homeX;
          const dy = woodland.y[index]! - homeY;
          const distance = dx * dx + dy * dy;
          // Strictly nearer, so a tie keeps the lower index and the choice does not
          // depend on iteration order. Same total-order rule as everything else here.
          if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
          }
        }

        if (best >= 0) {
          const treeX = woodland.x[best]!;
          const treeY = woodland.y[best]!;
          // Send a few, not everybody. The same reasoning as the drovers: a village
          // that walks off in one body to cut a tree is a village doing nothing else.
          // Drawn from the hands nobody has put to work.
          const axes = free;
          for (let i = 0; i < Math.min(ai.builders, axes.length); i++) {
            const hand = axes[(stats.decisions + i) % axes.length]!;
            const dx = world.posX[hand.index]! - treeX;
            const dy = world.posY[hand.index]! - treeY;
            if (dx * dx + dy * dy > 4) {
              emit({
                kind: CommandKind.MoveTo,
                a: packHandle(hand.index, world.generation[hand.index]!),
                b: treeX,
                c: treeY,
                d: 0,
              });
            }
          }
          // Ordered every decision while short. `fell` refuses until somebody is
          // actually standing there, and a refusal costs nothing — which is what lets
          // the move and the cut be the same branch rather than a state machine.
          emit({ kind: CommandKind.Fell, a: best, b: 0, c: 0, d: player });
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
      const wishlist: readonly BuildingType[] = [
        ...(homesteads < ai.wantedHomesteads ? [BuildingType.Umuzi] : []),
        ...(folds < ai.wantedFolds ? [BuildingType.IsibayaSezimbuzi] : []),
        ...(pits < ai.wantedPits ? [BuildingType.Umgodi] : []),
        BuildingType.GrainStore,
      ];

      /*
       * Ordered only if it can actually be paid for, IN TIMBER AS WELL AS GRAIN.
       *
       * Timber was never checked. The AI ordered on its grain balance alone and
       * `construction.place` refused every one of those orders for want of wood — and a
       * decision spent being refused is a decision not spent herding, trading or asking
       * a neighbour for help. It is the sort of waste that never shows up as a bug
       * because the AI simply appears a little slow.
       */
      /*
       * The best thing it can actually pay for, not the best thing it wants.
       *
       * The wishlist is a strict order of preference and the first cut of this took its
       * head and then asked whether that was affordable — so a village that wanted a
       * homestead and could not afford the timber for one built NOTHING, while a fold
       * it could pay for twice over sat below it on the list. Measured: timber pinned
       * at 35 for a whole match against a homestead's 55, and one building raised in
       * twenty minutes.
       *
       * A preference is a preference, not a blocker.
       */
      let wanted: BuildingType | null = null;
      for (const candidate of wishlist) {
        const cost = buildingSpec(candidate);
        if (
          economy.balance(player, Resource.Grain) > buildFloor + cost.grainCost &&
          economy.balance(player, Resource.Wood) >= cost.woodCost &&
          economy.balance(player, Resource.Cattle) >= cost.cattleCost
        ) {
          wanted = candidate;
          break;
        }
      }

      if (wanted !== null) {
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
          // Zero: an ordinary build, paid for and raised. Non-zero FOUNDS a building free
          // and already standing, which is the match script's privilege — see Build in
          // commands.ts, and the whole match the neighbour spent building for nothing
          // because this said `player`.
          d: 0,
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

      // --- herd -----------------------------------------------------------
      // Nothing to fight: go and take cattle, which is what the war is about.
      if (cattle.length > 0 && free.length > 0) {
        const herders = Math.min(free.length, cattle.length);
        for (let i = 0; i < herders; i++) {
          const unit = free[i]!;
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
      for (let i = 0; i < free.length; i++) {
        const unit = free[i]!;
        emit({
          kind: CommandKind.MoveTo,
          a: packHandle(unit.index, world.generation[unit.index]!),
          b: homeX + cos(step) * ai.herdRadius,
          c: homeY + sin(step) * ai.herdRadius,
          d: 0,
        });
      }
      stats.ordersIssued += free.length;
    },
  };
}
