import { t, type MessageKey } from '../core/i18n/index.js';
import { SPECIES } from '../shared/wildlife.js';

/**
 * Every visual asset the game ships, laid out by category. Dev builds only.
 *
 * Reached from a button on the setup screen that exists only under `import.meta.env.DEV`
 * (and loaded as its own chunk from there), so none of it reaches a production build.
 *
 * It reads what SHIPPED — the packed sprite atlas and the terrain tile page — not the
 * pipeline's working files, because the question it answers is "what will the player
 * see". Categories are worked out from the atlas itself (a kind with a `build` animation
 * is a building, a `still` one is scenery, a species name is an animal), so art added
 * later lands in the right section without anyone touching this file.
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
  readonly origins: Readonly<Record<string, { x: number; y: number; pixelsPerUnit: number }>>;
  readonly kinds: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly frames: Readonly<Record<string, AtlasFrame>>;
}

interface TerrainTile {
  readonly file: string;
  readonly subject: string;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

interface TerrainManifest {
  readonly page: string;
  readonly seasons: Readonly<Record<string, string>>;
  readonly tiles: readonly TerrainTile[];
}

/** The game draws a world metre at this many pixels (presentation.json `sprites`). */
const GAME_PIXELS_PER_UNIT = 29;
/** Ticks of the gallery's own clock per animation frame, at 20 ticks a second. */
const FRAME_MS = 110;

/** How animations are listed on a card. */
const ANIM_ORDER = ['still', 'build', 'idle', 'walk', 'run', 'attack'];

const SPRITES = '/assets/sprites';
const TERRAIN = '/assets/terrain';

type Category = 'terrain' | 'people' | 'animals' | 'livestock' | 'buildings' | 'scenery' | 'overlays';

const CATEGORY_LABELS: Readonly<Record<Category, MessageKey>> = {
  terrain: 'gallery.terrain',
  people: 'gallery.people',
  animals: 'gallery.animals',
  livestock: 'gallery.livestock',
  buildings: 'gallery.buildings',
  scenery: 'gallery.scenery',
  overlays: 'gallery.overlays',
};

const WILD = new Set(SPECIES.map((info) => info.name));

function categoryOf(kind: string, anims: Readonly<Record<string, number>>): Category {
  if (kind.endsWith('-team') || kind.endsWith('-shield')) return 'overlays';
  if (anims.build !== undefined) return 'buildings';
  if (anims.still !== undefined) return 'scenery';
  if (WILD.has(kind)) return 'animals';
  if (kind.startsWith('nguni')) return 'livestock';
  return 'people';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(src));
    image.src = src;
  });
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}

/** A labelled group of buttons, one of which is on. */
function toggle(
  parent: HTMLElement,
  label: MessageKey,
  options: readonly { readonly key: MessageKey; readonly value: string }[],
  initial: string,
  onChange: (value: string) => void,
): void {
  const group = element('span', 'gallery__toggle', parent);
  element('span', 'gallery__toggle-label', group).textContent = t(label);
  const buttons: HTMLButtonElement[] = [];
  for (const option of options) {
    const button = element('button', 'gallery__chip', group);
    button.textContent = t(option.key);
    button.classList.toggle('is-on', option.value === initial);
    button.addEventListener('click', () => {
      for (const other of buttons) other.classList.toggle('is-on', other === button);
      onChange(option.value);
    });
    buttons.push(button);
  }
}

export async function showGallery(parent: HTMLElement): Promise<void> {
  document.title = t('gallery.title');
  parent.textContent = '';
  const page = element('div', 'gallery', parent);

  const header = element('div', 'gallery__header', page);
  element('h1', 'gallery__title', header).textContent = t('gallery.title');
  const back = element('a', 'gallery__back', header);
  back.textContent = t('gallery.back');
  back.href = location.pathname;
  const controls = element('div', 'gallery__controls', page);
  const nav = element('nav', 'gallery__nav', page);
  const body = element('div', 'gallery__body', page);

  const [atlas, terrain] = await Promise.all([
    fetch(`${SPRITES}/atlas.json`).then((r) => r.json() as Promise<AtlasFile>),
    fetch(`${TERRAIN}/manifest.json`).then((r) => r.json() as Promise<TerrainManifest>),
  ]);
  const pages = await Promise.all(atlas.pages.map((name) => loadImage(`${SPRITES}/${name}`)));
  const seasonPages: Record<string, HTMLImageElement> = { wet: await loadImage(`${TERRAIN}/${terrain.page}`) };
  for (const [season, file] of Object.entries(terrain.seasons)) seasonPages[season] = await loadImage(`${TERRAIN}/${file}`);

  // --- view settings -------------------------------------------------------------
  let zoom = 1;
  let atGameScale = false;
  let playing = true;
  let season = 'wet';
  const setBackground = (value: string): void => {
    page.dataset.background = value;
  };
  setBackground('veld');
  toggle(controls, 'gallery.background', [
    { key: 'gallery.bgVeld', value: 'veld' },
    { key: 'gallery.bgDark', value: 'dark' },
    { key: 'gallery.bgLight', value: 'light' },
    { key: 'gallery.bgChecker', value: 'checker' },
  ], 'veld', setBackground);
  toggle(controls, 'gallery.scale', [
    { key: 'gallery.scaleGame', value: 'game' },
    { key: 'gallery.scale1', value: '1' },
    { key: 'gallery.scale2', value: '2' },
  ], '1', (value) => {
    atGameScale = value === 'game';
    zoom = value === '2' ? 2 : 1;
    redrawAll();
  });
  toggle(controls, 'gallery.season', [
    { key: 'gallery.wet', value: 'wet' },
    { key: 'gallery.dry', value: 'dry' },
    { key: 'gallery.drought', value: 'drought' },
  ], 'wet', (value) => {
    season = value;
    drawTerrain();
  });
  const play = element('button', 'gallery__chip is-on', controls);
  play.textContent = t('gallery.pause');
  play.addEventListener('click', () => {
    playing = !playing;
    play.textContent = t(playing ? 'gallery.pause' : 'gallery.play');
    play.classList.toggle('is-on', playing);
  });

  // --- sprites -----------------------------------------------------------------
  interface Strip {
    readonly canvas: HTMLCanvasElement;
    readonly kind: string;
    readonly anim: string;
    readonly frames: number;
    /** Buildings and scenery lay their frames out side by side instead of animating. */
    readonly still: boolean;
  }
  const strips: Strip[] = [];
  const visible = new Set<HTMLCanvasElement>();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target as HTMLCanvasElement);
      else visible.delete(entry.target as HTMLCanvasElement);
    }
  });

  function frameOf(kind: string, anim: string, direction: number, index: number): AtlasFrame | undefined {
    return atlas.frames[`${kind}_${anim}_${direction}_${String(index).padStart(2, '0')}`];
  }

  /** How big a frame of this kind is drawn: its trimmed box, scaled. */
  function scaleOf(kind: string): number {
    const ppu = atlas.origins[kind]?.pixelsPerUnit;
    return atGameScale && ppu !== undefined ? GAME_PIXELS_PER_UNIT / ppu : zoom;
  }

  /** The cell a kind needs so every frame of every direction fits at a common origin. */
  function cellOf(kind: string, anim: string, directions: number, frames: number): { w: number; h: number; left: number; top: number } {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let d = 0; d < directions; d++) {
      for (let f = 0; f < frames; f++) {
        const frame = frameOf(kind, anim, d, f);
        if (frame === undefined) continue;
        left = Math.min(left, frame.offsetX);
        top = Math.min(top, frame.offsetY);
        right = Math.max(right, frame.offsetX + frame.w);
        bottom = Math.max(bottom, frame.offsetY + frame.h);
      }
    }
    return { w: right - left, h: bottom - top, left, top };
  }

  function drawStrip(strip: Strip, tick: number): void {
    const { canvas, kind, anim, frames, still } = strip;
    const directions = still ? 1 : atlas.directions;
    const cell = cellOf(kind, anim, directions, frames);
    const scale = scaleOf(kind);
    const cellW = Math.ceil(cell.w * scale) + 8;
    const cellH = Math.ceil(cell.h * scale) + 8;
    const columns = still ? frames : directions;
    const width = cellW * columns;
    if (canvas.width !== width || canvas.height !== cellH) {
      canvas.width = width;
      canvas.height = cellH;
    }
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = scale < 1;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (let column = 0; column < columns; column++) {
      const direction = still ? 0 : column;
      const index = still ? column : tick % frames;
      const frame = frameOf(kind, anim, direction, index);
      if (frame === undefined) continue;
      const source = pages[frame.page];
      if (source === undefined) continue;
      context.drawImage(
        source,
        frame.x,
        frame.y,
        frame.w,
        frame.h,
        column * cellW + 4 + (frame.offsetX - cell.left) * scale,
        4 + (frame.offsetY - cell.top) * scale,
        frame.w * scale,
        frame.h * scale,
      );
    }
  }

  const sections = new Map<Category, HTMLElement>();
  function section(category: Category): HTMLElement {
    let found = sections.get(category);
    if (found !== undefined) return found;
    found = element('section', 'gallery__section', body);
    found.id = `gallery-${category}`;
    element('h2', 'gallery__heading', found).textContent = t(CATEGORY_LABELS[category]);
    sections.set(category, found);
    return found;
  }

  // Terrain first, as the thing the rest stands on; then everything in the atlas.
  const terrainSection = section('terrain');
  const kinds = Object.keys(atlas.kinds).sort();
  const order: Category[] = ['people', 'animals', 'livestock', 'buildings', 'scenery', 'overlays'];
  for (const category of order) {
    for (const kind of kinds) {
      const anims = atlas.kinds[kind]!;
      if (categoryOf(kind, anims) !== category) continue;
      const card = element('div', 'gallery__card', section(category));
      const title = element('div', 'gallery__name', card);
      title.textContent = kind;
      const origin = atlas.origins[kind];
      title.title = origin === undefined ? kind : `${kind} — ${origin.pixelsPerUnit.toFixed(1)} px/m`;
      // A fixed order, so every card reads the same way down: rest, walk, run, then
      // whatever else. The atlas keeps them in the order they happened to be packed.
      const byOrder = Object.entries(anims).sort(
        ([a], [b]) => (ANIM_ORDER.indexOf(a) + 1 || 99) - (ANIM_ORDER.indexOf(b) + 1 || 99),
      );
      for (const [anim, frames] of byOrder) {
        const row = element('div', 'gallery__row', card);
        element('span', 'gallery__anim', row).textContent = t('gallery.frames', { anim, frames });
        const canvas = element('canvas', 'gallery__strip', row);
        canvas.title = t('gallery.frames', { anim, frames });
        const strip: Strip = { canvas, kind, anim, frames, still: anim === 'build' || anim === 'still' };
        strips.push(strip);
        observer.observe(canvas);
        drawStrip(strip, 0);
      }
    }
  }

  // --- terrain -----------------------------------------------------------------
  const TERRAIN_GROUPS: readonly { readonly label: MessageKey; readonly subjects: (subject: string) => boolean; readonly limit: number }[] = [
    { label: 'gallery.ground', subjects: (s) => !['transition', 'corner', 'water', 'field'].includes(s), limit: Infinity },
    { label: 'gallery.water', subjects: (s) => s === 'water', limit: Infinity },
    { label: 'gallery.fields', subjects: (s) => s === 'field', limit: Infinity },
    { label: 'gallery.transitions', subjects: (s) => s === 'transition', limit: 48 },
    { label: 'gallery.corners', subjects: (s) => s === 'corner', limit: 32 },
  ];
  const terrainCanvases: { canvas: HTMLCanvasElement; tile: TerrainTile }[] = [];
  for (const group of TERRAIN_GROUPS) {
    const tiles = terrain.tiles.filter((tile) => group.subjects(tile.subject));
    if (tiles.length === 0) continue;
    const block = element('div', 'gallery__card gallery__card--wide', terrainSection);
    element('div', 'gallery__name', block).textContent = t('gallery.tileCount', { group: t(group.label), count: tiles.length });
    const grid = element('div', 'gallery__tiles', block);
    const shown = tiles.slice(0, group.limit);
    // Grouped by subject within the group, so the bands read as bands.
    shown.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.file < b.file ? -1 : 1));
    for (const tile of shown) {
      const canvas = element('canvas', 'gallery__tile', grid);
      canvas.title = tile.file;
      terrainCanvases.push({ canvas, tile });
    }
    if (shown.length < tiles.length) {
      element('div', 'gallery__more', block).textContent = t('gallery.more', { count: tiles.length - shown.length });
    }
  }

  function drawTerrain(): void {
    const source = seasonPages[season] ?? seasonPages.wet!;
    for (const { canvas, tile } of terrainCanvases) {
      canvas.width = tile.width * zoom;
      canvas.height = tile.height * zoom;
      const context = canvas.getContext('2d')!;
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, tile.x, tile.y, tile.width, tile.height, 0, 0, canvas.width, canvas.height);
    }
  }

  // --- nav ---------------------------------------------------------------------
  for (const [category, node] of sections) {
    const link = element('a', 'gallery__link', nav);
    link.textContent = t(CATEGORY_LABELS[category]);
    link.href = `#${node.id}`;
  }

  function redrawAll(): void {
    for (const strip of strips) drawStrip(strip, tick);
    drawTerrain();
  }

  let tick = 0;
  let last = performance.now();
  function frame(now: number): void {
    if (!page.isConnected) return;
    if (playing && now - last >= FRAME_MS) {
      last = now;
      tick++;
      for (const strip of strips) if (!strip.still && visible.has(strip.canvas)) drawStrip(strip, tick);
    }
    requestAnimationFrame(frame);
  }
  drawTerrain();
  requestAnimationFrame(frame);
}
