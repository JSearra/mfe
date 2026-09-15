import type { Heightmap } from '../../shared/heightmap.js';

/**
 * Where the undergrowth stands. **Trees are no longer here** — see src/sim/woodland.ts.
 *
 * This file used to place the acacias too, and argued that vegetation should stay
 * render-side because making it solid "would put them in the simulation, in the pathing
 * cost layers, in the replay hash and in every save, for scenery". That argument was
 * right about scenery and stopped applying the moment trees became a resource you grow,
 * pick and fell (ADR-0019): a food supply the simulation cannot see is not a food
 * supply. Trees moved into the simulation and are handed to the renderer with the
 * snapshot.
 *
 * The expensive half of the old decision survived the move. Trees still do not block
 * movement and are still not entities — walking through a thorn bush remains a smaller
 * lie than sixteen thousand obstacles in the pathing grid is a risk.
 *
 * What is left here is scrub, aloes and stones: things that are only ever looked at.
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
  { density: 0.04, kinds: ['scrub'] }, // 2 low ground
  { density: 0.08, kinds: ['scrub'] }, // 3 thornveld — the thickest
  { density: 0.035, kinds: ['scrub'] }, // 4 grassland
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
