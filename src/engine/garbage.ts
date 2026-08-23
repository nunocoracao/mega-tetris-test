/**
 * Garbage: the rows the other player sends you.
 *
 * A garbage row is a solid row with one column left open, pushed in at the
 * bottom of the well so that everything already there rises by a row. It is not
 * a piece and never was one, so its cells are `GARBAGE_CELL` rather than a
 * `PieceKind` — see `types.ts`.
 *
 * Everything here is plain data and pure functions. The queue lives in
 * `GameState` (a closure would be invisible to a replay), its delay is counted
 * down in slices bounded by its own deadline the way gravity and the lock delay
 * already are, and the hole columns come from a seeded generator carried in the
 * snapshot. A versus run is therefore exactly as reproducible as a solo one.
 *
 * ## The three decisions worth writing down
 *
 * **One hole per batch, shared by every row in it.** Four rows arriving from a
 * quad give you a four-deep column to dig out, not four holes scattered across
 * the well. This is what real games do and it is the whole reason a big attack
 * is dangerous rather than merely tall: a shared hole is a shaft you can drop an
 * I into and undo the damage, while four random holes are four separate
 * problems and no way back. Separate batches each draw their own column and
 * are free to draw the same one twice — the rule is "one batch, one hole", not
 * "never repeat".
 *
 * **The queue has a delay, and the delay is the game.** Garbage does not land
 * the instant it is sent; it sits in `GameState.garbageQueue` counting down for
 * `GARBAGE_DELAY_MS`, visible, while you decide what to do about it. Which
 * brings us to:
 *
 * **Outgoing attack cancels incoming garbage before any of it lands.** A clear
 * of your own eats what is queued against you, soonest batch first, and only
 * the remainder crosses to the other side. Without cancellation versus is two
 * people playing solitaire next to each other; with it, every clear is an
 * answer to the last one.
 */

import { isValidPosition, pieceCells, pushRowsUp, type Board } from './board';
import { randomStep } from './random';
import { GARBAGE_CELL, type ActivePiece, type Cell } from './types';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * How long a batch of garbage sits in the queue before it rises.
 *
 * Long enough to read the warning and answer it with a clear of your own —
 * about a piece and a half at level 1 — and short enough that ignoring it is
 * never the cheap option.
 */
export const GARBAGE_DELAY_MS = 900;

/**
 * The most rows one batch may carry. A batch bigger than this is split, so a
 * monstrous combo arrives as several batches with several holes rather than as
 * one unplayable slab.
 */
export const MAX_GARBAGE_BATCH_ROWS = 4;

/**
 * The most batches the queue may hold. A player being buried faster than they
 * can be killed is a runaway loop, not a game; past this the queue stops
 * growing and the overflow is simply dropped.
 */
export const MAX_GARBAGE_QUEUE = 16;

/**
 * What the garbage generator's seed is mixed with.
 *
 * The hole columns must not be drawn from the same stream as the pieces: if
 * they were, taking a hit would shuffle the bag and two runs that played
 * identically up to the first attack would deal different pieces afterwards.
 * A separate generator, salted off the run seed, keeps the piece stream a
 * function of the seed alone — and keeps a solo run bit-for-bit unchanged by
 * the mere existence of this file. The constant is the golden-ratio word every
 * hash mixer uses; nothing about it is magic beyond "not zero, and not a
 * neighbour of a plausible seed".
 */
export const GARBAGE_SEED_SALT = 0x9e3779b9;

/** The garbage generator a run with this seed starts from. */
export function createGarbageRandom(seed: number): number {
  return ((seed >>> 0) ^ GARBAGE_SEED_SALT) >>> 0;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * One incoming attack, waiting.
 *
 * `rows` shrinks when a clear of yours cancels part of it, and the batch
 * disappears when it reaches zero. `delayMs` counts down in `update`; every
 * batch counts down at once, so a queue is ordered by arrival and by
 * imminence at the same time.
 */
export interface GarbageBatch {
  /** How many rows this batch will push up. Always at least 1 while queued. */
  readonly rows: number;
  /** The column left open in every one of those rows. */
  readonly holeColumn: number;
  /** Milliseconds left before it rises. */
  readonly delayMs: number;
  /** Identity, so the UI can follow one batch across frames. */
  readonly id: number;
}

/** Total rows waiting in a queue. */
export function pendingGarbage(queue: readonly GarbageBatch[]): number {
  return queue.reduce((total, batch) => total + batch.rows, 0);
}

/** The soonest deadline in a queue, or `Infinity` when there is nothing in it. */
export function garbageDeadlineMs(queue: readonly GarbageBatch[]): number {
  let soonest = Number.POSITIVE_INFINITY;
  for (const batch of queue) {
    if (batch.delayMs < soonest) {
      soonest = batch.delayMs;
    }
  }
  return soonest;
}

/**
 * Draw the hole column for a batch.
 *
 * One step of the snapshot's own garbage generator, so the column is a function
 * of the seed and of how many batches have been drawn before it — never of the
 * wall clock, and never of `Math.random`.
 */
export function nextHoleColumn(random: number, width: number): { random: number; column: number } {
  const stepped = randomStep(random);
  const columns = Math.max(1, Math.floor(width));
  return { random: stepped.state, column: Math.min(columns - 1, Math.floor(stepped.value * columns)) };
}

/**
 * Add `rows` of garbage to a queue, splitting anything over
 * `MAX_GARBAGE_BATCH_ROWS` into separate batches with separate holes.
 *
 * Returns the new queue, the advanced generator, the next free id, and the
 * batches that were actually added (which the caller turns into events). Rows
 * that would take the queue past `MAX_GARBAGE_QUEUE` are dropped.
 */
export function queueGarbage(options: {
  readonly queue: readonly GarbageBatch[];
  readonly rows: number;
  readonly delayMs: number;
  readonly width: number;
  readonly random: number;
  readonly nextId: number;
}): {
  queue: readonly GarbageBatch[];
  random: number;
  nextId: number;
  added: readonly GarbageBatch[];
} {
  const wanted = Math.max(0, Math.floor(options.rows));
  const queue = [...options.queue];
  const added: GarbageBatch[] = [];
  let random = options.random;
  let nextId = options.nextId;
  let left = wanted;

  while (left > 0 && queue.length < MAX_GARBAGE_QUEUE) {
    const rows = Math.min(left, MAX_GARBAGE_BATCH_ROWS);
    const drawn = nextHoleColumn(random, options.width);
    random = drawn.random;
    const batch: GarbageBatch = {
      rows,
      holeColumn: drawn.column,
      delayMs: Math.max(0, options.delayMs),
      id: nextId,
    };
    nextId += 1;
    queue.push(batch);
    added.push(batch);
    left -= rows;
  }

  return { queue, random, nextId, added };
}

/**
 * Spend `lines` of outgoing attack against a queue, soonest batch first.
 *
 * Soonest-first is the forgiving order and the one that makes cancelling feel
 * like an answer: the clear you just made deals with the thing that was about
 * to happen to you, not with something two batches away. Returns the reduced
 * queue and how many lines were actually eaten; the rest is the caller's to
 * send on.
 */
export function cancelGarbage(
  queue: readonly GarbageBatch[],
  lines: number,
): { queue: readonly GarbageBatch[]; cancelled: number } {
  let left = Math.max(0, Math.floor(lines));
  if (left === 0 || queue.length === 0) {
    return { queue, cancelled: 0 };
  }

  const next: GarbageBatch[] = [];
  let cancelled = 0;
  for (const batch of queue) {
    if (left <= 0) {
      next.push(batch);
      continue;
    }
    const eaten = Math.min(left, batch.rows);
    left -= eaten;
    cancelled += eaten;
    if (eaten < batch.rows) {
      next.push({ ...batch, rows: batch.rows - eaten });
    }
  }

  return { queue: next, cancelled };
}

/**
 * Run every batch's clock down by `deltaMs`. Batches reaching zero are left in
 * the queue at zero rather than removed — landing them is a separate step, so
 * that the caller can decide *when* in a frame the well rises.
 */
export function tickGarbage(queue: readonly GarbageBatch[], deltaMs: number): readonly GarbageBatch[] {
  if (queue.length === 0 || !(deltaMs > 0)) {
    return queue;
  }
  return queue.map((batch) =>
    batch.delayMs <= 0 ? batch : { ...batch, delayMs: Math.max(0, batch.delayMs - deltaMs) },
  );
}

// ---------------------------------------------------------------------------
// Rising
// ---------------------------------------------------------------------------

/** The cells of one garbage row: solid, with `holeColumn` left open. */
export function garbageRow(width: number, holeColumn: number): readonly Cell[] {
  return Array.from({ length: width }, (_, x) => (x === holeColumn ? null : GARBAGE_CELL));
}

/** The topmost board row any of a piece's cells occupies. */
function topCellRow(piece: ActivePiece): number {
  let top = Number.POSITIVE_INFINITY;
  for (const { y } of pieceCells(piece)) {
    if (y < top) {
      top = y;
    }
  }
  return top;
}

/** What a rise did to the well. */
export interface RiseResult {
  readonly board: Board;
  /** Where the falling piece ended up, nudged out of the way if it had to be. */
  readonly active: ActivePiece | null;
  /**
   * The rise pushed something out of the top of the well: either a row with
   * blocks in it, or the falling piece, which had nowhere left to go. The run
   * is over.
   */
  readonly toppedOut: boolean;
  /** How far the falling piece had to be lifted. Zero most of the time. */
  readonly nudged: number;
}

/**
 * Push `rows` garbage rows in under everything.
 *
 * The falling piece is lifted by as little as it takes to stay legal — usually
 * nothing at all, because the rise happens below it. Two things end the run
 * here, and they are the same thing said twice: a rise may not push blocks out
 * of the top of the well, and it may not push the falling piece any further out
 * of it than it already was. A piece resting against the ceiling therefore dies
 * to a single row, which is exactly the pressure garbage is supposed to apply.
 */
export function riseGarbage(
  board: Board,
  active: ActivePiece | null,
  rows: number,
  holeColumn: number,
): RiseResult {
  const count = Math.max(0, Math.floor(rows));
  if (count === 0) {
    return { board, active, toppedOut: false, nudged: 0 };
  }

  const row = garbageRow(board.width, holeColumn);
  const pushed = pushRowsUp(board, Array.from({ length: count }, () => row));
  const lostBlocks = pushed.overflow.some((lost) => lost.some((cell) => cell != null));

  if (active === null) {
    return { board: pushed.board, active: null, toppedOut: lostBlocks, nudged: 0 };
  }

  // The piece may not end up higher than it already was, and — if it was inside
  // the well to begin with — may not leave it at all.
  const ceiling = Math.min(0, topCellRow(active));
  for (let up = 0; up <= count; up += 1) {
    const candidate: ActivePiece = { ...active, y: active.y - up };
    if (topCellRow(candidate) < ceiling) {
      break;
    }
    if (isValidPosition(pushed.board, candidate)) {
      return { board: pushed.board, active: candidate, toppedOut: lostBlocks, nudged: up };
    }
  }

  return { board: pushed.board, active, toppedOut: true, nudged: 0 };
}
