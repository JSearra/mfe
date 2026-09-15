import { Assets, Rectangle, Texture } from 'pixi.js';

/**
 * Loads the sprite atlas and hands out textures by meaning rather than by coordinate.
 *
 * This is the only file that knows an atlas has coordinates at all. ARCHITECTURE
 * section 9 wants the renderer asset-agnostic so the art pipeline can change — repack
 * the pages, re-cut the frames, swap procedural placeholders for commissioned art —
 * without touching rendering code. Callers ask for "a walking impi facing 3, frame 7".
 *
 * Loading is allowed to fail. A missing or malformed atlas returns null and the caller
 * falls back to drawing shapes, because a game that renders untextured is worth far
 * more than one that shows nothing, and because the tests run without any assets built.
 */

interface AtlasFrame {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

interface AtlasFile {
  readonly pages: readonly string[];
  readonly directions: number;
  readonly origins: Readonly<
    Record<string, { x: number; y: number; pixelsPerUnit?: number }>
  >;
  readonly kinds: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly frames: Readonly<Record<string, AtlasFrame>>;
}

/**
 * Where to draw a frame so its subject's foot lands on a given screen point.
 *
 * Frames are trimmed to their opaque bounding box, so a raised spear makes one frame
 * taller than the next. Drawing trimmed frames at a shared origin makes a unit bob as
 * its own bounding box changes shape, which reads as the animation being broken. The
 * anchor is the foot, recovered from the trim offset and the recorded origin.
 */
export interface SpriteFrame {
  readonly texture: Texture;
  /** Pixels to subtract from the screen position to place the frame's top-left. */
  readonly anchorX: number;
  readonly anchorY: number;
  /**
   * Draw scale that makes one world unit the same number of screen pixels for every
   * kind, whatever camera framing that kind was rendered with.
   *
   * Without it the scale is inherited from how tightly the artist framed the shot: a
   * cow needs a wider camera than a man, so at a shared scale factor the two disagree
   * about how big a metre is by a third.
   */
  readonly scale: number;
}

export interface SpriteAtlas {
  readonly directions: number;
  /** Frame count for a kind's animation, or 0 if it has none. */
  frameCount(kind: string, anim: string): number;
  /** Null when the kind, animation, direction or frame does not exist. */
  frame(kind: string, anim: string, direction: number, frame: number): SpriteFrame | null;
}

const CENTRE = 64;

/** Assumed when a render predates pixelsPerUnit being recorded. */
const FALLBACK_PIXELS_PER_UNIT = 128 / 2.2;

function buildAtlas(
  file: AtlasFile,
  pages: readonly Texture[],
  pixelsPerWorldUnit: number,
): SpriteAtlas {
  // Resolved once into nested arrays. The alternative is composing a key string per
  // entity per frame, which allocates in the render loop for every unit on screen.
  const table = new Map<string, (SpriteFrame | null)[][]>();

  for (const [kind, animations] of Object.entries(file.kinds)) {
    const origin = file.origins[kind] ?? { x: CENTRE, y: CENTRE };
    const scale = pixelsPerWorldUnit / (origin.pixelsPerUnit ?? FALLBACK_PIXELS_PER_UNIT);
    for (const [anim, frameCount] of Object.entries(animations)) {
      const directions: (SpriteFrame | null)[][] = [];
      for (let direction = 0; direction < file.directions; direction++) {
        const frames: (SpriteFrame | null)[] = [];
        for (let index = 0; index < frameCount; index++) {
          const key = `${kind}_${anim}_${direction}_${String(index).padStart(2, '0')}`;
          const entry = file.frames[key];
          const page = entry ? pages[entry.page] : undefined;
          if (!entry || !page) {
            frames.push(null);
            continue;
          }
          frames.push({
            texture: new Texture({
              source: page.source,
              frame: new Rectangle(entry.x, entry.y, entry.w, entry.h),
            }),
            anchorX: origin.x - entry.offsetX,
            anchorY: origin.y - entry.offsetY,
            scale,
          });
        }
        directions.push(frames);
      }
      table.set(`${kind}/${anim}`, directions);
    }
  }

  return {
    directions: file.directions,

    frameCount(kind, anim) {
      return table.get(`${kind}/${anim}`)?.[0]?.length ?? 0;
    },

    frame(kind, anim, direction, frame) {
      const directions = table.get(`${kind}/${anim}`);
      if (!directions) return null;
      const frames = directions[direction];
      if (!frames || frames.length === 0) return null;
      return frames[frame % frames.length] ?? null;
    },
  };
}

export async function loadSpriteAtlas(
  pixelsPerWorldUnit: number,
  base = 'assets/sprites',
): Promise<SpriteAtlas | null> {
  try {
    const response = await fetch(`${base}/atlas.json`);
    if (!response.ok) return null;
    const file = (await response.json()) as AtlasFile;
    if (!file.pages?.length || !file.frames) return null;

    const pages = await Promise.all(file.pages.map((page) => Assets.load<Texture>(`${base}/${page}`)));
    return buildAtlas(file, pages, pixelsPerWorldUnit);
  } catch {
    return null;
  }
}

interface TerrainTileEntry {
  readonly file: string;
  readonly subject: string;
  readonly band: number;
  /**
   * Set on transition tiles only: which of the four diamond edges this one bleeds in
   * from, as a bitmask. Clockwise from the upper right, matching the neighbour order
   * the terrain renderer walks.
   */
  readonly mask?: number;
  /** Set on field tiles: 'broken' for turned earth, 'crop' for a standing crop. */
  readonly field?: string;
  readonly averageColour: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface TerrainManifest {
  readonly page: string;
  readonly padding: number;
  readonly tiles: readonly TerrainTileEntry[];
}

export interface TerrainTile {
  readonly texture: Texture;
  /** Mean colour of the tile, for the flat-shaded cliff faces beneath it. */
  readonly colour: number;
}

export interface TerrainTiles {
  /** Variants available for a height level, nearest band if that level has none. */
  variants(level: number): readonly TerrainTile[];
  /**
   * A band's ground, masked to bleed in from the edges in `mask`, or null.
   *
   * Laid over the tile BELOW it in the ramp, so a boundary reads as the higher ground
   * spilling downhill rather than as a diamond edge. Null when the pipeline has not
   * produced a set for that band, which simply leaves the seam hard rather than
   * failing to draw the map.
   */
  transition(band: number, mask: number): TerrainTile | null;
  /**
   * A field on this band's ground, either broken earth or a standing crop.
   *
   * Drawn from the band's own tile so a field looks like the ground it came out of —
   * the soil of the Karoo is not the soil of the thornveld.
   */
  field(band: number, crop: boolean): TerrainTile | null;
}

/** Edge bits of the four orthogonal neighbours, clockwise from the upper right. */
export const TRANSITION_MASKS = 16;

/**
 * Load the terrain tile page.
 *
 * One page, so filling tile tops never switches texture: a texture per subject would
 * break the batch every time the ground changed underfoot, which at a dozen visible
 * chunks is hundreds of draw calls against a budget of sixty.
 */
export async function loadTerrainTiles(base = 'assets/terrain'): Promise<TerrainTiles | null> {
  try {
    const response = await fetch(`${base}/manifest.json`);
    if (!response.ok) return null;
    const manifest = (await response.json()) as TerrainManifest;
    if (!manifest.page || !manifest.tiles?.length) return null;

    const page = await Assets.load<Texture>(`${base}/${manifest.page}`);
    // Nearest sampling: these are pixel art at exactly their drawn size, and linear
    // filtering on a diamond's edge fringes it against the transparent padding.
    page.source.scaleMode = 'nearest';

    const byBand: TerrainTile[][] = [];
    // band -> mask -> tile. Dense and small: sixteen slots a band, fifteen of them used.
    const transitions: (TerrainTile | null)[][] = [];
    // band -> [broken, crop]
    const fields: (TerrainTile | null)[][] = [];

    for (const entry of manifest.tiles) {
      const tile: TerrainTile = {
        texture: new Texture({
          source: page.source,
          frame: new Rectangle(entry.x, entry.y, entry.width, entry.height),
        }),
        colour: Number.parseInt(entry.averageColour.slice(1), 16),
      };

      if (entry.field !== undefined) {
        const row = (fields[entry.band] ??= [null, null]);
        row[entry.field === 'crop' ? 1 : 0] = tile;
        continue;
      }
      if (entry.mask !== undefined) {
        const row = (transitions[entry.band] ??= new Array<TerrainTile | null>(
          TRANSITION_MASKS,
        ).fill(null));
        row[entry.mask] = tile;
        continue;
      }
      (byBand[entry.band] ??= []).push(tile);
    }
    if (byBand.length === 0) return null;

    return {
      variants(level: number) {
        const exact = byBand[level];
        if (exact && exact.length > 0) return exact;
        // A band with no art falls back to the nearest one that has some, rather than
        // leaving a hole in the map.
        for (let distance = 1; distance < byBand.length; distance++) {
          const below = byBand[level - distance];
          if (below && below.length > 0) return below;
          const above = byBand[level + distance];
          if (above && above.length > 0) return above;
        }
        return [];
      },

      transition(band: number, mask: number) {
        return transitions[band]?.[mask] ?? null;
      },

      field(band: number, crop: boolean) {
        return fields[band]?.[crop ? 1 : 0] ?? null;
      },
    };
  } catch {
    return null;
  }
}
