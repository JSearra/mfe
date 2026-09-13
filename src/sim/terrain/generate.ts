import { buildPermutation, fbm, smoothstep } from './noise.js';
import type { Heightmap } from '../../shared/heightmap.js';
import { tuning } from '../tuning.js';

/**
 * Deterministic heightmap generation.
 *
 * Lives in src/sim because it consumes the seeded RNG and its output is simulation
 * state. The resulting map is handed to the renderer once at load; the data structure
 * and the pure functions over it live in shared/heightmap.ts.
 */

export interface HeightmapOptions {
  levels: number;
  frequency: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  /**
   * How many times to re-apply smoothstep before quantising. Each pass pushes values
   * toward 0 and 1, which is what turns smooth noise into flats and plateaus with
   * abrupt steps between them — the shape the four map scripts need.
   */
  flatten: number;
}

/**
 * The default generator: generic savanna, used when no named map is chosen.
 * The four scripted landscapes live in ./maps.ts.
 */
export function createHeightmap(
  width: number,
  height: number,
  seed: number,
  options: HeightmapOptions = tuning.terrain,
): Heightmap {
  const { levels, frequency, octaves, lacunarity, gain, flatten } = options;
  const perm = buildPermutation(seed);
  const data = new Uint8Array(width * height);
  const maxLevel = levels - 1;

  for (let tileY = 0; tileY < height; tileY++) {
    for (let tileX = 0; tileX < width; tileX++) {
      let value = fbm(perm, tileX * frequency, tileY * frequency, octaves, lacunarity, gain);
      for (let i = 0; i < flatten; i++) value = smoothstep(value);

      let level = Math.floor(value * levels);
      if (level < 0) level = 0;
      if (level > maxLevel) level = maxLevel;
      data[tileY * width + tileX] = level;
    }
  }

  return { width, height, levels, data };
}
