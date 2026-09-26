import { heightAt, isShore, isWater, type Heightmap } from '../../shared/heightmap.js';

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
 * Stones are placed by what the ground is DOING rather than by its band alone. Rock
 * collects at the foot of a cliff, where the face sheds it; it breaks out along a rim;
 * it piles on the ironstone caps of a koppie; and it lines a shore the sea has
 * scoured. A boulder in the middle of a grass flat says nothing, so those are rare.
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
  /** Drawn size against the art's own. Stones vary; one size of boulder reads as stamped. */
  readonly scale?: number;
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

/** Boulder variants, as make_prop.py builds them. */
const BOULDER_LONE = 0;
const BOULDER_PILE = 1;
const BOULDER_SCATTER = 2;

/**
 * How likely a tile is to carry a stone, by what the ground there is doing.
 *
 * Talus is the thickest by far, because it is the one place rock is not optional: a
 * cliff sheds it, and a cliff with clean ground at its foot reads as a wall someone
 * built. The open-veld rate is a hint of stone underfoot, not a feature.
 */
const STONE = {
  talus: 0.3,
  rim: 0.1,
  cap: 0.05,
  high: 0.012,
  shore: 0.07,
  veld: 0.003,
} as const;

/** Tiles of height difference that make an edge a cliff rather than a slope. */
const CLIFF = 2;

const SIDES_X = [1, -1, 0, 0] as const;
const SIDES_Y = [0, 0, 1, -1] as const;

/**
 * What kind of stony ground a tile is, and the chance and shape of a stone on it.
 * Null where no stone belongs — in the water.
 */
function stoneAt(map: Heightmap, tileX: number, tileY: number): { chance: number; variants: readonly number[] } | null {
  if (isWater(map, tileX, tileY)) return null;
  const level = heightAt(map, tileX, tileY);

  let below = false;
  let above = false;
  for (let side = 0; side < 4; side++) {
    const other = heightAt(map, tileX + SIDES_X[side]!, tileY + SIDES_Y[side]!);
    if (other < 0) continue;
    if (other - level >= CLIFF) below = true;
    if (level - other >= CLIFF) above = true;
  }

  // At the foot of a face: everything it has shed, big and small.
  if (below) return { chance: STONE.talus, variants: [BOULDER_LONE, BOULDER_PILE, BOULDER_SCATTER, BOULDER_LONE] };
  if (above) return { chance: STONE.rim, variants: [BOULDER_LONE, BOULDER_SCATTER] };
  if (level >= map.levels - 1) return { chance: STONE.cap, variants: [BOULDER_PILE, BOULDER_LONE] };
  if (level >= map.levels - 2) return { chance: STONE.high, variants: [BOULDER_LONE, BOULDER_SCATTER] };
  if (isShore(map, tileX, tileY)) return { chance: STONE.shore, variants: [BOULDER_SCATTER, BOULDER_LONE] };
  return { chance: STONE.veld, variants: [BOULDER_LONE, BOULDER_SCATTER] };
}

function hash(x: number, y: number, seed: number): number {
  let value = (x * 0x1f1f1f1f) ^ (y * 0x85ebca6b) ^ Math.imul(seed, 0x9e3779b9);
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  return (value ^ (value >>> 13)) >>> 0;
}

export function planDecorations(map: Heightmap, seed: number): Decoration[] {
  const out: Decoration[] = [];

  for (let tileY = 0; tileY < map.height; tileY++) {
    for (let tileX = 0; tileX < map.width; tileX++) {
      // Stone first: a tile that has one carries nothing else, or the aloe and the
      // boulder stand in each other.
      const stone = stoneAt(map, tileX, tileY);
      if (stone !== null) {
        const roll = hash(tileX, tileY, seed ^ 0x57014e);
        if ((roll & 0xffff) / 0x10000 < stone.chance) {
          out.push({
            worldX: tileX + (((roll >>> 16) & 0xff) / 255) * 0.6 + 0.2,
            worldY: tileY + (((roll >>> 24) & 0xff) / 255) * 0.6 + 0.2,
            kind: 'boulder',
            variant: stone.variants[hash(tileX, tileY, seed ^ 0x2b0d) % stone.variants.length]!,
            scale: 0.75 + ((hash(tileX, tileY, seed ^ 0x9a1e) & 0xff) / 255) * 0.6,
          });
          continue;
        }
      }

      const level = map.data[tileY * map.width + tileX]!;
      const band = BANDS[Math.min(level, BANDS.length - 1)]!;
      if (band.kinds.length === 0) continue;
      // Nothing grows in the water. The bands used to guarantee that, when water was
      // only ever level 0; a lagoon or a mountain tarn can sit higher than that.
      if (isWater(map, tileX, tileY)) continue;

      const roll = hash(tileX, tileY, seed);
      if ((roll & 0xffff) / 0x10000 >= band.density) continue;

      // Jittered within the tile rather than planted on its centre, or a wood comes out
      // on a grid and reads as an orchard.
      const jitterX = (((roll >>> 16) & 0xff) / 255) * 0.8 + 0.1;
      const jitterY = (((roll >>> 24) & 0xff) / 255) * 0.8 + 0.1;
      const pick = hash(tileX, tileY, seed ^ 0x5bf0);

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
