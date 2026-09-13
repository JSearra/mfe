import {
  createSnapshotWriter,
  encodeFacing,
  encodeHpPct,
  type SnapshotWriter,
} from '../shared/snapshot.js';
import { isVisible, type FogState } from './vision/fog.js';
import { tuning } from './tuning.js';
import { packHandle, type World } from './world.js';

/**
 * Build the snapshot one viewer sees.
 *
 * `viewerId` was taken from the very first version with an identity filter, precisely so
 * that adding fog of war would be a change to this function's body rather than to the
 * boundary, the minimap, hit-testing and the AI's information model. The filter is real
 * now: a viewer sees their own entities always, and everyone else's only while the tile
 * they stand on is visible.
 *
 * Filtering is by player visibility, never by camera frustum: letting the renderer
 * tell the simulation what to send based on the viewport breaks the minimap and fog
 * memory, and makes the boundary camera-dependent. The camera culls on the far side.
 */
export function buildSnapshot(
  world: World,
  viewerId: number,
  fog: FogState | null = null,
): ArrayBuffer {
  const { capacity, alive } = world;

  const seen = (i: number): boolean => {
    if (alive[i] !== 1) return false;
    if (fog === null) return true;
    if (world.faction[i] === viewerId) return true;
    return isVisible(fog, viewerId, Math.floor(world.posX[i]!), Math.floor(world.posY[i]!));
  };

  let count = 0;
  for (let i = 0; i < capacity; i++) if (seen(i)) count++;

  const writer: SnapshotWriter = createSnapshotWriter(count, world.tick, viewerId);
  const maxHp = tuning.unit.maxHp;

  let slot = 0;
  for (let i = 0; i < capacity; i++) {
    if (!seen(i)) continue;

    writer.handle[slot] = packHandle(i, world.generation[i]!);
    writer.animStartTick[slot] = world.animStartTick[i]!;
    writer.x[slot] = world.posX[i]!;
    writer.y[slot] = world.posY[i]!;
    writer.facing[slot] = encodeFacing(world.facing[i]!);
    writer.animState[slot] = world.animState[i]!;
    writer.faction[slot] = world.faction[i]!;
    writer.flags[slot] = world.flags[i]!;
    writer.hpPct[slot] = encodeHpPct(world.hp[i]!, maxHp);
    writer.kind[slot] = world.kind[i]!;
    writer.stressPct[slot] = encodeHpPct(world.stress[i]!, tuning.cattle.stressMax);
    // Herd state rides in the flags byte; it is four values, not a field's worth.
    writer.flags[slot] = (world.flags[i]! & 0xf0) | (world.herdState[i]! & 0x0f);
    slot++;
  }

  return writer.buffer;
}
