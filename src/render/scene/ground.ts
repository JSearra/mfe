import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import { buildPermutationWith, fbm } from '../../shared/noise.js';

/**
 * Which ground each tile is drawn with — no longer a synonym for its height.
 *
 * It was. The renderer took `map.data[...]`, the tile's own height, as its band, so
 * every one-level step in the terrain was also a complete change of ground texture. On
 * rolling country that happens constantly: measured over three seeds, **18% of all
 * adjacent tile pairs changed ground — a texture boundary every 5.5 tiles.** No amount
 * of blending rescues that. There is at most two thirds of a tile to blend across, the
 * map is permanently mid-transition, and every one of those transitions is a visible
 * edge. It is why every height change read as a hard stop.
 *
 * Age of Empires and Red Alert both keep terrain type and elevation INDEPENDENT — grass
 * exists at many elevations in both, and a slope is a slope rather than a change of
 * ground. This does the same, without throwing the land away: ground follows a SMOOTHED
 * height blended half-and-half with a slow noise field, so high country still tends to
 * the dry end of the ramp, a single tile's wobble cannot flip it, and the boundaries
 * that remain are long, sparse contours rather than a rash.
 *
 * Measured with the shipped weights: 18% down to about 5%, a boundary every twenty
 * tiles instead of every five and a half.
 *
 * Render-side entirely. The simulation's heightmap is untouched and nothing here can
 * reach it: movement, pathing, cost, line of sight and picking all still read the
 * height, which is the thing they are actually about.
 */

/**
 * How far the height is averaged before it decides a ground, in tiles.
 *
 * Six. Smoothing alone takes the boundary density from 18% to 9.7%, which is better and
 * not enough — the large-scale relief still crosses a band edge often. What it buys is
 * that the remaining boundaries follow the shape of the LAND rather than its noise.
 */
const SMOOTH_RADIUS = 6;

/**
 * How much of the answer is the slow noise rather than the land.
 *
 * Half. At 0.8 the density falls further, to 3.8%, and the ground stops being a fact
 * about the terrain — it becomes a pattern laid over it, and the aridity shift the map
 * scripts rely on stops meaning anything. Half keeps the land in the answer and still
 * gets most of the benefit: 5.1%.
 */
const NOISE_WEIGHT = 0.5;

/** Wavelength of the ground noise, as a frequency per tile. About one feature per 55. */
const NOISE_FREQUENCY = 0.018;

/**
 * Box-blur the heightmap, separably.
 *
 * Separable because the alternative is a (2r+1)^2 tap per tile — 169 at this radius,
 * 2.8 million over a standard map — where two passes of (2r+1) cost 26. It runs once
 * when a map is loaded either way, but the square version is slow enough to feel.
 */
function smoothHeights(map: Heightmap): Float32Array {
  const { width, height } = map;
  const pass = new Float32Array(width * height);
  const out = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dx = -SMOOTH_RADIUS; dx <= SMOOTH_RADIUS; dx++) {
        const h = heightAt(map, x + dx, y);
        // Off the map contributes nothing rather than counting as zero, which would
        // drag every border tile toward the wet end of the ramp.
        if (h < 0) continue;
        sum += h;
        count++;
      }
      pass[y * width + x] = count === 0 ? 0 : sum / count;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -SMOOTH_RADIUS; dy <= SMOOTH_RADIUS; dy++) {
        const row = y + dy;
        if (row < 0 || row >= height) continue;
        sum += pass[row * width + x]!;
        count++;
      }
      out[y * width + x] = count === 0 ? 0 : sum / count;
    }
  }
  return out;
}

/**
 * The ground band of every tile, as a field computed once when a map is loaded.
 *
 * `seed` is the map's own, so two viewers of the same match see the same country. It is
 * shuffled through the same Fisher-Yates the simulation uses, over a small local
 * generator rather than the simulation's: nothing here may touch the simulation's RNG,
 * and nothing here needs to — this is a picture, not a rule.
 */
export function createGroundField(map: Heightmap, seed: number, bands: number): Uint8Array {
  const { width, height } = map;
  const smooth = smoothHeights(map);
  const out = new Uint8Array(width * height);

  // A small xorshift, purely to shuffle the lattice. Deterministic from the seed.
  let state = (seed ^ 0x5bf03635) >>> 0 || 1;
  const perm = buildPermutationWith((bound) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % bound;
  });

  const top = bands - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const land = smooth[y * width + x]!;
      const drift = fbm(perm, x * NOISE_FREQUENCY, y * NOISE_FREQUENCY, 3, 2, 0.5);
      const band = Math.round(land * (1 - NOISE_WEIGHT) + drift * top * NOISE_WEIGHT);
      out[y * width + x] = band < 0 ? 0 : band > top ? top : band;
    }
  }
  paintBeaches(map, out, Math.min(SAND, top));
  return out;
}

/** The band a strand is drawn with: the pale sandstone, the only ground that reads as sand. */
const SAND = 6;
/** How far a beach runs up from the waterline, in tiles. */
const BEACH_DEPTH = 2;
/** Beaches are the tallest ground they cover — a strand is low. */
const BEACH_MAX_HEIGHT = 2;
/**
 * Standing water at least this large is the sea, and gets a beach. A river reach is
 * cut into short lengths by its drifts, so this also keeps sand off the riverbanks,
 * where the grass comes down to the water.
 */
const SEA_MIN = 300;

/**
 * Draw a strand along the sea.
 *
 * The Coast map's grass ran straight into the water, and a coastline with no beach
 * reads as a flooded field. This is the smoothed ground field's one hard edge on
 * purpose: a beach IS a boundary, the one place on the map the ground should change
 * abruptly, and it is thin enough that the transition art carries it.
 */
function paintBeaches(map: Heightmap, ground: Uint8Array, sand: number): void {
  const { width, height, water, data } = map;
  if (water.length === 0) return;

  // Which water is the sea: flood each wet region and keep the large ones.
  const region = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  const sea = new Uint8Array(width * height);
  let label = 0;
  for (let start = 0; start < water.length; start++) {
    if (water[start] !== 1 || region[start] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    region[start] = label;
    while (head < tail) {
      const at = queue[head++]!;
      const x = at % width;
      const y = (at - x) / width;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const to = ny * width + nx;
        if (water[to] !== 1 || region[to] !== -1) continue;
        region[to] = label;
        queue[tail++] = to;
      }
    }
    if (tail >= SEA_MIN) for (let i = 0; i < tail; i++) sea[queue[i]!] = 1;
    label++;
  }

  // Distance inland from the sea, a breadth-first step at a time, as far as a beach runs.
  const distance = new Uint8Array(width * height).fill(0xff);
  let head = 0;
  let tail = 0;
  for (let at = 0; at < sea.length; at++) {
    if (sea[at] !== 1) continue;
    distance[at] = 0;
    queue[tail++] = at;
  }
  while (head < tail) {
    const at = queue[head++]!;
    const next = distance[at]! + 1;
    if (next > BEACH_DEPTH) continue;
    const x = at % width;
    const y = (at - x) / width;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const to = ny * width + nx;
      if (water[to] === 1 || distance[to]! <= next) continue;
      distance[to] = next;
      // Not up a sea cliff: a headland left standing over the water keeps its ground.
      if (data[to]! <= BEACH_MAX_HEIGHT) ground[to] = sand;
      queue[tail++] = to;
    }
  }
}
