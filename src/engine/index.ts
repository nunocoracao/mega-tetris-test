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

export { dailySeed, isDateStamp, DATE_STAMP_PATTERN } from './daily';

export type {
  RecorderOptions,
  ReplayEntry,
  ReplayInput,
  ReplayLog,
  ReplayOptions,
  ReplayPlayer,
  RunRecorder,
} from './replay';
export {
  advanceReplay,
  createRecorder,
  emptyLog,
  isReplayInput,
  replay,
  restartReplay,
  startReplay,
  MAX_LOG_ENTRIES,
  MAX_REPLAY_MS,
  REPLAY_FORMAT_VERSION,
  REPLAY_INPUTS,
} from './replay';

export type { ShareErrorReason, SharePayload, ShareResult, SharedRun } from './share';
export {
  decodeShare,
  fromBase64Url,
  inflateRaw,
  inflateZlib,
  packShare,
  readShareFragment,
  shareFragment,
  sharePayloadBytes,
  toBase64Url,
  MAX_BODY_BYTES,
  MAX_DECODE_CHARS,
  MAX_SHARE_CHARS,
  SHARE_CODEC_DEFLATE,
  SHARE_CODEC_STORED,
  SHARE_ERROR_MESSAGES,
  SHARE_FRAGMENT_KEY,
} from './share';

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

export type {
  ActionKind,
  FinishedOutcome,
  GameEvent,
  GameInput,
  GameMode,
  GameOptions,
  GameState,
  GameStatus,
  ModeRules,
  RunOutcome,
  SpinKind,
} from './game';
export {
  applyInput,
  createGame,
  dropDistance,
  ghostPiece,
  gravityIntervalMs,
  isResting,
  levelForLines,
  parseGameMode,
  spinKind,
  spinTable,
  update,
  GAME_MODES,
  MODE_RULES,
  SPRINT_GOAL_LINES,
  ULTRA_TIME_LIMIT_MS,
  BACK_TO_BACK_MULTIPLIER,
  COMBO_POINTS,
  DEFAULT_SEED,
  GRAVITY_BASE_MS,
  GRAVITY_FACTOR,
  GRAVITY_FLOOR_MS,
  HARD_DROP_POINTS,
  KICKED_SPIN_POINTS,
  LINE_CLEAR_DELAY_MS,
  LINE_CLEAR_POINTS,
  LINES_PER_LEVEL,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  NEXT_QUEUE_SIZE,
  SOFT_DROP_POINTS,
  SPIN_POINTS,
} from './game';
