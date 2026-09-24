import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import type { CattleSystem } from './cattle.js';
import type { ConstructionSystem } from './construction.js';
import type { ProductionSystem } from './production.js';
import type { Economy } from './economy/ledger.js';
import { buildingSpec, type BuildingType } from '../shared/buildings/index.js';
import { TECH_IDS } from '../shared/tech/index.js';
import type { TechState } from './tech.js';
import type { MovementSystem } from './movement.js';
import { fell, type Woodland } from './woodland.js';
import { abandon, canPlant, plant, setFallow, type Farmland } from './economy/farmland.js';
import { trade, TradeResult } from './trade.js';
import { AllyResult, alliedWith, breakBond, propose, withdraw, type Alliance } from './alliance.js';
import { Ration, Resource } from './economy/ledger.js';
import type { Heightmap } from '../shared/heightmap.js';
import { cull } from './herd.js';
import { holdForOrder } from './labour.js';
import { MovementClass } from './pathing/costs.js';
import { tuning } from './tuning.js';
import {
  clearOrderQueue,
  destroy,
  enqueueOrder,
  EntityKind,
  handleIndex,
  isAlive,
  OrderMode,
  spawn,
  type Handle,
  type World,
} from './world.js';

/**
 * Commands are the sole path by which simulation state changes.
 *
 * Keeping that true is what makes three later things cheap rather than structural:
 * an AI opponent is just another command source, replays are a command log, and
 * lockstep needs only a canonical ordering. See docs/ARCHITECTURE.md section 1.
 *
 * Payload slots are numeric so a command serializes to a flat buffer without a
 * per-command object graph when the worker boundary lands.
 */

/** Cattle answer to nobody until somebody leashes them. */
export const NEUTRAL_FACTION = 2;

export const CommandKind = {
  Spawn: 0,
  MoveTo: 1,
  Destroy: 2,
  SpawnCattle: 3,
  /** Tether a cow to a herder — what right-clicking a neutral herd issues. */
  Leash: 4,
  /**
   * 5 was `Attack`. Retired with combat in Phase V6. Command values are durable — they
   * sit in recorded logs and cross the worker boundary — so retired ones are left as
   * gaps rather than renumbered.
   */
  Build: 6,
  Research: 7,
  Train: 8,
  SetRally: 9,
  /** 10 was `AttackMove`, 11 `SetStance`. Both retired with combat. */
  /**
   * Walk between here and there until told otherwise.
   *
   * Kept through the combat retirement. It was built as an attack-move that refuses to
   * finish, but nothing about walking a beat needs a fight at the end of it, and a
   * herder covering ground between two points wants exactly this.
   */
  Patrol: 12,
  /** Cut a standing tree for its timber. `a` is the index into the woodland. */
  Fell: 13,
  /** Break new ground for a field. `a`/`b` are the tile. */
  Plant: 14,
  /** Give a field up. `a` is its index in the farmland. */
  Abandon: 15,
  /**
   * Offer a neighbour `d` of resource `b` for whatever resource `c` they will give.
   *
   * `a` is the neighbour. The amount returned is not in the command because only the
   * neighbour knows it — see src/sim/trade.ts.
   */
  Trade: 16,
  /**
   * Ask neighbour `a` for a standing tie. They answer from their own regard for you;
   * see src/sim/alliance.ts.
   */
  Ally: 17,
  /** Walk away from the tie with neighbour `a`, and wear the cost of it. */
  Break: 18,
  /**
   * Slaughter part of the standing herd for the meat.
   *
   * The lever the game was missing. A herd grows on its own and eats grain every season
   * whether the village wants it to or not, and until this there was no way to refuse
   * it: trade moved eight beasts a parcel at a rate set by a neighbour who was usually
   * as hungry as you. Measured in play, a village went 120 head to 160 while its people
   * starved. Killing cattle for food is what a village actually does in a bad year, and
   * it is a real decision because the herd is also the wealth.
   */
  Cull: 19,
  /**
   * Put the village on short rations, or take it off them. `a` is the ration.
   *
   * The move a bad year did not have. See `Ration` in economy/ledger.ts for why it is
   * two states rather than a dial, and why it costs work.
   */
  SetRation: 20,
  /**
   * Rest a field, or put it back to work. `a` is its index, `b` is 1 to rest it.
   *
   * See `setFallow` in economy/farmland.ts: the field pays nothing while it rests and
   * comes back better than it went in, which is what makes having more land than hands
   * a position rather than a mistake.
   */
  Fallow: 21,
} as const;

export type CommandKind = (typeof CommandKind)[keyof typeof CommandKind];

export interface Command {
  /** Tick on which this command executes. */
  readonly tick: number;
  readonly playerId: number;
  /** Monotonic per player. (playerId, seq) is the tie-break that makes ordering total. */
  readonly seq: number;
  readonly kind: CommandKind;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

export function makeCommand(
  tick: number,
  playerId: number,
  seq: number,
  kind: CommandKind,
  a = 0,
  b = 0,
  c = 0,
  d = 0,
): Command {
  return { tick, playerId, seq, kind, a, b, c, d };
}

/**
 * Total order over commands. Two players acting on the same tick must resolve the
 * same way on every machine, so arrival order is never consulted.
 */
export function compareCommands(x: Command, y: Command): number {
  if (x.tick !== y.tick) return x.tick - y.tick;
  if (x.playerId !== y.playerId) return x.playerId - y.playerId;
  return x.seq - y.seq;
}

/**
 * Apply one command. A command naming a dead or recycled entity is dropped, not
 * applied and not thrown on: by the time a click reaches here its target may have
 * died, and that is ordinary, not exceptional.
 */
/** The systems a command may act on. Named for the same reason SimSystems is. */
export interface CommandContext {
  readonly movement: MovementSystem;
  readonly woodland: Woodland;
  readonly farmland: Farmland;
  /** Terrain, for siting decisions a command makes. */
  readonly map: Heightmap;
  readonly cattle: CattleSystem;
  readonly construction: ConstructionSystem;
  readonly production: ProductionSystem;
  readonly economy: Economy;
  readonly alliance: Alliance;
  readonly tech: TechState;
}

export function applyCommand(
  world: World,
  command: Command,
  events: SimEvent[],
  context: CommandContext,
): boolean {
  const { movement, cattle, construction, production, economy, woodland, farmland, map, alliance, tech } =
    context;
  switch (command.kind) {
    case CommandKind.Spawn: {
      const handle = spawn(world, command.a, command.b, command.c, command.d);
      if (handle === 0) return false;
      events.push(makeEvent(world.tick, EventType.Spawned, handle, command.a, command.b));
      return true;
    }

    case CommandKind.MoveTo: {
      const handle = command.a as Handle;
      const mode = OrderMode.Move;

      // `d` non-zero appends rather than replaces. It rides on the existing command
      // rather than doubling the command kinds, because queueing is a property of how an
      // order was issued and not a different order.
      if (command.d !== 0) {
        if (!isAlive(world, handle)) return false;
        const index = handleIndex(handle);
        if (world.kind[index] !== EntityKind.Unit) return false;
        // A unit standing idle has nothing to queue behind, so the first shift-click
        // starts the march instead of sitting in a queue nothing will ever drain.
        if (world.hasTarget[index] !== 1) {
          if (!movement.order(world, handle, command.b, command.c)) return false;
          world.orderMode[index] = mode;
          holdForOrder(world, index);
          events.push(makeEvent(world.tick, EventType.OrderIssued, handle, command.b, command.c));
          return true;
        }
        if (!enqueueOrder(world, index, command.b, command.c, mode)) return false;
        holdForOrder(world, index);
        return true;
      }

      if (!movement.order(world, handle, command.b, command.c)) return false;
      clearOrderQueue(world, handleIndex(handle));
      // Set after the order is accepted, so a rejected order cannot leave a unit in a
      // mode it never entered. The same goes for the hold: a direct order takes this
      // person out of the labour pool (src/sim/labour.ts), and a refused one does not.
      world.orderMode[handleIndex(handle)] = mode;
      holdForOrder(world, handleIndex(handle));
      events.push(makeEvent(world.tick, EventType.OrderIssued, handle, command.b, command.c));
      return true;
    }

    case CommandKind.SpawnCattle: {
      // Neutral faction: cattle belong to whoever can hold them, which is the point.
      const handle = spawn(world, command.a, command.b, NEUTRAL_FACTION, 1, EntityKind.Cattle);
      if (handle === 0) return false;
      events.push(makeEvent(world.tick, EventType.Spawned, handle, command.a, command.b));
      return true;
    }

    case CommandKind.Patrol: {
      const handle = command.a as Handle;
      if (!isAlive(world, handle)) return false;
      const index = handleIndex(handle);
      if (world.kind[index] !== EntityKind.Unit) return false;

      // The near end is wherever the unit is standing when the order arrives, so a
      // patrol is set with one click like every other order rather than two.
      world.patrolX[index] = world.posX[index]!;
      world.patrolY[index] = world.posY[index]!;
      if (!movement.order(world, handle, command.b, command.c)) return false;
      clearOrderQueue(world, index);
      world.orderMode[index] = OrderMode.Patrol;
      holdForOrder(world, index);
      events.push(makeEvent(world.tick, EventType.OrderIssued, handle, command.b, command.c));
      return true;
    }

    case CommandKind.Fell:
      // Felling is a command and picking fruit is not, deliberately: standing under a
      // tree to eat is reversible and cutting it down is not. A village should not
      // level a wood by walking through it. See src/sim/woodland.ts.
      return fell(world, woodland, economy, command.playerId, command.a) > 0;

    case CommandKind.Plant:
      return plant(farmland, economy, map, command.playerId, command.a, command.b) === 0;

    case CommandKind.Abandon:
      return abandon(farmland, command.a);

    case CommandKind.Trade: {
      const result = trade(
        economy,
        command.playerId,
        command.a,
        command.b as Resource,
        command.c as Resource,
        command.d,
        alliance,
      );
      // A refusal is news. The player cannot see a neighbour's books, so silence would
      // be indistinguishable from the command going missing.
      events.push(
        makeEvent(
          world.tick,
          result === TradeResult.Traded ? EventType.Traded : EventType.TradeRefused,
          0,
          0,
          0,
          command.a,
        ),
      );
      return result === TradeResult.Traded;
    }

    case CommandKind.Ally: {
      // Asks, or takes an offer already on the table — see src/sim/alliance.ts. A tie
      // needs both sides to have asked, so one command serves for both halves.
      const result = propose(alliance, command.playerId, command.a);
      const announce =
        result === AllyResult.Allied
          ? EventType.AllianceFormed
          : result === AllyResult.Refused
            ? EventType.AllianceRefused
            : result === AllyResult.Offered
              ? EventType.AllianceOffered
              : null;
      // Every outcome that changed anything is news, for the reason a refused trade is:
      // the player cannot see what a neighbour makes of them, so silence would read as
      // a lost command.
      if (announce !== null) {
        events.push(makeEvent(world.tick, announce, 0, command.playerId, command.a));
      }
      return result === AllyResult.Allied || result === AllyResult.Offered;
    }

    case CommandKind.Break:
      // Breaking a tie costs standing; withdrawing an offer nobody took costs nothing.
      // One command for both, because from the player's side it is the same button.
      return alliedWith(alliance, command.playerId, command.a)
        ? breakBond(alliance, command.playerId, command.a, events, world.tick)
        : withdraw(alliance, command.playerId, command.a);

    case CommandKind.Cull: {
      const taken = cull(economy, command.playerId);
      if (taken <= 0) return false;
      events.push(makeEvent(world.tick, EventType.Culled, 0, command.playerId, 0, taken));
      return true;
    }

    case CommandKind.Leash: {
      if (!cattle.leash(world, command.a as Handle, command.b as Handle)) return false;
      // The herder, not the beast: `a` is the person taking the tether. Held while they
      // hold it, so the allocator never walks a drover off the herd he was sent for.
      const herder = command.a as Handle;
      if (isAlive(world, herder) && world.kind[handleIndex(herder)] === EntityKind.Unit) {
        holdForOrder(world, handleIndex(herder));
      }
      return true;
    }

    // The acting player is who SENT the command, never a player named in its payload.
    // Both read command.d / command.b once. Every caller passes its own id, so the two
    // have always agreed and nothing was visibly wrong — but the payload is data a
    // client controls and playerId is provenance, and under the lockstep this project
    // keeps possible the payload version lets any client build with a rival's grain.
    case CommandKind.Build: {
      /*
       * `d` zero is an ordinary build, for whoever sent the command.
       *
       * `d` non-zero FOUNDS a building already standing and free, for player `d - 1`:
       * the village a match begins in, laid out by the match script rather than built by
       * anybody. It names its owner because the script sends the neighbour's village
       * too, and taking the owner from provenance handed player 0 both villages — the
       * neighbour's kraal, great house and huts forty tiles off were the player's own,
       * and work went looking for hands there (Phase B2 is what showed it).
       *
       * Founding is a privilege, so it is refused once the opening is over. It was
       * `d !== 0` with no limit at all, and the neighbour sends `d: player` on every
       * build — so the AI, as player 1, founded every building it ever ordered: free,
       * instant, the whole match. Every AI measurement since that flag went in was a
       * village that built for nothing.
       */
      const founded = command.d !== 0;
      if (founded && world.tick >= tuning.economy.upkeepIntervalTicks) return false;
      const owner = founded ? command.d - 1 : command.playerId;
      if (owner < 0 || owner >= economy.players) return false;
      const placed =
        construction.place(
          world,
          economy,
          owner,
          command.c as BuildingType,
          command.a,
          command.b,
          events,
          founded,
        ) === 0;
      if (placed) {
        const size = buildingSpec(command.c).footprint;
        const blocked = movement.pathing.layer(MovementClass.Infantry).tileCost;
        buildOverFields(farmland, map, blocked, command.a, command.b, size, founded);
      }
      return placed;
    }

    case CommandKind.Research: {
      const id = TECH_IDS[command.a];
      if (id === undefined) return false;
      // Provenance, not payload — see the note on Build above.
      return tech.begin(command.playerId, id, economy);
    }

    case CommandKind.Train:
      return production.train(world, economy, command.a as Handle, command.b) === 0;

    case CommandKind.SetRally:
      return production.setRally(world, command.a as Handle, command.b, command.c);

    case CommandKind.Fallow:
      // Ownership is checked inside, the way Abandon's is: a field index arriving from
      // a client is untrusted until the farmland says whose it is.
      return setFallow(farmland, command.a, command.b === 1, command.playerId);

    case CommandKind.SetRation:
      // No check on the value beyond the enum's own range: a ration is a village-wide
      // switch with no cost to flip and nothing to validate against the world.
      economy.setRation(command.playerId, command.a === Ration.Short ? Ration.Short : Ration.Full);
      return true;

    case CommandKind.Destroy:
      return destroy(world, command.a as Handle);

    default:
      return false;
  }
}

/**
 * A building put up on a field takes the ground.
 *
 * Fields do not block placement — they do not block anything, which is what lets cattle
 * wander into them — so a hut could be founded on top of one. The opening did exactly
 * that: the starting fields are laid out before the village is founded, and up to four
 * of ten came out under a dwelling, where nobody could stand to work them. That cost
 * nothing while nobody went anywhere on their own; once work found its own people
 * (Phase B2) they walked at a wall for the whole match.
 *
 * A player who builds on a field has chosen the building, and the field is gone. A
 * FOUNDED building is the match script laying out a village, and the field it lands on
 * is moved to the nearest open ground that will take a crop instead — the opening's
 * land is part of the opening, and losing four fields of ten to the layout is not a
 * decision anybody made.
 */
function buildOverFields(
  land: Farmland,
  map: Heightmap,
  blocked: Uint8Array,
  tileX: number,
  tileY: number,
  size: number,
  founded: boolean,
): void {
  const spacing = tuning.farmland.minSpacing;
  const free = (x: number, y: number, self: number): boolean => {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
    if (blocked[y * map.width + x] === 255 || !canPlant(map, x, y)) return false;
    for (let g = 0; g < land.count; g++) {
      if (g === self || land.alive[g] === 0) continue;
      const dx = land.tileX[g]! - x;
      const dy = land.tileY[g]! - y;
      if (dx * dx + dy * dy < spacing * spacing) return false;
    }
    return true;
  };

  for (let f = 0; f < land.count; f++) {
    if (land.alive[f] === 0) continue;
    const fx = land.tileX[f]!;
    const fy = land.tileY[f]!;
    const dx = fx - tileX;
    const dy = fy - tileY;
    if (dx < 0 || dx >= size || dy < 0 || dy >= size) continue;
    if (!founded) {
      abandon(land, f);
      continue;
    }
    // Nearest first, ring by ring, and within a ring in row order, so the choice is the
    // same on every machine.
    let moved = false;
    for (let ring = 1; ring <= 8 && !moved; ring++) {
      for (let ry = -ring; ry <= ring && !moved; ry++) {
        for (let rx = -ring; rx <= ring && !moved; rx++) {
          if (Math.max(Math.abs(rx), Math.abs(ry)) !== ring) continue;
          if (!free(fx + rx, fy + ry, f)) continue;
          land.tileX[f] = fx + rx;
          land.tileY[f] = fy + ry;
          land.version++;
          moved = true;
        }
      }
    }
    if (!moved) abandon(land, f);
  }
}
