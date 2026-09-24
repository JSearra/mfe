import { Assets, Rectangle, Texture } from 'pixi.js';
import { diamondUvs, QUAD_FLOATS } from './scene/terrainGeometry.js';
import { SEAM_CORNERS } from './scene/seams.js';
import { BLEND_VARIANTS } from './scene/terrainBand.js';
import { presentation } from './presentation.js';

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
  /**
   * Set on corner tiles only: which diamond POINT this one bleeds in from — east,
   * south, west, north — for ground that touches the tile only diagonally.
   */
  readonly corner?: number;
  /**
   * Which cut of a boundary-tiling mask this is. Absent on the multi-edge masks, which
   * are baked once — see BLEND_VARIANTS.
   */
  readonly variant?: number;
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
  /** Season name -> a page in the same layout, re-toned by tools/art/season.py. */
  readonly seasons?: { readonly dry?: string; readonly drought?: string };
}

export interface TerrainTile {
  readonly texture: Texture;
  /** Mean colour of the tile, for the flat-shaded cliff faces beneath it. */
  readonly colour: number;
  /**
   * The diamond's four corners in page-normalised UV, as x,y pairs.
   *
   * Precomputed here because the terrain mesh needs UVs rather than a Texture, and
   * because this is the one file that is allowed to know an atlas has coordinates at
   * all — ARCHITECTURE section 9 wants the renderer asset-agnostic, and a mesh builder
   * reaching into `texture.frame` to find a page offset would break that.
   */
  readonly uv: Float32Array;
}

export interface TerrainTiles {
  /**
   * The whole page, as one texture.
   *
   * The terrain mesh is drawn with this and indexes into it with the per-tile UVs
   * above, which is what keeps a chunk of any composition to a single draw call.
   */
  readonly page: Texture;
  /**
   * Show the ground at a point on the season ramp: 0 the rains, 1 the dry season, 2
   * drought, and anything between (roadmap Phase B5).
   *
   * Redraws the page itself as a blend of the two seasonal pages either side, so every
   * chunk mesh and field sprite that samples it changes at once — no geometry rebuilt,
   * no second mesh, no extra draw call. Quantised, so it only redraws when the ground
   * would visibly change. A no-op when the pipeline shipped no seasonal pages.
   */
  setSeason(position: number): void;
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
  transition(band: number, mask: number, variant: number): TerrainTile | null;
  /**
   * A band's ground bleeding in from one diamond point, or null.
   *
   * Its own accessor rather than more bits in the mask above. Folding the diagonals in
   * would take that mask from four bits to eight — 255 combinations a band, two
   * thousand tiles — for a wedge whose shape does not depend on how many of them a tile
   * has. A tile with two diagonal neighbours draws two.
   */
  corner(band: number, corner: number, variant: number): TerrainTile | null;
  /**
   * The bank where dry ground meets water, bleeding in from `mask`'s edges, or null.
   *
   * One set rather than one per band. Water is painted rather than textured, so all of
   * a waterline's softness lives on the land side of it, and a bank is wet sand and
   * pebbles whatever the hinterland behind it happens to be.
   */
  shore(mask: number, variant: number): TerrainTile | null;
  /** The same, arriving at one diamond point — a bend in a river, or a spit. */
  shoreCorner(corner: number, variant: number): TerrainTile | null;
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
 * One cut of a mask, falling back to cut zero.
 *
 * The fallback is what lets the multi-edge masks be baked once while the four that tile
 * a boundary are baked four times: asking for cut three of a mask that has only one
 * answers the one it has, rather than a hole in the map.
 */
function pick(
  row: (TerrainTile | null)[] | undefined,
  index: number,
  variant: number,
): TerrainTile | null {
  if (row === undefined) return null;
  return row[index * BLEND_VARIANTS + variant] ?? row[index * BLEND_VARIANTS] ?? null;
}

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

    const wet = await Assets.load<Texture>(`${base}/${manifest.page}`);
    const seasonal = await loadSeasons(base, manifest, wet);
    const page = seasonal?.page ?? wet;
    // Nearest sampling: these are pixel art at exactly their drawn size, and linear
    // filtering on a diamond's edge fringes it against the transparent padding.
    page.source.scaleMode = 'nearest';

    const byBand: TerrainTile[][] = [];
    // band -> mask * BLEND_VARIANTS + variant -> tile. Dense and small, and the stride
    // means a mask with only one cut simply leaves three slots null; `pick` below reads
    // those back as cut zero.
    const transitions: (TerrainTile | null)[][] = [];
    // band -> corner -> tile. Four a band, one per diamond point.
    const corners: (TerrainTile | null)[][] = [];
    // band -> [broken, crop]
    const fields: (TerrainTile | null)[][] = [];
    const shores = new Array<TerrainTile | null>(TRANSITION_MASKS * BLEND_VARIANTS).fill(null);
    const shoreCorners = new Array<TerrainTile | null>(SEAM_CORNERS * BLEND_VARIANTS).fill(null);

    const pageWidth = page.source.width;
    const pageHeight = page.source.height;

    for (const entry of manifest.tiles) {
      const uv = new Float32Array(QUAD_FLOATS);
      diamondUvs(entry.x, entry.y, entry.width, entry.height, pageWidth, pageHeight, uv);
      const tile: TerrainTile = {
        texture: new Texture({
          source: page.source,
          frame: new Rectangle(entry.x, entry.y, entry.width, entry.height),
        }),
        colour: Number.parseInt(entry.averageColour.slice(1), 16),
        uv,
      };

      if (entry.field !== undefined) {
        const row = (fields[entry.band] ??= [null, null]);
        row[entry.field === 'crop' ? 1 : 0] = tile;
        continue;
      }
      if (entry.subject === 'shore') {
        const cut = entry.variant ?? 0;
        if (entry.corner !== undefined) shoreCorners[entry.corner * BLEND_VARIANTS + cut] = tile;
        else if (entry.mask !== undefined) shores[entry.mask * BLEND_VARIANTS + cut] = tile;
        continue;
      }
      if (entry.corner !== undefined) {
        const row = (corners[entry.band] ??= new Array<TerrainTile | null>(
          SEAM_CORNERS * BLEND_VARIANTS,
        ).fill(null));
        row[entry.corner * BLEND_VARIANTS + (entry.variant ?? 0)] = tile;
        continue;
      }
      if (entry.mask !== undefined) {
        const row = (transitions[entry.band] ??= new Array<TerrainTile | null>(
          TRANSITION_MASKS * BLEND_VARIANTS,
        ).fill(null));
        row[entry.mask * BLEND_VARIANTS + (entry.variant ?? 0)] = tile;
        continue;
      }
      (byBand[entry.band] ??= []).push(tile);
    }
    if (byBand.length === 0) return null;

    return {
      page,

      setSeason(position: number) {
        seasonal?.set(position);
      },

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

      transition(band: number, mask: number, variant: number) {
        return pick(transitions[band], mask, variant);
      },

      corner(band: number, corner: number, variant: number) {
        return pick(corners[band], corner, variant);
      },

      shore(mask: number, variant: number) {
        return pick(shores, mask, variant);
      },

      shoreCorner(corner: number, variant: number) {
        return pick(shoreCorners, corner, variant);
      },

      field(band: number, crop: boolean) {
        return fields[band]?.[crop ? 1 : 0] ?? null;
      },
    };
  } catch {
    return null;
  }
}

/**
 * The seasonal pages, and a canvas that holds the blend of two of them.
 *
 * The three pages are the same tiles in the same places, re-toned per band by
 * tools/art/season.py. Blending them is a straight lerp of premultiplied pixels — drawn
 * with `lighter` at complementary alphas, so a soft-edged transition tile keeps exactly
 * the alpha it had rather than thickening where two draws overlap.
 */
async function loadSeasons(
  base: string,
  manifest: TerrainManifest,
  wet: Texture,
): Promise<{ page: Texture; set(position: number): void } | null> {
  const dryFile = manifest.seasons?.dry;
  const droughtFile = manifest.seasons?.drought;
  if (dryFile === undefined || droughtFile === undefined) return null;
  if (typeof document === 'undefined') return null;

  const [dry, drought] = await Promise.all([
    Assets.load<Texture>(`${base}/${dryFile}`),
    Assets.load<Texture>(`${base}/${droughtFile}`),
  ]);
  const images = [wet, dry, drought].map((t) => t.source.resource as CanvasImageSource);
  const width = wet.source.width;
  const height = wet.source.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  const page = Texture.from(canvas);

  const steps = presentation.terrain.seasonRamp.steps;
  let shown = -1;

  function set(position: number): void {
    const clamped = position < 0 ? 0 : position > 2 ? 2 : position;
    const step = Math.round(clamped * steps);
    if (step === shown) return;
    shown = step;

    const at = step / steps;
    const lower = Math.min(Math.floor(at), 1);
    const t = at - lower;
    context!.clearRect(0, 0, width, height);
    context!.globalCompositeOperation = 'lighter';
    context!.globalAlpha = 1 - t;
    context!.drawImage(images[lower]!, 0, 0);
    if (t > 0) {
      context!.globalAlpha = t;
      context!.drawImage(images[lower + 1]!, 0, 0);
    }
    context!.globalAlpha = 1;
    context!.globalCompositeOperation = 'source-over';
    page.source.update();
  }

  set(0);
  return { page, set };
}
