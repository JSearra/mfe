import { describe, expect, it } from 'vitest';
import { MapScript } from '../src/shared/maps.js';
import { createHeightmap } from '../src/sim/terrain/generate.js';
import { generateMap } from '../src/sim/terrain/maps.js';
import { buildCostLayer, MovementClass } from '../src/sim/pathing/costs.js';
import { createAStarScratch, findPath, PathStatus } from '../src/sim/pathing/astar.js';
import { largestRegion, snapToRegion } from '../src/sim/terrain/placement.js';

/**
 * The cattle a match starts with have to be cattle a player can actually get to.
 *
 * `main.ts` scatters six herds at these offsets from the centre of the map, and the
 * player's force starts at the centre. A herd behind terrain nothing can climb is not a
 * raid, it is scenery — and since the win condition is cattle, a map where the herds are
 * walled off is a map that cannot be won.
 *
 * Kept in step with main.ts by hand, which is a seam; it is here rather than there
 * because main.ts builds a renderer and cannot be imported under Node.
 */
const HERD_SITES: readonly (readonly [number, number])[] = [
  [9, 6],
  [27, 22],
  [2, -12],
  [34, 40],
  [-10, 26],
  [46, 2],
];

const SIZE = 128;
const SEED = 0x4d666563;
const CENTRE = 64;

/**
 * Herds the player's force cannot walk to, placed the way a match places them.
 *
 * Both the start and the herds are snapped onto the largest walkable region first,
 * because that is what main.ts does — the raw offsets are wishes, not positions.
 */
function unreachableHerds(map: ReturnType<typeof createHeightmap>): number {
  const layer = buildCostLayer(map, MovementClass.Infantry);
  const scratch = createAStarScratch(SIZE * SIZE);
  const region = largestRegion(map);

  const home = snapToRegion(map, region, CENTRE - 2, CENTRE);
  const start = Math.floor(home.y) * SIZE + Math.floor(home.x);

  return HERD_SITES.filter(([x, y]) => {
    const at = snapToRegion(map, region, CENTRE + x, CENTRE + y);
    const goal = Math.floor(at.y) * SIZE + Math.floor(at.x);
    return findPath(layer, scratch, start, goal, 200_000).status !== PathStatus.Found;
  }).length;
}

describe('the herds a match starts with', () => {
  it('are all reachable on the default map', () => {
    expect(unreachableHerds(createHeightmap(SIZE, SIZE, SEED))).toBe(0);
  });

  // Every named script, with no exclusions. Umfolozi and the Magaliesberg used to be
  // here as known-broken: 1 of 6 and 0 of 6 reachable respectively, the latter unable to
  // walk eleven tiles to its own doorstep herd.
  it.each(Object.values(MapScript))('are all reachable on %s', (script) => {
    expect(unreachableHerds(generateMap(script, SIZE, SIZE, SEED))).toBe(0);
  });

  it.each(Object.values(MapScript))('and so is the enemy, on %s', (script) => {
    // A herd nobody can contest is scenery. The enemy has to be able to reach them too,
    // which on a river map means being on the same bank.
    const map = generateMap(script, SIZE, SIZE, SEED);
    const layer = buildCostLayer(map, MovementClass.Infantry);
    const scratch = createAStarScratch(SIZE * SIZE);
    const region = largestRegion(map);

    const enemy = snapToRegion(map, region, CENTRE + 34, CENTRE + 26);
    const from = Math.floor(enemy.y) * SIZE + Math.floor(enemy.x);

    for (const [x, y] of HERD_SITES) {
      const at = snapToRegion(map, region, CENTRE + x, CENTRE + y);
      const goal = Math.floor(at.y) * SIZE + Math.floor(at.x);
      expect(findPath(layer, scratch, from, goal, 200_000).status).toBe(PathStatus.Found);
    }
  });
});
