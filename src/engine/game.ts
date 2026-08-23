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

import { attackLines } from './attack';
import {
  clearRows,
  createBoard,
  findFullRows,
  isValidPosition,
  lockPiece,
  pieceCells,
  type Board,
} from './board';
import {
  cancelGarbage,
  createGarbageRandom,
  garbageDeadlineMs,
  pendingGarbage,
  queueGarbage,
  riseGarbage,
  tickGarbage,
  GARBAGE_DELAY_MS,
  type GarbageBatch,
} from './garbage';
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

/** How many lines a Sprint has to clear before the clock stops. */
export const SPRINT_GOAL_LINES = 40;

/** How long an Ultra run lasts. Two minutes, to the millisecond. */
export const ULTRA_TIME_LIMIT_MS = 120_000;

/** Base score per line clear, before the level multiplier. */
export const LINE_CLEAR_POINTS: Readonly<Record<number, number>> = {
  1: 100,
  2: 300,
  3: 500,
  4: 800,
};

/**
 * Base score for a **spin** clear — a piece that turned into its slot and was
 * boxed in when it locked — before the level multiplier. Index 0 is the flat
 * bonus for a spin that completed no rows at all: it cleared nothing, but it
 * was still the hard way to place that piece.
 *
 * Every entry beats `LINE_CLEAR_POINTS` for the same number of rows, which is
 * the whole point: the clever clear must pay better than the fast one.
 */
export const SPIN_POINTS: Readonly<Record<number, number>> = {
  0: 100,
  1: 400,
  2: 800,
  3: 1200,
  4: 1600,
};

/**
 * The same table for a **kicked** spin — one that only fitted because a wall
 * kick shoved it sideways or upwards on the way round. Turning a piece in a
 * hole it already fits is the harder trick, so the kicked version is worth
 * roughly half, and still beats the plain clear of the same size.
 */
export const KICKED_SPIN_POINTS: Readonly<Record<number, number>> = {
  0: 50,
  1: 200,
  2: 400,
  3: 600,
  4: 900,
};

/**
 * Points per step of a combo, before the level multiplier.
 *
 * The first clear of a chain scores nothing extra — `combo` is 1 there and the
 * bonus is `COMBO_POINTS * (combo - 1) * level` — so the reward only starts
 * once the player has kept the chain alive.
 */
export const COMBO_POINTS = 50;

/**
 * What a back-to-back clear multiplies its base by. Rounded **down** to a whole
 * point (`Math.floor`), so the score is always an integer and never rounds a
 * player up into a number they did not earn.
 */
export const BACK_TO_BACK_MULTIPLIER = 1.5;

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
 * `over`    — the run is finished; only `restart` does anything. *Why* it
 *             finished is `GameState.outcome`, which the UI needs and must not
 *             have to infer.
 */
export type GameStatus = 'ready' | 'playing' | 'paused' | 'over';

/**
 * The four ways to play. Same rules, same level curve, different finish line.
 *
 * `marathon` — endless. The run ends when the well tops out, and that is the
 *              whole of it. This is the default and the shape the game had
 *              before there was a choice.
 * `sprint`   — clear `SPRINT_GOAL_LINES` as fast as possible. The result is a
 *              time; a top-out before the goal is a did-not-finish.
 * `ultra`    — score as much as possible in `ULTRA_TIME_LIMIT_MS`. The result
 *              is a score; a top-out ends the run early with whatever it had.
 * `versus`   — endless, like Marathon, but with the garbage rules switched on:
 *              clears send rows at somebody else's well, and rows arrive from
 *              theirs. The finish line is the *other* well topping out, which
 *              is a thing this snapshot cannot see — so it is the caller that
 *              pairs two games and calls `winMatch` on the survivor.
 *
 * Gravity, scoring and levels are deliberately identical across all four: a
 * mode is a finish line drawn on the same game, not a different game.
 */
export type GameMode = 'marathon' | 'sprint' | 'ultra' | 'versus';

/** Every mode, in the order the start screen offers them. */
export const GAME_MODES: readonly GameMode[] = ['marathon', 'sprint', 'ultra', 'versus'];

/**
 * What a mode asks of a run. Zero means "no such limit", which is what makes
 * Marathon the mode with nothing to say: both of its goals are off.
 */
export interface ModeRules {
  /** Lines that end the run when reached. 0 for no line goal. */
  readonly goalLines: number;
  /** Milliseconds of play that end the run. 0 for no clock. */
  readonly timeLimitMs: number;
  /**
   * The garbage rules are part of this mode.
   *
   * The one thing a mode changes that is not a finish line, and it is here
   * rather than at the call site for the same reason the other two are: a
   * Versus run without an attack table would be a lie, and `restart` would have
   * to remember to pass the option again.
   */
  readonly garbage: boolean;
}

export const MODE_RULES: Readonly<Record<GameMode, ModeRules>> = {
  marathon: { goalLines: 0, timeLimitMs: 0, garbage: false },
  sprint: { goalLines: SPRINT_GOAL_LINES, timeLimitMs: 0, garbage: false },
  ultra: { goalLines: 0, timeLimitMs: ULTRA_TIME_LIMIT_MS, garbage: false },
  versus: { goalLines: 0, timeLimitMs: 0, garbage: true },
};

/** Anything at all, read as a mode. Unrecognised values are Marathon. */
export function parseGameMode(value: unknown): GameMode {
  return GAME_MODES.includes(value as GameMode) ? (value as GameMode) : 'marathon';
}

/**
 * How a run finished, or `none` while it is still going.
 *
 * This is a fact the UI needs and cannot reliably reconstruct: "40 lines and
 * the game is over" could be a finished Sprint or a Marathon that topped out on
 * its fortieth line, and the two deserve completely different sentences — and,
 * in Sprint's case, completely different treatment by the record book.
 *
 * `toppedOut`    — the well overflowed: a piece had nowhere to spawn, or rising
 *                  garbage pushed the stack (or the falling piece) out of the
 *                  top of it. In Sprint this is a DNF.
 * `goalReached`  — the mode's line goal was met. Sprint only.
 * `timeUp`       — the mode's clock ran out. Ultra only.
 * `won`          — the *other* well topped out first. Versus only, and the one
 *                  outcome a snapshot cannot reach on its own: this well is
 *                  perfectly healthy, and the news arrives from outside through
 *                  `winMatch`.
 */
export type RunOutcome = 'none' | 'toppedOut' | 'goalReached' | 'timeUp' | 'won';

/** A finished run's outcome: everything but `none`. */
export type FinishedOutcome = Exclude<RunOutcome, 'none'>;

/**
 * The last thing that successfully happened to the falling piece.
 *
 * This exists for exactly one reason: a spin is "the piece turned, and then
 * locked without moving again", and that is a fact about *history*, not about
 * the board. It lives in `GameState` rather than in a module-level variable or
 * a closure so that a snapshot still replays identically — a hidden mutable
 * "did we just rotate?" flag would make the engine impure and silently break
 * every replay that started from a mid-game snapshot.
 *
 * `none`       — nothing has touched this piece yet: it just spawned, or came
 *                out of the hold slot.
 * `move`       — a sideways move landed.
 * `drop`       — the piece went down: gravity, a soft drop, or a hard drop
 *                that actually fell. A hard drop of zero rows moves nothing
 *                and so leaves the previous action standing, which is what
 *                lets a player turn a piece into its slot and slam to confirm.
 * `rotate`     — a rotation that turned in place, with no kick.
 * `kickRotate` — a rotation that only fitted after a wall kick.
 */
export type ActionKind = 'none' | 'move' | 'drop' | 'rotate' | 'kickRotate';

/**
 * How a piece got where it locked.
 *
 * `none` — not a spin. `full` — it turned in place and was boxed in.
 * `kick` — same, but the rotation needed a wall kick to fit.
 */
export type SpinKind = 'none' | 'full' | 'kick';

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
   * A piece locked as a spin: it turned into place and could not then move
   * left, right or down. Fires for every spin, whether or not it cleared
   * anything, so the UI has one signal for "that was a clever placement".
   *
   * `cleared` is how many rows it completed — zero for a spin that only set
   * something up — and `points` is the *flat* spin bonus, which is only
   * non-zero when `cleared` is zero. A spin that cleared rows is scored, and
   * described, by the `rowsCleared` event that follows.
   */
  | {
      readonly type: 'spin';
      readonly kind: PieceKind;
      readonly spin: 'full' | 'kick';
      readonly cells: readonly Point[];
      readonly cleared: number;
      readonly points: number;
    }
  /**
   * Rows came out of the board. `rows` are the board row indices as they were
   * *before* the collapse, top to bottom. `quad` marks the four-line clear,
   * `spin` says whether the piece turned into its slot, `combo` is how many
   * consecutive locks have now cleared something (1 for the first),
   * `backToBack` marks a clear that took the back-to-back bonus, and
   * `backToBackChain` is how many difficult clears the current chain is up to.
   */
  | {
      readonly type: 'rowsCleared';
      readonly kind: PieceKind;
      readonly rows: readonly number[];
      readonly count: number;
      readonly quad: boolean;
      readonly spin: SpinKind;
      readonly combo: number;
      readonly backToBack: boolean;
      readonly backToBackChain: number;
      readonly points: number;
    }
  /**
   * A clear threw garbage at the other player.
   *
   * `lines` is what the attack table made of it, `cancelled` is how much of
   * that went into eating this player's own queue, and `sent` is what is left
   * for the opponent. Only ever fires in a run with garbage switched on.
   */
  | {
      readonly type: 'attack';
      readonly kind: PieceKind;
      readonly lines: number;
      readonly cancelled: number;
      readonly sent: number;
    }
  /**
   * Garbage was cancelled by an outgoing attack before it could land.
   * `remaining` is how many rows are still queued afterwards.
   */
  | { readonly type: 'garbageCancelled'; readonly rows: number; readonly remaining: number }
  /** Garbage joined the queue and started counting down. */
  | {
      readonly type: 'garbageQueued';
      readonly id: number;
      readonly rows: number;
      readonly holeColumn: number;
      readonly delayMs: number;
      readonly pending: number;
    }
  /**
   * Garbage rose: `rows` solid rows with a hole at `holeColumn` were pushed in
   * at the bottom and everything above them moved up. `nudged` is how far the
   * falling piece had to be lifted to stay legal.
   */
  | {
      readonly type: 'garbageRose';
      readonly id: number;
      readonly rows: number;
      readonly holeColumn: number;
      readonly nudged: number;
      readonly pending: number;
    }
  /** The level went up. */
  | { readonly type: 'levelUp'; readonly level: number; readonly previousLevel: number }
  /** The player swapped pieces: `held` went into the slot, `active` came out. */
  | { readonly type: 'hold'; readonly held: PieceKind; readonly active: PieceKind }
  /**
   * The run ended, with everything any mode needs to describe it: which mode it
   * was, *how* it ended, and the four numbers. `durationMs` is the run's clock
   * at the moment it stopped, which is Sprint's whole result and the only one
   * of the four that the snapshot's `score`/`lines`/`level` do not cover.
   */
  | {
      readonly type: 'runEnd';
      readonly mode: GameMode;
      readonly outcome: FinishedOutcome;
      readonly score: number;
      readonly lines: number;
      readonly level: number;
      readonly durationMs: number;
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
  /**
   * The last thing that happened to the falling piece. Part of the snapshot on
   * purpose — see `ActionKind`.
   */
  readonly lastAction: ActionKind;
  /**
   * Consecutive locks that each cleared at least one row, **this one
   * included**: 0 between chains, 1 on the first clear, 2 on the second. The
   * bonus is therefore `COMBO_POINTS * (combo - 1) * level`, which is zero for
   * the first clear and starts paying from the second. A lock that clears
   * nothing puts it back to 0; a hold, a pause or a resize do not touch it.
   */
  readonly combo: number;
  /**
   * A difficult clear — a quad or a spin clear — is standing, so the next
   * difficult clear takes the back-to-back bonus. Only a *clearing* lock can
   * change this: a lock that clears nothing leaves the chain alone.
   */
  readonly backToBack: boolean;
  /** How many difficult clears the current back-to-back chain is up to; 0 when
   *  there is no chain. */
  readonly backToBackChain: number;
  /**
   * Total time advanced while playing. The UI clock, and — in Ultra — the
   * thing the deadline is measured against, which is why `update` consumes
   * time in slices that stop *on* the limit rather than stepping over it.
   */
  readonly elapsedMs: number;
  /** What happened during the call that produced this snapshot. */
  readonly events: readonly GameEvent[];
  /** The seed this run was created with; `restart` reuses it. */
  readonly seed: number;
  /** The level this run started on. */
  readonly startLevel: number;
  /** Which mode is being played. `restart` keeps it; changing it is a
   *  `createGame` call. */
  readonly mode: GameMode;
  /** Lines that end the run when reached, or 0 when the mode has no goal. */
  readonly goalLines: number;
  /** Milliseconds that end the run when reached, or 0 when there is no clock. */
  readonly timeLimitMs: number;
  /** How the run finished, or `none` while it is still going. */
  readonly outcome: RunOutcome;
  /**
   * Versus rules are switched on for this run.
   *
   * Off unless `createGame` was given a `garbage` option, and everything about
   * garbage hangs off it: `receiveGarbage` is a no-op, no garbage event is ever
   * emitted, and the queue stays empty. A marathon, sprint or ultra run is
   * therefore exactly the run it was before any of this existed.
   */
  readonly garbageEnabled: boolean;
  /** How long an incoming batch waits before it rises. */
  readonly garbageDelayMs: number;
  /** Incoming attacks waiting to rise, in arrival order. */
  readonly garbageQueue: readonly GarbageBatch[];
  /**
   * The generator the hole columns are drawn from. Separate from the bag on
   * purpose — see `GARBAGE_SEED_SALT` — so taking a hit cannot change which
   * pieces the run deals.
   */
  readonly garbageRandom: number;
  /** The id the next batch will take. Part of the snapshot, so replays match. */
  readonly nextGarbageId: number;
  /** Rows of attack this run has sent to the other player, cancellation aside. */
  readonly garbageSent: number;
  /** Rows of garbage that have actually risen in this well. */
  readonly garbageReceived: number;
  /** Rows of incoming garbage this run's own clears have cancelled. */
  readonly garbageCancelled: number;
}

/**
 * Versus rules. Passing this object at all is what turns garbage on; there is
 * no `enabled: false`, because a run that does not want garbage simply does not
 * ask for it.
 */
export interface GarbageOptions {
  /** Milliseconds a batch waits in the queue. Defaults to `GARBAGE_DELAY_MS`. */
  readonly delayMs?: number;
}

export interface GameOptions {
  readonly seed?: number;
  readonly startLevel?: number;
  /** Which mode to play. Defaults to `marathon`. */
  readonly mode?: GameMode;
  /**
   * Versus rules. Omitted means the mode decides — which is garbage off in
   * every mode but `versus`. Passing it turns the rules on whatever the mode
   * says, and is how a test (or a tuned match) changes the queue delay.
   */
  readonly garbage?: GarbageOptions;
}

const NO_EVENTS: readonly GameEvent[] = Object.freeze([]);
const NO_GARBAGE: readonly GarbageBatch[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function withEvents(state: GameState, events: readonly GameEvent[]): GameState {
  if (events.length === 0 && state.events.length === 0) {
    return state;
  }
  return { ...state, events: events.length === 0 ? NO_EVENTS : events };
}

/** Which of the two spin tables a spin of this kind is paid from. */
export function spinTable(spin: Exclude<SpinKind, 'none'>): Readonly<Record<number, number>> {
  return spin === 'full' ? SPIN_POINTS : KICKED_SPIN_POINTS;
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

/**
 * Was this lock a spin?
 *
 * Two conditions, and deliberately no piece-specific ones: the last thing that
 * moved the piece was a rotation, and from where it now sits it cannot go
 * left, right or down. That is the generic shape of "it was turned into a hole
 * it could not have been slid into", and it is true of an S wedged under an
 * overhang exactly as it is of a T in a notch. Special-casing T would be both
 * more code and a worse rule.
 *
 * Checked against the board as it stands *before* the piece is committed, so
 * the piece is not colliding with its own cells.
 */
export function spinKind(board: Board, piece: ActivePiece, lastAction: ActionKind): SpinKind {
  if (lastAction !== 'rotate' && lastAction !== 'kickRotate') {
    return 'none';
  }
  const boxedIn = !fits(board, piece, -1, 0) && !fits(board, piece, 1, 0) && !fits(board, piece, 0, 1);
  if (!boxedIn) {
    return 'none';
  }
  return lastAction === 'rotate' ? 'full' : 'kick';
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

/**
 * End the run, recording *how* it ended and the numbers it ended on.
 *
 * The one exit from a live game, whichever mode is being played and whichever
 * of the three things stopped it — so there is exactly one place that decides
 * what a finished snapshot looks like, and exactly one event to listen for.
 */
function endRun(state: GameState, outcome: FinishedOutcome, events: GameEvent[]): GameState {
  events.push({
    type: 'runEnd',
    mode: state.mode,
    outcome,
    score: state.score,
    lines: state.lines,
    level: state.level,
    durationMs: state.elapsedMs,
  });
  return {
    ...state,
    active: null,
    status: 'over',
    outcome,
    clearDelayMs: 0,
    lockMs: 0,
    gravityMs: 0,
  };
}

/** Has this mode's line goal been met? False for a mode that has no goal. */
function goalReached(state: GameState): boolean {
  return state.goalLines > 0 && state.lines >= state.goalLines;
}

/** Has this mode's clock run out? False for a mode that has no clock. */
function timeExpired(state: GameState): boolean {
  return state.timeLimitMs > 0 && state.elapsedMs >= state.timeLimitMs;
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
    // A fresh piece has no history, so it cannot be a spin until it is turned.
    lastAction: 'none',
    clearDelayMs: 0,
  };

  const piece = spawnedPiece(kind, queued.board);
  if (!isValidPosition(queued.board, piece)) {
    return endRun(queued, 'toppedOut', events);
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

  // Ask before committing: `spinKind` needs the board without the piece in it.
  const spin = spinKind(state.board, piece, state.lastAction);

  let board = lockPiece(state.board, piece);
  const cells = pieceCells(piece);
  events.push({ type: 'lock', kind: piece.kind, cells });

  let { score, lines, backToBack, backToBackChain } = state;
  let clearDelayMs = 0;
  let garbageQueue = state.garbageQueue;
  let garbageSent = state.garbageSent;
  let garbageCancelledTotal = state.garbageCancelled;

  const rows = findFullRows(board);
  const count = rows.length;
  // The chain of clearing locks: one longer when this lock cleared, back to
  // nothing when it did not.
  const combo = count > 0 ? state.combo + 1 : 0;

  if (spin !== 'none') {
    // The flat bonus is for a spin that set something up rather than cashing
    // it in; a spin that cleared rows is paid for by the clear itself.
    const points = count > 0 ? 0 : (spinTable(spin)[0] ?? 0) * state.level;
    score += points;
    events.push({ type: 'spin', kind: piece.kind, spin, cells, cleared: count, points });
  }

  if (count > 0) {
    board = clearRows(board, rows).board;
    const quad = count === 4;
    // A quad or a spin clear is "difficult": it keeps a back-to-back chain
    // alive, and takes the bonus if one was already standing. Anything else
    // breaks it.
    const difficult = quad || spin !== 'none';
    const bonus = difficult && backToBack;

    const table = spin === 'none' ? LINE_CLEAR_POINTS : spinTable(spin);
    const base = (table[count] ?? 0) * state.level;
    // Rounded down, so the score stays a whole number of points.
    const clearPoints = bonus ? Math.floor(base * BACK_TO_BACK_MULTIPLIER) : base;
    const comboPoints = COMBO_POINTS * Math.max(0, combo - 1) * state.level;
    const points = clearPoints + comboPoints;

    score += points;
    lines += count;
    backToBackChain = difficult ? backToBackChain + 1 : 0;
    backToBack = difficult;

    events.push({
      type: 'rowsCleared',
      kind: piece.kind,
      rows,
      count,
      quad,
      spin,
      combo,
      backToBack: bonus,
      backToBackChain,
      points,
    });
    clearDelayMs = LINE_CLEAR_DELAY_MS;

    // Versus, and only versus: the same signals the clear was scored from tell
    // the attack table how much garbage it throws. Cancellation comes first —
    // what is queued against this player is eaten before anything crosses over,
    // which is the mechanic the whole mode is built on.
    if (state.garbageEnabled) {
      const attack = attackLines({ count, spin, combo, backToBack: bonus });
      const eaten = cancelGarbage(garbageQueue, attack);
      garbageQueue = eaten.queue;
      garbageCancelledTotal += eaten.cancelled;
      const sent = attack - eaten.cancelled;
      garbageSent += sent;
      if (eaten.cancelled > 0) {
        events.push({
          type: 'garbageCancelled',
          rows: eaten.cancelled,
          remaining: pendingGarbage(garbageQueue),
        });
      }
      if (attack > 0) {
        events.push({ type: 'attack', kind: piece.kind, lines: attack, cancelled: eaten.cancelled, sent });
      }
    }
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
    combo,
    backToBack,
    backToBackChain,
    // Hold becomes available again as soon as a piece commits.
    holdLocked: false,
    gravityMs: 0,
    lockMs: 0,
    lockResets: 0,
    lastAction: 'none',
    clearDelayMs,
    garbageQueue,
    garbageSent,
    garbageCancelled: garbageCancelledTotal,
  };

  // The finish line is checked *here*, on the clear that crossed it, rather
  // than on the next frame: a Sprint ends on the run's fortieth line, and the
  // clock it is judged by is the clock as it stood at that moment.
  if (goalReached(locked)) {
    return endRun(locked, 'goalReached', events);
  }

  return clearDelayMs > 0 ? locked : spawnNext(locked, events);
}

/**
 * Spend `ms` of the run clock.
 *
 * One place, so that every timer the run owns moves together: the clock the
 * mode's deadline is measured against, and every queued batch of garbage. The
 * per-branch timers in `update` (gravity, lock delay, the clear pause) stay
 * where they are, because each of those belongs to exactly one branch.
 */
function spendTime(state: GameState, ms: number): GameState {
  if (!(ms > 0)) {
    return state;
  }
  return {
    ...state,
    elapsedMs: state.elapsedMs + ms,
    garbageQueue: tickGarbage(state.garbageQueue, ms),
  };
}

/**
 * Rise any batch whose delay has run out, oldest first.
 *
 * Called at the top of every slice of `update`, so a batch never sits at zero
 * across a frame boundary, and once more after the loop for the delta that
 * lands exactly on a deadline with nothing left to spend.
 */
function landDueGarbage(state: GameState, events: GameEvent[]): GameState {
  if (state.garbageQueue.length === 0) {
    return state;
  }

  let current = state;
  for (;;) {
    const batch = current.garbageQueue.find((queued) => queued.delayMs <= 0);
    if (batch === undefined) {
      return current;
    }

    const risen = riseGarbage(current.board, current.active, batch.rows, batch.holeColumn);
    const queue = current.garbageQueue.filter((queued) => queued !== batch);
    current = {
      ...current,
      board: risen.board,
      active: risen.active,
      garbageQueue: queue,
      garbageReceived: current.garbageReceived + batch.rows,
      // A piece that had to be lifted has moved, so its lock delay starts
      // again; a piece the rise did not touch keeps the one it was counting.
      lockMs: risen.nudged > 0 ? 0 : current.lockMs,
    };
    events.push({
      type: 'garbageRose',
      id: batch.id,
      rows: batch.rows,
      holeColumn: batch.holeColumn,
      nudged: risen.nudged,
      pending: pendingGarbage(queue),
    });

    if (risen.toppedOut) {
      return endRun(current, 'toppedOut', events);
    }
  }
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
  const mode = parseGameMode(options.mode ?? 'marathon');
  const rules = MODE_RULES[mode];
  const opening = drawPieces(createBagState(seed), NEXT_QUEUE_SIZE);
  const garbage = options.garbage;

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
    lastAction: 'none',
    combo: 0,
    backToBack: false,
    backToBackChain: 0,
    elapsedMs: 0,
    events: NO_EVENTS,
    seed,
    startLevel,
    mode,
    goalLines: rules.goalLines,
    timeLimitMs: rules.timeLimitMs,
    outcome: 'none',
    // The mode turns the rules on; the option only tunes them. A Versus game
    // therefore has an attack table whoever created it, and `restart` keeps it.
    garbageEnabled: garbage !== undefined || rules.garbage,
    garbageDelayMs: Math.max(0, Math.floor(garbage?.delayMs ?? GARBAGE_DELAY_MS)),
    garbageQueue: NO_GARBAGE,
    garbageRandom: createGarbageRandom(seed),
    nextGarbageId: 1,
    garbageSent: 0,
    garbageReceived: 0,
    garbageCancelled: 0,
  };

  // Creating a game is not an update, so it reports no events.
  return withEvents(spawnNext(empty, []), NO_EVENTS);
}

/**
 * Advance the clock by `deltaMs`.
 *
 * Time is consumed in slices that stop at the next deadline — the next gravity
 * step, the end of the lock delay, the end of a line-clear pause, and in a
 * timed mode the end of the run itself — so a single large delta produces
 * exactly the same sequence of events as the many small frames it stands in
 * for. That last deadline is why a 100 ms frame ends an Ultra run at exactly
 * 120000 ms and not at 120100: the slice stops on the limit, the run ends
 * there, and the 100 ms that would have overrun it is simply never spent.
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

    if (timeExpired(current)) {
      current = endRun(current, 'timeUp', events);
      break;
    }

    // Garbage whose delay has run out rises before any more time is spent, so
    // the rest of this slice sees the well it is actually going to act on.
    current = landDueGarbage(current, events);
    if (current.status !== 'playing') {
      break;
    }

    // How much of `remaining` the run's own deadlines will even allow: the
    // mode's clock, and the soonest batch of garbage. Both are infinite when
    // absent, which is what keeps Marathon's arithmetic untouched.
    const untilTimeLimit =
      current.timeLimitMs > 0 ? current.timeLimitMs - current.elapsedMs : Number.POSITIVE_INFINITY;
    const untilDeadline = Math.min(untilTimeLimit, garbageDeadlineMs(current.garbageQueue));

    const piece = current.active;

    if (piece === null) {
      // Between pieces: run down the line-clear pause, then spawn.
      const consumed = Math.min(remaining, Math.max(0, current.clearDelayMs), untilDeadline);
      remaining -= consumed;
      current = { ...spendTime(current, consumed), clearDelayMs: current.clearDelayMs - consumed };
      if (current.clearDelayMs <= 0 && !timeExpired(current)) {
        current = spawnNext(current, events);
      }
      continue;
    }

    if (!isResting(current.board, piece)) {
      // Falling: accumulate toward the next gravity step.
      const interval = gravityIntervalMs(current.level);
      const consumed = Math.min(
        remaining,
        Math.max(0, interval - current.gravityMs),
        untilDeadline,
      );
      remaining -= consumed;
      const gravityMs = current.gravityMs + consumed;
      current = { ...spendTime(current, consumed), gravityMs };
      if (gravityMs >= interval) {
        current = {
          ...current,
          gravityMs: gravityMs - interval,
          active: { ...piece, y: piece.y + 1 },
          // Gravity counts: a piece that was turned and then fell a row was not
          // spun into where it ends up.
          lastAction: 'drop',
          lockMs: 0,
        };
      }
      continue;
    }

    // Resting: run down the lock delay, then commit the piece.
    const consumed = Math.min(remaining, Math.max(0, LOCK_DELAY_MS - current.lockMs), untilDeadline);
    remaining -= consumed;
    const lockMs = current.lockMs + consumed;
    current = { ...spendTime(current, consumed), lockMs };
    if (lockMs >= LOCK_DELAY_MS) {
      current = lockActive(current, events);
    }
  }

  // The delta may have landed exactly on a deadline with nothing left to spend,
  // in which case the loop exited without noticing. Both deadlines have still
  // arrived.
  if (current.status === 'playing') {
    current = landDueGarbage(current, events);
  }
  if (current.status === 'playing' && timeExpired(current)) {
    current = endRun(current, 'timeUp', events);
  }

  return withEvents(current, events);
}

/** Shift the active piece sideways, refreshing the lock delay if it lands. */
function move(state: GameState, dx: number): GameState {
  const piece = state.active;
  if (piece === null || !fits(state.board, piece, dx, 0)) {
    return withEvents(state, NO_EVENTS);
  }
  const moved: GameState = {
    ...state,
    active: { ...piece, x: piece.x + dx },
    lastAction: 'move',
  };
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
      // A kick of (0, 0) is the piece turning where it stands; anything else
      // had to be shoved to fit, and a spin off it is worth less.
      const lastAction: ActionKind = kick.x === 0 && kick.y === 0 ? 'rotate' : 'kickRotate';
      return withEvents(refreshLock({ ...state, active: candidate, lastAction }), NO_EVENTS);
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
      lastAction: 'drop',
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
    // A slam that falls no rows has not moved the piece, so it leaves the
    // rotation that put it there standing as the last action — which is what
    // lets a player turn into a slot and hard drop to confirm the spin.
    lastAction: distance > 0 ? 'drop' : state.lastAction,
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
    // The piece coming out of the slot is a fresh one; it has not been turned.
    // (`combo` and the back-to-back chain are untouched — a hold is not a lock,
    // so it neither builds nor breaks either of them.)
    lastAction: 'none',
  };

  if (!isValidPosition(held.board, fresh)) {
    return withEvents(endRun(held, 'toppedOut', events), events);
  }
  return withEvents({ ...held, active: fresh }, events);
}

/**
 * Take `rows` of garbage from the other player.
 *
 * The rows do not land here: they join the queue with the run's own delay on
 * them, and `update` rises them when it runs out. Splitting, hole columns and
 * the queue cap are `garbage.ts`'s business.
 *
 * A no-op in a run that did not ask for garbage — which is every solo run —
 * and a no-op once the run is over. That is the guarantee behind "marathon
 * behaves exactly as it did": there is no path from this function into a state
 * whose `garbageEnabled` is false.
 */
export function receiveGarbage(state: GameState, rows: number): GameState {
  if (!state.garbageEnabled || state.status === 'over' || !(rows > 0)) {
    return withEvents(state, NO_EVENTS);
  }

  const queued = queueGarbage({
    queue: state.garbageQueue,
    rows,
    delayMs: state.garbageDelayMs,
    width: state.board.width,
    random: state.garbageRandom,
    nextId: state.nextGarbageId,
  });

  const pending = pendingGarbage(queued.queue);
  const events: GameEvent[] = queued.added.map((batch) => ({
    type: 'garbageQueued',
    id: batch.id,
    rows: batch.rows,
    holeColumn: batch.holeColumn,
    delayMs: batch.delayMs,
    pending,
  }));

  return withEvents(
    {
      ...state,
      garbageQueue: queued.queue,
      garbageRandom: queued.random,
      nextGarbageId: queued.nextId,
    },
    events,
  );
}

/**
 * End this run because the *other* well topped out.
 *
 * The one thing that finishes a Versus game without anything happening in it,
 * and therefore the one exit `update` can never take: this well is fine, and
 * losing is something that happened somewhere else. The caller that owns the
 * pair is the only thing that can see both, so it is the caller that calls this
 * — and it goes through `endRun` like every other ending, so a won match emits
 * the same `runEnd` event with the same four numbers on it.
 *
 * Gated on `garbageEnabled`, exactly as `receiveGarbage` is: there is no path
 * from here into a solo run, so no Marathon can end with `won`.
 */
export function winMatch(state: GameState): GameState {
  if (!state.garbageEnabled || state.status === 'over' || state.status === 'ready') {
    return withEvents(state, NO_EVENTS);
  }
  const events: GameEvent[] = [];
  return withEvents(endRun(state, 'won', events), events);
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
      // Same seed, same starting level, same mode, same versus rules — a rerun,
      // not a different game. A UI that wants a different sequence, or a
      // different mode, calls `createGame`.
      return {
        ...createGame({
          seed: state.seed,
          startLevel: state.startLevel,
          mode: state.mode,
          garbage: state.garbageEnabled ? { delayMs: state.garbageDelayMs } : undefined,
        }),
        status: 'playing',
      };

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
