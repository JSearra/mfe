import type { Heightmap } from '../../shared/heightmap.js';

/**
 * Where the vegetation stands.
 *
 * Render-side and nothing else. Trees do not block movement, do not appear in snapshots
 * and are not entities — which is a deliberate trade rather than an oversight. Making
 * them solid would put them in the simulation, in the pathing cost layers, in the
 * replay hash and in every save, for scenery. Walking through a thorn bush is a smaller
 * lie than that is a risk.
 *
 * Placement is derived from the map seed, so it is identical on every machine that
 * builds the same map and costs nothing to store or transmit. It is also stable frame to
 * frame, which matters more than it sounds: the depth sort keys off position, and
 * scenery that moved would churn the draw order of everything near it.
 */

export interface Decoration {
  readonly worldX: number;
  readonly worldY: number;
  readonly kind: string;
  readonly variant: number;
}

/**
 * What grows at each height band, and how thickly.
 *
 * The bands are the same ones the terrain textures use, so vegetation agrees with the
 * ground it stands on: scrub through the thornveld, umbrella thorns across the
 * grassland, aloes on the thin stony ground up top, and nothing in the wet.
 */
const BANDS: readonly { readonly density: number; readonly kinds: readonly string[] }[] = [
  { density: 0.0, kinds: [] }, // 0 riverbed — standing water
  { density: 0.012, kinds: ['scrub'] }, // 1 donga floor — scoured
  { density: 0.05, kinds: ['scrub', 'acacia'] }, // 2 low ground
  { density: 0.11, kinds: ['scrub', 'scrub', 'acacia'] }, // 3 thornveld — the thickest
  { density: 0.045, kinds: ['acacia', 'scrub'] }, // 4 grassland
  { density: 0.03, kinds: ['aloe', 'scrub'] }, // 5 high sourveld
  { density: 0.022, kinds: ['aloe'] }, // 6 sandstone
  { density: 0.01, kinds: ['aloe'] }, // 7 ironstone caps
];

const VARIANTS = 3;

function hash(x: number, y: number, seed: number): number {
  let value = (x * 0x1f1f1f1f) ^ (y * 0x85ebca6b) ^ Math.imul(seed, 0x9e3779b9);
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  return (value ^ (value >>> 13)) >>> 0;
}

export function planDecorations(map: Heightmap, seed: number): Decoration[] {
  const out: Decoration[] = [];

  for (let tileY = 0; tileY < map.height; tileY++) {
    for (let tileX = 0; tileX < map.width; tileX++) {
      const level = map.data[tileY * map.width + tileX]!;
      const band = BANDS[Math.min(level, BANDS.length - 1)]!;
      if (band.kinds.length === 0) continue;

      const roll = hash(tileX, tileY, seed);
      if ((roll & 0xffff) / 0x10000 >= band.density) continue;

      // Jittered within the tile rather than planted on its centre, or a wood comes out
      // on a grid and reads as an orchard.
      const jitterX = (((roll >>> 16) & 0xff) / 255) * 0.8 + 0.1;
      const jitterY = (((roll >>> 24) & 0xff) / 255) * 0.8 + 0.1;
      const pick = hash(tileX, tileY, seed ^ 0x5bf0)

      out.push({
        worldX: tileX + jitterX,
        worldY: tileY + jitterY,
        kind: band.kinds[pick % band.kinds.length]!,
        variant: (pick >>> 8) % VARIANTS,
      });
    }
  }

  return out;
}
