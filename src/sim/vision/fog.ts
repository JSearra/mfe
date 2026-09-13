import type { Heightmap } from '../../shared/heightmap.js';
import { tuning } from '../tuning.js';
import { EntityKind, type World } from '../world.js';

/**
 * Fog of war.
 *
 * Ranked the highest-retrofit-cost omission in the original brief, and the reason
 * `buildSnapshot` has taken a `viewerId` since Phase 3 with an identity filter. That
 * argument is what makes this a change of one function's body rather than a rewrite of
 * the boundary, the minimap, hit-testing and the AI's information model.
 *
 * Three states per tile, which is the minimum that supports "I remember a kraal being
 * here": unexplored, explored (remembered, not currently seen), and visible.
 */

export const Fog = {
  Unexplored: 0,
  Explored: 1,
  Visible: 2,
} as const;

export type Fog = (typeof Fog)[keyof typeof Fog];

export interface FogState {
  readonly players: number;
  readonly width: number;
  readonly height: number;
  /** players x tiles, row-major per player. */
  readonly tiles: Uint8Array;
  /** Bumped whenever visibility changes, so the renderer can skip unchanged frames. */
  version: number;
}

export function createFog(players: number, map: Heightmap): FogState {
  return {
    players,
    width: map.width,
    height: map.height,
    tiles: new Uint8Array(players * map.width * map.height),
    version: 0,
  };
}

export function fogAt(fog: FogState, player: number, tileX: number, tileY: number): Fog {
  if (tileX < 0 || tileY < 0 || tileX >= fog.width || tileY >= fog.height) return Fog.Unexplored;
  return fog.tiles[player * fog.width * fog.height + tileY * fog.width + tileX] as Fog;
}

export function isVisible(fog: FogState, player: number, tileX: number, tileY: number): boolean {
  return fogAt(fog, player, tileX, tileY) === Fog.Visible;
}

/**
 * Line of sight from one tile to another, over terrain.
 *
 * A ray is traced from the observer's eye to the target and blocked by any ground that
 * rises above the line between them. This is what makes high ground worth taking and a
 * donga worth hiding in — without it, elevation would be decoration.
 */
function hasLineOfSight(
  map: Heightmap,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  eyeHeight: number,
): boolean {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps <= 1) return true;

  const startHeight = map.data[fromY * map.width + fromX]! + eyeHeight;
  const endHeight = map.data[toY * map.width + toX]!;

  for (let step = 1; step < steps; step++) {
    const t = step / steps;
    // Rounding rather than flooring keeps the ray on the tiles it visually crosses.
    const x = Math.round(fromX + dx * t);
    const y = Math.round(fromY + dy * t);
    const groundHeight = map.data[y * map.width + x]!;
    const rayHeight = startHeight + (endHeight - startHeight) * t;
    // Strictly above: terrain level with the ray is grazed, not blocked.
    if (groundHeight > rayHeight + 0.5) return false;
  }
  return true;
}

/**
 * Recompute visibility.
 *
 * Runs every `intervalTicks` rather than every tick. Vision does not need 20Hz precision
 * — a fifth of a second of latency on a revealed tile is imperceptible — and the cost is
 * O(units x radius^2 x ray length), which is the sort of thing that quietly eats a tick
 * budget if left unbounded.
 */
export function updateFog(world: World, map: Heightmap, fog: FogState): void {
  const v = tuning.vision;
  if (world.tick % v.intervalTicks !== 0) return;

  const tiles = fog.width * fog.height;

  // Everything currently visible drops to remembered; what is still seen is restored
  // below. Explored never reverts to unexplored — that is the memory.
  for (let i = 0; i < fog.tiles.length; i++) {
    if (fog.tiles[i] === Fog.Visible) fog.tiles[i] = Fog.Explored;
  }

  for (let index = 0; index < world.capacity; index++) {
    if (world.alive[index] !== 1) continue;
    const player = world.faction[index]!;
    if (player >= fog.players) continue;

    const isCattle = world.kind[index] === EntityKind.Cattle;
    const radius = isCattle ? v.cattleRadius : v.unitRadius;
    const originX = Math.floor(world.posX[index]!);
    const originY = Math.floor(world.posY[index]!);
    if (originX < 0 || originY < 0 || originX >= fog.width || originY >= fog.height) continue;

    // High ground sees further, which is most of why a plateau is worth holding.
    const elevationBonus = map.data[originY * map.width + originX]! * 0.35;
    const reach = radius + elevationBonus;
    const reachSq = reach * reach;
    const span = Math.ceil(reach);
    const base = player * tiles;

    for (let dy = -span; dy <= span; dy++) {
      const y = originY + dy;
      if (y < 0 || y >= fog.height) continue;

      for (let dx = -span; dx <= span; dx++) {
        const x = originX + dx;
        if (x < 0 || x >= fog.width) continue;
        if (dx * dx + dy * dy > reachSq) continue;

        const at = base + y * fog.width + x;
        if (fog.tiles[at] === Fog.Visible) continue;
        if (!hasLineOfSight(map, originX, originY, x, y, v.eyeHeight)) continue;
        fog.tiles[at] = Fog.Visible;
      }
    }
  }

  fog.version++;
}
