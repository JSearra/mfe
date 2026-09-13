import type { SimEvent } from '../../shared/events.js';
import { EventType, makeEvent } from '../../shared/events.js';
import { FACTIONS, type FactionConfig, type FactionId } from '../../shared/factions/index.js';
import { cos, TWO_PI } from '../math/trig.js';
import { mixSeed } from '../math/rng.js';
import { tuning } from '../tuning.js';
import { EntityKind, packHandle, type World } from '../world.js';

/**
 * The economic ledger: what each player holds, what it costs to keep, and what the
 * season is doing to the harvest.
 *
 * Everything here is driven by the tick counter. There is no wall clock in the
 * simulation, so upkeep lands on exact tick multiples forever rather than drifting a
 * frame at a time — which is also what lets a 10,000-tick replay reproduce the ledger
 * exactly.
 */

export const Resource = {
  Cattle: 0,
  Grain: 1,
  Ammunition: 2,
} as const;

export type Resource = (typeof Resource)[keyof typeof Resource];

export const RESOURCE_COUNT = 3;

export interface Economy {
  readonly players: number;
  /** players x RESOURCE_COUNT, row-major. */
  readonly amounts: Float64Array;
  readonly factions: readonly FactionConfig[];
  /** Upkeep cycles completed. */
  upkeepCount: number;
  /** Grain shortfall at the last upkeep, per player. */
  readonly shortfall: Float64Array;

  balance(player: number, resource: Resource): number;
  add(player: number, resource: Resource, amount: number): void;
  spend(player: number, resource: Resource, amount: number): boolean;
  /** Seasonal drought, 0 (wet) to 1 (parched). A pure function of the tick. */
  drought(tick: number): number;
  update(world: World, events: SimEvent[]): void;
}

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

export function createEconomy(
  factionIds: readonly FactionId[],
  seed: number,
  plots: readonly GrainPlot[] = [],
): Economy {
  const players = factionIds.length;
  const factions = factionIds.map((id) => FACTIONS[id]);
  const amounts = new Float64Array(players * RESOURCE_COUNT);
  const shortfall = new Float64Array(players);

  for (let player = 0; player < players; player++) {
    const config = factions[player]!;
    amounts[player * RESOURCE_COUNT + Resource.Cattle] = config.startingCattle;
    amounts[player * RESOURCE_COUNT + Resource.Grain] = config.startingGrain;
    amounts[player * RESOURCE_COUNT + Resource.Ammunition] = config.startingAmmunition;
  }

  const e = tuning.economy;

  const economy: Economy = {
    players,
    amounts,
    factions,
    upkeepCount: 0,
    shortfall,

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
     * Drought over the year, with a per-year severity.
     *
     * Severity is derived by hashing the year index rather than by drawing from the
     * simulation RNG. A query that consumed RNG state would change the sequence every
     * other system sees, turning a pure-looking lookup into a hidden side effect — and
     * it would mean calling drought() twice gave two different answers.
     */
    drought(tick) {
      const year = Math.floor(tick / e.seasonTicks);
      const phase = (tick % e.seasonTicks) / e.seasonTicks;
      // 0 at the start of the year, 1 at its height.
      const curve = (1 - cos(phase * TWO_PI)) / 2;
      // Severity in [0.55, 1.05], so some years are merely dry and some are ruinous.
      const severity = 0.55 + (mixSeed(seed, year) / 4294967296) * 0.5;
      const value = curve * severity;
      return value < 0 ? 0 : value > 1 ? 1 : value;
    },

    update(world, events) {
      const tick = world.tick;
      if (tick === 0 || tick % e.upkeepIntervalTicks !== 0) return;

      economy.upkeepCount++;
      const droughtNow = economy.drought(tick);
      const parched = droughtNow >= e.droughtThreshold;

      // --- harvest ----------------------------------------------------------
      for (const plot of plots) {
        if (plot.owner >= players) continue;
        // Open savanna yields nothing once the drought passes the threshold. Sheltered
        // ground keeps producing, at a reduced rate.
        const yieldNow = parched
          ? plot.sheltered
            ? e.plotBaseYield * e.shelteredYieldFactor
            : 0
          : e.plotBaseYield * (1 - droughtNow * 0.5);
        economy.add(plot.owner, Resource.Grain, yieldNow);
      }

      // --- headcount --------------------------------------------------------
      const units = new Float64Array(players);
      const herds = new Float64Array(players);
      for (let i = 0; i < world.capacity; i++) {
        if (world.alive[i] !== 1) continue;
        const owner = world.faction[i]!;
        if (owner >= players) continue;
        if (world.kind[i] === EntityKind.Cattle) herds[owner]!++;
        else units[owner]!++;
      }

      for (let player = 0; player < players; player++) {
        const config = factions[player]!;

        // Cattle on the ledger are the standing herd; cattle on the map are the ones
        // being driven. Both eat.
        const onLedger = economy.balance(player, Resource.Cattle);
        const totalCattle = onLedger + herds[player]!;
        const needed =
          (units[player]! * e.grainPerUnit + totalCattle * e.grainPerCattle) *
          config.upkeepMultiplier;

        const held = economy.balance(player, Resource.Grain);
        if (held >= needed) {
          economy.spend(player, Resource.Grain, needed);
          shortfall[player] = 0;

          // The herd grows only when it is fed.
          const growth =
            (onLedger * e.cattleGrowthPerHundred) / 100 * config.herdGrowthMultiplier;
          economy.add(player, Resource.Cattle, growth * (parched ? 0.25 : 1));
        } else {
          economy.spend(player, Resource.Grain, held);
          shortfall[player] = needed - held;
          starve(world, player, events);
        }

        economy.add(player, Resource.Ammunition, e.ammunitionPerUpkeep * (config.startingAmmunition > 0 ? 1 : 0));
      }
    },
  };

  return economy;
}

/** Hunger falls on the troops, not the herd: eating the herd is the player's choice. */
function starve(world: World, player: number, events: SimEvent[]): void {
  const damage = tuning.economy.starvationDamage;

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
