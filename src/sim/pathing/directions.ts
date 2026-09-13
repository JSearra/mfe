/**
 * Eight movement directions, and how they relate to the four orthogonal edges that
 * carry passability.
 *
 * Order: N, NE, E, SE, S, SW, W, NW.
 */
export const DIR8_DX = [0, 1, 1, 1, 0, -1, -1, -1] as const;
export const DIR8_DY = [-1, -1, 0, 1, 1, 1, 0, -1] as const;
export const DIR8_COUNT = 8;
export const NO_DIRECTION = 255;

/** Integer step weights: 70 : 99 approximates 1 : sqrt(2) to better than 0.1%. */
export const ORTHO_STEP = 70;
export const DIAG_STEP = 99;

export function isDiagonal(direction: number): boolean {
  return (direction & 1) === 1;
}

/**
 * Edge bits a direction requires from the source tile.
 *
 * A diagonal needs BOTH adjacent orthogonals, which is what stops units cutting the
 * corner of a cliff — squeezing diagonally between two impassable steps.
 */
export const DIR8_REQUIRED_EDGES = [
  0b0001, // N  -> north
  0b0011, // NE -> north + east
  0b0010, // E  -> east
  0b0110, // SE -> east + south
  0b0100, // S  -> south
  0b1100, // SW -> south + west
  0b1000, // W  -> west
  0b1001, // NW -> west + north
] as const;
