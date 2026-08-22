/**
 * Public surface of the game engine.
 *
 * Everything here is pure TypeScript with no DOM, browser or Vite dependency,
 * so it can be imported by the UI, by tests, or by a plain Node script.
 */

export type { ActivePiece, Cell, PieceKind, Point, Rotation, RotationDirection } from './types';

export {
  boxSize,
  getCells,
  getKicks,
  nextRotation,
  spawnPosition,
  KICKS_CCW,
  KICKS_CW,
  KICKS_I_CCW,
  KICKS_I_CW,
  PIECE_KINDS,
} from './pieces';

export type { Board, CellUpdate } from './board';
export {
  boardFromStrings,
  boardToStrings,
  cellAt,
  clearRows,
  createBoard,
  findFullRows,
  isBoardEmpty,
  isInsideBoard,
  isValidPosition,
  lockPiece,
  pieceCells,
  setCells,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BUFFER_ROWS,
  EMPTY_CHAR,
  VISIBLE_HEIGHT,
} from './board';

export type { Bag, RandomFn } from './random';
export { createBag, createRandom, shuffle } from './random';
