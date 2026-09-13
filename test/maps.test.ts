import { describe, expect, it } from 'vitest';
import { heightAt, type Heightmap } from '../src/shared/heightmap.js';
import { EDGE_DX, EDGE_DY, derivePassability } from '../src/shared/passability.js';
import { MAP_SCRIPTS, MapScript, generateMap } from '../src/sim/terrain/maps.js';

const SIZE = 96;

function reachableFrom(map: Heightmap, startX: number, startY: number): Uint8Array {
  const flags = derivePassability(map);
  const seen = new Uint8Array(map.width * map.height);
  const stack = [startY * map.width + startX];
  seen[stack[0]!] = 1;

  while (stack.length > 0) {
    const index = stack.pop()!;
    const x = index % map.width;
    const y = (index / map.width) | 0;
    for (let dir = 0; dir < 4; dir++) {
      if ((flags[index]! & (1 << dir)) === 0) continue;
      const next = (y + EDGE_DY[dir]!) * map.width + (x + EDGE_DX[dir]!);
      if (seen[next] === 1) continue;
      seen[next] = 1;
      stack.push(next);
    }
  }
  return seen;
}

function histogram(map: Heightmap): number[] {
  const counts = new Array<number>(map.levels).fill(0);
  for (const level of map.data) counts[level]!++;
  return counts;
}

describe('every map script', () => {
  it.each(MAP_SCRIPTS)('%s is deterministic and in range', (script) => {
    const a = generateMap(script, SIZE, SIZE, 0x1234);
    const b = generateMap(script, SIZE, SIZE, 0x1234);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));

    for (const level of a.data) {
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThan(a.levels);
    }
  });

  it.each(MAP_SCRIPTS)('%s differs between seeds', (script) => {
    const a = generateMap(script, SIZE, SIZE, 1);
    const b = generateMap(script, SIZE, SIZE, 2);
    expect(Array.from(b.data)).not.toEqual(Array.from(a.data));
  });

  it.each(MAP_SCRIPTS)('%s leaves a usable amount of ground connected', (script) => {
    // A beautiful map nobody can cross is a bug, and it is invisible until units try.
    const map = generateMap(script, SIZE, SIZE, 7);
    let best = 0;
    for (const [x, y] of [[2, 2], [SIZE - 3, 2], [2, SIZE - 3], [SIZE - 3, SIZE - 3], [SIZE >> 1, SIZE >> 1]] as const) {
      const seen = reachableFrom(map, x, y);
      let count = 0;
      for (const tile of seen) count += tile;
      best = Math.max(best, count);
    }
    expect(best / (SIZE * SIZE)).toBeGreaterThan(0.35);
  });
});

describe('Thaba Bosiu', () => {
  const map = generateMap(MapScript.ThabaBosiu, SIZE, SIZE, 42);

  it('raises tabular plateaus well above the veld', () => {
    const counts = histogram(map);
    const high = counts.slice(5).reduce((a, b) => a + b, 0);
    expect(high).toBeGreaterThan(120); // real plateaus, not stray peaks
    expect(high / (SIZE * SIZE)).toBeLessThan(0.5); // and not the whole map
  });

  it('rings them with cliffs rather than slopes', () => {
    // Count edges where the step exceeds what anything can climb.
    let sheer = 0;
    for (let y = 1; y < SIZE - 1; y++) {
      for (let x = 1; x < SIZE - 1; x++) {
        if (Math.abs(heightAt(map, x, y) - heightAt(map, x + 1, y)) > 1) sheer++;
      }
    }
    expect(sheer).toBeGreaterThan(80);
  });

  it('cuts passes, so a plateau is defensible rather than merely unreachable', () => {
    // The summit must be walkable from the lowland — that is the whole point of the
    // place. Without the ramps this map would generate scenery, not ground.
    const seen = reachableFrom(map, 1, 1);
    let summitsReached = 0;
    for (let i = 0; i < map.data.length; i++) {
      if (map.data[i]! >= 5 && seen[i] === 1) summitsReached++;
    }
    expect(summitsReached).toBeGreaterThan(20);
  });
});

describe('Umfolozi', () => {
  const map = generateMap(MapScript.Umfolozi, SIZE, SIZE, 11);

  it('carves a channel that spans the map', () => {
    let rowsWithChannel = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (map.data[y * SIZE + x] === 0) {
          rowsWithChannel++;
          break;
        }
      }
    }
    expect(rowsWithChannel).toBeGreaterThan(SIZE * 0.8);
  });

  it('leaves drifts where the bed rises enough to wade', () => {
    // A river with no crossings splits the map in two and the game with it.
    let drifts = 0;
    for (let y = 0; y < SIZE; y++) {
      let hasBed = false;
      let hasDrift = false;
      for (let x = 0; x < SIZE; x++) {
        const level = map.data[y * SIZE + x]!;
        if (level === 0) hasBed = true;
        if (level === 1) hasDrift = true;
      }
      if (hasDrift && !hasBed) drifts++;
    }
    expect(drifts).toBeGreaterThan(2);
  });

  it('builds ridges either side rather than a flat floodplain', () => {
    const counts = histogram(map);
    expect(counts.filter((c) => c > SIZE).length).toBeGreaterThan(3);
  });
});

describe('The Great Karoo', () => {
  const map = generateMap(MapScript.Karoo, SIZE, SIZE, 5);

  it('is overwhelmingly flat, which is what makes cover scarce', () => {
    const counts = histogram(map);
    const dominant = Math.max(...counts);
    expect(dominant / (SIZE * SIZE)).toBeGreaterThan(0.6);
  });

  it('raises koppies that cannot be walked over', () => {
    let koppieTiles = 0;
    for (const level of map.data) if (level >= 7) koppieTiles++;
    expect(koppieTiles).toBeGreaterThan(30);

    // And they are genuinely impassable from the plain.
    const seen = reachableFrom(map, 1, 1);
    let reachableKoppie = 0;
    for (let i = 0; i < map.data.length; i++) {
      if (map.data[i]! >= 7 && seen[i] === 1) reachableKoppie++;
    }
    expect(reachableKoppie).toBe(0);
  });

  it('sinks dongas that break sight without blocking movement along them', () => {
    let donga = 0;
    for (const level of map.data) if (level <= 1) donga++;
    expect(donga).toBeGreaterThan(40);
  });
});

describe('The Magaliesberg', () => {
  const map = generateMap(MapScript.Magaliesberg, SIZE, SIZE, 3);

  it('lays down parallel ridge lines', () => {
    // Ridges run east-west, so high ground should concentrate in a few rows rather
    // than scatter evenly.
    const perRow: number[] = [];
    for (let y = 0; y < SIZE; y++) {
      let high = 0;
      for (let x = 0; x < SIZE; x++) if (map.data[y * SIZE + x]! >= 5) high++;
      perRow.push(high);
    }
    const ridgeRows = perRow.filter((count) => count > SIZE * 0.4).length;
    expect(ridgeRows).toBeGreaterThan(4);
    expect(ridgeRows).toBeLessThan(SIZE * 0.6);
  });

  it('pierces them with poorts, so the map funnels rather than divides', () => {
    // North and south must connect — through the gaps, because the ridges themselves
    // exceed what anything can climb.
    const seen = reachableFrom(map, 2, 2);
    let southReached = 0;
    for (let x = 0; x < SIZE; x++) if (seen[(SIZE - 2) * SIZE + x] === 1) southReached++;
    expect(southReached).toBeGreaterThan(0);
  });
});
