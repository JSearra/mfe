import {
  createSnapshotWriter,
  encodeFacing,
  encodeHpPct,
  type SnapshotWriter,
} from '../shared/snapshot.js';
import { tuning } from './tuning.js';
import { packHandle, type World } from './world.js';

/**
 * Build the snapshot one viewer sees.
 *
 * `viewerId` is taken from the very first version, with an identity filter, because
 * fog of war changes this signature — from "every entity" to "entities visible to
 * player P, plus remembered ghosts of buildings in explored tiles" — and that change
 * propagates into the minimap, hit-testing and the AI's information model. The
 * argument costs nothing today and saves a boundary rewrite later.
 *
 * Filtering is by player visibility, never by camera frustum: letting the renderer
 * tell the simulation what to send based on the viewport breaks the minimap and fog
 * memory, and makes the boundary camera-dependent. The camera culls on the far side.
 */
export function buildSnapshot(world: World, viewerId: number): ArrayBuffer {
  const { capacity, alive } = world;

  let count = 0;
  for (let i = 0; i < capacity; i++) if (alive[i] === 1) count++;

  const writer: SnapshotWriter = createSnapshotWriter(count, world.tick, viewerId);
  const maxHp = tuning.unit.maxHp;

  let slot = 0;
  for (let i = 0; i < capacity; i++) {
    if (alive[i] !== 1) continue;

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
