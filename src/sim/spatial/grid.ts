/**
 * Uniform grid spatial hash.
 *
 * Absent from the original brief and more performance-critical than pathfinding:
 * flocking is an O(n·k) neighbour query at 20Hz over hundreds of cattle, and combat
 * targeting, selection and stampede collision all need it too.
 *
 * Determinism: buckets are traversed in index order and each bucket's contents are kept
 * sorted by entity index. Without that, a neighbour query returns candidates in
 * insertion order, every "nearest" tie resolves by whatever happened to be inserted
 * first, and two machines diverge on the first frame of combat. See ARCHITECTURE
 * section 1.
 */

export interface SpatialGrid {
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
  /** Entity indices per cell, each cell sorted ascending. */
  readonly cells: number[][];
  clear(): void;
  insert(entityIndex: number, worldX: number, worldY: number): void;
  /**
   * Candidates near a point, sorted ascending. Returns the count.
   *
   * **A superset of `radius`, not the radius.** The answer is every entity in the cells
   * the query's bounding box touches, so a candidate can be most of a cell further out
   * than asked for — with the default cellSize 2 and a radius of 2.2, up to about 4.2.
   * Narrowing to the true radius is the caller's job and every caller must do it.
   * Construction did not, and built from units twice as far away as intended.
   */
  query(worldX: number, worldY: number, radius: number, out: number[]): number;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export function createSpatialGrid(
  worldWidth: number,
  worldHeight: number,
  cellSize: number,
): SpatialGrid {
  const columns = Math.max(1, Math.ceil(worldWidth / cellSize));
  const rows = Math.max(1, Math.ceil(worldHeight / cellSize));
  const cells: number[][] = Array.from({ length: columns * rows }, () => []);

  function cellIndex(worldX: number, worldY: number): number {
    let column = Math.floor(worldX / cellSize);
    let row = Math.floor(worldY / cellSize);
    if (column < 0) column = 0;
    else if (column >= columns) column = columns - 1;
    if (row < 0) row = 0;
    else if (row >= rows) row = rows - 1;
    return row * columns + column;
  }

  return {
    cellSize,
    columns,
    rows,
    cells,

    clear(): void {
      for (const cell of cells) cell.length = 0;
    },

    insert(entityIndex: number, worldX: number, worldY: number): void {
      // Kept sorted on insert: cells hold a handful of entities, so this is cheaper
      // than sorting query results and it makes traversal order total.
      const cell = cells[cellIndex(worldX, worldY)]!;
      let at = cell.length;
      while (at > 0 && cell[at - 1]! > entityIndex) at--;
      cell.splice(at, 0, entityIndex);
    },

    query(worldX: number, worldY: number, radius: number, out: number[]): number {
      out.length = 0;

      // Each bound is clamped independently, matching how insert() clamps an
      // out-of-bounds position into the edge cell. Clamping only one side would let a
      // query miss entities that insert() had already folded into that cell.
      const minColumn = clamp(Math.floor((worldX - radius) / cellSize), 0, columns - 1);
      const maxColumn = clamp(Math.floor((worldX + radius) / cellSize), 0, columns - 1);
      const minRow = clamp(Math.floor((worldY - radius) / cellSize), 0, rows - 1);
      const maxRow = clamp(Math.floor((worldY + radius) / cellSize), 0, rows - 1);

      // Row-major traversal, ascending: a total order over cells.
      for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
          const cell = cells[row * columns + column]!;
          for (const entityIndex of cell) out.push(entityIndex);
        }
      }

      // Cells are internally sorted but concatenating them is not, so restore the order.
      out.sort((a, b) => a - b);
      return out.length;
    },
  };
}
