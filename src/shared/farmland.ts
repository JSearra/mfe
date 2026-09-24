/**
 * The wire format for the fields.
 *
 * In `shared/` for the reason the snapshot schema and the woodland format are: the
 * simulation writes it and the renderer reads it, and `src/render` may not import values
 * from `src/sim` at all.
 */

/**
 * Floats per field: tileX, tileY, owner, established, condition, its own slot, whether
 * it is resting, and the hands standing in it and asked for.
 */
export const FARMLAND_STRIDE = 9;

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

/**
 * Is this field resting?
 *
 * Carried across because a player has to be able to SEE which of their fields are
 * fallow. A rule the village lives by and cannot read off the map is half a mechanic —
 * see CLAUDE.md, and the three playthroughs that died of invisible field decay.
 */
export function fieldFallow(packed: Float32Array, at: number): boolean {
  return packed[at + 6]! === 1;
}

/** People standing in this field at the last labour pass. */
export function fieldHands(packed: Float32Array, at: number): number {
  return packed[at + 7]!;
}

/**
 * People this field is asking for. Zero when it asks for nobody: resting, or too far
 * from a homestead for work to find it on its own (src/sim/labour.ts).
 */
export function fieldHandsWanted(packed: Float32Array, at: number): number {
  return packed[at + 8]!;
}
