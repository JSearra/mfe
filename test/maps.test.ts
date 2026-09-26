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

describe('Coast', () => {
  const map = generateMap(MapScript.Coast, SIZE, SIZE, 777);
  const wet = (x: number, y: number): boolean => map.water[y * SIZE + x] === 1;

  it('lies along the east edge, where its cliffs face the camera', () => {
    let east = 0;
    let west = 0;
    for (let y = 0; y < SIZE; y++) {
      if (wet(SIZE - 1, y)) east++;
      if (wet(0, y)) west++;
    }
    expect(east / SIZE).toBeGreaterThan(0.8);
    // The river rises at the inland edge, so the west has a channel's width of water
    // and no more.
    expect(west).toBeLessThan(SIZE * 0.1);
  });

  it('has a coastline of bays and headlands rather than a ruled edge', () => {
    // Where the land ends, row by row. A wall of water down one side varies by a tile
    // or two; a coast varies by a good fraction of the map.
    const shore: number[] = [];
    for (let y = 0; y < SIZE; y++) {
      let x = SIZE - 1;
      while (x > 0 && wet(x, y)) x--;
      shore.push(x);
    }
    expect(Math.max(...shore) - Math.min(...shore)).toBeGreaterThan(SIZE * 0.12);
  });

  it('brings a river down to the sea', () => {
    // Water in nearly every column from the inland edge to the shore. Not every one:
    // drifts are dry columns, left so the two banks stay joined.
    let shoreline = SIZE;
    for (let y = 0; y < SIZE; y++) {
      let x = SIZE - 1;
      while (x > 0 && wet(x, y)) x--;
      shoreline = Math.min(shoreline, x);
    }
    let columns = 0;
    for (let x = 0; x < shoreline; x++) {
      for (let y = 0; y < SIZE; y++) {
        if (wet(x, y)) {
          columns++;
          break;
        }
      }
    }
    expect(columns / shoreline).toBeGreaterThan(0.7);
  });
});

describe('uKhahlamba', () => {
  const map = generateMap(MapScript.UKhahlamba, SIZE, SIZE, 21);

  it('stands the High Berg along the western edge, at the back of the view', () => {
    // Most of the western tenth is the wall — not all, because the rivers cut valleys
    // down through it — and none of the eastern tenth is.
    const band = Math.ceil(SIZE * 0.1);
    let west = 0;
    let east = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < band; x++) {
        if (heightAt(map, x, y) === 7) west++;
        if (heightAt(map, SIZE - 1 - x, y) === 7) east++;
      }
    }
    expect(west / (SIZE * band)).toBeGreaterThan(0.6);
    expect(east).toBe(0);
  });

  it('keeps the start in foothills a field will take', () => {
    // The village always starts at the centre; farmland takes levels 0 to 4.
    let arable = 0;
    let tiles = 0;
    const c = SIZE >> 1;
    for (let y = c - 5; y <= c + 5; y++) {
      for (let x = c - 5; x <= c + 5; x++) {
        tiles++;
        if (heightAt(map, x, y) <= 4 && map.water[y * SIZE + x] !== 1) arable++;
      }
    }
    expect(arable / tiles).toBeGreaterThan(0.8);
  });

  it('rises in faces a tile tall, not a staircase of small steps', () => {
    let tall = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE - 1; x++) if (Math.abs(heightAt(map, x, y) - heightAt(map, x + 1, y)) >= 3) tall++;
    }
    expect(tall).toBeGreaterThan(SIZE * 0.5);
  });

  it('can be climbed by the valleys its rivers cut', () => {
    const seen = reachableFrom(map, SIZE >> 1, SIZE >> 1);
    let summit = 0;
    for (let i = 0; i < map.data.length; i++) if (map.data[i] === 7 && seen[i] === 1) summit++;
    expect(summit).toBeGreaterThan(20);
  });
});
