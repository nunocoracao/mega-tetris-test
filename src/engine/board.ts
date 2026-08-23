/**
 * The playfield: an immutable grid of cells plus the queries and mutators the
 * rest of the game needs.
 *
 * Every "mutator" (`setCells`, `lockPiece`, `clearRows`) returns a **new**
 * board and leaves its input untouched. That makes the engine trivial to test,
 * lets the UI diff old against new for animations, and rules out a whole class
 * of aliasing bugs.
 *
 * Cells are stored in a single flat array in row-major order, so the cell at
 * `(x, y)` is at index `y * width + x`.
 */

import { getCells, PIECE_KINDS } from './pieces';
import { GARBAGE_CELL, type ActivePiece, type Cell, type Point } from './types';

/** Columns in the standard field. */
export const BOARD_WIDTH = 10;

/** Rows the player can see. */
export const VISIBLE_HEIGHT = 20;

/**
 * Hidden rows above the visible field. Pieces spawn here, so a piece is
 * already in play before the player sees it and a rotation near the ceiling
 * has somewhere to go.
 */
export const BUFFER_ROWS = 2;

/** Total rows stored in a standard board, buffer included. */
export const BOARD_HEIGHT = VISIBLE_HEIGHT + BUFFER_ROWS;

/** The character `boardToStrings` uses for an empty cell. */
export const EMPTY_CHAR = '.';

export interface Board {
  readonly width: number;
  readonly height: number;
  /** Row-major cells, length `width * height`. */
  readonly cells: readonly Cell[];
}

/** A single cell write, used by `setCells`. */
export interface CellUpdate {
  readonly x: number;
  readonly y: number;
  readonly value: Cell;
}

/** An empty board. Defaults to the standard 10 x (20 + 2) field. */
export function createBoard(width: number = BOARD_WIDTH, height: number = BOARD_HEIGHT): Board {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`createBoard: width and height must be positive integers (got ${width}x${height})`);
  }
  return { width, height, cells: new Array<Cell>(width * height).fill(null) };
}

/** True when `(x, y)` lies inside the board array. */
export function isInsideBoard(board: Board, x: number, y: number): boolean {
  return x >= 0 && x < board.width && y >= 0 && y < board.height;
}

/** The cell at `(x, y)`, or `null` for coordinates outside the board. */
export function cellAt(board: Board, x: number, y: number): Cell {
  if (!isInsideBoard(board, x, y)) {
    return null;
  }
  return board.cells[y * board.width + x] ?? null;
}

/** A copy of `board` with the given cells written in. */
export function setCells(board: Board, updates: readonly CellUpdate[]): Board {
  if (updates.length === 0) {
    return board;
  }
  const cells = [...board.cells];
  for (const { x, y, value } of updates) {
    if (!isInsideBoard(board, x, y)) {
      throw new Error(`setCells: (${x}, ${y}) is outside the ${board.width}x${board.height} board`);
    }
    cells[y * board.width + x] = value;
  }
  return { ...board, cells };
}

/** The board coordinates of the four cells `piece` currently occupies. */
export function pieceCells(piece: ActivePiece): readonly Point[] {
  return getCells(piece.kind, piece.rotation).map((offset) => ({
    x: piece.x + offset.x,
    y: piece.y + offset.y,
  }));
}

/**
 * Can `piece` sit where it claims to?
 *
 * Invalid when any of its cells is off the left or right edge, below the
 * floor, or on top of a filled cell. Cells *above* the top of the array are
 * legal: a piece is allowed to be partly above the field while it spawns or
 * kicks upwards, and only the part that has entered the board can collide.
 */
export function isValidPosition(board: Board, piece: ActivePiece): boolean {
  for (const { x, y } of pieceCells(piece)) {
    if (x < 0 || x >= board.width || y >= board.height) {
      return false;
    }
    if (y < 0) {
      continue; // above the board: nothing to collide with up there.
    }
    if (board.cells[y * board.width + x] != null) {
      return false;
    }
  }
  return true;
}

/**
 * A new board with `piece` written into it.
 *
 * Cells above the top of the array are dropped rather than throwing, so a
 * piece that tops out can still be locked; callers detect the loss by
 * checking the piece's position, not by catching an error here.
 */
export function lockPiece(board: Board, piece: ActivePiece): Board {
  const updates: CellUpdate[] = [];
  for (const { x, y } of pieceCells(piece)) {
    if (isInsideBoard(board, x, y)) {
      updates.push({ x, y, value: piece.kind });
    }
  }
  return setCells(board, updates);
}

/** Indices of every completely filled row, top to bottom. */
export function findFullRows(board: Board): number[] {
  const full: number[] = [];
  for (let y = 0; y < board.height; y += 1) {
    let complete = true;
    for (let x = 0; x < board.width; x += 1) {
      if (board.cells[y * board.width + x] == null) {
        complete = false;
        break;
      }
    }
    if (complete) {
      full.push(y);
    }
  }
  return full;
}

/**
 * Remove `rows` from the board, letting everything above them fall by as many
 * rows as were cleared beneath it, and top the board back up with empty rows.
 * The rows need not be adjacent.
 */
export function clearRows(board: Board, rows: readonly number[]): { board: Board; cleared: number } {
  const doomed = new Set(rows.filter((y) => y >= 0 && y < board.height));
  if (doomed.size === 0) {
    return { board, cleared: 0 };
  }

  const survivors: Cell[] = [];
  for (let y = 0; y < board.height; y += 1) {
    if (doomed.has(y)) {
      continue;
    }
    survivors.push(...board.cells.slice(y * board.width, (y + 1) * board.width));
  }

  const blankRows = new Array<Cell>(doomed.size * board.width).fill(null);
  return {
    board: { ...board, cells: [...blankRows, ...survivors] },
    cleared: doomed.size,
  };
}

/**
 * Push rows in at the **bottom**, shifting everything already on the board up
 * by as many rows, and hand back whatever fell off the top.
 *
 * The mirror image of `clearRows`, and deliberately generic: it knows nothing
 * about garbage, only about rows. Each entry of `newRows` must be exactly
 * `board.width` cells wide; the first entry ends up highest, so the array reads
 * top-to-bottom like everything else here.
 *
 * `overflow` is the rows that no longer fit, again top-to-bottom. The caller
 * decides what that means — for garbage it is a top-out, because the stack has
 * been shoved out of the well.
 */
export function pushRowsUp(
  board: Board,
  newRows: readonly (readonly Cell[])[],
): { board: Board; overflow: readonly (readonly Cell[])[] } {
  if (newRows.length === 0) {
    return { board, overflow: [] };
  }
  for (const [index, row] of newRows.entries()) {
    if (row.length !== board.width) {
      throw new Error(`pushRowsUp: row ${index} is ${row.length} wide, expected ${board.width}`);
    }
  }

  const lost = Math.min(newRows.length, board.height);
  const overflow: (readonly Cell[])[] = [];
  for (let y = 0; y < lost; y += 1) {
    overflow.push(board.cells.slice(y * board.width, (y + 1) * board.width));
  }

  // Everything that survives, then the new rows underneath it. When more rows
  // arrive than the board is tall, only the last `height` of them land.
  const kept = board.cells.slice(lost * board.width);
  const landing = newRows.slice(Math.max(0, newRows.length - board.height)).flat();
  return { board: { ...board, cells: [...kept, ...landing] }, overflow };
}

/** True when no cell on the board is filled. */
export function isBoardEmpty(board: Board): boolean {
  return board.cells.every((cell) => cell == null);
}

/**
 * Render the board as one string per row — `.` for empty, the piece letter for
 * a filled cell. Used by tests (and any future debug overlay) so board states
 * can be written and read as ASCII art.
 */
export function boardToStrings(board: Board): string[] {
  const rows: string[] = [];
  for (let y = 0; y < board.height; y += 1) {
    let row = '';
    for (let x = 0; x < board.width; x += 1) {
      row += board.cells[y * board.width + x] ?? EMPTY_CHAR;
    }
    rows.push(row);
  }
  return rows;
}

const CELL_BY_CHAR = new Map<string, Exclude<Cell, null>>([
  ...PIECE_KINDS.map((kind) => [kind, kind] as const),
  [GARBAGE_CELL, GARBAGE_CELL] as const,
]);

/**
 * Parse ASCII art back into a board. The inverse of `boardToStrings`: width
 * and height come from the input, so tests can use small boards where a full
 * 10x22 field would only obscure the point. `G` is a garbage block.
 */
export function boardFromStrings(rows: readonly string[]): Board {
  if (rows.length === 0) {
    throw new Error('boardFromStrings: need at least one row');
  }
  const width = rows[0]?.length ?? 0;
  if (width === 0) {
    throw new Error('boardFromStrings: rows must not be empty');
  }

  const cells: Cell[] = [];
  for (const [y, row] of rows.entries()) {
    if (row.length !== width) {
      throw new Error(`boardFromStrings: row ${y} is ${row.length} wide, expected ${width}`);
    }
    for (const char of row) {
      if (char === EMPTY_CHAR) {
        cells.push(null);
        continue;
      }
      const cell = CELL_BY_CHAR.get(char);
      if (cell === undefined) {
        throw new Error(`boardFromStrings: '${char}' is not '${EMPTY_CHAR}' or a piece letter`);
      }
      cells.push(cell);
    }
  }

  return { width, height: rows.length, cells };
}
