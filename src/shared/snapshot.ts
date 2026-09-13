/**
 * The simulation -> render boundary.
 *
 * The field layout is declared ONCE, below, and both the writer and the reader derive
 * their offsets from it. Hand-written paired codecs drift — encoder writes a field at
 * one offset, decoder reads it at another — and the resulting bug reads as corrupted
 * game state rather than as a codec error. Deriving both sides makes that class of bug
 * unrepresentable.
 *
 * Layout is planar (all handles, then all x, then all y, ...) rather than interleaved,
 * because the renderer's hot loop interpolates whole fields at a time. Planar gives it
 * Float32Array views it can walk linearly, with no copy.
 *
 * See docs/ARCHITECTURE.md section 5.
 */

export const SNAPSHOT_VERSION = 4;

export type FieldType = 'u32' | 'f32' | 'u8';

export interface FieldSpec {
  readonly name: string;
  readonly type: FieldType;
}

/**
 * Ordered widest-first so each block stays naturally aligned.
 *
 * `facing` is quantised over the full circle into 256 steps rather than to the atlas's
 * eight directions. Same one byte, but it survives interpolation: quantising to eight
 * up front would make the renderer's shortest-arc facing lerp meaningless, and picking
 * a sprite octant from 256 steps is a rounding away.
 */
export const SNAPSHOT_FIELDS = [
  { name: 'handle', type: 'u32' },
  { name: 'animStartTick', type: 'u32' },
  { name: 'x', type: 'f32' },
  { name: 'y', type: 'f32' },
  { name: 'facing', type: 'u8' },
  { name: 'animState', type: 'u8' },
  { name: 'faction', type: 'u8' },
  { name: 'flags', type: 'u8' },
  { name: 'hpPct', type: 'u8' },
  { name: 'kind', type: 'u8' },
  /**
   * Stress, 0-255. Carried explicitly rather than packed into `flags` because the
   * renderer has to make it legible — a player who cannot read how close a herd is to
   * bolting cannot plan around it, which is half of what the mechanic is for.
   */
  { name: 'stressPct', type: 'u8' },
  /**
   * Construction progress, 0-255. A separate field from stress rather than sharing the
   * byte by kind: a union keyed on a discriminator saves one byte per entity and costs
   * the next reader a careful think about which meaning applies.
   */
  { name: 'progressPct', type: 'u8' },
] as const satisfies readonly FieldSpec[];

type Fields = typeof SNAPSHOT_FIELDS;

type ArrayFor<T extends FieldType> = T extends 'u32'
  ? Uint32Array
  : T extends 'f32'
    ? Float32Array
    : Uint8Array;

/** Field views, typed from the declaration above rather than restated by hand. */
export type SnapshotFields = {
  -readonly [F in Fields[number] as F['name']]: ArrayFor<F['type']>;
};

export interface SnapshotView extends SnapshotFields {
  readonly version: number;
  readonly tick: number;
  readonly count: number;
  readonly viewerId: number;
  readonly buffer: ArrayBuffer;
}

const BYTES_PER: Record<FieldType, number> = { u32: 4, f32: 4, u8: 1 };

/** version, tick, count, viewerId. */
const HEADER_BYTES = 16;

function align4(value: number): number {
  return (value + 3) & ~3;
}

export interface Layout {
  readonly offsets: readonly number[];
  readonly byteLength: number;
}

export function computeLayout(count: number): Layout {
  const offsets: number[] = [];
  let cursor = HEADER_BYTES;

  for (const field of SNAPSHOT_FIELDS) {
    offsets.push(cursor);
    cursor = align4(cursor + BYTES_PER[field.type] * count);
  }
  return { offsets, byteLength: cursor };
}

function viewFor(buffer: ArrayBuffer, field: FieldSpec, offset: number, count: number): unknown {
  switch (field.type) {
    case 'u32':
      return new Uint32Array(buffer, offset, count);
    case 'f32':
      return new Float32Array(buffer, offset, count);
    case 'u8':
      return new Uint8Array(buffer, offset, count);
  }
}

function bindFields(buffer: ArrayBuffer, layout: Layout, count: number): SnapshotFields {
  const bound: Record<string, unknown> = {};
  for (let i = 0; i < SNAPSHOT_FIELDS.length; i++) {
    const field = SNAPSHOT_FIELDS[i]!;
    bound[field.name] = viewFor(buffer, field, layout.offsets[i]!, count);
  }
  return bound as SnapshotFields;
}

export interface SnapshotWriter extends SnapshotFields {
  readonly buffer: ArrayBuffer;
  readonly count: number;
}

/** Allocate a snapshot buffer and bind writable field views over it. */
export function createSnapshotWriter(
  count: number,
  tick: number,
  viewerId: number,
): SnapshotWriter {
  const layout = computeLayout(count);
  const buffer = new ArrayBuffer(layout.byteLength);

  const header = new Uint32Array(buffer, 0, 4);
  header[0] = SNAPSHOT_VERSION;
  header[1] = tick;
  header[2] = count;
  header[3] = viewerId;

  return { buffer, count, ...bindFields(buffer, layout, count) };
}

export class SnapshotVersionError extends Error {
  constructor(
    readonly found: number,
    readonly expected: number,
  ) {
    super(
      `snapshot version ${found} cannot be read by this build, which speaks version ${expected}`,
    );
    this.name = 'SnapshotVersionError';
  }
}

/**
 * Bind read views over a snapshot buffer. Zero copy.
 *
 * A version mismatch throws rather than returning garbage: reading a v1 buffer with v2
 * offsets produces plausible-looking nonsense, which is far harder to diagnose than a
 * refusal at the boundary.
 */
export function decodeSnapshot(buffer: ArrayBuffer): SnapshotView {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new RangeError(`snapshot buffer is ${buffer.byteLength} bytes, shorter than its header`);
  }

  const header = new Uint32Array(buffer, 0, 4);
  const version = header[0]!;
  if (version !== SNAPSHOT_VERSION) throw new SnapshotVersionError(version, SNAPSHOT_VERSION);

  const count = header[2]!;
  const layout = computeLayout(count);
  if (buffer.byteLength < layout.byteLength) {
    throw new RangeError(
      `snapshot claims ${count} entities (${layout.byteLength} bytes) but is ${buffer.byteLength}`,
    );
  }

  return {
    version,
    tick: header[1]!,
    count,
    viewerId: header[3]!,
    buffer,
    ...bindFields(buffer, layout, count),
  };
}

// --- quantisation ------------------------------------------------------------

const TAU = Math.PI * 2;
const FACING_STEPS = 256;

export function encodeFacing(radians: number): number {
  const turns = radians / TAU;
  const wrapped = turns - Math.floor(turns);
  return Math.round(wrapped * FACING_STEPS) & (FACING_STEPS - 1);
}

export function decodeFacing(quantised: number): number {
  return (quantised / FACING_STEPS) * TAU;
}

export function encodeHpPct(hp: number, maxHp: number): number {
  if (maxHp <= 0) return 0;
  const ratio = hp / maxHp;
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return Math.round(clamped * 255);
}
