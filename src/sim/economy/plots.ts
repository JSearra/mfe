import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import { mixSeed } from '../math/rng.js';
import { tuning } from '../tuning.js';
import { createFarmland, type Farmland } from './farmland.js';

/**
 * Arable land, laid out around each player's start.
 *
 * Nothing created plots until this existed, which had two consequences that only showed
 * up in a long AI-vs-AI match. Grain income was zero, so upkeep drained every player to
 * nothing by tick 1000 and troops starved; and the drought mechanic was inert, because
 * withering the open savanna withers nothing when no savanna is under cultivation.
 *
 * Plots sit on the lowest ground near a start, which is where they belong — and the
 * lowest few are marked sheltered, standing for a river bottom or a kloof that keeps
 * producing when the open veld does not. That is the drought's counterplay, and the
 * reason a bad year is a crisis rather than a loss.
 */
/**
 * Returns established fields at full condition, because a village has been farming this
 * ground for years before the first tick. Everything after this is broken by hand —
 * sited by command, worked until it takes, and kept or lost (Phase V3).
 */
export function createStartingFarmland(
  map: Heightmap,
  starts: readonly { readonly x: number; readonly y: number }[],
  seed: number,
): Farmland {
  const { plotsPerPlayer, shelteredPerPlayer, plotSearchRadius } = tuning.economy;
  const land = createFarmland();
  const established = tuning.farmland.establishWork;

  for (let owner = 0; owner < starts.length; owner++) {
    const start = starts[owner]!;
    const candidates: { tileX: number; tileY: number; height: number; rank: number }[] = [];

    for (let dy = -plotSearchRadius; dy <= plotSearchRadius; dy++) {
      for (let dx = -plotSearchRadius; dx <= plotSearchRadius; dx++) {
        const tileX = Math.floor(start.x) + dx;
        const tileY = Math.floor(start.y) + dy;
        const height = heightAt(map, tileX, tileY);
        if (height < 0) continue;
        // Keep a little clear ground around the start for the force to stand on.
        if (dx * dx + dy * dy < 9) continue;

        candidates.push({
          tileX,
          tileY,
          height,
          // Hashed rather than drawn from the RNG: this runs during setup and must not
          // consume state the simulation will later depend on.
          rank: mixSeed(seed ^ owner, tileY * map.width + tileX),
        });
      }
    }

    // Lowest ground first, ties broken by the hash so the choice is deterministic but
    // not a visible grid.
    candidates.sort((a, b) => (a.height !== b.height ? a.height - b.height : a.rank - b.rank));

    for (let i = 0; i < Math.min(plotsPerPlayer, candidates.length); i++) {
      const candidate = candidates[i]!;
      const slot = land.count++;
      land.tileX[slot] = candidate.tileX;
      land.tileY[slot] = candidate.tileY;
      land.owner[slot] = owner;
      land.sheltered[slot] = i < shelteredPerPlayer ? 1 : 0;
      land.work[slot] = established;
      land.condition[slot] = 1;
      land.alive[slot] = 1;
    }
  }

  return land;
}
