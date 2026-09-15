import { heightAt, type Heightmap } from '../../shared/heightmap.js';
import { mixSeed } from '../math/rng.js';
import { tuning } from '../tuning.js';
import { EntityKind, type World } from '../world.js';
import { Resource, type Economy } from './ledger.js';

/**
 * Wild food, and the ground that grows it.
 *
 * The first loop of the village game that is not the farm (ADR-0019, roadmap Phase V2).
 * Foraging pays less per head than a plot and asks for nothing in advance: no land
 * committed a season early, no work to establish, no building. It is what a village
 * lives on while the grain is in the ground and what it falls back on when the grain
 * fails — which makes *where the village sits* a decision rather than a spawn point.
 *
 * **A patch is ground, not a plant.** The trees and scrub the renderer draws are
 * deliberately not entities and must stay that way: `render/scene/decoration.ts` records
 * why, and the reasoning is that putting sixteen thousand bushes into the pathing
 * layers, the replay hash and every save is a large risk to carry for scenery. So a
 * patch is a tile of veld rich enough to gather from, and the vegetation standing on it
 * is the visual cue rather than the thing itself. The two agree because both are placed
 * from the same height bands and the same seed, not because either reads the other.
 *
 * Gathering works the way construction works: whoever is standing near it does it. There
 * is no Forage command and there does not need to be one — the player's decision is
 * where to put people, which is the decision a village game is made of. Sending a
 * villager is an ordinary move order.
 */

export interface ForagePatch {
  readonly tileX: number;
  readonly tileY: number;
  /** 0..1. Thicker veld yields faster and holds more. */
  readonly richness: number;
}

export interface ForageState {
  readonly patches: readonly ForagePatch[];
  /** Food remaining in each patch. Parallel to `patches`. */
  readonly stock: Float64Array;
  /** Bumped when any stock changes, so a host can skip re-sending an unchanged veld. */
  version: number;
}

/** Full stock for a patch of this richness. */
function capacity(richness: number): number {
  return tuning.forage.patchStock * (0.4 + 0.6 * richness);
}

/**
 * Scatter patches over the ground that would carry them.
 *
 * Placed on the middle bands — the low ground is wet and the tops are stone — and
 * ranked by a hash of the tile rather than drawn from the simulation RNG, because this
 * runs during setup and must not consume state the simulation will later depend on.
 * That is the same rule `createStartingPlots` follows and for the same reason.
 *
 * Deterministic in tile order with an explicit rank tie-break, so two machines building
 * the same map lay the veld out identically.
 */
export function createForagePatches(map: Heightmap, seed: number): ForagePatch[] {
  const f = tuning.forage;
  const candidates: { tileX: number; tileY: number; richness: number; rank: number }[] = [];

  for (let tileY = 0; tileY < map.height; tileY++) {
    for (let tileX = 0; tileX < map.width; tileX++) {
      const level = heightAt(map, tileX, tileY);
      if (level < f.minBand || level > f.maxBand) continue;

      // Richest in the middle of the range, thinning toward the wet and the stone.
      const span = f.maxBand - f.minBand;
      const middle = f.minBand + span / 2;
      const distance = span === 0 ? 0 : Math.abs(level - middle) / (span / 2 + 1e-9);
      const richness = distance > 1 ? 0 : 1 - distance * 0.7;

      candidates.push({
        tileX,
        tileY,
        richness,
        rank: mixSeed(seed ^ 0xf04a6e, tileY * map.width + tileX),
      });
    }
  }

  // Richest first, then by rank, then by tile index: a total order, so the same map
  // always yields the same veld.
  candidates.sort((a, b) => {
    if (a.richness !== b.richness) return b.richness - a.richness;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.tileY * map.width + a.tileX - (b.tileY * map.width + b.tileX);
  });

  // Spread them out. A cluster of patches on one hillside is one patch with extra
  // bookkeeping, and it makes half the map worth nothing to stand on.
  const chosen: ForagePatch[] = [];
  const spacing = tuning.forage.gatherRadius * 2.5;
  for (const candidate of candidates) {
    if (chosen.length >= f.patchCount) break;
    let clear = true;
    for (const taken of chosen) {
      const dx = taken.tileX - candidate.tileX;
      const dy = taken.tileY - candidate.tileY;
      if (dx * dx + dy * dy < spacing * spacing) {
        clear = false;
        break;
      }
    }
    if (clear) {
      chosen.push({ tileX: candidate.tileX, tileY: candidate.tileY, richness: candidate.richness });
    }
  }
  return chosen;
}

export function createForage(map: Heightmap, seed: number): ForageState {
  const patches = createForagePatches(map, seed);
  const stock = new Float64Array(patches.length);
  for (let i = 0; i < patches.length; i++) stock[i] = capacity(patches[i]!.richness);
  return { patches, stock, version: 0 };
}

/**
 * Gather, then regrow. Runs on the upkeep cycle, so it keeps step with the ledger it
 * pays into and with the drought that governs both.
 *
 * `wetness` is 1 in a good season and falls toward 0 in a drought — the same curve the
 * harvest uses, passed in rather than recomputed so the veld and the fields cannot
 * disagree about the weather.
 */
export function updateForage(
  world: World,
  state: ForageState,
  economy: Economy,
  wetness: number,
): void {
  const f = tuning.forage;
  const reachSq = f.gatherRadius * f.gatherRadius;
  let moved = false;

  for (let index = 0; index < state.patches.length; index++) {
    const patch = state.patches[index]!;
    const centreX = patch.tileX + 0.5;
    const centreY = patch.tileY + 0.5;

    // Who is standing in it. Counted per player, because two villages can work the same
    // ground and the food should go to whoever sent the people.
    const gatherers = new Float64Array(economy.players);
    for (let i = 0; i < world.capacity; i++) {
      if (world.alive[i] !== 1 || world.kind[i] !== EntityKind.Unit) continue;
      const owner = world.faction[i]!;
      if (owner >= economy.players) continue;
      const dx = world.posX[i]! - centreX;
      const dy = world.posY[i]! - centreY;
      if (dx * dx + dy * dy > reachSq) continue;
      gatherers[owner]!++;
    }

    for (let player = 0; player < economy.players; player++) {
      const hands = gatherers[player]!;
      if (hands === 0) continue;

      // Diminishing: a patch of veld does not yield twice as fast because twice as many
      // people are picking it over. Past the cap the extra hands are standing about,
      // which is what makes foraging a poor use of a large village and farming a good
      // one — the roadmap's "worth less per head than farming".
      const working = hands > f.maxGatherers ? f.maxGatherers : hands;
      const wanted = working * f.perGathererPerUpkeep * (0.5 + 0.5 * patch.richness);
      const taken = Math.min(wanted, state.stock[index]!);
      if (taken <= 0) continue;

      state.stock[index] = state.stock[index]! - taken;
      economy.add(player, Resource.Grain, taken);
      moved = true;
    }

    // Regrowth. Slower in a dry year, and it is what makes a patch worth coming back to
    // rather than stripping: the veld recovers on its own schedule whether anyone waits
    // for it or not.
    const full = capacity(patch.richness);
    if (state.stock[index]! < full) {
      const grown = f.regrowthPerUpkeep * (0.25 + 0.75 * wetness) * (0.5 + 0.5 * patch.richness);
      state.stock[index] = Math.min(full, state.stock[index]! + grown);
      moved = true;
    }
  }

  if (moved) state.version++;
}
