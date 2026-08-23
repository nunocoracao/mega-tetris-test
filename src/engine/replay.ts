/**
 * Replays — the determinism, cashed in.
 *
 * The README has claimed from the first week that the game is a pure function
 * of `(seed, ordered list of calls)`. This is the file that spends that claim:
 * write down the calls, and the run can be rebuilt from nothing but a number
 * and a list.
 *
 * ## What a log has to contain, and what it does not
 *
 * `update(state, deltaMs)` consumes time in slices bounded by the next deadline
 * — the next gravity step, the end of the lock delay, the end of a clear pause,
 * the mode's own clock — which makes it **additive**: `update(a)` then
 * `update(b)` produces exactly the state `update(a + b)` does. So a log does
 * *not* need the sixty frame deltas a second the browser actually fed the
 * engine. It needs only the moments something else happened.
 *
 * That is the whole format: for each input, the input and the run clock it was
 * applied at, plus the clock the run finished on. Replaying is then
 *
 *     for each entry: advance to entry.t, then applyInput(entry.input)
 *     advance to log.durationMs
 *
 * and the result is the same `GameState`, field for field — board, bag, score,
 * combo, back-to-back chain and all. `replay.test.ts` asserts exactly that
 * across several seeds and several hundred inputs, which is the test this whole
 * feature exists for: if it goes red, the engine has stopped being a pure
 * function of its inputs and *that* is the bug.
 *
 * ## The format is a contract
 *
 * A replay is not a recording of pixels: it is a recording of *decisions*, and
 * it only means anything against the rules that were in force when it was made.
 * Change gravity, scoring, the bag, the kick tables or the lock delay and every
 * log ever written decodes into a different run. That is why
 * `REPLAY_FORMAT_VERSION` exists and why it must go up when engine rules move —
 * see the README and `.watchfire/memory.md`.
 */

import { applyInput, createGame, update, type GameEvent, type GameInput, type GameMode, type GameState } from './game';

/**
 * The version stamped into every recorded run, and the only one this build
 * will play back.
 *
 * **Bump this whenever a change to the engine's rules would make an existing
 * log replay differently** — gravity, scoring, the bag order, wall kicks, lock
 * delay, spawn positions, the mode rules. A log from another version is refused
 * with a clear message rather than played back into a run that never happened.
 */
export const REPLAY_FORMAT_VERSION = 1;

/**
 * The most entries one run may record.
 *
 * A log is bounded memory, not a growing tape: a cabinet left running for two
 * hours must not quietly eat the browser. Twenty thousand entries is far more
 * than any real run produces — a fast player at five inputs a second would need
 * a little over an hour of continuous play to reach it — and costs on the order
 * of a megabyte.
 *
 * When the cap is reached the recorder **stops and says so** rather than
 * dropping the oldest entries. A log with a hole in the middle is not a shorter
 * replay, it is a wrong one; a log that stops early is an honest prefix, and
 * `ReplayLog.truncated` is how the UI knows not to offer it as a shareable
 * record of the whole run.
 */
export const MAX_LOG_ENTRIES = 20_000;

/**
 * The longest run a log may claim to cover. Four hours is well past any real
 * session and keeps the work of replaying a stranger's link bounded.
 */
export const MAX_REPLAY_MS = 4 * 60 * 60 * 1000;

/**
 * The inputs a log can hold.
 *
 * Every `GameInput` except `restart` — and the omission is the point. A restart
 * throws the run away and deals a fresh one from the same seed, which is a
 * *new* run and gets a log of its own. Allowing it here would mean a log whose
 * clock runs backwards halfway through, and a "replay" that is really two.
 */
export const REPLAY_INPUTS = [
  'moveLeft',
  'moveRight',
  'softDrop',
  'hardDrop',
  'rotateCW',
  'rotateCCW',
  'hold',
  'pause',
  'resume',
] as const satisfies readonly GameInput['type'][];

export type ReplayInput = (typeof REPLAY_INPUTS)[number];

/** Is this something a log may contain? `restart` deliberately is not. */
export function isReplayInput(value: unknown): value is ReplayInput {
  return REPLAY_INPUTS.includes(value as ReplayInput);
}

/**
 * One thing the player did, and the run clock it happened on.
 *
 * `t` is `GameState.elapsedMs` as it stood *before* the input was applied —
 * absolute rather than relative, because that is the number a human reading a
 * log wants to see and the number a viewer seeking through one needs. The
 * URL codec delta-encodes it; the format in memory stays readable.
 */
export interface ReplayEntry {
  readonly t: number;
  readonly input: ReplayInput;
}

/** A whole run, as its inputs. */
export interface ReplayLog {
  /** The run clock at the end — how much play the log covers. */
  readonly durationMs: number;
  readonly entries: readonly ReplayEntry[];
  /**
   * The recorder hit `MAX_LOG_ENTRIES` and stopped. What is here is a correct
   * prefix of the run, but it is not the whole of it: do not offer it as a
   * shareable record.
   */
  readonly truncated: boolean;
}

/** Everything a run needs besides its seed. Mirrors `GameOptions` minus the seed. */
export interface ReplayOptions {
  readonly startLevel?: number;
  readonly mode?: GameMode;
}

/** An empty log — a run that recorded nothing. */
export function emptyLog(): ReplayLog {
  return { durationMs: 0, entries: [], truncated: false };
}

const NO_EVENTS: readonly GameEvent[] = Object.freeze([]);

/**
 * How much play one `update` call may be asked to swallow at a time.
 *
 * `update` is additive, so chopping the advance up changes nothing about the
 * result — but it does keep every individual call well inside the engine's own
 * `MAX_STEPS_PER_UPDATE` guard, which a single multi-minute delta at the
 * gravity floor could otherwise trip. One second is roughly twenty gravity
 * steps at the fastest the game ever gets.
 */
const ADVANCE_CHUNK_MS = 1000;

/**
 * Run the clock forward to `t`, in chunks, and stop early if it will not move.
 *
 * The clock only advances while the game is `playing`, so a paused or finished
 * run simply stays where it is — which is exactly right: a log records the run
 * clock, and a run clock that is not running is not a gap to be filled in.
 */
function advanceTo(state: GameState, t: number): GameState {
  let current = state;
  while (current.elapsedMs < t) {
    const before = current.elapsedMs;
    current = update(current, Math.min(t - current.elapsedMs, ADVANCE_CHUNK_MS));
    if (current.elapsedMs <= before) {
      // Paused, finished, or otherwise not spending time. Nothing more to do.
      break;
    }
  }
  // `events` belong to the call that produced them, and asking for time to pass
  // is a call — even when there was no time left to pass. Without this, a
  // replay whose clock is already at the target would hand back the events of
  // the *input* before it, while the live run (whose loop called `update`
  // anyway) had already cleared them. Same state, different `events`, and a
  // `toEqual` that fails for a reason that has nothing to do with the game.
  return current.events.length === 0 ? current : update(current, 0);
}

/**
 * Rebuild the final state of a recorded run.
 *
 * Pure, like everything else here: the same three arguments give the same
 * snapshot on any machine, in any browser, on any day.
 */
export function replay(seed: number, options: ReplayOptions, log: ReplayLog): GameState {
  let state = createGame({ seed, startLevel: options.startLevel, mode: options.mode });
  for (const entry of log.entries) {
    state = advanceTo(state, entry.t);
    state = applyInput(state, { type: entry.input });
  }
  return advanceTo(state, log.durationMs);
}

/**
 * A replay part-way through, as plain immutable data.
 *
 * The stepped counterpart to `replay`, for a UI that wants to *watch* the run
 * rather than know how it ended. It is driven exactly the way the live game is
 * — hand it the frame's elapsed milliseconds — so the viewer can reuse the loop
 * and the renderer without either of them learning what a replay is.
 */
export interface ReplayPlayer {
  readonly seed: number;
  readonly options: ReplayOptions;
  readonly log: ReplayLog;
  /** The run as it stands. Paint this; it is an ordinary `GameState`. */
  readonly state: GameState;
  /** Events produced by the last `advanceReplay`, oldest first. */
  readonly events: readonly GameEvent[];
  /** How many log entries have been applied. */
  readonly index: number;
  /** The playback clock, in run milliseconds. */
  readonly clockMs: number;
  /** The run clock the log ends on. */
  readonly durationMs: number;
  /** Every entry has been applied and the clock has reached the end. */
  readonly done: boolean;
}

/** A replay positioned at the very start, with nothing applied yet. */
export function startReplay(seed: number, options: ReplayOptions, log: ReplayLog): ReplayPlayer {
  return {
    seed,
    options,
    log,
    state: createGame({ seed, startLevel: options.startLevel, mode: options.mode }),
    events: NO_EVENTS,
    index: 0,
    clockMs: 0,
    durationMs: log.durationMs,
    done: log.entries.length === 0 && log.durationMs <= 0,
  };
}

/**
 * Advance a replay by `deltaMs` of *run* time.
 *
 * Everything the log says happened at or before the new clock is applied, in
 * order, and then the clock is run out to where it now stands. A pause and the
 * resume that followed it carry the same `t` — the run clock does not move
 * while a game is paused — so a pause in the original run is stepped straight
 * through rather than sat out again, which is what a viewer wants.
 *
 * Speed is the caller's business: hand it `delta * 2` for double speed. That is
 * the whole of the 2× and 4× controls.
 */
export function advanceReplay(player: ReplayPlayer, deltaMs: number): ReplayPlayer {
  if (player.done || !(deltaMs > 0)) {
    return player.events.length === 0 ? player : { ...player, events: NO_EVENTS };
  }

  const target = Math.min(player.clockMs + deltaMs, player.durationMs);
  const entries = player.log.entries;
  const events: GameEvent[] = [];
  let state = player.state;
  let index = player.index;

  const collect = (next: GameState): GameState => {
    if (next.events.length > 0) {
      events.push(...next.events);
    }
    return next;
  };

  for (;;) {
    const entry = entries[index];
    if (entry === undefined || entry.t > target) {
      break;
    }
    state = collect(advanceTo(state, entry.t));
    state = collect(applyInput(state, { type: entry.input }));
    index += 1;
  }
  state = collect(advanceTo(state, target));

  return {
    ...player,
    state,
    events: events.length === 0 ? NO_EVENTS : events,
    index,
    clockMs: target,
    done: index >= entries.length && target >= player.durationMs,
  };
}

/**
 * A replay wound back to the beginning, ready to play again. Cheap — it throws
 * the state away and rebuilds it from the seed, which is the entire point.
 */
export function restartReplay(player: ReplayPlayer): ReplayPlayer {
  return startReplay(player.seed, player.options, player.log);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * The tape.
 *
 * Deliberately an *observer*: it is handed the clock and the input by whoever
 * was about to apply them, and it hands nothing back. It cannot change what the
 * game does because there is no path from it to the engine — no wrapped
 * `update`, no adjusted delta, no callback the game waits on. `replay.test.ts`
 * proves it by playing the same script twice, once with a recorder attached and
 * once without, and comparing the two final states.
 */
export interface RunRecorder {
  /**
   * Note an input that is about to be applied to a state whose run clock reads
   * `elapsedMs`. Inputs a log may not hold (`restart`) are ignored.
   */
  record(elapsedMs: number, input: GameInput['type']): void;
  /**
   * Note where the run clock has got to, so the log covers the time after the
   * last input as well. Costs one comparison; safe to call every frame.
   */
  mark(elapsedMs: number): void;
  /** The run so far, as a fresh immutable log. */
  log(): ReplayLog;
  /** How many entries are on the tape. */
  size(): number;
  /** The cap was reached and recording stopped — see `MAX_LOG_ENTRIES`. */
  truncated(): boolean;
  /** Throw the tape away and start a new run. */
  reset(): void;
}

export interface RecorderOptions {
  /** Mostly for tests, which would rather not press twenty thousand keys. */
  readonly maxEntries?: number;
}

export function createRecorder(options: RecorderOptions = {}): RunRecorder {
  const maxEntries = Math.max(0, Math.floor(options.maxEntries ?? MAX_LOG_ENTRIES));
  let entries: ReplayEntry[] = [];
  let durationMs = 0;
  let truncated = false;

  return {
    record(elapsedMs: number, input: GameInput['type']): void {
      if (!isReplayInput(input)) {
        return;
      }
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const t = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
      entries.push({ t, input });
      if (t > durationMs) {
        durationMs = t;
      }
    },

    mark(elapsedMs: number): void {
      if (Number.isFinite(elapsedMs) && elapsedMs > durationMs) {
        durationMs = elapsedMs;
      }
    },

    log(): ReplayLog {
      return { durationMs, entries: [...entries], truncated };
    },

    size(): number {
      return entries.length;
    },

    truncated(): boolean {
      return truncated;
    },

    reset(): void {
      entries = [];
      durationMs = 0;
      truncated = false;
    },
  };
}
