import type { SimEvent } from '../../shared/events.js';
import { EventType, makeEvent } from '../../shared/events.js';
import { FACTIONS, type FactionConfig, type FactionId } from '../../shared/factions/index.js';
import { cos, TWO_PI } from '../math/trig.js';
import { mixSeed } from '../math/rng.js';
import { tuning } from '../tuning.js';
import { EntityKind, handleIndex, isAlive, NULL_HANDLE, packHandle, type World } from '../world.js';

/**
 * The economic ledger: what each player holds, what it costs to keep, and what the
 * season is doing to the harvest.
 *
 * Everything here is driven by the tick counter. There is no wall clock in the
 * simulation, so upkeep lands on exact tick multiples forever rather than drifting a
 * frame at a time — which is also what lets a 10,000-tick replay reproduce the ledger
 * exactly.
 */

/**
 * What a village holds.
 *
 * `Ammunition` was 2 until Phase V6. It existed to be spent per shot and nothing else,
 * so retiring combat left it a column that could only ever go up. Unlike the event and
 * command enums, resource indices are not durable wire values — no recorded command log
 * names one — so this renumbers rather than leaving a gap, and the save format moves
 * with it.
 */
export const Resource = {
  Cattle: 0,
  Grain: 1,
  /** Timber, cut from the woodland. See src/sim/woodland.ts. */
  Wood: 2,
} as const;

export type Resource = (typeof Resource)[keyof typeof Resource];

export const RESOURCE_COUNT = 3;

/**
 * How much a village is eating.
 *
 * A bad year used to have exactly one outcome and no move in it: the granary ran out
 * and every unit the player owned took damage at once, and the only decision that had
 * ever mattered was the one taken ten minutes earlier. Cutting the ration is the move a
 * village actually has — eat less, work slower, come out the other side.
 *
 * It is a real decision and not a free one, because the work it costs is exactly the
 * work that would have dug the village out: fewer hands on a field, a granary that
 * takes longer to raise. Without that cost a short ration would be strictly better than
 * a full one in every season and no one would ever choose between them.
 *
 * Two states rather than a slider. The interesting question is whether to tighten the
 * belt, not by how much, and a slider would ask the player to optimise a number instead
 * of taking a decision.
 */
export const Ration = {
  Full: 0,
  Short: 1,
} as const;

export type Ration = (typeof Ration)[keyof typeof Ration];

export interface Economy {
  readonly players: number;
  /** players x RESOURCE_COUNT, row-major. */
  readonly amounts: Float64Array;
  readonly factions: readonly FactionConfig[];
  /** Upkeep cycles completed. */
  upkeepCount: number;
  /** Grain shortfall at the last upkeep, per player. */
  readonly shortfall: Float64Array;
  /**
   * What the last upkeep cost, and what came in to meet it, per player.
   *
   * Recorded so the player can be shown both before deciding to raise more households.
   * Without it, training is a trap the game springs silently: measured in play, a
   * village went from 24 mouths to 51 on a granary that could feed 24, and nothing on
   * screen said so until everyone was dead. `shortfall` only speaks once it is too late.
   */
  readonly upkeep: Float64Array;
  readonly harvested: Float64Array;
  /**
   * Households the last harvest would feed, alongside the herd this village already has.
   *
   * The number the objective is missing. A village starts able to feed about 38 and is
   * asked to settle 60, and nothing on screen connected those two facts — so a player
   * watching "Village 24/60" had no way to know that the answer was more fields rather
   * than more people. Ten untended fields feed 8; ten tended feed 38; fourteen tended
   * feed 69. That is the whole of the win path and it was invisible.
   */
  readonly feeds: Float64Array;
  /**
   * Grain held back in the pits, per player, against a hungry season.
   *
   * Simulation state and therefore saved. Kept beside `amounts` rather than inside it
   * because a reserve is not a resource the player spends — nothing can be bought with
   * it, trade cannot see it, and the only thing that ever draws on it is going short.
   * A fourth column in `amounts` would have had to be excluded by hand from every one
   * of those, which is four chances to forget.
   */
  readonly reserve: Float64Array;
  /** What each village is eating. Simulation state, and saved. */
  readonly ration: Uint8Array;

  balance(player: number, resource: Resource): number;
  /** Set a village's ration. Reversible, and one village's business alone. */
  setRation(player: number, ration: Ration): void;
  /**
   * How fast this village works, given what it is eating.
   *
   * Read by construction and production rather than applied here, because the ledger
   * charges for food and does not build things. The same shape as the tech modifiers
   * those systems already take.
   */
  labourFactor(player: number): number;
  add(player: number, resource: Resource, amount: number): void;
  spend(player: number, resource: Resource, amount: number): boolean;
  /** Seasonal drought, 0 (wet) to 1 (parched). A pure function of the tick. */
  drought(tick: number): number;
  /**
   * `buildingYield` is injected rather than imported so the ledger stays ignorant of
   * construction. The dependency runs one way: buildings know they produce grain; the
   * granary does not need to know what a granary is.
   */
  update(
    world: World,
    events: SimEvent[],
    buildingYield?: BuildingYield,
    grainMultiplier?: (player: number) => number,
    harvest?: Harvest,
    /**
     * How much grain this player's pits can hold, injected for the same reason
     * `buildingYield` is: the ledger knows that a village can put something by, and
     * does not need to learn what a building is to find out how much.
     */
    reserveCapacity?: (player: number) => number,
  ): void;
}

export type BuildingYield = (owner: number) => {
  grain: number;
  cattle: number;
  /**
   * Grain the drought does not touch.
   *
   * A separate channel rather than a flag on `grain`, because the two are summed from
   * different buildings in the same village and there is no single answer for the pair.
   * Goats and fowl browse scrub and eat scraps where cattle graze grass, so a fold
   * comes through a dry year that kills a herd — which is why a homestead that owned
   * cattle kept them anyway.
   */
  hardyGrain: number;
};

/**
 * What one field offers this cycle, `null` for a field that offers nothing, and
 * `undefined` once the caller has run off the end of them.
 *
 * Indexed rather than passed as an array so the ledger never holds a reference into the
 * farmland's arrays, which would make it a second owner of that state.
 */
export type Harvest = (
  index: number,
) => { owner: number; sheltered: boolean; share: number } | null | undefined;

export interface GrainPlot {
  readonly tileX: number;
  readonly tileY: number;
  readonly owner: number;
  /**
   * A plot in a river bottom or a kloof still yields when the open veld does not.
   * Sheltered ground is the drought's counterplay, and the reason drought is a pressure
   * rather than a timer that decides the match.
   */
  readonly sheltered: boolean;
}

/**
 * The ledger no longer holds the fields.
 *
 * It used to take a static `GrainPlot[]` laid out at map generation and yield from it
 * forever, which made arable land a property of the map. Fields are placed, worked and
 * lost now (src/sim/economy/farmland.ts), so the ledger asks what they have rather than
 * owning them — two owners of the same state is how a save comes back wrong.
 */
export function createEconomy(factionIds: readonly FactionId[], seed: number): Economy {
  const players = factionIds.length;
  const factions = factionIds.map((id) => FACTIONS[id]);
  const amounts = new Float64Array(players * RESOURCE_COUNT);
  const shortfall = new Float64Array(players);
  const upkeep = new Float64Array(players);
  const harvested = new Float64Array(players);
  const feeds = new Float64Array(players);
  const reserve = new Float64Array(players);
  const ration = new Uint8Array(players);

  for (let player = 0; player < players; player++) {
    const config = factions[player]!;
    amounts[player * RESOURCE_COUNT + Resource.Cattle] = config.startingCattle;
    amounts[player * RESOURCE_COUNT + Resource.Grain] = config.startingGrain;
    amounts[player * RESOURCE_COUNT + Resource.Wood] = config.startingWood;
  }

  const e = tuning.economy;

  const economy: Economy = {
    players,
    amounts,
    factions,
    upkeepCount: 0,
    shortfall,
    upkeep,
    harvested,
    feeds,
    reserve,
    ration,

    balance(player, resource) {
      return amounts[player * RESOURCE_COUNT + resource] ?? 0;
    },

    add(player, resource, amount) {
      const at = player * RESOURCE_COUNT + resource;
      amounts[at] = (amounts[at] ?? 0) + amount;
      if (amounts[at]! < 0) amounts[at] = 0;
    },

    spend(player, resource, amount) {
      const at = player * RESOURCE_COUNT + resource;
      if ((amounts[at] ?? 0) < amount) return false;
      amounts[at] = amounts[at]! - amount;
      return true;
    },

    /**
     * Drought over the year, with a per-year severity that gets worse as the match ages.
     *
     * Severity is derived by hashing the year index rather than by drawing from the
     * simulation RNG. A query that consumed RNG state would change the sequence every
     * other system sees, turning a pure-looking lookup into a hidden side effect — and
     * it would mean calling drought() twice gave two different answers.
     *
     * **The first year is deliberately gentle, and that is a fix rather than a mood.**
     * Severity used to be drawn from the same range every year, which made 40% of
     * openings peak above 0.85 — open fields under 28% — and some of them a total crop
     * failure in year one. A village starts with four hundred grain and no reserves, so
     * those openings were lost before the player did anything, by weather they could not
     * see coming and had no instrument against. It ramps in over three years now: the
     * opening is a season the village has already survived, and the ruinous years arrive
     * once there is a granary and a herd to meet them with.
     */
    setRation(player, value) {
      if (player < players) ration[player] = value;
    },

    labourFactor(player) {
      return ration[player] === Ration.Short ? e.rationShortLabour : 1;
    },

    drought(tick) {
      const year = Math.floor(tick / e.seasonTicks);
      const phase = (tick % e.seasonTicks) / e.seasonTicks;
      // 0 at the start of the year, 1 at its height.
      const curve = (1 - cos(phase * TWO_PI)) / 2;
      // Severity in [0.55, 1.05], so some years are merely dry and some are ruinous.
      const spread = 0.55 + (mixSeed(seed, year) / 4294967296) * 0.5;
      const mercy = e.firstYearSeverity + year * e.severityRampPerYear;
      const severity = spread * (mercy > 1 ? 1 : mercy);
      const value = curve * severity;
      return value < 0 ? 0 : value > 1 ? 1 : value;
    },

    update(world, events, buildingYield, grainMultiplier, harvest, reserveCapacity) {
      const tick = world.tick;
      if (tick === 0 || tick % e.upkeepIntervalTicks !== 0) return;

      economy.upkeepCount++;
      harvested.fill(0);

      /*
       * Grain in the open granary goes off.
       *
       * Not a tax on running a village: at the shipped rate a village working on a few
       * hundred grain loses a fraction of a single unit of upkeep a cycle, and would
       * not notice if it were not told. It is a reason not to sit on four thousand for
       * a year, which until now was strictly the best thing a careful player could do —
       * grain accumulated for ever and the only pressure on a hoard was the temptation
       * to spend it.
       *
       * It exists because an umgodi has to be worth digging, and the first design of
       * one was not. A pit that drew from the granary in a shortfall and refilled from
       * it in a surplus does not extend a village's life by a single cycle: the total
       * is conserved, so all it ever did was move the same grain later. Grain that
       * KEEPS, against grain that does not, is the difference the real pits were dug
       * for — a sealed pit holds a harvest for years where a basket does not — and it
       * is the only version of the building that is worth anything.
       *
       * Before the harvest lands, so a village is never taxed on grain it has not had a
       * season to use.
       */
      for (let player = 0; player < players; player++) {
        const held = economy.balance(player, Resource.Grain);
        if (held > 0) economy.spend(player, Resource.Grain, held * e.grainSpoilPerCycle);
      }
      const droughtNow = economy.drought(tick);

      /*
       * Yield falls away with the drought instead of off a cliff at a threshold.
       *
       * It used to be all or nothing: below droughtThreshold a plot paid
       * base * (1 - drought/2), and at or above it the open veld paid nothing at all.
       * At the shipped numbers that was 37.8 grain a cycle at 74% drought and 8.1 at
       * 75% — an 86% collapse for a one-point change in a value the player watches tick
       * upward. Nothing about that is plannable, and planning around the dry season is
       * the whole of what this mechanic is for.
       *
       * Squared, so the bite comes late: a merely dry year is a dip, a real drought is a
       * catastrophe. Sheltered ground — a river bottom, a kloof — never falls below its
       * floor, which is what makes it worth holding and is the drought's counterplay.
       */
      const openFactor = 1 - droughtNow * droughtNow;
      const shelteredFactor =
        openFactor < e.shelteredYieldFactor ? e.shelteredYieldFactor : openFactor;

      // --- harvest ----------------------------------------------------------
      //
      // The fields are asked what they have rather than read directly, so the ledger
      // keeps owning the weather and the fields keep owning their own condition. A
      // field that is not yet established, or has been grazed to nothing, offers
      // nothing and the ledger does not need to know which.
      if (harvest !== undefined) {
        for (let index = 0; ; index++) {
          const field = harvest(index);
          if (field === undefined) break;
          if (field === null) continue;
          if (field.owner >= players) continue;
          const yielded =
            e.plotBaseYield * (field.sheltered ? shelteredFactor : openFactor) * field.share;
          economy.add(field.owner, Resource.Grain, yielded);
          harvested[field.owner] = harvested[field.owner]! + yielded;
        }
      }

      // --- buildings --------------------------------------------------------
      if (buildingYield !== undefined) {
        for (let player = 0; player < players; player++) {
          const produced = buildingYield(player);
          // A granary full of nothing is still empty: buildings share the drought, on
          // the sheltered curve — they are built structures, not open veld.
          const multiplier = grainMultiplier?.(player) ?? 1;
          const stored = produced.grain * shelteredFactor * multiplier;
          // The fold's share is NOT put through the weather. That is the whole of what
          // distinguishes it from a granary, and folding it into the line above would
          // quietly delete the building.
          const hardy = produced.hardyGrain * multiplier;
          economy.add(player, Resource.Grain, stored + hardy);
          harvested[player] = harvested[player]! + stored + hardy;
          economy.add(player, Resource.Cattle, produced.cattle);
        }
      }

      // --- headcount --------------------------------------------------------
      const units = new Float64Array(players);
      const herds = new Float64Array(players);
      for (let i = 0; i < world.capacity; i++) {
        if (world.alive[i] !== 1) continue;

        if (world.kind[i] === EntityKind.Cattle) {
          // A cow eats the grain of whoever is DRIVING it, which is not the same as the
          // faction it was born into. Cattle spawn neutral and leashing one sets its
          // tether and its herd state, never its faction — so charging world.faction
          // here charged the neutral faction, which has no ledger, and a driven herd
          // cost its owner nothing while still counting toward the cattle victory.
          //
          // Resolved through the tether, which is how the cattle victory counted the same
          // animals. The two agreed about who holds a herd.
          const tether = world.tetheredTo[i]!;
          if (tether === NULL_HANDLE || !isAlive(world, tether)) continue;
          const driver = world.faction[handleIndex(tether)]!;
          if (driver < players) herds[driver]!++;
          continue;
        }

        const owner = world.faction[i]!;
        if (owner >= players) continue;
        units[owner]!++;
      }

      for (let player = 0; player < players; player++) {
        const config = factions[player]!;

        // Cattle on the ledger are the standing herd; cattle on the map are the ones
        // being driven. Both eat.
        const onLedger = economy.balance(player, Resource.Cattle);
        const totalCattle = onLedger + herds[player]!;
        /*
         * The ration applies to the PEOPLE and not to the herd.
         *
         * Cattle are not rationed; they graze, and what they eat is grass rather than
         * the village's grain — `grainPerCattle` is the fodder and salt a standing herd
         * costs its keeper, not a portion anyone can choose to cut. A village that
         * wants to spend less on its cattle has the cull for that, which is a decision
         * with a price rather than a dial.
         */
        const eats = ration[player] === Ration.Short ? e.rationShortFactor : 1;
        const needed =
          (units[player]! * e.grainPerUnit * eats + totalCattle * e.grainPerCattle) *
          config.upkeepMultiplier;

        upkeep[player] = needed;
        // What the land could carry, as opposed to what it is carrying. The herd is
        // counted first because it eats whether or not anybody plans for it.
        const forHerd = totalCattle * e.grainPerCattle * config.upkeepMultiplier;
        const spare = (harvested[player]! - forHerd) / (e.grainPerUnit * config.upkeepMultiplier);
        feeds[player] = spare > 0 ? Math.floor(spare) : 0;

        const capacity = reserveCapacity?.(player) ?? 0;
        // A pit that has been filled in — demolished, or never dug — cannot be holding
        // grain. Clamped rather than left, or a reserve would survive the thing that
        // held it.
        if (reserve[player]! > capacity) reserve[player] = capacity;

        const held = economy.balance(player, Resource.Grain);
        if (held >= needed) {
          economy.spend(player, Resource.Grain, needed);
          shortfall[player] = 0;

          /*
           * Put something by, out of what is left after everyone has eaten.
           *
           * A share of the surplus rather than all of it, so digging a pit is never a
           * way to make grain disappear from a village that wanted to spend it. The
           * pit is a hedge against the season, and a hedge that swallowed the whole
           * harvest would be a tax.
           */
          const spare = economy.balance(player, Resource.Grain);
          const room = capacity - reserve[player]!;
          if (room > 0 && spare > 0) {
            const stored = Math.min(spare * e.pitFillRate, room);
            economy.spend(player, Resource.Grain, stored);
            reserve[player] = reserve[player]! + stored;
          }

          // The herd grows only when it is fed, and grows slowly on dry grazing.
          const growth =
            (onLedger * e.cattleGrowthPerHundred) / 100 * config.herdGrowthMultiplier;
          economy.add(player, Resource.Cattle, growth * shelteredFactor);
        } else {
          /*
           * The pit opens before anybody goes hungry, and empties before anybody does.
           *
           * Before rather than after, which is the whole of what it buys: starvation
           * damage falls on every unit the player owns at once, so a village that dies
           * and is then handed its reserve has been handed nothing. Drawn down to
           * whatever the granary was short, so a pit too small for the famine still
           * pays out all it has and the hunger that follows is only what it could not
           * meet.
           */
          economy.spend(player, Resource.Grain, held);
          let missing = needed - held;
          const drawn = Math.min(reserve[player]!, missing);
          reserve[player] = reserve[player]! - drawn;
          missing -= drawn;

          shortfall[player] = missing;
          // In proportion to what was missed, not to the fact of missing. See `starve`.
          if (missing > 0) starve(world, player, events, needed > 0 ? missing / needed : 1);
        }
      }
    },
  };

  return economy;
}

/**
 * Hunger falls on the people, not the herd: eating the herd is the player's choice.
 *
 * **In proportion to the shortfall**, which `tasks/plan.md` section F has wanted since
 * September: being five grain short did the same damage, to every unit the player
 * owned, as being five hundred short.
 *
 * That was not only harsh, it made the whole of this game's counterplay worthless. A
 * grain pit and a cut ration both exist to turn a catastrophic shortfall into a small
 * one, and while a small one was just as lethal neither of them bought anything at all
 * — a village that covered 95% of its upkeep died exactly as fast as one that covered
 * none of it. A village one grain short has not had a famine; it has had a thin week.
 *
 * The full figure is the CEILING rather than the new baseline, so a total failure costs
 * exactly what it always did and nothing here makes the game harsher than it was.
 *
 * The event still fires for everyone, however small the miss. The alert bar is the only
 * thing that tells a player their village is going short at all, and going quiet on a
 * near miss would hide the warning precisely when it is still early enough to act on.
 */
function starve(world: World, player: number, events: SimEvent[], fraction: number): void {
  const share = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  const damage = tuning.economy.starvationDamage * share;

  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1) continue;
    if (world.faction[i] !== player || world.kind[i] !== EntityKind.Unit) continue;

    const hp = world.hp[i]!;
    world.hp[i] = hp > damage ? hp - damage : 0;
    events.push(
      makeEvent(
        world.tick,
        EventType.Starved,
        packHandle(i, world.generation[i]!),
        world.posX[i]!,
        world.posY[i]!,
        damage,
      ),
    );
  }
}
