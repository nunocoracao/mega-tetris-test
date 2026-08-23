/**
 * Public surface of the game engine.
 *
 * Everything here is pure TypeScript with no DOM, browser or Vite dependency,
 * so it can be imported by the UI, by tests, or by a plain Node script.
 */

export type {
  ActivePiece,
  Cell,
  GarbageCell,
  PieceKind,
  Point,
  Rotation,
  RotationDirection,
} from './types';
export { GARBAGE_CELL } from './types';

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
  pushRowsUp,
  setCells,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BUFFER_ROWS,
  EMPTY_CHAR,
  VISIBLE_HEIGHT,
} from './board';

export { dailySeed, isDateStamp, DATE_STAMP_PATTERN } from './daily';

export type { ClearSignals } from './attack';
export {
  attackLines,
  attackTable,
  comboAttackLines,
  ATTACK_LINES,
  BACK_TO_BACK_ATTACK_BONUS,
  COMBO_ATTACK_LINES,
  KICKED_SPIN_ATTACK_LINES,
  SPIN_ATTACK_LINES,
} from './attack';

export type { BoardMetrics, BotDifficulty, BotPlan, BotProfile, BotState, BotStep, BotWeights } from './bot';
export {
  boardMetrics,
  columnHeights,
  createBot,
  distinctRotations,
  parseBotDifficulty,
  planPlacement,
  scoreBoard,
  stepBot,
  BOT_DIFFICULTIES,
  BOT_PROFILES,
  BOT_WEIGHTS,
  LOOKAHEAD_BRANCHES,
  LOOKAHEAD_DISCOUNT,
  WELL_TOLERANCE,
} from './bot';

export type { GarbageBatch, RiseResult } from './garbage';
export {
  cancelGarbage,
  createGarbageRandom,
  garbageDeadlineMs,
  garbageRow,
  nextHoleColumn,
  pendingGarbage,
  queueGarbage,
  riseGarbage,
  tickGarbage,
  GARBAGE_DELAY_MS,
  GARBAGE_SEED_SALT,
  MAX_GARBAGE_BATCH_ROWS,
  MAX_GARBAGE_QUEUE,
} from './garbage';

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
  GarbageOptions,
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
  receiveGarbage,
  spinKind,
  spinTable,
  update,
  winMatch,
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
