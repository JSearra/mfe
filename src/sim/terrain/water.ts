import { type Heightmap } from '../../shared/heightmap.js';
import { nextFloat, nextInt, type Rng } from '../math/rng.js';
import { cos, sin, TWO_PI } from '../math/trig.js';
import { fbm } from '../../shared/noise.js';

/**
 * Rivers and coastlines: where the water is.
 *
 * The existing maps already cut rivers as sunken channels, which blocks and channels
 * movement through the same height rule everything else uses. That stays. What is added
 * here is the MARK — a tile that is not merely low but wet — because fishing has to know
 * where the water is, and because "low ground" is everywhere on an open map while a
 * river is somewhere particular.
 *
 * **A river must never cut the map in two.** Water is impassable, so a channel carved
 * bank to bank divides the land into two components: the herds on the far side become
 * unreachable and the neighbouring village cannot be walked to, which is the exact
 * failure `terrain/placement.ts` exists to work around and should not be manufactured
 * here. Every course laid down leaves DRIFTS — shallow crossings at intervals, dry tiles
 * spanning the channel — so the two banks are always joined.
 */

/** Tiles of dry crossing left standing between stretches of water. */
const DRIFT_WIDTH = 2;

/** Offshore land smaller than this is drowned rather than left as a speck. */
const ISLET_MIN = 7;

/**
 * Grade the ground down toward every waterline, one level per tile of distance.
 *
 * `MAX_CLIMB` is 1 and a channel floor is 0, so ground that rises no faster than a
 * level a tile as it leaves the water has no edge in it a unit cannot walk, and
 * therefore no part of it draws as a face. A tile `d` tiles from water is held to
 * height `d`, which is exactly that condition written down.
 *
 * SELF-LIMITING, which is what keeps it from flattening the map: at distance `d` it
 * only lowers ground standing above `d`, so it reaches as far inland as the terrain is
 * steep and stops the moment the natural ground is already low enough. Beside a river
 * on the flats it touches nothing; under an escarpment it cuts a ramp down to the
 * water. That is also why it runs as a distance transform rather than a sweep along
 * each row: the bank of a meander faces every direction in turn, and grading only
 * across the channel left the walls standing wherever it ran the other way. Measured on
 * the shipped seed, cliff edges within three tiles of water went 859 -> 378 grading one
 * axis, and 378 -> a handful grading all of them.
 *
 * Deterministic: a fixed-order breadth-first sweep over integers, no floating point and
 * nothing from the banned list. It runs once at generation.
 *
 * A terrain change rather than a drawing one, deliberately. The comment in `carveRiver`
 * has always said the banks must fall toward the channel "or the river becomes a canyon
 * nothing can approach". It graded one tile, so it did not do what it said.
 */
export function gradeBanks(map: Heightmap, keep?: Uint8Array): void {
  const { width, height, data, water } = map;
  if (water.length === 0) return;

  // Distance to the nearest water tile, capped at the tallest ground there can be:
  // past that the clamp can never bite, so there is nothing to learn by walking further.
  const reach = map.levels;
  const distance = new Uint8Array(width * height).fill(0xff);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  for (let at = 0; at < water.length; at++) {
    if (water[at] !== 1) continue;
    distance[at] = 0;
    queue[tail++] = at;
  }

  const stepX = [1, -1, 0, 0];
  const stepY = [0, 0, 1, -1];

  while (head < tail) {
    const at = queue[head++]!;
    const next = distance[at]! + 1;
    if (next > reach) continue;

    const tileX = at % width;
    const tileY = (at - tileX) / width;

    for (let side = 0; side < 4; side++) {
      const x = tileX + stepX[side]!;
      const y = tileY + stepY[side]!;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;

      const to = y * width + x;
      if (distance[to]! <= next) continue;
      distance[to] = next;
      // A kept tile stands where it is: a sea cliff is a bank that was NOT graded. The
      // distance still passes through it, so the ground behind it grades as usual.
      if (data[to]! > next && keep?.[to] !== 1) data[to] = next;
      queue[tail++] = to;
    }
  }
}

/**
 * Cut a meandering watercourse across the map, top to bottom, and mark it wet.
 *
 * Carves the channel floor down as it goes, so the river sits in a valley rather than
 * lying on the surface like a painted line — the banks read as banks from the side, at
 * the isometric angle the game is actually seen from.
 */
export function carveRiver(map: Heightmap, rng: Rng, driftEvery: number): void {
  const { width, height, data, water } = map;
  if (water.length === 0) return;

  // A wandering centre line. Amplitude is a fraction of the width so a river crosses a
  // small map as readily as a large one.
  const phase = nextFloat(rng) * TWO_PI;
  const amplitude = width * (0.14 + nextFloat(rng) * 0.10);
  const wobble = 0.045 + nextFloat(rng) * 0.03;
  const centre = width * (0.35 + nextFloat(rng) * 0.3);
  const halfWidth = 1 + nextInt(rng, 2);
  const driftAt = nextInt(rng, driftEvery);

  for (let tileY = 0; tileY < height; tileY++) {
    // Left dry: the crossing. Two rows of it, so a drift is walkable rather than a
    // single-tile seam a unit has to find exactly.
    if ((tileY + driftAt) % driftEvery < DRIFT_WIDTH) continue;

    const course = centre + sin(tileY * wobble + phase) * amplitude;
    const from = Math.floor(course - halfWidth);
    const to = Math.floor(course + halfWidth);

    for (let tileX = from; tileX <= to; tileX++) {
      if (tileX < 0 || tileX >= width) continue;
      const at = tileY * width + tileX;
      data[at] = 0;
      water[at] = 1;
    }
    // Banks fall toward the channel rather than standing over it as a cliff, or the
    // river becomes a canyon nothing can approach — and a shore nobody can stand on is
    // no use to anybody fishing. Graded over BANK_GRADE tiles, one level a tile, so
    // every edge in the bank is walkable and none of it draws as a face.

  }
}

/**
 * Flood one edge of the map to make a coast.
 *
 * An edge rather than a corner or a lake: a coastline is a boundary of the world, and
 * bounding one side of the map with water costs no connectivity — everything inland
 * stays joined to everything else, which is the property a river has to work for.
 */
export function carveCoast(map: Heightmap, rng: Rng, depth: number): void {
  const { width, height, data, water } = map;
  if (water.length === 0) return;

  const phase = nextFloat(rng) * TWO_PI;
  const roll = 0.06 + nextFloat(rng) * 0.05;
  const ragged = 2 + nextInt(rng, 3);

  for (let tileY = 0; tileY < height; tileY++) {
    // An irregular shoreline. A straight edge of water reads as the map running out
    // rather than as a coast.
    const reach = depth + Math.round(sin(tileY * roll + phase) * ragged + cos(tileY * roll * 2.3) * 1.5);
    for (let tileX = 0; tileX < reach && tileX < width; tileX++) {
      const at = tileY * width + tileX;
      data[at] = 0;
      water[at] = 1;
    }

  }
}

/**
 * A sea along the west edge, with a coastline shaped like one.
 *
 * `carveCoast` below lays water to a depth that wobbles row by row, and a coast drawn
 * that way is a straight edge with a ripple in it: a wall of water down one side of the
 * map, which is what the Coast map was. A real one is bays and headlands at every
 * scale, and the odd rock standing off it.
 *
 * So the waterline here is a CONTOUR of a two-dimensional field — distance inland,
 * pushed about by slow noise — rather than a depth per row. A contour curls: it makes
 * bays that run in behind a headland, and where the noise dips offshore it leaves an
 * islet standing. Two tidy-ups follow, both about what a player can use: specks of
 * land too small to be anything are drowned, and water cut off from the sea (a hollow
 * the contour happened to enclose) is filled, because a lake that appears for no reason
 * a kilometre inland is a generator artefact rather than a landscape.
 *
 * `reach` is the mean depth of the sea as a fraction of the width.
 */
export function floodSea(map: Heightmap, perm: Uint8Array, reach: number): void {
  const { width, height, data, water } = map;
  if (water.length === 0) return;

  for (let tileY = 0; tileY < height; tileY++) {
    for (let tileX = 0; tileX < width; tileX++) {
      // Bays a fifth of the map across, and coves on them a few tiles wide.
      const broad = fbm(perm, tileX * 0.026 + 31.7, tileY * 0.026 + 5.3, 4, 2, 0.5) - 0.5;
      const fine = fbm(perm, tileX * 0.11 + 7.1, tileY * 0.11 + 19.9, 2, 2, 0.5) - 0.5;
      const inland = tileX / width - broad * 0.8 - fine * 0.1;
      if (inland >= reach) continue;
      const at = tileY * width + tileX;
      water[at] = 1;
      data[at] = 0;
    }
  }

  const component = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  const stepX = [1, -1, 0, 0];
  const stepY = [0, 0, 1, -1];

  /** Flood one region of like tiles from `start`; returns its size and whether it reaches the west edge. */
  function flood(start: number, wet: number, label: number): { size: number; edge: boolean } {
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    component[start] = label;
    let edge = false;
    while (head < tail) {
      const at = queue[head++]!;
      const x = at % width;
      const y = (at - x) / width;
      if (x === 0) edge = true;
      for (let side = 0; side < 4; side++) {
        const nx = x + stepX[side]!;
        const ny = y + stepY[side]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const to = ny * width + nx;
        if (component[to] !== -1 || water[to] !== wet) continue;
        component[to] = label;
        queue[tail++] = to;
      }
    }
    return { size: tail, edge };
  }

  // Fixed tile order and integer labels throughout: deterministic without trying.
  let label = 0;
  const sizes: number[] = [];
  const edges: boolean[] = [];
  for (let at = 0; at < width * height; at++) {
    if (component[at] !== -1) continue;
    const result = flood(at, water[at]!, label++);
    sizes.push(result.size);
    edges.push(result.edge);
  }

  // The mainland is the largest dry region; every other dry region is an island.
  let mainland = -1;
  for (let at = 0; at < width * height; at++) {
    if (water[at] === 1) continue;
    const c = component[at]!;
    if (mainland === -1 || sizes[c]! > sizes[mainland]!) mainland = c;
  }

  for (let at = 0; at < width * height; at++) {
    const c = component[at]!;
    if (water[at] === 1) {
      // Cut off from the open sea: not a lagoon, a hollow. Fill it.
      if (!edges[c]) {
        water[at] = 0;
        data[at] = Math.max(data[at]!, 1);
      }
    } else if (c !== mainland && sizes[c]! < ISLET_MIN) {
      // Too small to read as land. Drown it.
      water[at] = 1;
      data[at] = 0;
    }
  }
}

/**
 * A river running west across the map, into the sea if there is one.
 *
 * `carveRiver` runs top to bottom, which on the Coast map put the river PARALLEL to the
 * shore — near the sea and never reaching it. A river reaching a sea is the one thing a
 * coastline most needs, so this one runs from the inland edge toward the water, and
 * opens into an estuary over its last few tiles: the mouth is the widest part of any
 * river, and a mouth the width of the channel reads as a ditch meeting a lake.
 *
 * Drifts are left as `carveRiver` leaves them, and for the same reason: a river from
 * edge to sea divides the land into two banks, and only the drifts join them. None in
 * the estuary itself, where nobody wades.
 */
export function carveRiverWest(
  map: Heightmap,
  rng: Rng,
  driftEvery: number,
  options: { centre?: number; amplitude?: number; halfWidth?: number } = {},
): void {
  const { width, height, data, water } = map;
  if (water.length === 0) return;

  const phase = nextFloat(rng) * TWO_PI;
  const amplitude = height * (options.amplitude ?? 0.08 + nextFloat(rng) * 0.08);
  const wobble = 0.05 + nextFloat(rng) * 0.03;
  const centre = height * (options.centre ?? 0.3 + nextFloat(rng) * 0.4);
  const halfWidth = options.halfWidth ?? 1 + nextInt(rng, 2);
  const driftAt = nextInt(rng, driftEvery);

  const courseAt = (tileX: number): number =>
    centre + sin(tileX * wobble + phase) * amplitude + sin(tileX * wobble * 2.7 + phase * 1.3) * amplitude * 0.25;

  // Where the river meets standing water already laid down — the sea — if it does.
  let mouth = -1;
  for (let tileX = 0; tileX < width; tileX++) {
    const tileY = Math.floor(courseAt(tileX));
    if (tileY < 0 || tileY >= height) continue;
    if (water[tileY * width + tileX] === 1) mouth = tileX;
  }

  const ESTUARY = 9;
  for (let tileX = width - 1; tileX > mouth; tileX--) {
    const fromMouth = mouth < 0 ? width : tileX - mouth;
    const opening = fromMouth < ESTUARY ? Math.floor((ESTUARY - fromMouth) / 2) : 0;
    if (opening === 0 && (tileX + driftAt) % driftEvery < DRIFT_WIDTH) continue;

    const course = courseAt(tileX);
    const from = Math.floor(course - halfWidth - opening);
    const to = Math.floor(course + halfWidth + opening);
    for (let tileY = from; tileY <= to; tileY++) {
      if (tileY < 0 || tileY >= height) continue;
      const at = tileY * width + tileX;
      data[at] = 0;
      water[at] = 1;
    }
  }
}
