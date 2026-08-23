/**
 * Personal bests, lifetime totals, and what a finished run does to them.
 *
 * Deliberately free of both storage and the DOM. Everything here is a pure
 * function of plain data, so "did that run break a record?" is a unit test
 * rather than something you can only find out by playing well. `ui/storage.ts`
 * persists what this module produces; `ui/hud.ts` phrases it.
 *
 * Two rules shape the shape.
 *
 * **A run that starts above level 1 is not measured against a run that started
 * at the bottom.** Beginning on level 8 is a head start — faster gravity, but
 * ten levels of easy scoring skipped — so those runs keep their own bests and
 * stay out of the headline number.
 *
 * **A mode is its own record book.** Forty lines in 1:42 and 8,400 points in two
 * minutes are not comparable achievements, and neither is comparable to an
 * endless run, so each mode keeps a base ladder and a head-start ladder of its
 * own. What a record even *means* changes with the mode: Marathon and Ultra are
 * raced on the score, Sprint on the clock, where **lower is better** and only a
 * completed forty counts at all.
 *
 * The totals (games played, lines all-time) count every run in every mode,
 * because those are a record of time spent rather than of skill.
 */

import {
  BOT_DIFFICULTIES,
  parseBotDifficulty,
  type BotDifficulty,
  type FinishedOutcome,
  type GameMode,
  GAME_MODES,
} from '../engine';

/** The lowest level a run may start on, and the highest the start screen offers. */
export const MIN_START_LEVEL = 1;
export const MAX_START_LEVEL = 10;

/** Every level the start screen lets a player begin on. */
export const START_LEVELS: readonly number[] = Array.from(
  { length: MAX_START_LEVEL - MIN_START_LEVEL + 1 },
  (_, index) => MIN_START_LEVEL + index,
);

/** Anything outside the offered range — corrupt, hand-edited — comes back in. */
export function clampStartLevel(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_START_LEVEL;
  }
  return Math.min(MAX_START_LEVEL, Math.max(MIN_START_LEVEL, Math.floor(value)));
}

/** A run that did not start at the bottom, and so is scored on its own ladder. */
export function isHeadStart(startLevel: number): boolean {
  return clampStartLevel(startLevel) > MIN_START_LEVEL;
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/**
 * The furthest a player has got on one ladder.
 *
 * The same four numbers in every mode, read differently in each: in Marathon
 * and Ultra `score` is the record and `durationMs` is the clock the record run
 * happened to take, while in Sprint `durationMs` **is** the record and the rest
 * are the numbers the fastest run happened to post.
 */
export interface Best {
  readonly score: number;
  readonly level: number;
  readonly lines: number;
  readonly durationMs: number;
}

/** One mode's two ladders: honest starts, and head starts. */
export interface ModeBests {
  /** Bests over runs that started on level 1 — the honest headline. */
  readonly base: Best;
  /** Bests over runs that started higher up, kept apart on purpose. */
  readonly headStart: Best;
}

/**
 * What Versus remembers, per difficulty.
 *
 * Deliberately three small numbers rather than a ladder. Versus is not raced on
 * a score — a match is won or lost, and the score you happened to post while
 * winning says nothing about how close it was — so the record that means
 * anything is how often you beat *that* opponent, and the best of it is the
 * most garbage you have ever put across in a match you won. A big attack in a
 * match you lost is not an achievement, it is a story.
 */
export interface VersusRecord {
  readonly wins: number;
  readonly losses: number;
  /** Rows of garbage sent in the best won match; 0 until the first win. */
  readonly bestSent: number;
}

export interface Stats {
  /** One record book per mode. */
  readonly modes: Readonly<Record<GameMode, ModeBests>>;
  /** One win/loss record per bot difficulty. Versus keeps no score ladder. */
  readonly versus: Readonly<Record<BotDifficulty, VersusRecord>>;
  /** Every run that reached an end, in any mode, head start or not. */
  readonly gamesPlayed: number;
  /** Every line ever cleared, likewise. */
  readonly totalLines: number;
}

/** A finished match, as the record book needs it. */
export interface VersusSummary {
  readonly difficulty: BotDifficulty;
  /** The player's well outlasted the opponent's. */
  readonly won: boolean;
  /** Rows of garbage the player sent across, cancellation aside. */
  readonly sent: number;
}

/** A run, as it stood when it ended. */
export interface RunSummary {
  readonly mode: GameMode;
  /** How it ended. Sprint's record book cares; the totals do not. */
  readonly outcome: FinishedOutcome;
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  readonly startLevel: number;
  readonly durationMs: number;
}

/** Which of the four numbers this run pushed past. */
export type RecordKind = 'score' | 'level' | 'lines' | 'time';

/**
 * What each mode races on — the one number the panel shouts about — and the
 * lesser records it still bothers to track.
 *
 * Sprint tracks nothing but the clock on purpose: a completed sprint is always
 * forty lines, so "most lines" would be a record every player ties on their
 * first finish, and a score record would reward stacking rather than speed.
 */
export const MODE_HEADLINE: Readonly<Record<GameMode, RecordKind>> = {
  marathon: 'score',
  sprint: 'time',
  ultra: 'score',
  versus: 'score',
};

/**
 * Versus tracks **nothing** on the shared ladders, and that is the point: a
 * match is won or lost, and neither the score nor the clock says which. Its
 * record book is `Stats.versus`, per difficulty — see `VersusRecord`. The runs
 * still count in `gamesPlayed` and `totalLines`, because those measure time
 * spent rather than skill.
 */
const MODE_RECORDS: Readonly<Record<GameMode, readonly RecordKind[]>> = {
  marathon: ['score', 'lines', 'level'],
  sprint: ['time'],
  ultra: ['score', 'lines', 'level'],
  versus: [],
};

/** The records a mode keeps, in the order the run-summary panel lists them. */
export function recordsFor(mode: GameMode): readonly RecordKind[] {
  return MODE_RECORDS[mode];
}

/** The answer `applyRun` gives: new stats, plus what was worth celebrating. */
export interface StatsUpdate {
  readonly stats: Stats;
  /** The run that produced it, carried along so the panel has the numbers. */
  readonly run: RunSummary;
  /** The bests as they stood *before* the run, in the ladder it belongs to. */
  readonly previousBest: Best;
  readonly records: readonly RecordKind[];
  /**
   * Beat the number this mode is actually raced on — the high score in
   * Marathon and Ultra, the clock in Sprint. The one the panel shouts about.
   */
  readonly isHeadlineRecord: boolean;
  /** The run started above level 1, so it was measured on the second ladder. */
  readonly headStart: boolean;
}

// ---------------------------------------------------------------------------
// Defaults and validation
// ---------------------------------------------------------------------------

export function emptyBest(): Best {
  return { score: 0, level: 0, lines: 0, durationMs: 0 };
}

export function emptyModeBests(): ModeBests {
  return { base: emptyBest(), headStart: emptyBest() };
}

export function emptyVersusRecord(): VersusRecord {
  return { wins: 0, losses: 0, bestSent: 0 };
}

/** An empty record for every difficulty, built from the engine's own list. */
export function emptyVersusRecords(): Record<BotDifficulty, VersusRecord> {
  const records = {} as Record<BotDifficulty, VersusRecord>;
  for (const difficulty of BOT_DIFFICULTIES) {
    records[difficulty] = emptyVersusRecord();
  }
  return records;
}

export function defaultStats(): Stats {
  const modes = {} as Record<GameMode, ModeBests>;
  for (const mode of GAME_MODES) {
    modes[mode] = emptyModeBests();
  }
  return {
    modes,
    versus: emptyVersusRecords(),
    gamesPlayed: 0,
    totalLines: 0,
  };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A stored number, or zero.
 *
 * Everything counted here is a non-negative whole number, so anything else —
 * a string, a NaN, an Infinity, a negative from a hand-edited store — is not a
 * value to be repaired, it is a value to be ignored.
 */
function count(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

function sanitizeBest(raw: unknown): Best {
  const source = isRecordObject(raw) ? raw : {};
  return {
    score: count(source['score']),
    level: count(source['level']),
    lines: count(source['lines']),
    durationMs: count(source['durationMs']),
  };
}

function sanitizeModeBests(raw: unknown): ModeBests {
  const source = isRecordObject(raw) ? raw : {};
  return {
    base: sanitizeBest(source['base']),
    headStart: sanitizeBest(source['headStart']),
  };
}

function sanitizeVersusRecord(raw: unknown): VersusRecord {
  const source = isRecordObject(raw) ? raw : {};
  return {
    wins: count(source['wins']),
    losses: count(source['losses']),
    bestSent: count(source['bestSent']),
  };
}

/** Any parsed value at all, coerced into a usable `Stats`. Never throws. */
export function sanitizeStats(raw: unknown): Stats {
  const source = isRecordObject(raw) ? raw : {};
  const modes = isRecordObject(source['modes']) ? source['modes'] : {};
  // Built from the engine's own list, so a mode added there cannot be silently
  // dropped by the store on the way back in.
  const bests = {} as Record<GameMode, ModeBests>;
  for (const mode of GAME_MODES) {
    bests[mode] = sanitizeModeBests(modes[mode]);
  }
  const stored = isRecordObject(source['versus']) ? source['versus'] : {};
  const versus = {} as Record<BotDifficulty, VersusRecord>;
  for (const difficulty of BOT_DIFFICULTIES) {
    versus[difficulty] = sanitizeVersusRecord(stored[difficulty]);
  }
  return {
    modes: bests,
    versus,
    gamesPlayed: count(source['gamesPlayed']),
    totalLines: count(source['totalLines']),
  };
}

// ---------------------------------------------------------------------------
// The update
// ---------------------------------------------------------------------------

/** The ladder a run of this mode beginning on `startLevel` is measured against. */
export function bestFor(stats: Stats, mode: GameMode, startLevel: number): Best {
  const bests = stats.modes[mode];
  return isHeadStart(startLevel) ? bests.headStart : bests.base;
}

/** Has this player finished anything at all, in any mode, on either ladder? */
export function hasAnyBest(stats: Stats): boolean {
  if (stats.gamesPlayed > 0) {
    return true;
  }
  return GAME_MODES.some((mode) => {
    const bests = stats.modes[mode];
    return bests.base.score > 0 || bests.headStart.score > 0;
  });
}

/** A Sprint that actually reached its goal — the only kind that sets a time. */
export function isSprintFinish(run: RunSummary): boolean {
  return run.mode === 'sprint' && run.outcome === 'goalReached';
}

/** One mode's ladders, with `next` written into the one `headStart` names. */
function withLadder(bests: ModeBests, headStart: boolean, next: Best): ModeBests {
  return headStart ? { ...bests, headStart: next } : { ...bests, base: next };
}

/**
 * Fold a finished run into the stats.
 *
 * Pure, and the only place records are decided. Records are strict: equalling a
 * best is not beating it, so a repeat of yesterday's score does not set off the
 * confetti — and a Sprint that ties your fastest forty is a tie, not a record.
 *
 * The two record shapes differ, and the difference is the point. A *bigger is
 * better* number is folded in one at a time: beat the score and the stored
 * score moves, beat the lines and the stored lines move, and the duration
 * beside them belongs to the run that set the score. Sprint's *lower is better*
 * clock cannot work that way — a best time is a run, not a collection of
 * high-water marks — so beating it replaces the whole record with the run that
 * did it, and failing to finish leaves it entirely alone.
 */
export function applyRun(stats: Stats, run: RunSummary): StatsUpdate {
  const headStart = isHeadStart(run.startLevel);
  const bests = stats.modes[run.mode];
  const previousBest = headStart ? bests.headStart : bests.base;
  const tracked = recordsFor(run.mode);

  /**
   * A run that did nothing broke nothing.
   *
   * Without this, the very first game — top-out on the opening piece, nothing
   * scored, nothing cleared — still counts as a "level 1 best", because the
   * stored level starts at zero. Telling somebody they have set a personal
   * best for losing immediately is the sort of hollow praise that makes every
   * later celebration worth less.
   */
  const counts = run.score > 0 || run.lines > 0;
  const duration = Math.max(0, Math.floor(run.durationMs));

  // In the order the run-summary panel lists them, so a caller that wants to
  // say "score and lines" reads the list top to bottom.
  const records: RecordKind[] = [];
  if (tracked.includes('score') && counts && run.score > previousBest.score) {
    records.push('score');
  }
  if (tracked.includes('lines') && counts && run.lines > previousBest.lines) {
    records.push('lines');
  }
  if (tracked.includes('level') && counts && run.level > previousBest.level) {
    records.push('level');
  }
  // A did-not-finish has no time to record. This is the whole of the DNF rule:
  // the run still counts in the totals, it simply never reaches the clock.
  if (
    tracked.includes('time') &&
    isSprintFinish(run) &&
    (previousBest.durationMs === 0 || duration < previousBest.durationMs)
  ) {
    records.push('time');
  }

  const isHeadlineRecord = records.includes(MODE_HEADLINE[run.mode]);

  const nextBest: Best = records.includes('time')
    ? { score: run.score, level: run.level, lines: run.lines, durationMs: duration }
    : {
        score: Math.max(previousBest.score, tracked.includes('score') ? run.score : 0),
        level: Math.max(previousBest.level, tracked.includes('level') ? run.level : 0),
        lines: Math.max(previousBest.lines, tracked.includes('lines') ? run.lines : 0),
        durationMs: records.includes('score') ? duration : previousBest.durationMs,
      };

  return {
    stats: {
      ...stats,
      modes: { ...stats.modes, [run.mode]: withLadder(bests, headStart, nextBest) },
      gamesPlayed: stats.gamesPlayed + 1,
      totalLines: stats.totalLines + count(run.lines),
    },
    run,
    previousBest,
    records,
    isHeadlineRecord,
    headStart,
  };
}

/**
 * What `applyVersus` gives back: the new stats, and the record as it stood
 * *before* the match, so the panel can say "your third win" honestly.
 */
export interface VersusUpdate {
  readonly stats: Stats;
  readonly match: VersusSummary;
  readonly previous: VersusRecord;
  readonly record: VersusRecord;
  /** This win sent more garbage than any won match before it. */
  readonly isBest: boolean;
}

/**
 * Fold a finished match into the versus record book.
 *
 * Separate from `applyRun` because it answers a different question: `applyRun`
 * asks "how far did that run get", and a match asks "did you beat that
 * opponent". Both are called for a Versus run, and each writes only its own
 * half — which is why `applyRun` now spreads the stats it was given rather than
 * rebuilding the object from three fields.
 *
 * `bestSent` only ever moves on a **win**: the most garbage you have ever put
 * across in a match you actually took. Strict, like every other record here.
 */
export function applyVersus(stats: Stats, match: VersusSummary): VersusUpdate {
  const difficulty = parseBotDifficulty(match.difficulty);
  const previous = stats.versus[difficulty];
  const sent = Math.max(0, Math.floor(match.sent));
  const isBest = match.won && sent > previous.bestSent;
  const record: VersusRecord = {
    wins: previous.wins + (match.won ? 1 : 0),
    losses: previous.losses + (match.won ? 0 : 1),
    bestSent: isBest ? sent : previous.bestSent,
  };
  return {
    stats: { ...stats, versus: { ...stats.versus, [difficulty]: record } },
    match: { ...match, difficulty, sent },
    previous,
    record,
    isBest,
  };
}

/** Has this player played a match against this opponent at all? */
export function hasVersusRecord(record: VersusRecord): boolean {
  return record.wins + record.losses > 0;
}
