/**
 * The game state machine.
 *
 * Everything the game *is* lives in one immutable `GameState` snapshot, and
 * everything the game *does* is one of two pure functions:
 *
 *   - `update(state, deltaMs)` — time passes: gravity, lock delay, the pause
 *     after a line clear.
 *   - `applyInput(state, input)` — the player did something.
 *
 * Both return a brand-new snapshot and never touch their input. There is no
 * DOM, no `Date.now()` and no `Math.random()` anywhere: the only source of
 * randomness is the seeded bag carried inside the state itself. That makes the
 * whole game a pure function of `(seed, ordered list of calls)`, so a replay
 * with the same seed and the same script produces a deeply equal state every
 * single time — which is exactly what the tests assert.
 *
 * The UI never reads engine internals to decide what to animate. Each returned
 * snapshot carries `events`: a small, presentation-free description of what
 * just happened. Events belong to the update that produced them and are
 * replaced (not accumulated) on the next call.
 */

import {
  clearRows,
  createBoard,
  findFullRows,
  isValidPosition,
  lockPiece,
  pieceCells,
  type Board,
} from './board';
import { getKicks, nextRotation, spawnPosition } from './pieces';
import { createBagState, drawPiece, drawPieces, type BagState } from './random';
import type { ActivePiece, PieceKind, Point, RotationDirection } from './types';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** How many upcoming kinds the preview shows. */
export const NEXT_QUEUE_SIZE = 5;

/** Gravity interval at level 1, in milliseconds per row. Comfortable. */
export const GRAVITY_BASE_MS = 800;

/** Each level multiplies the interval by this — a 15% speed-up per level. */
export const GRAVITY_FACTOR = 0.85;

/** However high the level climbs, a row never falls faster than this. */
export const GRAVITY_FLOOR_MS = 50;

/** Grace period, once a piece is resting, before it locks. */
export const LOCK_DELAY_MS = 500;

/**
 * How many times a move or rotation may refresh the lock delay for one piece.
 * Without a cap a player could spin a piece on the stack forever; with it, a
 * stalled piece locks after at most `(cap + 1) * LOCK_DELAY_MS`.
 */
export const MAX_LOCK_RESETS = 15;

/** Pause after a line clear, so the UI has room to animate it. */
export const LINE_CLEAR_DELAY_MS = 250;

/** Cleared lines needed per level. */
export const LINES_PER_LEVEL = 10;

/** Base score per line clear, before the level multiplier. */
export const LINE_CLEAR_POINTS: Readonly<Record<number, number>> = {
  1: 100,
  2: 300,
  3: 500,
  4: 800,
};

/** Points per row for a soft drop. */
export const SOFT_DROP_POINTS = 1;

/** Points per row for a hard drop. */
export const HARD_DROP_POINTS = 2;

/** Seed used when the caller does not supply one. */
export const DEFAULT_SEED = 1;

/**
 * Safety net for `update`: the most timer steps one call may run. A frame is
 * one or two; anything near this means a pathological `deltaMs`, and stopping
 * beats looping forever.
 */
const MAX_STEPS_PER_UPDATE = 10_000;

/**
 * Gravity interval for a level, in milliseconds per row.
 *
 * The curve is a plain geometric decay — `800 * 0.85^(level - 1)` — clamped to
 * a 50 ms floor, so the difficulty ramp is smooth and easy to reason about:
 *
 *   level 1 → 800 ms   level 5 → 418 ms   level 10 → 185 ms
 *   level 2 → 680 ms   level 7 → 302 ms   level 15 →  82 ms
 *   level 3 → 578 ms                      level 18 →  50 ms (floor, and on)
 *
 * Rounded to whole milliseconds so the numbers stay exact and reproducible.
 */
export function gravityIntervalMs(level: number): number {
  const clamped = Math.max(1, Math.floor(level));
  const interval = GRAVITY_BASE_MS * GRAVITY_FACTOR ** (clamped - 1);
  return Math.max(GRAVITY_FLOOR_MS, Math.round(interval));
}

/** The level a player is on after clearing `lines` from `startLevel`. */
export function levelForLines(startLevel: number, lines: number): number {
  return startLevel + Math.floor(lines / LINES_PER_LEVEL);
}

// ---------------------------------------------------------------------------
// State, inputs and events
// ---------------------------------------------------------------------------

/**
 * `ready`   — a piece is on the field but the clock has not started.
 * `playing` — time and input both flow.
 * `paused`  — gravity is frozen and gameplay input is ignored.
 * `over`    — the spawn area was blocked; only `restart` does anything.
 */
export type GameStatus = 'ready' | 'playing' | 'paused' | 'over';

/**
 * Something that just happened, described in game terms only — no colours,
 * durations or sounds. The UI decides how to celebrate; the engine only says
 * what to celebrate.
 */
export type GameEvent =
  /** A piece entered the field. */
  | { readonly type: 'spawn'; readonly kind: PieceKind }
  /** A piece became part of the stack, at these board cells. */
  | { readonly type: 'lock'; readonly kind: PieceKind; readonly cells: readonly Point[] }
  /** A hard drop fell `distance` rows before locking. */
  | { readonly type: 'hardDrop'; readonly kind: PieceKind; readonly distance: number }
  /**
   * Rows came out of the board. `rows` are the board row indices as they were
   * *before* the collapse, top to bottom. `quad` marks the four-line clear, and
   * `backToBack` marks a quad that immediately followed another one.
   */
  | {
      readonly type: 'rowsCleared';
      readonly rows: readonly number[];
      readonly count: number;
      readonly quad: boolean;
      readonly backToBack: boolean;
      readonly points: number;
    }
  /** The level went up. */
  | { readonly type: 'levelUp'; readonly level: number; readonly previousLevel: number }
  /** The player swapped pieces: `held` went into the slot, `active` came out. */
  | { readonly type: 'hold'; readonly held: PieceKind; readonly active: PieceKind }
  /** The run ended, with its final numbers. */
  | {
      readonly type: 'gameOver';
      readonly score: number;
      readonly lines: number;
      readonly level: number;
    };

/** Every player action the engine understands. */
export type GameInput =
  | { readonly type: 'moveLeft' }
  | { readonly type: 'moveRight' }
  | { readonly type: 'softDrop' }
  | { readonly type: 'hardDrop' }
  | { readonly type: 'rotateCW' }
  | { readonly type: 'rotateCCW' }
  | { readonly type: 'hold' }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'restart' };

/**
 * A complete, immutable picture of the game. Every field is plain data, so a
 * snapshot can be compared with `toEqual`, cloned, or logged.
 */
export interface GameState {
  readonly board: Board;
  /** The falling piece, or `null` while a line clear is being animated. */
  readonly active: ActivePiece | null;
  /** The upcoming kinds, soonest first. Always `NEXT_QUEUE_SIZE` long. */
  readonly next: readonly PieceKind[];
  /** The piece stream: seeded, and part of the snapshot so replays match. */
  readonly bag: BagState;
  /** The kind parked in the hold slot, if any. */
  readonly hold: PieceKind | null;
  /** Hold has been used for the current piece and is unavailable until it locks. */
  readonly holdLocked: boolean;
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  readonly status: GameStatus;
  /** Milliseconds accumulated toward the next gravity step. */
  readonly gravityMs: number;
  /** Milliseconds the current piece has been resting on the stack. */
  readonly lockMs: number;
  /** Lock-delay refreshes spent by the current piece (capped at `MAX_LOCK_RESETS`). */
  readonly lockResets: number;
  /** Milliseconds left in the post-clear pause before the next piece spawns. */
  readonly clearDelayMs: number;
  /** The last clear was a quad, so the next quad is back-to-back. */
  readonly backToBack: boolean;
  /** Total time advanced while playing. Useful for a UI clock. */
  readonly elapsedMs: number;
  /** What happened during the call that produced this snapshot. */
  readonly events: readonly GameEvent[];
  /** The seed this run was created with; `restart` reuses it. */
  readonly seed: number;
  /** The level this run started on. */
  readonly startLevel: number;
}

export interface GameOptions {
  readonly seed?: number;
  readonly startLevel?: number;
}

const NO_EVENTS: readonly GameEvent[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function withEvents(state: GameState, events: readonly GameEvent[]): GameState {
  if (events.length === 0 && state.events.length === 0) {
    return state;
  }
  return { ...state, events: events.length === 0 ? NO_EVENTS : events };
}

/** Could `piece` sit `(dx, dy)` away from where it is now? */
function fits(board: Board, piece: ActivePiece, dx: number, dy: number): boolean {
  return isValidPosition(board, { ...piece, x: piece.x + dx, y: piece.y + dy });
}

/** True when the piece has landed: there is no room for it one row lower. */
export function isResting(board: Board, piece: ActivePiece): boolean {
  return !fits(board, piece, 0, 1);
}

/** How many rows `piece` would fall if dropped straight down. */
export function dropDistance(board: Board, piece: ActivePiece): number {
  let distance = 0;
  while (fits(board, piece, 0, distance + 1)) {
    distance += 1;
  }
  return distance;
}

/** Where the active piece would land — the ghost the UI draws under it. */
export function ghostPiece(state: GameState): ActivePiece | null {
  if (state.active === null) {
    return null;
  }
  return { ...state.active, y: state.active.y + dropDistance(state.board, state.active) };
}

/** A piece of `kind` at its spawn position and spawn rotation. */
function spawnedPiece(kind: PieceKind, board: Board): ActivePiece {
  const at = spawnPosition(kind, board.width);
  return { kind, rotation: 0, x: at.x, y: at.y };
}

/** End the run, recording the final numbers for the UI. */
function endGame(state: GameState, events: GameEvent[]): GameState {
  events.push({
    type: 'gameOver',
    score: state.score,
    lines: state.lines,
    level: state.level,
  });
  return { ...state, active: null, status: 'over', clearDelayMs: 0, lockMs: 0, gravityMs: 0 };
}

/**
 * Bring the head of the next queue onto the field and top the queue back up.
 * A piece that has nowhere to spawn ends the run.
 */
function spawnNext(state: GameState, events: GameEvent[]): GameState {
  const kind = state.next[0];
  if (kind === undefined) {
    return state; // unreachable: the queue is topped up on every spawn.
  }
  const drawn = drawPiece(state.bag);
  const queued: GameState = {
    ...state,
    next: [...state.next.slice(1), drawn.kind],
    bag: drawn.bag,
    gravityMs: 0,
    lockMs: 0,
    lockResets: 0,
    clearDelayMs: 0,
  };

  const piece = spawnedPiece(kind, queued.board);
  if (!isValidPosition(queued.board, piece)) {
    return endGame(queued, events);
  }

  events.push({ type: 'spawn', kind });
  return { ...queued, active: piece };
}

/**
 * Commit the active piece to the stack, score any lines it completed, and hand
 * over to the next piece — after a short pause when rows were cleared, so the
 * UI can play the clear animation on a settled board.
 */
function lockActive(state: GameState, events: GameEvent[]): GameState {
  const piece = state.active;
  if (piece === null) {
    return state;
  }

  let board = lockPiece(state.board, piece);
  events.push({ type: 'lock', kind: piece.kind, cells: pieceCells(piece) });

  let { score, lines, backToBack } = state;
  let clearDelayMs = 0;

  const rows = findFullRows(board);
  if (rows.length > 0) {
    board = clearRows(board, rows).board;
    const count = rows.length;
    const quad = count === 4;
    const points = (LINE_CLEAR_POINTS[count] ?? 0) * state.level;
    score += points;
    lines += count;
    events.push({
      type: 'rowsCleared',
      rows,
      count,
      quad,
      backToBack: quad && backToBack,
      points,
    });
    backToBack = quad;
    clearDelayMs = LINE_CLEAR_DELAY_MS;
  }

  const level = levelForLines(state.startLevel, lines);
  if (level > state.level) {
    events.push({ type: 'levelUp', level, previousLevel: state.level });
  }

  const locked: GameState = {
    ...state,
    board,
    active: null,
    score,
    lines,
    level,
    backToBack,
    // Hold becomes available again as soon as a piece commits.
    holdLocked: false,
    gravityMs: 0,
    lockMs: 0,
    lockResets: 0,
    clearDelayMs,
  };

  return clearDelayMs > 0 ? locked : spawnNext(locked, events);
}

/**
 * Give the piece its lock delay back after a successful move or rotation.
 *
 * Only counts while the piece is actually resting, and only up to
 * `MAX_LOCK_RESETS` times, so a piece cannot be stalled indefinitely.
 */
function refreshLock(state: GameState): GameState {
  if (state.active === null || !isResting(state.board, state.active)) {
    return { ...state, lockMs: 0 };
  }
  if (state.lockResets >= MAX_LOCK_RESETS) {
    return state;
  }
  return { ...state, lockMs: 0, lockResets: state.lockResets + 1 };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A fresh game: an empty board, a full preview queue and the first piece on
 * the field, waiting in `ready` until the player starts it with `resume`.
 */
export function createGame(options: GameOptions = {}): GameState {
  const seed = options.seed ?? DEFAULT_SEED;
  const startLevel = Math.max(1, Math.floor(options.startLevel ?? 1));
  const opening = drawPieces(createBagState(seed), NEXT_QUEUE_SIZE);

  const empty: GameState = {
    board: createBoard(),
    active: null,
    next: opening.kinds,
    bag: opening.bag,
    hold: null,
    holdLocked: false,
    score: 0,
    lines: 0,
    level: startLevel,
    status: 'ready',
    gravityMs: 0,
    lockMs: 0,
    lockResets: 0,
    clearDelayMs: 0,
    backToBack: false,
    elapsedMs: 0,
    events: NO_EVENTS,
    seed,
    startLevel,
  };

  // Creating a game is not an update, so it reports no events.
  return withEvents(spawnNext(empty, []), NO_EVENTS);
}

/**
 * Advance the clock by `deltaMs`.
 *
 * Time is consumed in slices that stop at the next deadline — the next gravity
 * step, the end of the lock delay, the end of a line-clear pause — so a single
 * large delta produces exactly the same sequence of events as the many small
 * frames it stands in for.
 */
export function update(state: GameState, deltaMs: number): GameState {
  if (state.status !== 'playing' || !(deltaMs > 0)) {
    return withEvents(state, NO_EVENTS);
  }

  const events: GameEvent[] = [];
  let current = state;
  let remaining = deltaMs;
  let steps = 0;

  while (remaining > 0 && current.status === 'playing') {
    if (steps >= MAX_STEPS_PER_UPDATE) {
      break;
    }
    steps += 1;

    const piece = current.active;

    if (piece === null) {
      // Between pieces: run down the line-clear pause, then spawn.
      const consumed = Math.min(remaining, Math.max(0, current.clearDelayMs));
      remaining -= consumed;
      current = {
        ...current,
        clearDelayMs: current.clearDelayMs - consumed,
        elapsedMs: current.elapsedMs + consumed,
      };
      if (current.clearDelayMs <= 0) {
        current = spawnNext(current, events);
      }
      continue;
    }

    if (!isResting(current.board, piece)) {
      // Falling: accumulate toward the next gravity step.
      const interval = gravityIntervalMs(current.level);
      const consumed = Math.min(remaining, Math.max(0, interval - current.gravityMs));
      remaining -= consumed;
      const gravityMs = current.gravityMs + consumed;
      current = { ...current, gravityMs, elapsedMs: current.elapsedMs + consumed };
      if (gravityMs >= interval) {
        current = {
          ...current,
          gravityMs: gravityMs - interval,
          active: { ...piece, y: piece.y + 1 },
          lockMs: 0,
        };
      }
      continue;
    }

    // Resting: run down the lock delay, then commit the piece.
    const consumed = Math.min(remaining, Math.max(0, LOCK_DELAY_MS - current.lockMs));
    remaining -= consumed;
    const lockMs = current.lockMs + consumed;
    current = { ...current, lockMs, elapsedMs: current.elapsedMs + consumed };
    if (lockMs >= LOCK_DELAY_MS) {
      current = lockActive(current, events);
    }
  }

  return withEvents(current, events);
}

/** Shift the active piece sideways, refreshing the lock delay if it lands. */
function move(state: GameState, dx: number): GameState {
  const piece = state.active;
  if (piece === null || !fits(state.board, piece, dx, 0)) {
    return withEvents(state, NO_EVENTS);
  }
  const moved: GameState = { ...state, active: { ...piece, x: piece.x + dx } };
  return withEvents(refreshLock(moved), NO_EVENTS);
}

/**
 * Turn the active piece, trying each wall kick in order and taking the first
 * position the board accepts. A rotation that fits nowhere is simply refused.
 */
function rotate(state: GameState, direction: RotationDirection): GameState {
  const piece = state.active;
  if (piece === null) {
    return withEvents(state, NO_EVENTS);
  }
  const rotation = nextRotation(piece.rotation, direction);
  for (const kick of getKicks(piece.kind, direction)) {
    const candidate: ActivePiece = {
      ...piece,
      rotation,
      x: piece.x + kick.x,
      y: piece.y + kick.y,
    };
    if (isValidPosition(state.board, candidate)) {
      return withEvents(refreshLock({ ...state, active: candidate }), NO_EVENTS);
    }
  }
  return withEvents(state, NO_EVENTS);
}

/** One row down for one point. Refused (and unscored) when already resting. */
function softDrop(state: GameState): GameState {
  const piece = state.active;
  if (piece === null || !fits(state.board, piece, 0, 1)) {
    return withEvents(state, NO_EVENTS);
  }
  return withEvents(
    {
      ...state,
      active: { ...piece, y: piece.y + 1 },
      score: state.score + SOFT_DROP_POINTS,
      gravityMs: 0,
      lockMs: 0,
    },
    NO_EVENTS,
  );
}

/** Slam the piece to its resting place, score the distance and lock at once. */
function hardDrop(state: GameState): GameState {
  const piece = state.active;
  if (piece === null) {
    return withEvents(state, NO_EVENTS);
  }
  const distance = dropDistance(state.board, piece);
  const events: GameEvent[] = [{ type: 'hardDrop', kind: piece.kind, distance }];
  const landed: GameState = {
    ...state,
    active: { ...piece, y: piece.y + distance },
    score: state.score + distance * HARD_DROP_POINTS,
  };
  return withEvents(lockActive(landed, events), events);
}

/**
 * Park the active piece and bring the held one out (or the next one, the first
 * time). The piece that comes out always starts at its spawn position and
 * spawn rotation, and hold stays locked until the next piece commits.
 */
function hold(state: GameState): GameState {
  const piece = state.active;
  if (piece === null || state.holdLocked) {
    return withEvents(state, NO_EVENTS);
  }

  const events: GameEvent[] = [];
  let incoming: PieceKind;
  let swapped: GameState = state;

  if (state.hold === null) {
    const head = state.next[0];
    if (head === undefined) {
      return withEvents(state, NO_EVENTS); // unreachable: the queue is never empty.
    }
    const drawn = drawPiece(state.bag);
    incoming = head;
    swapped = { ...state, next: [...state.next.slice(1), drawn.kind], bag: drawn.bag };
  } else {
    incoming = state.hold;
  }

  events.push({ type: 'hold', held: piece.kind, active: incoming });

  const fresh = spawnedPiece(incoming, swapped.board);
  const held: GameState = {
    ...swapped,
    hold: piece.kind,
    holdLocked: true,
    gravityMs: 0,
    lockMs: 0,
    lockResets: 0,
  };

  if (!isValidPosition(held.board, fresh)) {
    return withEvents(endGame(held, events), events);
  }
  return withEvents({ ...held, active: fresh }, events);
}

/**
 * Apply a player action.
 *
 * `pause`, `resume` and `restart` always work; every other input is ignored
 * unless the game is `playing` with a piece on the field, which is what makes
 * "inputs after game over are no-ops" fall out for free.
 */
export function applyInput(state: GameState, input: GameInput): GameState {
  switch (input.type) {
    case 'restart':
      // Same seed, same starting level — a rerun, not a different game. A UI
      // that wants a different sequence calls `createGame` with a new seed.
      return { ...createGame({ seed: state.seed, startLevel: state.startLevel }), status: 'playing' };

    case 'pause':
      return state.status === 'playing'
        ? withEvents({ ...state, status: 'paused' }, NO_EVENTS)
        : withEvents(state, NO_EVENTS);

    case 'resume':
      return state.status === 'paused' || state.status === 'ready'
        ? withEvents({ ...state, status: 'playing' }, NO_EVENTS)
        : withEvents(state, NO_EVENTS);

    default:
      break;
  }

  if (state.status !== 'playing' || state.active === null) {
    return withEvents(state, NO_EVENTS);
  }

  switch (input.type) {
    case 'moveLeft':
      return move(state, -1);
    case 'moveRight':
      return move(state, 1);
    case 'softDrop':
      return softDrop(state);
    case 'hardDrop':
      return hardDrop(state);
    case 'rotateCW':
      return rotate(state, 'cw');
    case 'rotateCCW':
      return rotate(state, 'ccw');
    case 'hold':
      return hold(state);
  }
}
