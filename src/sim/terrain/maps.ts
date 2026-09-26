import type { Heightmap } from '../../shared/heightmap.js';
import { MapScript } from '../../shared/maps.js';
import { carveRiver, carveRiverWest, floodSea, gradeBanks } from './water.js';
import { createRng, nextFloat, nextInt, nextU32 } from '../math/rng.js';
import { cos, sin, TWO_PI } from '../math/trig.js';
import { fbm, smoothstep } from '../../shared/noise.js';
import { buildPermutation } from './seededNoise.js';

/**
 * The four named maps from the original brief, as heightmap functions.
 *
 * That they can be heightmap functions at all is ADR-0006 paying off. A cliff is any
 * edge whose height step exceeds MAX_CLIMB, so mesas, koppies, poorts and dongas are all
 * expressible as shapes in one array rather than as bespoke tile-placement code with its
 * own passability rules.
 *
 * Every generator is deterministic from its seed: seeded RNG, owned trig, no wall clock.
 * The same seed gives the same battlefield on every machine, which is what makes a map
 * something a replay can reference by name and number rather than having to ship.
 */

// The names live in src/shared so the UI can offer them without importing from the
// simulation; the generators below stay here, where they belong.
export { MapScript, MAP_SCRIPTS } from '../../shared/maps.js';

const LEVELS = 8;

function make(width: number, height: number): { data: Uint8Array; map: Heightmap } {
  const data = new Uint8Array(width * height);
  const water = new Uint8Array(width * height);
  return { data, map: { width, height, levels: LEVELS, data, water } };
}

function clampLevel(value: number): number {
  const level = Math.floor(value);
  return level < 0 ? 0 : level > LEVELS - 1 ? LEVELS - 1 : level;
}

/**
 * Thaba Bosiu: "the mountain at night".
 *
 * Plateaus lifted straight out of the veld with unclimbable rims, each cut by one or two
 * ramps. The defensive character comes entirely from those ramps — the height step does
 * the rest, because everything else around the rim exceeds MAX_CLIMB and is therefore a
 * cliff without anything having to say so.
 */
/** Levels from a Thaba Bosiu summit down to the apron at the foot of its rim. */
const RIM_DROP = 3;

function thabaBosiu(width: number, height: number, seed: number): Heightmap {
  const { data, map } = make(width, height);
  const rng = createRng(seed);
  const perm = buildPermutation(seed ^ 0x51ee);

  // Rolling sourveld underneath: low swells rather than a floor, so the mesas rise out
  // of country rather than off a table.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = clampLevel(fbm(perm, x * 0.05, y * 0.05, 4, 2, 0.5) * 3.1);
    }
  }

  // The Mohokare runs past the mountain. Laid first, so the mesas can be kept clear of
  // it: grading its banks later would otherwise saw a ramp into any rim within reach.
  carveRiver(map, rng, 13);

  const mesaCount = 2 + nextInt(rng, 2);
  for (let m = 0; m < mesaCount; m++) {
    const radius = Math.floor(width * 0.1) + nextInt(rng, Math.floor(width * 0.06));
    // Foothills: the talus apron a mesa stands in, falling away a level every couple of
    // tiles. A plateau lifted straight off the flat reads as a stage set; the apron is
    // what makes it a mountain, and it is also where the stone collects.
    const apron = 5 + nextInt(rng, 3);

    // The best of several sites, by distance from the river. Taking the first that
    // cleared a fixed margin failed on most seeds — the river meanders across the whole
    // middle of the map — and the mesa then landed on the water and was graded away.
    let centreX = 0;
    let centreY = 0;
    let clearance = -1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = Math.floor(width * 0.2) + nextInt(rng, Math.floor(width * 0.6));
      const y = Math.floor(height * 0.2) + nextInt(rng, Math.floor(height * 0.6));
      const clear = distanceToWater(map, x, y, radius * 2);
      if (clear > clearance) {
        clearance = clear;
        centreX = x;
        centreY = y;
      }
    }
    const top = 5 + nextInt(rng, 2);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * width + x;
        if (map.water[at] === 1) continue;
        const dx = x - centreX;
        const dy = y - centreY;
        // A noisy radius, so the rim is not a circle. Lobes as well as a ragged edge: at
        // a tile and a half of wobble every mesa came out a coin, and the real mountain
        // is a sprawl of spurs and re-entrants.
        const lobes = (fbm(perm, x * 0.045 + m * 17, y * 0.045, 3, 2, 0.5) - 0.5) * radius * 2.2;
        const wobble = fbm(perm, x * 0.09, y * 0.09, 3, 2, 0.5) * 3 - 1.5;
        const beyond = Math.sqrt(dx * dx + dy * dy) - (radius + lobes + wobble);
        if (beyond <= 0) {
          data[at] = top;
          continue;
        }
        if (beyond > apron) continue;
        // Three levels below the summit at the foot of the rim, then down to the veld.
        // Three, not two: the rim is the whole character of the place, and at two
        // levels a mesa's wall drew a third as tall as it did on the bare plain.
        const slope = clampLevel(top - RIM_DROP - Math.floor(beyond * 0.5));
        if (data[at]! < slope) data[at] = slope;
      }
    }

    // Cut the passes. Without them the plateau is unreachable rather than defensible,
    // which is a different and much worse map.
    const passes = 1 + nextInt(rng, 2);
    for (let p = 0; p < passes; p++) {
      // A bearing whose way down stays on the map and out of the river. A pass that
      // runs into the water or off the edge leads nowhere, and with one or two of them
      // per mesa that was enough, on some seeds, to leave a summit nobody could reach.
      let angle = 0;
      for (let attempt = 0; attempt < 6; attempt++) {
        angle = (nextU32(rng) / 4294967296) * TWO_PI;
        if (passLands(map, centreX, centreY, angle, radius * 2 + apron + top)) break;
      }
      // Where the rim actually is on this bearing. The outline is lobed, so the nominal
      // radius can be several tiles inside or outside it, and a ramp started from the
      // wrong one either trenches the summit or stops short of the edge it was for.
      let rim = 0;
      for (let step = 0; step < width; step++) {
        const x = Math.round(centreX + cos(angle) * step);
        const y = Math.round(centreY + sin(angle) * step);
        if (x < 0 || y < 0 || x >= width || y >= height || data[y * width + x]! < top) break;
        rim = step;
      }
      // A ramp descends one level per tile, which is exactly MAX_CLIMB. It starts as
      // far inside the rim as the rim is tall — three tiles for a three-level drop to
      // the apron — so it arrives at the foot at the apron's own height rather than
      // leaving a step at the bottom, and runs on down until it meets the ground.
      const start = rim - RIM_DROP;
      for (let step = start; step <= rim + apron + top; step++) {
        const x = Math.round(centreX + cos(angle) * step);
        const y = Math.round(centreY + sin(angle) * step);
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) break;
        const rampHeight = clampLevel(top - (step - start));
        if (step > rim && data[y * width + x]! <= rampHeight) break;
        for (let wy = -1; wy <= 1; wy++) {
          for (let wx = -1; wx <= 1; wx++) {
            const index = (y + wy) * width + (x + wx);
            if (map.water[index] === 1) continue;
            if (data[index]! > rampHeight) data[index] = rampHeight;
          }
        }
      }
    }
  }

  gradeBanks(map);
  return map;
}

/**
 * Whether a pass cut on this bearing reaches open ground: every tile along it, out to
 * `length`, on the map and dry, with a tile of margin either side for the ramp's width.
 */
function passLands(map: Heightmap, centreX: number, centreY: number, angle: number, length: number): boolean {
  for (let step = 0; step <= length; step++) {
    const x = Math.round(centreX + cos(angle) * step);
    const y = Math.round(centreY + sin(angle) * step);
    if (x < 2 || y < 2 || x >= map.width - 2 || y >= map.height - 2) return false;
    for (let wy = -1; wy <= 1; wy++) {
      for (let wx = -1; wx <= 1; wx++) {
        if (map.water[(y + wy) * map.width + (x + wx)] === 1) return false;
      }
    }
  }
  return true;
}

/**
 * Distance from a point to the nearest water, up to `reach`.
 *
 * Sampled on a two-tile grid, which is plenty for siting a mountain. Returns `reach`
 * when there is none that close. Integer arithmetic and a square root only.
 */
function distanceToWater(map: Heightmap, centreX: number, centreY: number, reach: number): number {
  let best = reach * reach;
  for (let y = centreY - reach; y <= centreY + reach; y += 2) {
    for (let x = centreX - reach; x <= centreX + reach; x += 2) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      if (map.water[y * map.width + x] !== 1) continue;
      const dx = x - centreX;
      const dy = y - centreY;
      if (dx * dx + dy * dy < best) best = dx * dx + dy * dy;
    }
  }
  return Math.sqrt(best);
}

/**
 * Coast: the land running down to the sea.
 *
 * The one landscape here bounded by water rather than merely crossed by it. A coastline
 * costs no connectivity — everything inland stays joined — so the shoreline can be as
 * long as it likes, and a village sited on it has a food supply the drought cannot
 * touch. That is the point of it: every other source of food on this map answers to the
 * weather.
 */
function coast(width: number, height: number, seed: number): Heightmap {
  const { data, map } = make(width, height);
  const perm = buildPermutation(seed ^ 0x36ea);
  const cliffs = buildPermutation(seed ^ 0x0c1f);
  const rng = createRng(seed);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Rising away from the sea: a coastal plain behind the strand, hills at the back.
      const inland = x / width;
      const base = fbm(perm, x * 0.03, y * 0.03, 4, 2, 0.5);
      // Headlands: stretches where high ground runs right down to the water.
      const bluff = fbm(cliffs, x * 0.05, y * 0.05, 3, 2, 0.5);
      const lift = bluff > 0.56 ? (bluff - 0.56) * 14 : 0;
      data[y * width + x] = clampLevel((base * 0.55 + inland * 0.75) * 6.2 + lift);
    }
  }

  floodSea(map, perm, 0.2);
  // And a river reaching the sea, because a coast without one is a wall of water.
  carveRiverWest(map, rng, 13);

  // Where a headland meets the sea it is left standing as a cliff rather than graded
  // down to a beach. Not everywhere — the strand is where the fishing is, and a coast
  // that is all cliff has nowhere to stand — only where the bluff noise is high.
  const keep = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (map.water[at] === 1) continue;
      if (fbm(cliffs, x * 0.05, y * 0.05, 3, 2, 0.5) > 0.6 && data[at]! >= 3) keep[at] = 1;
    }
  }
  // Both, then graded together: a river meeting the sea has one bank, not two.
  gradeBanks(map, keep);
  // Sea to the east — see `mirror`. Built facing west because every helper here counts
  // inland from x = 0, and turned round at the end.
  mirror(map);
  return map;
}

/**
 * Flip a map east to west.
 *
 * The camera looks from the south-east, so only faces that step DOWN toward it — toward
 * larger x and y — are drawn; a face stepping down away from the viewer is behind the
 * ground it belongs to. A mountain range on the east edge therefore showed the player
 * nothing but its flat top, and a sea on the west edge hid every sea cliff the coast
 * had. Rising toward the back of the view is what makes relief visible at all.
 */
function mirror(map: Heightmap): void {
  const { width, height, data, water } = map;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width >> 1; x++) {
      const a = row + x;
      const b = row + width - 1 - x;
      const level = data[a]!;
      data[a] = data[b]!;
      data[b] = level;
      const wet = water[a]!;
      water[a] = water[b]!;
      water[b] = wet;
    }
  }
}

/**
 * Umfolozi: rolling spurs cut by a braided river.
 *
 * The river is a sunken channel rather than a separate water tile type, so it blocks and
 * channels movement through the same height rule everything else uses. Drifts — shallow
 * crossings — are left where the channel rises back to bank level.
 */
function umfolozi(width: number, height: number, seed: number): Heightmap {
  const { data, map } = make(width, height);
  const perm = buildPermutation(seed ^ 0x21fe);
  const rng = createRng(seed);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Ridged noise: sharp spurs rather than smooth hills.
      const base = fbm(perm, x * 0.035, y * 0.035, 5, 2, 0.5);
      const ridged = 1 - Math.abs(base * 2 - 1);
      data[y * width + x] = clampLevel(smoothstep(ridged) * 5.5);
    }
  }

  // A meandering channel carved to the floor, with periodic drifts left standing.
  const driftEvery = 11 + nextInt(rng, 7);
  for (let y = 0; y < height; y++) {
    const meander = sin(y * 0.09) * width * 0.22 + sin(y * 0.031) * width * 0.1;
    const centre = Math.round(width / 2 + meander);
    const halfWidth = 2 + Math.floor(fbm(perm, y * 0.2, 0, 2, 2, 0.5) * 3);

    for (let x = centre - halfWidth; x <= centre + halfWidth; x++) {
      if (x < 0 || x >= width) continue;
      // A drift: the bed rises to bank level and can be waded.
      const drift = y % driftEvery === 0;
      data[y * width + x] = drift ? 1 : 0;
      // And everywhere it does not rise, there is water in it. The channel was already
      // impassable by height; marking it wet is what makes it fishable, and what stops
      // the renderer drawing a river as dry ground.
      map.water[y * width + x] = drift ? 0 : 1;
    }
  }
  // The spurs used to stand straight over the channel, which made the river a canyon:
  // measured, the largest walkable piece of the map was 53% of it. Graded, the banks
  // come down to the water a level a tile, and the spurs keep their crests.
  gradeBanks(map);
  return map;
}

/**
 * The Great Karoo: a flat plain interrupted by koppies and dongas.
 *
 * Almost all of it is one level, which is the point — cover is scarce and every piece of
 * it matters. Koppies are impassable because their sides exceed MAX_CLIMB; dongas are
 * sunk one level, so they break line of sight without blocking movement along them.
 */
function karoo(width: number, height: number, seed: number): Heightmap {
  const { data, map } = make(width, height);
  const rng = createRng(seed);
  const perm = buildPermutation(seed ^ 0x4a20);

  data.fill(2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Barely any relief: enough to stop it looking like graph paper.
      if (fbm(perm, x * 0.07, y * 0.07, 3, 2, 0.5) > 0.62) data[y * width + x] = 3;
    }
  }

  // Koppies come in ranges as well as alone: a line of them where a dolerite sill
  // breaks the surface, and a few loners between.
  const koppies: { x: number; y: number; radius: number }[] = [];
  const ranges = 2 + nextInt(rng, 2);
  for (let r = 0; r < ranges; r++) {
    let x = 8 + nextInt(rng, width - 16);
    let y = 8 + nextInt(rng, height - 16);
    const heading = (nextU32(rng) / 4294967296) * TWO_PI;
    const count = 3 + nextInt(rng, 3);
    for (let k = 0; k < count; k++) {
      koppies.push({ x, y, radius: 2 + nextInt(rng, 3) });
      const gap = 6 + nextInt(rng, 5);
      x = Math.round(x + cos(heading) * gap);
      y = Math.round(y + sin(heading) * gap);
    }
  }
  const loners = 3 + nextInt(rng, 4);
  for (let k = 0; k < loners; k++) {
    koppies.push({ x: 3 + nextInt(rng, width - 6), y: 3 + nextInt(rng, height - 6), radius: 2 + nextInt(rng, 3) });
  }

  // Each stands in a skirt of scree that climbs two levels toward it. The crown still
  // rises sheer out of the skirt, so a koppie stays unclimbable — which is what it is
  // for on this map — but it no longer stands on the plain like a pillar on a floor.
  const SKIRT = 3;
  for (const koppie of koppies) {
    const reach = koppie.radius + SKIRT;
    for (let y = koppie.y - reach; y <= koppie.y + reach; y++) {
      for (let x = koppie.x - reach; x <= koppie.x + reach; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const dx = x - koppie.x;
        const dy = y - koppie.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const at = y * width + x;
        if (distance <= koppie.radius) {
          data[at] = 7;
          continue;
        }
        if (distance > reach) continue;
        const skirt = distance - koppie.radius <= 1.5 ? 4 : 3;
        if (data[at]! < skirt) data[at] = skirt;
      }
    }
  }

  const dongas = 3 + nextInt(rng, 3);
  for (let d = 0; d < dongas; d++) {
    let x = nextInt(rng, width);
    let y = nextInt(rng, height);
    const drift = (nextU32(rng) / 4294967296) * TWO_PI;

    for (let step = 0; step < Math.floor(width * 0.7); step++) {
      const wander = sin(step * 0.19 + drift) * 0.9;
      x = Math.round(x + cos(drift) + wander);
      y = Math.round(y + sin(drift) - wander * 0.4);
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) break;
      data[y * width + x] = 1;
      if (step % 3 === 0) data[y * width + Math.min(width - 1, x + 1)] = 1;
    }
  }
  return map;
}

/**
 * The Magaliesberg: parallel ridge lines pierced by poorts.
 *
 * A poort is a gap in a ridge, and here it is literally that — a stretch where the band
 * is not raised. Armies funnel through them because the alternative exceeds MAX_CLIMB,
 * which makes holding one the whole tactical question of the map.
 */
function magaliesberg(width: number, height: number, seed: number): Heightmap {
  const { data, map } = make(width, height);
  const rng = createRng(seed);
  const perm = buildPermutation(seed ^ 0x3a15);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = clampLevel(fbm(perm, x * 0.04, y * 0.04, 4, 2, 0.5) * 2);
    }
  }

  // A river through the ridges, as the Crocodile cuts the real range at Hartbeespoort.
  // Laid FIRST, from its own stream so the ridges draw exactly what they always drew,
  // because in this country the river came first: the poort it runs through is the one
  // it cut. Each ridge gives up one of its seeded poorts in exchange, so the river costs
  // the range no more ground than the gap it replaces.
  carveRiver(map, createRng(seed ^ 0x77e5), 12);
  const riverX = riverCentres(map);

  const ridges = 3 + nextInt(rng, 2);
  for (let r = 0; r < ridges; r++) {
    const baseY = Math.floor(((r + 0.5) / ridges) * height);
    const thickness = 3 + nextInt(rng, 3);
    const crest = 6 + nextInt(rng, 2);

    // Two or three poorts per ridge, at positions drawn from the seed.
    const poortCount = 2 + nextInt(rng, 2);
    const poorts: number[] = [];
    for (let p = 0; p < poortCount; p++) poorts.push(2 + nextInt(rng, width - 4));
    // The river's poort stands in for the first of them.
    poorts.shift();

    for (let x = 0; x < width; x++) {
      const inPoort = poorts.some((position) => Math.abs(x - position) <= 2);
      if (inPoort) continue;

      const waver = Math.round(sin(x * 0.06 + r) * 2.5);
      for (let t = -thickness; t <= thickness; t++) {
        const y = baseY + waver + t;
        if (y < 0 || y >= height) continue;
        // The river's own poort, which follows it however it bends through the ridge.
        if (Math.abs(x - riverX[y]!) <= 2) continue;
        // Taper to the crest so the ridge has flanks rather than being a wall.
        const level = clampLevel(crest - Math.abs(t) * 1.5);
        if (data[y * width + x]! < level) data[y * width + x] = level;
      }
    }
  }

  // Graded only close to the water, so the poort's walls stand. Graded everywhere in
  // reach, the river flattened a quarter of every ridge it crossed.
  gradeBanks(map, crestsAwayFrom(map, 1));
  return map;
}

/**
 * The river's centre column on every row, carried across drifts from the row above.
 * A map with no river gets -99 everywhere, which is nowhere near any column.
 */
function riverCentres(map: Heightmap): Int32Array {
  const { width, height, water } = map;
  const centres = new Int32Array(height).fill(-99);
  let last = -99;
  for (let y = 0; y < height; y++) {
    let first = -1;
    let final = -1;
    for (let x = 0; x < width; x++) {
      if (water[y * width + x] !== 1) continue;
      if (first < 0) first = x;
      final = x;
    }
    if (first >= 0) last = (first + final) >> 1;
    centres[y] = last;
  }
  // Rows before the first wet one take its column too.
  let firstWet = -99;
  for (let y = 0; y < height && firstWet === -99; y++) firstWet = centres[y]!;
  for (let y = 0; y < height && centres[y] === -99; y++) centres[y] = firstWet;
  return centres;
}

/** Ground that is not within `margin` tiles of water, as a keep-mask for `gradeBanks`. */
function crestsAwayFrom(map: Heightmap, margin: number): Uint8Array {
  const { width, height, water } = map;
  const keep = new Uint8Array(width * height).fill(1);
  for (let at = 0; at < water.length; at++) {
    if (water[at] !== 1) continue;
    const tileX = at % width;
    const tileY = (at - tileX) / width;
    for (let y = tileY - margin; y <= tileY + margin; y++) {
      for (let x = tileX - margin; x <= tileX + margin; x++) {
        if (x >= 0 && y >= 0 && x < width && y < height) keep[y * width + x] = 0;
      }
    }
  }
  return keep;
}

/**
 * uKhahlamba: the barrier of spears.
 *
 * The one map built around a mountain range rather than a feature on a plain. The High
 * Berg stands along the western edge as a basalt wall nobody climbs; below it the Little
 * Berg, a sandstone terrace with the wall's buttresses standing on it; below that the foothills
 * rolling out east into grassland, which is where a village can live. Rivers come off
 * the mountain and cut valleys down through both steps, and those valleys are the only
 * ways up — graded banks, the same rule every river uses, so a pass here is a river's
 * work rather than a special case.
 *
 * Measured against the start: the village sits in the foothills at the map's centre,
 * on ground a field will take. The mountain is the view, and the reason to walk west.
 */
function ukhahlamba(width: number, height: number, seed: number): Heightmap {
  const { data, map } = make(width, height);
  const rng = createRng(seed);
  const perm = buildPermutation(seed ^ 0x6b4a);
  const spires = buildPermutation(seed ^ 0x5b1e);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // How far toward the range, pushed about so the steps are not ruled lines.
      const east = x / width + (fbm(perm, x * 0.03, y * 0.03, 4, 2, 0.5) - 0.5) * 0.22;
      const rolling = fbm(perm, x * 0.06 + 40, y * 0.06, 4, 2, 0.5);
      let level: number;
      if (east < 0.6) {
        // Foothills: grass swells, rising gently toward the mountain.
        level = rolling * 2.4 + Math.max(0, east - 0.4) * 5;
      } else if (east < 0.66) {
        // The last slope, up to the sandstone.
        level = 3 + (east - 0.6) * 8;
      } else if (east < 0.78) {
        // The Little Berg: a walkable terrace, with buttresses standing off the wall
        // above it as pinnacles — the spires the range is named for.
        level = fbm(spires, x * 0.14, y * 0.14, 2, 2, 0.5) > 0.68 ? 7 : 4;
      } else {
        // The High Berg: three levels sheer above the terrace, one face the height of a
        // tile. Two smaller steps read as a staircase; one tall one reads as a wall.
        level = 7;
      }
      data[y * width + x] = clampLevel(level);
    }
  }

  // Rivers off the escarpment, running away from it (east, once mirrored). Two or three, spaced down the map so the
  // foothills are divided into country rather than cut into strips.
  const rivers = 2 + nextInt(rng, 2);
  for (let r = 0; r < rivers; r++) {
    const centre = (r + 0.5) / rivers + (nextFloat(rng) - 0.5) * 0.12;
    carveRiverWest(map, rng, 11, { centre, amplitude: 0.05, halfWidth: 1 });
  }
  gradeBanks(map);
  // The range to the west, the back of the view, where its faces can be seen. See
  // `mirror`: built on the east edge, the whole escarpment faced away from the camera.
  mirror(map);
  return map;
}

const GENERATORS: Readonly<Record<MapScript, (w: number, h: number, seed: number) => Heightmap>> = {
  [MapScript.ThabaBosiu]: thabaBosiu,
  [MapScript.Umfolozi]: umfolozi,
  [MapScript.Karoo]: karoo,
  [MapScript.Magaliesberg]: magaliesberg,
  [MapScript.Coast]: coast,
  [MapScript.UKhahlamba]: ukhahlamba,
};

export function generateMap(
  script: MapScript,
  width: number,
  height: number,
  seed: number,
): Heightmap {
  return GENERATORS[script](width, height, seed);
}

