import { describe, expect, it } from 'vitest';
import { heightmapFrom } from '../src/shared/heightmap.js';
import { decodeSnapshot } from '../src/shared/snapshot.js';
import { buildSnapshot } from '../src/sim/snapshot.js';
import { tuning } from '../src/sim/tuning.js';
import { Fog, createFog, fogAt, isVisible, updateFog } from '../src/sim/vision/fog.js';
import { createWorld, spawn } from '../src/sim/world.js';
import { flatMap } from './simHarness.js';

const V = tuning.vision;

describe('fog of war', () => {
  it('starts entirely unexplored', () => {
    const map = flatMap(32);
    const fog = createFog(2, map);
    expect(Array.from(fog.tiles).every((t) => t === Fog.Unexplored)).toBe(true);
  });

  it('reveals a radius around a unit and leaves the rest dark', () => {
    const map = flatMap(48);
    const world = createWorld(16, 1);
    const fog = createFog(2, map);
    spawn(world, 24.5, 24.5, 0);

    world.tick = V.intervalTicks;
    updateFog(world, map, fog);

    expect(isVisible(fog, 0, 24, 24)).toBe(true);
    expect(isVisible(fog, 0, 24, 20)).toBe(true);
    expect(fogAt(fog, 0, 2, 2)).toBe(Fog.Unexplored);
    // The other player has seen nothing.
    expect(isVisible(fog, 1, 24, 24)).toBe(false);
  });

  it('remembers ground once seen, without still seeing it', () => {
    const map = flatMap(48);
    const world = createWorld(16, 1);
    const fog = createFog(2, map);
    const scout = spawn(world, 24.5, 24.5, 0);

    world.tick = V.intervalTicks;
    updateFog(world, map, fog);
    expect(isVisible(fog, 0, 24, 24)).toBe(true);

    // March away.
    world.posX[scout & 0xffffff] = 2.5;
    world.posY[scout & 0xffffff] = 2.5;
    world.tick = V.intervalTicks * 2;
    updateFog(world, map, fog);

    expect(isVisible(fog, 0, 24, 24)).toBe(false);
    expect(fogAt(fog, 0, 24, 24)).toBe(Fog.Explored);
    // Explored never reverts to unexplored — that is the memory.
    expect(fogAt(fog, 0, 24, 24)).not.toBe(Fog.Unexplored);
  });

  it('only recomputes on the vision interval', () => {
    const map = flatMap(32);
    const world = createWorld(16, 1);
    const fog = createFog(2, map);
    spawn(world, 16.5, 16.5, 0);

    world.tick = V.intervalTicks + 1;
    updateFog(world, map, fog);
    expect(fog.version).toBe(0);

    world.tick = V.intervalTicks * 2;
    updateFog(world, map, fog);
    expect(fog.version).toBe(1);
  });

  // Without this, elevation would be decoration.
  it('is blocked by a ridge, and sees over it from higher ground', () => {
    const size = 24;
    const rows = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
    for (let x = 0; x < size; x++) rows[12]![x] = 6; // a ridge across the map
    const map = heightmapFrom(rows, 8);

    const low = createWorld(16, 1);
    const lowFog = createFog(1, map);
    spawn(low, 12.5, 8.5, 0);
    low.tick = V.intervalTicks;
    updateFog(low, map, lowFog);

    // Ground beyond the ridge is hidden from someone standing in front of it.
    expect(isVisible(lowFog, 0, 12, 15)).toBe(false);
    // The ridge itself is seen.
    expect(isVisible(lowFog, 0, 12, 12)).toBe(true);

    // Stand on the ridge and the far side opens up.
    const high = createWorld(16, 1);
    const highFog = createFog(1, map);
    spawn(high, 12.5, 12.5, 0);
    high.tick = V.intervalTicks;
    updateFog(high, map, highFog);
    expect(isVisible(highFog, 0, 12, 15)).toBe(true);
  });

  it('sees further from high ground', () => {
    const size = 40;
    const flat = flatMap(size);
    const raised = heightmapFrom(
      Array.from({ length: size }, () => Array.from({ length: size }, () => 7)),
      8,
    );

    const count = (map: typeof flat): number => {
      const world = createWorld(16, 1);
      const fog = createFog(1, map);
      spawn(world, 20.5, 20.5, 0);
      world.tick = V.intervalTicks;
      updateFog(world, map, fog);
      let seen = 0;
      for (const tile of fog.tiles) if (tile === Fog.Visible) seen++;
      return seen;
    };

    expect(count(raised)).toBeGreaterThan(count(flat));
  });
});

describe('snapshot filtering', () => {
  it('hides an enemy standing in the dark and reveals them when seen', () => {
    const map = flatMap(48);
    const world = createWorld(16, 1);
    const fog = createFog(2, map);

    spawn(world, 4.5, 4.5, 0); // ours
    spawn(world, 40.5, 40.5, 1); // theirs, far away

    world.tick = V.intervalTicks;
    updateFog(world, map, fog);

    const hidden = decodeSnapshot(buildSnapshot(world, 0, fog));
    expect(hidden.count).toBe(1);
    expect(hidden.faction[0]).toBe(0);

    // Walk an enemy into our vision.
    world.posX[1] = 5.5;
    world.posY[1] = 5.5;
    world.tick = V.intervalTicks * 2;
    updateFog(world, map, fog);

    const revealed = decodeSnapshot(buildSnapshot(world, 0, fog));
    expect(revealed.count).toBe(2);
  });

  it('always shows a viewer their own entities, wherever they are', () => {
    const map = flatMap(64);
    const world = createWorld(16, 1);
    const fog = createFog(2, map);

    spawn(world, 2.5, 2.5, 0);
    spawn(world, 60.5, 60.5, 0); // ours, nowhere near the first

    world.tick = V.intervalTicks;
    updateFog(world, map, fog);
    expect(decodeSnapshot(buildSnapshot(world, 0, fog)).count).toBe(2);
  });

  it('shows everything when no fog is supplied, as before', () => {
    const world = createWorld(16, 1);
    spawn(world, 1.5, 1.5, 0);
    spawn(world, 30.5, 30.5, 1);
    expect(decodeSnapshot(buildSnapshot(world, 0, null)).count).toBe(2);
  });
});
