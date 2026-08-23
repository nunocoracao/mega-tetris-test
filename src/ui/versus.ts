/**
 * Versus: the arrangement, not the rules.
 *
 * Task 18 built the rules — the garbage queue, the attack table and a bot that
 * can play — and every one of them is in `src/engine/`, pure and seeded. What
 * was missing was somebody to beat, and this is the file that puts them on the
 * screen: it owns the opponent's `GameState`, its `BotState`, and the two-way
 * exchange between that well and the player's.
 *
 * Three rules shape it.
 *
 * **The engine still owns everything that decides a match.** Nothing here
 * scores, clears, or invents an attack; it calls `stepBot`, `update`,
 * `receiveGarbage` and `winMatch` in that order and moves numbers between two
 * snapshots. `game.ts` deliberately did *not* grow a second board.
 *
 * **What crosses over is read from the state, not from an event.** `stepBot`
 * may apply several inputs in one call and each of them replaces the snapshot's
 * `events`, so a clear in the middle of a placement can leave no event behind.
 * `garbageSent` is a running total in the snapshot and cannot: the difference
 * across a frame is exactly what the opponent threw, however many presses it
 * took. The player's half is read the same way, in `src/main.ts`.
 *
 * **The opponent is decoration, in the accessibility sense.** A player cannot
 * act on that well, so a running description of it would be pure noise —
 * `opponentSummary` is a short sentence and `opponentMoment` says when it is
 * worth rewriting: garbage sent, garbage received, and the moment the machine
 * is nearly out of room.
 */

import {
  BOT_PROFILES,
  VISIBLE_HEIGHT,
  applyInput,
  createBot,
  createGame,
  pendingGarbage,
  receiveGarbage,
  stepBot,
  update as advanceGame,
  type BotDifficulty,
  type BotState,
  type GameState,
} from '../engine';
import {
  formatDuration,
  formatNumber,
  opponentLabel,
  stackHeight,
  versusRecordLine,
  type VersusOverlay,
  type VersusResultCopy,
} from './hud';
import type { Stats, VersusRecord, VersusSummary, VersusUpdate } from './stats';

// ---------------------------------------------------------------------------
// The incoming meter
// ---------------------------------------------------------------------------

/**
 * How many blocks the meter beside the well draws.
 *
 * Ten rather than twenty: past this the *number* is what a player reads, and a
 * column of twenty two-pixel slivers on a phone is not a shape anybody can
 * count. A queue deeper than the meter still reports its real size in words.
 */
export const METER_SEGMENTS = 10;

/**
 * How charged the soonest batch has to be before it is drawn as arriving.
 *
 * This is the whole point of the meter: rows that are *about* to land look
 * different from rows that are merely queued, so a player can decide whether
 * there is time for one more piece or whether the next clear has to cancel.
 */
export const IMMINENT_CHARGE = 0.6;

/** One block of the meter, bottom row first. */
export type MeterSegment = 'empty' | 'queued' | 'imminent';

/**
 * The incoming queue, as the meter needs it.
 *
 * `rows` is the number, `charge` is how close the soonest batch is to rising
 * (0 the moment it is queued, 1 as it lands) and `imminent` is how many of the
 * rows belong to that batch. Colour is only ever the fourth way this is said —
 * the segments change *shape*, the count is a numeral, and the label is a
 * sentence.
 */
export interface GarbageMeter {
  readonly rows: number;
  readonly imminent: number;
  readonly charge: number;
  readonly level: 'clear' | 'queued' | 'imminent';
  readonly label: string;
}

const CALM_METER: GarbageMeter = {
  rows: 0,
  imminent: 0,
  charge: 0,
  level: 'clear',
  label: 'Nothing incoming.',
};

/** `24` → `'24 rows'`, and one row is one row. */
function rowCount(count: number): string {
  return count === 1 ? '1 row' : `${formatNumber(count)} rows`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function garbageMeter(state: GameState): GarbageMeter {
  const queue = state.garbageQueue;
  const rows = pendingGarbage(queue);
  if (rows === 0 || queue.length === 0) {
    return CALM_METER;
  }

  // Every batch counts down from the same delay, so the soonest is simply the
  // one with the least left — which is also the one cancellation eats first.
  let soonest = queue[0];
  for (const batch of queue) {
    if (soonest === undefined || batch.delayMs < soonest.delayMs) {
      soonest = batch;
    }
  }
  if (soonest === undefined) {
    return CALM_METER;
  }

  const delayMs = Math.max(1, state.garbageDelayMs);
  const charge = clamp01(1 - soonest.delayMs / delayMs);
  const level = charge >= IMMINENT_CHARGE ? 'imminent' : 'queued';
  const label =
    level === 'imminent'
      ? `${rowCount(rows)} incoming, ${formatNumber(soonest.rows)} landing now.`
      : `${rowCount(rows)} incoming.`;
  return { rows, imminent: soonest.rows, charge, level, label };
}

/**
 * The meter's blocks, soonest at the front.
 *
 * The rows about to land are a different *shape* from the rows behind them, not
 * a different colour, which is the requirement colour alone can never meet.
 */
export function meterSegments(meter: GarbageMeter): readonly MeterSegment[] {
  const filled = Math.min(METER_SEGMENTS, meter.rows);
  const imminent = meter.level === 'imminent' ? Math.min(filled, meter.imminent) : 0;
  return Array.from({ length: METER_SEGMENTS }, (_, index) => {
    if (index >= filled) {
      return 'empty';
    }
    return index < imminent ? 'imminent' : 'queued';
  });
}

// ---------------------------------------------------------------------------
// The opponent, in words
// ---------------------------------------------------------------------------

/**
 * How high the machine's stack has to get before it is worth saying so.
 *
 * Three quarters of the well. Below it the exact height is not news; above it,
 * "nearly topped out" is the single most useful thing anybody watching that
 * well could be told.
 */
export const DANGER_ROWS = Math.ceil(VISIBLE_HEIGHT * 0.75);

/** Is the opponent nearly out of room? */
export function opponentInDanger(opponent: GameState): boolean {
  return stackHeight(opponent) >= DANGER_ROWS;
}

/**
 * The opponent's well as one sentence — the canvas's text alternative.
 *
 * Deliberately not a commentary. It says who is playing, what has crossed the
 * screen, and whether the machine is in trouble; it says nothing about which
 * piece is falling or where, because that would change sixty times a second and
 * a player cannot act on it anyway.
 */
export function opponentSummary(opponent: GameState, difficulty: BotDifficulty): string {
  const who = `${opponentLabel(difficulty)} opponent.`;
  if (opponent.status === 'over') {
    return `${who} Topped out.`;
  }
  const sent = `Sent ${rowCount(opponent.garbageSent)}.`;
  const incoming = pendingGarbage(opponent.garbageQueue);
  const taking = incoming > 0 ? ` Taking ${formatNumber(incoming)}.` : '';
  const danger = opponentInDanger(opponent) ? ' Nearly topped out.' : '';
  return `${who} ${sent}${taking}${danger}`;
}

/**
 * When that sentence is worth rewriting.
 *
 * Everything in it moves on an *event* — an attack landing, a batch queueing,
 * the stack crossing the danger line, the run ending — so a signature over
 * those four is what keeps the description out of the way the other 99% of the
 * time. Compare it with the last one and only write when it differs.
 */
export function opponentMoment(opponent: GameState): string {
  return [
    opponent.status,
    opponent.garbageSent,
    opponent.garbageReceived,
    pendingGarbage(opponent.garbageQueue) > 0 ? 'q' : '-',
    opponentInDanger(opponent) ? 'danger' : '-',
  ].join('|');
}

// ---------------------------------------------------------------------------
// The match
// ---------------------------------------------------------------------------

export interface MatchOptions {
  /** The opponent's seed. Its own, and part of what makes a match repeatable. */
  readonly seed: number;
  readonly difficulty: BotDifficulty;
  /** The level the opponent starts on. The same one the player chose. */
  readonly startLevel?: number;
}

/** What one frame of the opponent's game did. */
export interface MatchStep {
  /** Rows it threw this frame — hand them to the player's `receiveGarbage`. */
  readonly incoming: number;
  /** Its well ended this frame, which is the player winning. */
  readonly toppedOut: boolean;
}

const NOTHING: MatchStep = { incoming: 0, toppedOut: false };

export interface Match {
  /** The opponent's snapshot, for the renderer and the description. */
  state(): GameState;
  bot(): BotState;
  difficulty(): BotDifficulty;
  /** Rows the opponent has sent across, cancellation aside. */
  sent(): number;
  /** Start it playing; the count-in and the player's first piece wait for this. */
  resume(): void;
  pause(): void;
  /** Advance it by one frame and say what crossed the screen. */
  update(deltaMs: number): MatchStep;
  /** Rows the player just sent. */
  attack(rows: number): void;
  /** Freeze it: the match is decided, whichever way. */
  stop(): void;
  finished(): boolean;
}

/**
 * A match: one bot, one well, and the two-way exchange.
 *
 * The opponent's game is created in `versus` mode like the player's, so it has
 * the same attack table and the same queue delay — and its seed is its own, so
 * the two wells are dealt different pieces. Nothing in here reads the player's
 * state: what the player sent arrives through `attack`, and what the opponent
 * sent leaves through the step's `incoming`.
 */
export function createMatch(options: MatchOptions): Match {
  let state = createGame({
    seed: options.seed,
    startLevel: options.startLevel ?? 1,
    mode: 'versus',
  });
  // The bot's own generator is salted with the same seed, so a match is
  // reproducible from the pair of seeds and the difficulty alone.
  let bot = createBot(options.difficulty, options.seed);
  let stopped = false;

  return {
    state: () => state,
    bot: () => bot,
    difficulty: () => options.difficulty,
    sent: () => state.garbageSent,
    finished: () => stopped || state.status === 'over',

    resume(): void {
      state = applyInput(state, { type: 'resume' });
    },

    pause(): void {
      state = applyInput(state, { type: 'pause' });
    },

    attack(rows: number): void {
      if (stopped || !(rows > 0)) {
        return;
      }
      state = receiveGarbage(state, rows);
    },

    update(deltaMs: number): MatchStep {
      if (stopped || state.status !== 'playing') {
        return NOTHING;
      }
      const before = state.garbageSent;
      // Presses first, then the clock — the same order the player's frame runs
      // in, where the keyboard is drained before `update` is called.
      const step = stepBot(bot, state, deltaMs);
      bot = step.bot;
      state = advanceGame(step.state, deltaMs);
      const incoming = Math.max(0, state.garbageSent - before);
      const toppedOut = state.status === 'over';
      if (toppedOut) {
        stopped = true;
      }
      return incoming === 0 && !toppedOut ? NOTHING : { incoming, toppedOut };
    },

    stop(): void {
      stopped = true;
    },
  };
}

// ---------------------------------------------------------------------------
// The result, in words
// ---------------------------------------------------------------------------

/** A finished match, as the panel and the record book need it. */
export interface MatchResult {
  readonly difficulty: BotDifficulty;
  /** The player's well outlasted the machine's. */
  readonly won: boolean;
  /** Rows the player sent. */
  readonly sent: number;
  /** Rows the machine sent. */
  readonly received: number;
  /** The player's run clock when it ended. */
  readonly durationMs: number;
}

/**
 * Why there is no replay link on a versus panel.
 *
 * A tape is the player's inputs against a seed, and that is enough to replay a
 * solo run exactly. It is *not* enough here: the opponent's attacks land on the
 * player's clock at moments that depend on the frames the machine happened to
 * get, and a replay built without them would show a clean well where the real
 * run took four rows in the face. A link that plays back the wrong match is
 * worse than no link, so the game says so rather than offering one.
 */
export const REPLAY_REFUSAL =
  'No replay link for a match: the tape holds your keys, not the opponent, so it would play back a different game.';

/** The result screen's four strings: who won, why, what crossed, what it did. */
export function matchResultCopy(result: MatchResult, update: VersusUpdate): VersusResultCopy {
  const who = opponentLabel(result.difficulty);
  const clock = formatDuration(result.durationMs);
  const record = versusRecordLine(result.difficulty, update.record);
  const best = update.isBest ? ' Your best attack yet in a win.' : '';
  return {
    title: result.won ? 'You win' : `${who} wins`,
    hint: result.won
      ? `${who} topped out after ${clock}.`
      : `You topped out after ${clock}, and ${who} was still standing.`,
    line: `Garbage sent — you ${rowCount(result.sent)}, ${who} ${rowCount(result.received)}.`,
    note: `${record ?? ''}${best} ${REPLAY_REFUSAL}`.trim(),
  };
}

/** The start screen's teaser: your record against the chosen opponent. */
export function versusStartNote(stats: Stats, difficulty: BotDifficulty): string | null {
  return versusRecordLine(difficulty, stats.versus[difficulty]);
}

/** Both halves of the overlay's versus copy, ready to hand to the HUD. */
export function versusOverlay(
  stats: Stats,
  difficulty: BotDifficulty,
  result: VersusResultCopy | null,
): VersusOverlay {
  return { startNote: versusStartNote(stats, difficulty), result };
}

/** A finished match, as `applyVersus` wants it. */
export function versusSummary(result: MatchResult): VersusSummary {
  return { difficulty: result.difficulty, won: result.won, sent: result.sent };
}

/**
 * The one place the opponent's *speed* is described outside the start screen.
 *
 * `BOT_PROFILES` is the engine's table and this is only a reading of it, so a
 * retuned difficulty changes the sentence without anybody remembering to.
 */
export function opponentPressesPerSecond(difficulty: BotDifficulty): number {
  return Math.round(1000 / Math.max(1, BOT_PROFILES[difficulty].moveIntervalMs));
}

/** A record with nothing in it — for the start screen before the first match. */
export function isFreshRecord(record: VersusRecord): boolean {
  return record.wins === 0 && record.losses === 0;
}
