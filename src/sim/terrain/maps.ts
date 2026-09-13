import type { Heightmap } from '../../shared/heightmap.js';
import { createRng, nextInt, nextU32 } from '../math/rng.js';
import { cos, sin, TWO_PI } from '../math/trig.js';
import { buildPermutation, fbm, smoothstep } from './noise.js';

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

export const MapScript = {
  /** Tabular sandstone mesas with sheer sides and a handful of climbable passes. */
  ThabaBosiu: 'thaba-bosiu',
  /** Dissected rolling spurs cut by a braided river. */
  Umfolozi: 'umfolozi',
  /** Flat arid plain, ironstone koppies, and dongas sunk into it. */
  Karoo: 'karoo',
  /** Parallel ridge lines pierced by narrow poorts. */
  Magaliesberg: 'magaliesberg',
} as const;

export type MapScript = (typeof MapScript)[keyof typeof MapScript];

const LEVELS = 8;

function make(width: number, height: number): { data: Uint8Array; map: Heightmap } {
  const data = new Uint8Array(width * height);
  return { data, map: { width, height, levels: LEVELS, data } };
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
function thabaBosiu(width: number, height: number, seed: number): Heightmap {
  const { data, map } = make(width, height);
  const rng = createRng(seed);
  const perm = buildPermutation(seed ^ 0x51ee);

  // Rolling sourveld underneath.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = clampLevel(fbm(perm, x * 0.05, y * 0.05, 4, 2, 0.5) * 2.2);
    }
  }

  const mesaCount = 2 + nextInt(rng, 2);
  for (let m = 0; m < mesaCount; m++) {
    const centreX = width * 0.25 + nextInt(rng, Math.floor(width * 0.5));
    const centreY = height * 0.25 + nextInt(rng, Math.floor(height * 0.5));
    const radius = Math.floor(width * 0.09) + nextInt(rng, Math.floor(width * 0.06));
    const top = 5 + nextInt(rng, 2);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - centreX;
        const dy = y - centreY;
        // A noisy radius, so the rim is not a circle.
        const wobble = fbm(perm, x * 0.09, y * 0.09, 3, 2, 0.5) * 3 - 1.5;
        if (Math.sqrt(dx * dx + dy * dy) > radius + wobble) continue;
        data[y * width + x] = top;
      }
    }

    // Cut the passes. Without them the plateau is unreachable rather than defensible,
    // which is a different and much worse map.
    const passes = 1 + nextInt(rng, 2);
    for (let p = 0; p < passes; p++) {
      const angle = (nextU32(rng) / 4294967296) * TWO_PI;
      for (let step = 0; step <= radius + 6; step++) {
        const x = Math.round(centreX + cos(angle) * step);
        const y = Math.round(centreY + sin(angle) * step);
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) break;
        // A ramp descends one level per tile, which is exactly MAX_CLIMB.
        const rampHeight = clampLevel(top - Math.max(0, step - radius + top));
        for (let wy = -1; wy <= 1; wy++) {
          for (let wx = -1; wx <= 1; wx++) {
            const index = (y + wy) * width + (x + wx);
            if (data[index]! > rampHeight) data[index] = rampHeight;
          }
        }
      }
    }
  }
  return map;
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
      data[y * width + x] = y % driftEvery === 0 ? 1 : 0;
    }
  }
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

  const koppies = 5 + nextInt(rng, 5);
  for (let k = 0; k < koppies; k++) {
    const centreX = 3 + nextInt(rng, width - 6);
    const centreY = 3 + nextInt(rng, height - 6);
    const radius = 2 + nextInt(rng, 3);

    for (let y = centreY - radius; y <= centreY + radius; y++) {
      for (let x = centreX - radius; x <= centreX + radius; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const dx = x - centreX;
        const dy = y - centreY;
        if (dx * dx + dy * dy > radius * radius) continue;
        data[y * width + x] = 7;
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

  const ridges = 3 + nextInt(rng, 2);
  for (let r = 0; r < ridges; r++) {
    const baseY = Math.floor(((r + 0.5) / ridges) * height);
    const thickness = 3 + nextInt(rng, 3);
    const crest = 6 + nextInt(rng, 2);

    // Two or three poorts per ridge, at positions drawn from the seed.
    const poortCount = 2 + nextInt(rng, 2);
    const poorts: number[] = [];
    for (let p = 0; p < poortCount; p++) poorts.push(2 + nextInt(rng, width - 4));

    for (let x = 0; x < width; x++) {
      const inPoort = poorts.some((position) => Math.abs(x - position) <= 2);
      if (inPoort) continue;

      const waver = Math.round(sin(x * 0.06 + r) * 2.5);
      for (let t = -thickness; t <= thickness; t++) {
        const y = baseY + waver + t;
        if (y < 0 || y >= height) continue;
        // Taper to the crest so the ridge has flanks rather than being a wall.
        const level = clampLevel(crest - Math.abs(t) * 1.5);
        if (data[y * width + x]! < level) data[y * width + x] = level;
      }
    }
  }
  return map;
}

const GENERATORS: Readonly<Record<MapScript, (w: number, h: number, seed: number) => Heightmap>> = {
  [MapScript.ThabaBosiu]: thabaBosiu,
  [MapScript.Umfolozi]: umfolozi,
  [MapScript.Karoo]: karoo,
  [MapScript.Magaliesberg]: magaliesberg,
};

export function generateMap(
  script: MapScript,
  width: number,
  height: number,
  seed: number,
): Heightmap {
  return GENERATORS[script](width, height, seed);
}

export const MAP_SCRIPTS: readonly MapScript[] = Object.values(MapScript);
