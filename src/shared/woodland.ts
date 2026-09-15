/**
 * The wire format for the standing wood.
 *
 * In `shared/` for the same reason the snapshot schema is: the simulation writes it and
 * the renderer reads it, so neither can own it. `src/render` may not import values from
 * `src/sim` at all — the lint rule enforces that — and a stride the two sides agreed on
 * by copying a number would be a silent corruption the first time one of them changed.
 */

/** Floats per tree: x, y, a code carrying species and stage, and the tree's own slot. */
export const WOODLAND_STRIDE = 4;

/**
 * The slot is carried rather than implied.
 *
 * Packing drops felled trees, so a tree's position in the packed array stops matching
 * its index in the simulation the moment anything is cut down — and the renderer sends
 * an index back when the player clicks one. Without this the first felling would work
 * and every one after it would take down the wrong tree.
 */
export function treeSlot(packed: Float32Array, at: number): number {
  return packed[at + 3]!;
}

/** Species of the tree at `at`. 0 acacia, 1 marula. */
export function treeSpecies(packed: Float32Array, at: number): number {
  return Math.floor(packed[at + 2]! / 4);
}

/** Growth stage of the tree at `at`. 0 sapling, 1 young, 2 mature. */
export function treeStage(packed: Float32Array, at: number): number {
  return packed[at + 2]! % 4;
}
