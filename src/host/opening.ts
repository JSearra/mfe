import { BuildingType, buildingSpec } from '../shared/buildings/index.js';
import { heightAt, type Heightmap } from '../shared/heightmap.js';
import { CommandKind } from '../sim/commands.js';
import { mixSeed } from '../sim/math/rng.js';
import { largestRegion, snapToRegion } from '../sim/terrain/placement.js';
import { planWildlife } from '../sim/wildlife.js';

/**
 * The village and the herds a match opens with.
 *
 * Lifted out of main.ts so that the game and the soak harness seed the SAME opening.
 * CLAUDE.md has a rule about this for a reason: a harness that skipped the starting force
 * produced two phases of plausible, wrong measurements, and a copy of this layout in a
 * test would drift from the real one the first time either was touched. Phase B3's
 * retune is measured on exactly what a player sees at tick zero.
 *
 * Commands only, through whatever `send` the caller has: the renderer's host in play, a
 * direct host in a soak. Math.cos is fine here — this is host code, outside the
 * determinism ban, and what crosses into the simulation is the positions it produced.
 */

export const PLAYER = 0;
/** The neighbour, in the ledger. Off the map: see ADR-0021. */
export const NEIGHBOUR = 1;
const KIND_UNIT = 0;

/** The fixed half of every match's seed. The other half is the map's. */
export const WORLD_SEED = 0x5eedcafe;

/**
 * The seed a match's simulation runs on: the weather, the woodland and the field layout.
 *
 * Mixed with the MAP seed, because that is the one a player chooses. It was the fixed
 * WORLD_SEED alone, so every match had the same weather whatever land it was played on —
 * and only in the worker host: the direct host (`?sim=direct`, and the soak harness)
 * took its seed from an option nobody passed, and ran every match on seed 0. The same
 * match, two different years of weather, depending on which thread it ran on. Both hosts
 * and the soak take it from here now.
 */
export function matchSeed(mapSeed: number): number {
  return mixSeed(WORLD_SEED, mapSeed);
}

export const STARTING_UNITS = 24;
/**
 * Cattle per grazing herd. Six herds, so seventy-two head on the veld.
 *
 * There were thirty, in a single blob within sight of the player, and that was the whole
 * raidable supply of a game about raiding cattle. Against the eighty head a player needs
 * to win it meant a raid could never be the fastest route: building kraals out-produced
 * the entire veld. Seventy-two, in six herds, makes sweeping the map worth roughly what
 * winning costs — and still not quite enough on its own, so the last stretch has to come
 * from breeding or from the enemy.
 */
export const HERD_SIZE = 12;
/** How far the ring of dwellings stands from the cattle enclosure at the centre. */
export const VILLAGE_RADIUS = 6.5;
export const VILLAGE_HUTS = 5;

export type Send = (kind: CommandKind, a?: number, b?: number, c?: number, d?: number) => void;

export function seedOpening(send: Send, map: Heightmap, centre: number, seed = 0): void {
  /**
   * Everything a match places goes through here first.
   *
   * A generated map is not one walkable surface, and a position chosen by arithmetic
   * lands wherever the terrain happens to put it. On the Magaliesberg that dropped the
   * player's whole force onto a ridge flank in a contour ribbon of eighty tiles it could
   * never leave — it could not reach the one herd in the game, so the map could not be
   * won. See src/sim/terrain/placement.ts.
   *
   * On an unbroken map — the default veld, thaba-bosiu — this changes nothing at all.
   */
  const walkable = largestRegion(map);
  const place = (x: number, y: number): { x: number; y: number } =>
    snapToRegion(map, walkable, x, y);

  /*
   * The village each side begins in, rather than a crowd standing in a field.
   *
   * Laid out as an umuzi actually is: the cattle enclosure at the centre, the great
   * house at its head, the dwellings in a ring around both. That shape is not decoration
   * — it is the whole social and defensive logic of the form, the herd kept in the
   * middle where it can be watched, and it gives the opening a centre to read from the
   * first frame. A player who starts among their own buildings knows what they are
   * looking at; a player who starts in open veld does not.
   *
   * Founded rather than built: these are the huts the village already lives in, so they
   * cost nothing and stand from tick one. Same reasoning as the starting fields coming
   * back established and the starting wood not being all saplings.
   */
  /*
   * Where a founded building can actually stand: the nearest footprint to the wanted
   * tile that the simulation will accept — on the map, on the walkable ground, level to
   * the building's tolerance — and clear of the village's other buildings by a tile, so
   * there is a way between them.
   *
   * The layout was arithmetic and never asked. On uneven ground the simulation refused
   * the sites it did not like, silently from here: on one map the isibaya itself was
   * never founded, its twelve cattle stood loose in the middle of the homestead, where
   * the village's exemption from frightening its own penned herd could not apply, and
   * the herd bolted through the people four seconds into the match. Others lost half
   * their dwellings the same way.
   */
  const claimed = new Uint8Array(map.width * map.height);
  function site(type: BuildingType, wantX: number, wantY: number): { x: number; y: number } {
    const spec = buildingSpec(type);
    const size = spec.footprint;
    const fits = (tileX: number, tileY: number): boolean => {
      if (tileX < 0 || tileY < 0 || tileX + size > map.width || tileY + size > map.height) return false;
      let low = Infinity;
      let high = -Infinity;
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const index = (tileY + dy) * map.width + tileX + dx;
          if (walkable[index] !== 1 || claimed[index] === 1) return false;
          const h = heightAt(map, tileX + dx, tileY + dy);
          if (h < 0) return false;
          low = Math.min(low, h);
          high = Math.max(high, h);
        }
      }
      return high - low <= spec.maxHeightVariation;
    };
    const startX = Math.floor(wantX);
    const startY = Math.floor(wantY);
    let found: { x: number; y: number } | null = null;
    // Rings outward, each scanned in a fixed order, so every machine founds the same village.
    for (let ring = 0; ring <= 8 && found === null; ring++) {
      for (let dy = -ring; dy <= ring && found === null; dy++) {
        for (let dx = -ring; dx <= ring && found === null; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          if (fits(startX + dx, startY + dy)) found = { x: startX + dx, y: startY + dy };
        }
      }
    }
    // Nowhere near will do: send the wanted tile and let the refusal be reported.
    const at = found ?? { x: startX, y: startY };
    for (let dy = -1; dy <= size; dy++) {
      for (let dx = -1; dx <= size; dx++) {
        const x = at.x + dx;
        const y = at.y + dy;
        if (x >= 0 && y >= 0 && x < map.width && y < map.height) claimed[y * map.width + x] = 1;
      }
    }
    return at;
  }

  const home = place(centre - 2, centre);

  /** Founds the village and says where its isibaya ended up, footprint centre. */
  function foundVillage(wanted: { x: number; y: number }, owner: number): { x: number; y: number } {
    // The isibaya at the centre, which is where the cattle live and where the eye goes.
    // Sited first; the ring of dwellings is laid round wherever it stands.
    const kraal = site(BuildingType.Isibaya, wanted.x, wanted.y);
    send(CommandKind.Build, kraal.x, kraal.y, BuildingType.Isibaya, owner + 1);
    const half = buildingSpec(BuildingType.Isibaya).footprint / 2;
    const at = { x: kraal.x + half, y: kraal.y + half };
    // The indlunkulu stands at the head of the homestead, opposite the entrance.
    const wantHead = place(at.x, at.y - VILLAGE_RADIUS);
    const head = site(BuildingType.Indlunkulu, wantHead.x, wantHead.y);
    send(CommandKind.Build, head.x, head.y, BuildingType.Indlunkulu, owner + 1);
    // Dwellings around the ring, with a gap left at the foot for the way in and out.
    for (let i = 0; i < VILLAGE_HUTS; i++) {
      // Skipping the southern arc leaves the entrance clear rather than walling the
      // village in — a ring with no gate is a pen.
      const angle = (i / VILLAGE_HUTS) * Math.PI * 2 + Math.PI * 0.18;
      if (Math.sin(angle) > 0.78) continue;
      const wantHut = place(
        at.x + Math.cos(angle) * VILLAGE_RADIUS,
        at.y + Math.sin(angle) * VILLAGE_RADIUS,
      );
      const hutAt = site(BuildingType.Umuzi, wantHut.x, wantHut.y);
      send(CommandKind.Build, hutAt.x, hutAt.y, BuildingType.Umuzi, owner + 1);
    }
    /*
     * No grain store. The village a match begins in is SHELTER, not production.
     *
     * Founding one was tried and it gave the game away: a full ring of dwellings plus a
     * granary yields about 39 grain a season, and the opening went from feeding 61
     * households to feeding 116 against a target of 60. That is the entire economic arc
     * handed over at tick zero — and it is exactly the investment the objective was
     * calibrated against, which Phase V1 costed as "about 15 more a cycle than the land
     * gives, which is two granaries and the work to raise them".
     *
     * So the homestead starts small and growing it is the game: a kraal, a great house
     * and a few dwellings. The granary is still the first thing worth building.
     *
     * `owner + 1` in the last slot founds each building for that village — see Build in
     * src/sim/commands.ts. It was a bare 1, which founded both villages for player 0.
     */
    return at;
  }

  const kraal = foundVillage(home, PLAYER);

  // A village begins with a well (ADR-0023). On rain alone it would open some two
  // fifths short of water and working slower before the player had learned that water
  // was a thing to find. One well keeps the first wet season whole; the dry season, a
  // growing village and the river are the player's to answer.
  const wantWell = place(kraal.x + VILLAGE_RADIUS * 0.55, kraal.y + VILLAGE_RADIUS * 0.75);
  const well = site(BuildingType.Well, wantWell.x, wantWell.y);
  send(CommandKind.Build, well.x, well.y, BuildingType.Well, PLAYER + 1);

  // The people stand out by their own dwellings, NOT in among the cattle.
  //
  // Ringed at 0.45 of the village radius first, which put two dozen of them inside the
  // kraal with the herd: twenty beasts were bolting by tick 142, before the player had
  // touched anything. That is the stress curve working exactly as designed — crowding
  // panics cattle — and the opening has no business demonstrating it.
  //
  // OUTSIDE the ring of dwellings, not on it. At 0.86-1.06 of the village radius the
  // people stood where the huts stand, and a villager spawned inside a footprint is
  // walled in for good. Nobody noticed while people stood about; once work found its
  // own people (Phase B2) they were sent to fields they could never reach.
  for (let i = 0; i < STARTING_UNITS; i++) {
    const angle = (i / STARTING_UNITS) * Math.PI * 2;
    const ring = VILLAGE_RADIUS * (1.35 + ((i % 3) * 0.12));
    const at = place(kraal.x + Math.cos(angle) * ring, kraal.y + Math.sin(angle) * ring);
    send(CommandKind.Spawn, at.x, at.y, PLAYER, KIND_UNIT);
  }

  // No neighbouring village. The neighbours are off the map now (ADR-0021): a trade
  // screen and a party to ties, whose seasons run on their books in
  // src/sim/neighbours.ts. They are player NEIGHBOUR in the ledger and have nobody here.

  // Where the herds graze, as offsets from the centre of the map.
  //
  // The first is on the player's doorstep and deliberately stays there: the herd once
  // sat sixteen tiles out against a vision radius of eight, so a game about cattle
  // opened with no cattle on screen and the player had to go looking for the mechanic.
  // It is still far enough off that the troops do not frighten it — nothing stampedes
  // in the opening minute.
  //
  // The rest were laid out as mirrors between two villages when there were two on the
  // map. With the neighbour gone (ADR-0021) they are simply wild herds at a range of
  // distances — one close by at twelve tiles, the others out to forty — so taking cattle
  // is a thing to range for, not only to reach out and do.
  const HERD_SITES: readonly (readonly [number, number])[] = [
    [0, 0], // in the isibaya at the centre of the player's own village
    [27, 22], // out to the south-east, where the neighbour's village used to stand
    [2, -12], // near the player
    [34, 40], // beyond it
    [-10, 26], // out in open country
    [46, 2], // out in open country, far side
  ];

  for (const [rawX, rawY] of HERD_SITES) {
    // The home herd stands in the isibaya where it was actually founded. It was spawned
    // round the map centre, two tiles off the kraal, and some of it outside the pen.
    const anchor = rawX === 0 && rawY === 0 ? kraal : place(centre + rawX, centre + rawY);
    // A cluster, not a ring: cattle graze together, and a hollow ring has no centre to
    // click on or drive into. The radius follows the separation distance — at 1.5 units
    // apart a dozen beasts need about three units of room, and spawning them tighter
    // than they will stand just makes them shove each other apart on tick one.
    for (let i = 0; i < HERD_SIZE; i++) {
      const angle = i * 2.399963; // golden angle, so the blob fills evenly
      // Tighter for the herd in the kraal than for the ones out on the veld: a pen is a
      // pen. Keeps them clear of the dwellings ringing it, too.
      const penned = rawX === 0 && rawY === 0;
      const spread = (penned ? 1.9 : 3.2) * Math.sqrt((i + 0.5) / HERD_SIZE);
      const at = place(anchor.x + Math.cos(angle) * spread, anchor.y + Math.sin(angle) * spread);
      send(CommandKind.SpawnCattle, at.x, at.y);
    }
  }

  /*
   * The game (ADR-0022): bands placed by habitat, well clear of the village, so the
   * first thing a hunter has to do is go and find them.
   */
  for (const animal of planWildlife(map, seed, home, walkable)) {
    send(CommandKind.SpawnWild, animal.x, animal.y, animal.species, animal.band);
  }
}
