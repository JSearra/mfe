import { describe, expect, it } from 'vitest';
import { MapScript } from '../src/shared/maps.js';
import { createHeightmap } from '../src/sim/terrain/generate.js';
import { generateMap } from '../src/sim/terrain/maps.js';
import { buildCostLayer, MovementClass } from '../src/sim/pathing/costs.js';
import { createAStarScratch, findPath, PathStatus } from '../src/sim/pathing/astar.js';

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
 * Maps whose terrain already walls the player in, measured with eight-way A*: on
 * umfolozi the braided river leaves only the doorstep herd reachable, and on
 * magaliesberg the start cannot reach ANY of them — not even the one eleven tiles away,
 * which is where the game's only herd sat before there were six. Neither is caused by
 * the herd layout; both predate it, and magaliesberg has never been winnable.
 *
 * Pinned as broken rather than skipped, so that fixing the map generator fails this test
 * and says so. See tasks/plan.md.
 */
const WALLED_IN: ReadonlySet<string> = new Set([MapScript.Umfolozi, MapScript.Magaliesberg]);

function unreachableHerds(map: ReturnType<typeof createHeightmap>): number {
  const layer = buildCostLayer(map, MovementClass.Infantry);
  const scratch = createAStarScratch(SIZE * SIZE);
  const start = CENTRE * SIZE + CENTRE;

  return HERD_SITES.filter(([x, y]) => {
    const goal = (CENTRE + y) * SIZE + (CENTRE + x);
    return findPath(layer, scratch, start, goal, 200_000).status !== PathStatus.Found;
  }).length;
}

describe('the herds a match starts with', () => {
  it('are all reachable on the default map', () => {
    expect(unreachableHerds(createHeightmap(SIZE, SIZE, SEED))).toBe(0);
  });

  it.each(Object.values(MapScript).filter((s) => !WALLED_IN.has(s)))(
    'are all reachable on %s',
    (script) => {
      expect(unreachableHerds(generateMap(script, SIZE, SIZE, SEED))).toBe(0);
    },
  );

  it.each([...WALLED_IN])('records %s as still walling the player in', (script) => {
    // Fails when the map is fixed, which is the point: remove it from WALLED_IN then.
    expect(unreachableHerds(generateMap(script as MapScript, SIZE, SIZE, SEED))).toBeGreaterThan(0);
  });
});
