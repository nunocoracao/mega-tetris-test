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

export type { Bag, BagState, RandomFn } from './random';
export {
  createBag,
  createBagState,
  createRandom,
  drawPiece,
  drawPieces,
  randomStep,
  shuffle,
  shuffleWithState,
} from './random';

export type { GameEvent, GameInput, GameOptions, GameState, GameStatus } from './game';
export {
  applyInput,
  createGame,
  dropDistance,
  ghostPiece,
  gravityIntervalMs,
  isResting,
  levelForLines,
  update,
  DEFAULT_SEED,
  GRAVITY_BASE_MS,
  GRAVITY_FACTOR,
  GRAVITY_FLOOR_MS,
  HARD_DROP_POINTS,
  LINE_CLEAR_DELAY_MS,
  LINE_CLEAR_POINTS,
  LINES_PER_LEVEL,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  NEXT_QUEUE_SIZE,
  SOFT_DROP_POINTS,
} from './game';
