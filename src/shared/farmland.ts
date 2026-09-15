/**
 * The wire format for the fields.
 *
 * In `shared/` for the reason the snapshot schema and the woodland format are: the
 * simulation writes it and the renderer reads it, and `src/render` may not import values
 * from `src/sim` at all.
 */

/** Floats per field: tileX, tileY, owner, established, condition, and its own slot. */
export const FARMLAND_STRIDE = 6;

/**
 * The slot is carried rather than implied, for the reason the woodland's is: packing
 * drops abandoned fields, so a field's place in the packed array stops matching the
 * simulation's index as soon as one is given up.
 */
export function fieldSlot(packed: Float32Array, at: number): number {
  return packed[at + 5]!;
}

export function fieldOwner(packed: Float32Array, at: number): number {
  return packed[at + 2]!;
}

/** 1 once the ground is broken and the field is a crop rather than bare earth. */
export function fieldEstablished(packed: Float32Array, at: number): boolean {
  return packed[at + 3]! === 1;
}

/** 0..1: what the field will return of what it could. */
export function fieldCondition(packed: Float32Array, at: number): number {
  return packed[at + 4]!;
}
