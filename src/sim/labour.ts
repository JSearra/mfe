import { buildingSpec, BuildingType } from '../shared/buildings/index.js';
import { EventType, makeEvent, type SimEvent } from '../shared/events.js';
import { isFreshShore, isShore, type Heightmap } from '../shared/heightmap.js';
import { isEstablished, type Farmland } from './economy/farmland.js';
import type { MovementSystem } from './movement.js';
import { tuning } from './tuning.js';
import {
  EntityKind,
  handleIndex,
  isAlive,
  NULL_HANDLE,
  OrderMode,
  packHandle,
  type World,
} from './world.js';

/**
 * Work finds its own people (ADR-0020, roadmap Phase B2).
 *
 * Until this, the only thing that ever sent anybody to a field, a site or the water was
 * the player's own hand — and the single largest cause of death found in play was fields
 * left untended because nobody had been told to stand on them. A village of sixty cannot
 * be driven one person at a time, and a builder does not ask to be.
 *
 * So the relationship goes the other way. A place that needs hands asks for a number of
 * them, and the nearest free people of the village that owns it walk over and stay. The
 * player decides what exists and where; the village decides who goes.
 *
 * **Every rule that PAYS is unchanged.** A field is still tended by whoever stands within
 * `tendRadius` of it, a site still rises with whoever is near it, a shore tile still
 * catches for whoever is on it. This file only decides who goes where. That keeps a
 * direct order exactly as good as it was — someone sent by hand to a failing field tends
 * it just the same — and it is what makes the direct order an override rather than a
 * second, competing mechanism.
 *
 * **A direct order holds a person out of the pool.** Moving, patrolling or taking a herd
 * marks them `Held`, and they come back to work only after the order is done and a short
 * wait has passed. Otherwise the allocator would walk a drover off the herd he had just
 * been sent to take, twenty ticks after he was sent. Someone holding a tether is never
 * released while they hold it.
 *
 * **Only near a homestead.** A place is worked automatically only when it lies within
 * `homeRadius` of one of its village's finished dwellings. People come from homesteads,
 * and a field broken on the far side of the valley is a field somebody has to be sent to.
 * It is also what leaves a world with no village in it — most of the test suite — alone.
 *
 * **Who wins a contested person** is settled by a fixed order and by distance, nothing
 * else: every place first gets one pair of hands, in priority order, and only then does
 * any place get a second. Fields come first and worst-first, because the fields are the
 * game (CLAUDE.md); then the buildings that need staff; then building sites; then the
 * water. Within that, the nearest free person goes, ties broken on entity index. Somebody
 * already working somewhere that still wants them stays, so nobody is shuttled back and
 * forth between two places that each want them a little more on alternate passes.
 */

/** What a villager is doing, as far as the labour pool is concerned. */
export const Work = {
  /** Free. The allocator may send them anywhere. */
  None: 0,
  /** Under a direct order. Not the allocator's to move. `workHold` counts down. */
  Held: 1,
  /** Tending a field. `workAt` is its index in the farmland. */
  Field: 2,
  /** Staffing a finished building. `workAt` is its entity index. */
  Building: 3,
  /** Raising a building site. `workAt` is its entity index. */
  Site: 4,
  /** Fishing. `workAt` is the shore tile index. */
  Shore: 5,
  /**
   * Keeping a kraal. `workAt` is its entity index.
   *
   * Its own kind rather than `Building`, because it changes how cattle treat the person:
   * a herdsman at the kraal is the herd's own and does not frighten it — the same rule a
   * drover holding a tether already had (see cattle.ts). A granary hand is a stranger.
   */
  Kraal: 6,
  /**
   * Hunting from a camp (ADR-0022). `workAt` is the camp's entity index.
   *
   * Its own kind because the place is where a hunter sets out from and comes back to,
   * not where the work is: src/sim/hunting.ts takes them out after game, and while they
   * are out the allocator leaves them be rather than calling them back to the camp.
   */
  Hunt: 7,
  /**
   * Carrying water from a river bank (ADR-0023). `workAt` is the bank tile index.
   * Paid in src/sim/water.ts by how far the bank is from home.
   */
  Water: 8,
} as const;

export type Work = (typeof Work)[keyof typeof Work];

/** The hold every direct order puts on a villager. Called from command dispatch. */
export function holdForOrder(world: World, index: number): void {
  world.workKind[index] = Work.Held;
  world.workAt[index] = -1;
  world.workHold[index] = tuning.labour.holdTicks;
}

/** How many of the village's people are free and standing about. For the HUD. */
export function idleOf(world: World, player: number): number {
  let idle = 0;
  for (let i = 0; i < world.capacity; i++) {
    if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
    if (world.faction[i] !== player) continue;
    if (world.workKind[i] !== Work.None) continue;
    if (world.hasTarget[i] === 1) continue;
    // Laid up is not idle: they cannot be sent anywhere, and counting them as spare
    // hands would tell the player they have help they do not.
    if (world.injured[i]! > 0) continue;
    idle++;
  }
  return idle;
}

/** A place asking for hands, for the length of one pass. */
interface Place {
  kind: Work;
  at: number;
  /** Where the hands are sent to stand. */
  x: number;
  y: number;
  /** How far from (x, y) a person may be and still count as there. */
  reach: number;
  wanted: number;
  assigned: number;
}

export interface Labour {
  /**
   * Hands short across the village at the last pass: places asking, nobody free.
   *
   * Derived every pass and never saved, because it is a reading of state rather than
   * state — the same reason `builders` is recomputed every tick.
   */
  readonly short: Float64Array;
  update(
    world: World,
    land: Farmland,
    map: Heightmap,
    movement: MovementSystem,
    players: number,
    events?: SimEvent[],
  ): void;
}

/** Stand-point offsets around a footprint, so a building's hands do not stack on one tile. */
const SIDES: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

export function createLabour(players: number): Labour {
  const short = new Float64Array(players);
  const places: Place[] = [];
  const homes: number[] = [];
  const shoreSeen = new Set<number>();
  const shoreFound: { tile: number; distanceSq: number }[] = [];

  function withinHome(world: World, x: number, y: number): boolean {
    const r = tuning.labour.homeRadius;
    for (const home of homes) {
      const dx = world.posX[home]! - x;
      const dy = world.posY[home]! - y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  function collectPlaces(world: World, land: Farmland, map: Heightmap, player: number): void {
    const l = tuning.labour;
    places.length = 0;

    // --- homes ---------------------------------------------------------------
    homes.length = 0;
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Building) continue;
      if (world.faction[i] !== player) continue;
      const type = world.buildingType[i]!;
      if (type !== BuildingType.Umuzi && type !== BuildingType.Indlunkulu) continue;
      if (world.buildProgress[i]! < buildingSpec(type).work) continue;
      homes.push(i);
    }
    if (homes.length === 0) return;

    // --- fields, worst first ---------------------------------------------------
    const fieldsFrom = places.length;
    for (let f = 0; f < land.count; f++) {
      if (land.alive[f] === 0 || land.owner[f] !== player) continue;
      // A resting field wants nobody. Standing on it would only undo the rest.
      if (land.fallow[f] === 1) continue;
      const x = land.tileX[f]! + 0.5;
      const y = land.tileY[f]! + 0.5;
      if (!withinHome(world, x, y)) continue;
      // One pair of hands holds an established field against neglect; breaking ground or
      // bringing a failing field back takes the full complement.
      const recovering = !isEstablished(land, f) || land.condition[f]! < l.fieldRecoverBelow;
      places.push({
        kind: Work.Field,
        at: f,
        x,
        y,
        reach: tuning.farmland.tendRadius,
        wanted: recovering ? tuning.farmland.maxHands : l.fieldHands,
        assigned: 0,
      });
    }
    const fields = places.splice(fieldsFrom);
    fields.sort((a, b) => {
      const ca = land.work[a.at]! < tuning.farmland.establishWork ? -1 : land.condition[a.at]!;
      const cb = land.work[b.at]! < tuning.farmland.establishWork ? -1 : land.condition[b.at]!;
      return ca !== cb ? ca - cb : a.at - b.at;
    });
    for (const field of fields) places.push(field);

    // --- buildings that need staff, then sites ---------------------------------
    const sites: Place[] = [];
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Building) continue;
      if (world.faction[i] !== player) continue;
      const x = world.posX[i]!;
      const y = world.posY[i]!;
      if (!withinHome(world, x, y)) continue;
      const spec = buildingSpec(world.buildingType[i]!);
      const finished = world.buildProgress[i]! >= spec.work;
      // Stand just outside the footprint, on the side facing away from nothing in
      // particular: the footprint blocks people, and a goal inside it is unreachable.
      const standOff = spec.footprint / 2 + l.standOff;
      if (finished) {
        if (spec.hands === 0) continue;
        places.push({
          kind: spec.holdsCattle ? Work.Kraal : spec.hunts ? Work.Hunt : Work.Building,
          at: i,
          x: x + standOff,
          y,
          reach: l.buildingReach,
          wanted: spec.hands,
          assigned: 0,
        });
      } else {
        sites.push({
          kind: Work.Site,
          at: i,
          x: x + standOff,
          y,
          reach: tuning.buildings.buildRadius,
          wanted: l.siteHands,
          assigned: 0,
        });
      }
    }
    for (const site of sites) places.push(site);

    // --- water to drink (ADR-0023) --------------------------------------------------
    // Before the fishing: a village goes thirsty before it goes without fish. Fresh
    // banks only — the sea is salt — within a wider reach than the anglers', because a
    // long walk is not a refusal, only fewer trips (water.ts prices the distance).
    if (map.water.length > 0 && tuning.water.spots > 0) {
      const w = tuning.water;
      const banks: { tile: number; distanceSq: number }[] = [];
      const seen = new Set<number>();
      for (const home of homes) {
        const hx = world.posX[home]!;
        const hy = world.posY[home]!;
        for (let ty = Math.floor(hy - w.spotRadius); ty <= Math.floor(hy + w.spotRadius); ty++) {
          for (let tx = Math.floor(hx - w.spotRadius); tx <= Math.floor(hx + w.spotRadius); tx++) {
            const dx = tx + 0.5 - hx;
            const dy = ty + 0.5 - hy;
            const distanceSq = dx * dx + dy * dy;
            if (distanceSq > w.spotRadius * w.spotRadius) continue;
            if (!isFreshShore(map, tx, ty)) continue;
            const tile = ty * map.width + tx;
            if (seen.has(tile)) {
              for (const bank of banks) {
                if (bank.tile === tile && distanceSq < bank.distanceSq) bank.distanceSq = distanceSq;
              }
              continue;
            }
            seen.add(tile);
            banks.push({ tile, distanceSq });
          }
        }
      }
      banks.sort((a, b) => (a.distanceSq !== b.distanceSq ? a.distanceSq - b.distanceSq : a.tile - b.tile));
      const taken: number[] = [];
      for (const bank of banks) {
        if (taken.length >= w.spots) break;
        const bx = bank.tile % map.width;
        const by = Math.floor(bank.tile / map.width);
        let crowded = false;
        for (const other of taken) {
          const dx = (other % map.width) - bx;
          const dy = Math.floor(other / map.width) - by;
          if (dx * dx + dy * dy < w.spotSpacing * w.spotSpacing) crowded = true;
        }
        if (crowded) continue;
        taken.push(bank.tile);
        places.push({ kind: Work.Water, at: bank.tile, x: bx + 0.5, y: by + 0.5, reach: 0.75, wanted: w.maxCarriers, assigned: 0 });
      }
    }

    // --- the water ---------------------------------------------------------------
    if (map.water.length === 0 || l.fishingSpots === 0) return;
    shoreSeen.clear();
    shoreFound.length = 0;
    const r = l.fishingRadius;
    for (const home of homes) {
      const hx = world.posX[home]!;
      const hy = world.posY[home]!;
      for (let ty = Math.floor(hy - r); ty <= Math.floor(hy + r); ty++) {
        for (let tx = Math.floor(hx - r); tx <= Math.floor(hx + r); tx++) {
          const dx = tx + 0.5 - hx;
          const dy = ty + 0.5 - hy;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq > r * r) continue;
          if (!isShore(map, tx, ty)) continue;
          const tile = ty * map.width + tx;
          if (shoreSeen.has(tile)) {
            // Nearer to this home than the one that found it first: keep the nearer.
            for (const found of shoreFound) {
              if (found.tile === tile && distanceSq < found.distanceSq) found.distanceSq = distanceSq;
            }
            continue;
          }
          shoreSeen.add(tile);
          shoreFound.push({ tile, distanceSq });
        }
      }
    }
    shoreFound.sort((a, b) =>
      a.distanceSq !== b.distanceSq ? a.distanceSq - b.distanceSq : a.tile - b.tile,
    );
    // Spots are spread out, not packed along one stretch of bank: two anglers a tile
    // is the whole of what a tile gives, and a crowd on adjacent tiles is a crowd.
    const chosen: number[] = [];
    for (const found of shoreFound) {
      if (chosen.length >= l.fishingSpots) break;
      const fx = found.tile % map.width;
      const fy = Math.floor(found.tile / map.width);
      let crowded = false;
      for (const other of chosen) {
        const dx = (other % map.width) - fx;
        const dy = Math.floor(other / map.width) - fy;
        if (dx * dx + dy * dy < l.fishingSpacing * l.fishingSpacing) crowded = true;
      }
      if (crowded) continue;
      chosen.push(found.tile);
      places.push({
        kind: Work.Shore,
        at: found.tile,
        x: fx + 0.5,
        y: fy + 0.5,
        reach: 0.75,
        wanted: tuning.fishing.maxAnglers,
        assigned: 0,
      });
    }
  }

  /**
   * What each of this player's fields is asking for and has, for the readout.
   *
   * Hands PRESENT, counted the way the field itself counts them (within `tendRadius`),
   * not hands assigned — someone sent there by hand is tending it just the same, and the
   * number on screen has to agree with what the field will actually get.
   */
  function readFields(world: World, land: Farmland, player: number): void {
    const tendSq = tuning.farmland.tendRadius * tuning.farmland.tendRadius;
    let changed = false;
    for (let f = 0; f < land.count; f++) {
      if (land.alive[f] === 0 || land.owner[f] !== player) continue;
      let wanted = 0;
      for (const place of places) {
        if (place.kind === Work.Field && place.at === f) wanted = place.wanted;
      }
      const cx = land.tileX[f]! + 0.5;
      const cy = land.tileY[f]! + 0.5;
      let present = 0;
      for (let i = 0; i < world.capacity; i++) {
        if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
        if (world.faction[i] !== player) continue;
        const dx = world.posX[i]! - cx;
        const dy = world.posY[i]! - cy;
        if (dx * dx + dy * dy <= tendSq && present < 255) present++;
      }
      if (land.handsWanted[f] !== wanted || land.handsPresent[f] !== present) changed = true;
      land.handsWanted[f] = wanted;
      land.handsPresent[f] = present;
    }
    if (changed) land.version++;
  }

  /** Close enough to the place to be counted there by the rule that pays for it. */
  function within(world: World, index: number, place: Place): boolean {
    const onFootprint =
      place.kind === Work.Building || place.kind === Work.Kraal || place.kind === Work.Site;
    const cx = onFootprint ? world.posX[place.at]! : place.x;
    const cy = onFootprint ? world.posY[place.at]! : place.y;
    const dx = world.posX[index]! - cx;
    const dy = world.posY[index]! - cy;
    return dx * dx + dy * dy <= place.reach * place.reach;
  }

  function send(world: World, movement: MovementSystem, index: number, place: Place): void {
    // Spread a building's hands round its sides rather than stacking them on one point.
    let x = place.x;
    let y = place.y;
    if (place.kind === Work.Building || place.kind === Work.Kraal || place.kind === Work.Site) {
      const side = SIDES[place.assigned % SIDES.length]!;
      const cx = world.posX[place.at]!;
      const cy = world.posY[place.at]!;
      const off = place.x - cx;
      x = cx + side[0] * off;
      y = cy + side[1] * off;
    }
    movement.order(world, packHandle(index, world.generation[index]!), x, y);
  }

  return {
    short,

    update(world, land, map, movement, players, events): void {
      const l = tuning.labour;
      if (world.tick % l.intervalTicks !== 0) return;

      // --- release holds --------------------------------------------------------
      // Anyone holding a tether, gathered once from the cattle side.
      const herding = new Set<number>();
      for (let i = 0; i < world.capacity; i++) {
        if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Cattle) continue;
        const tether = world.tetheredTo[i]!;
        if (tether === NULL_HANDLE || !isAlive(world, tether)) continue;
        herding.add(handleIndex(tether));
      }

      for (let i = 0; i < world.capacity; i++) {
        if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
        if (world.workKind[i] !== Work.Held) continue;
        // Still doing what they were told: walking, walking a beat, or holding cattle.
        if (world.hasTarget[i] === 1 || world.queueCount[i]! > 0) continue;
        if (world.orderMode[i] === OrderMode.Patrol || herding.has(i)) continue;
        const left = world.workHold[i]! - l.intervalTicks;
        if (left > 0) {
          world.workHold[i] = left;
          continue;
        }
        world.workHold[i] = 0;
        world.workKind[i] = Work.None;
      }

      for (let player = 0; player < players; player++) {
        collectPlaces(world, land, map, player);
        readFields(world, land, player);

        // --- who stays --------------------------------------------------------
        // Walked in index order, so when a place wants fewer than it has, the lowest
        // indices keep the work and the choice does not depend on anything else.
        for (let i = 0; i < world.capacity; i++) {
          if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
          if (world.faction[i] !== player) continue;
          const kind = world.workKind[i]!;
          if (kind === Work.None || kind === Work.Held) continue;
          // A mauled hand leaves their work until they mend (ADR-0022).
          if (world.injured[i]! > 0) {
            world.workKind[i] = Work.None;
            world.workAt[i] = -1;
            continue;
          }
          // Somebody given a tether by a neighbour's cattle wandering into them is holding
          // a herd, which outranks anything the allocator had them doing.
          if (herding.has(i)) {
            holdForOrder(world, i);
            continue;
          }

          let found = -1;
          for (let p = 0; p < places.length; p++) {
            const place = places[p]!;
            if (place.kind === kind && place.at === world.workAt[i]) {
              found = p;
              break;
            }
          }
          if (found === -1 || places[found]!.assigned >= places[found]!.wanted) {
            world.workKind[i] = Work.None;
            world.workAt[i] = -1;
            continue;
          }
          const place = places[found]!;
          place.assigned++;
          // Stopped short — shoved by a crowd, or the first order never took. Send again.
          // Measured against the place's own reach, because anywhere outside it is
          // standing near the work rather than doing it: a field hand at 2.4 tiles from a
          // field that tends at 1.6 was counted as working and tended nothing. A
          // building's stand point is off the footprint, so it is measured from there.
          // Out after game: the hunt has them, and the camp is where they come back to.
          if (kind === Work.Hunt && world.quarry[i] !== NULL_HANDLE) continue;
          if (world.hasTarget[i] === 0 && !within(world, i, place)) send(world, movement, i, place);
        }

        // --- who goes -----------------------------------------------------------
        // Two rounds: first every place gets one pair of hands, then any place gets
        // more. Without the first round the fields, which come first, would take the
        // whole village before a site had anybody.
        let wanting = 0;
        for (let round = 0; round < 2; round++) {
          for (let p = 0; p < places.length; p++) {
            const place = places[p]!;
            const target = round === 0 ? Math.min(1, place.wanted) : place.wanted;
            while (place.assigned < target) {
              let best = -1;
              let bestDistance = l.reach * l.reach;
              for (let i = 0; i < world.capacity; i++) {
                if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
                if (world.faction[i] !== player) continue;
                if (world.workKind[i] !== Work.None || herding.has(i)) continue;
                if (world.injured[i]! > 0) continue;
                const dx = world.posX[i]! - place.x;
                const dy = world.posY[i]! - place.y;
                const distance = dx * dx + dy * dy;
                // Strictly nearer, so a tie keeps the lower index.
                if (distance < bestDistance) {
                  bestDistance = distance;
                  best = i;
                }
              }
              if (best === -1) break;
              send(world, movement, best, place);
              world.workKind[best] = place.kind;
              world.workAt[best] = place.at;
              place.assigned++;
            }
          }
        }
        for (const place of places) wanting += place.wanted - place.assigned;
        short[player] = wanting;

        // The warning is about work that pays, not about the water: a village with no
        // spare hands for fishing is simply a village with enough to do.
        if (events === undefined) continue;
        if (world.tick % (tuning.economy.upkeepIntervalTicks * l.warnEverySeasons) !== 0) continue;
        for (const place of places) {
          if (place.kind === Work.Shore || place.assigned > 0) continue;
          events.push(makeEvent(world.tick, EventType.HandsShort, 0, place.x, place.y, player));
          break;
        }
      }
    },
  };
}
