/**
 * Personal bests, lifetime totals, and what a finished run does to them.
 *
 * Deliberately free of both storage and the DOM. Everything here is a pure
 * function of plain data, so "did that run break a record?" is a unit test
 * rather than something you can only find out by playing well. `ui/storage.ts`
 * persists what this module produces; `ui/hud.ts` phrases it.
 *
 * One rule shapes the shape: **a run that starts above level 1 is not measured
 * against a run that started at the bottom.** Beginning on level 8 is a head
 * start — faster gravity, but ten levels of easy scoring skipped — so those
 * runs keep their own bests and stay out of the headline number. The totals
 * (games played, lines all-time) count every run, because those are a record of
 * time spent rather than of skill.
 */

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

/** The furthest a player has got, in each of the three things a run produces. */
export interface Best {
  readonly score: number;
  readonly level: number;
  readonly lines: number;
  /** How long the record-scoring run lasted. Shown beside it, never compared. */
  readonly durationMs: number;
}

export interface Stats {
  /** Bests over runs that started on level 1 — the honest headline. */
  readonly best: Best;
  /** Bests over runs that started higher up, kept apart on purpose. */
  readonly headStart: Best;
  /** Every run that reached a game over, head start or not. */
  readonly gamesPlayed: number;
  /** Every line ever cleared, likewise. */
  readonly totalLines: number;
}

/** A run, as it stood when it ended. */
export interface RunSummary {
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  readonly startLevel: number;
  readonly durationMs: number;
}

/** Which of the three numbers this run pushed past. */
export type RecordKind = 'score' | 'level' | 'lines';

/** The answer `applyRun` gives: new stats, plus what was worth celebrating. */
export interface StatsUpdate {
  readonly stats: Stats;
  /** The run that produced it, carried along so the panel has the numbers. */
  readonly run: RunSummary;
  /** The bests as they stood *before* the run, in the ladder it belongs to. */
  readonly previousBest: Best;
  readonly records: readonly RecordKind[];
  /** Beat the stored high score — the one the panel shouts about. */
  readonly isHighScore: boolean;
  /** The run started above level 1, so it was measured on the second ladder. */
  readonly headStart: boolean;
}

// ---------------------------------------------------------------------------
// Defaults and validation
// ---------------------------------------------------------------------------

export function emptyBest(): Best {
  return { score: 0, level: 0, lines: 0, durationMs: 0 };
}

export function defaultStats(): Stats {
  return { best: emptyBest(), headStart: emptyBest(), gamesPlayed: 0, totalLines: 0 };
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

/** Any parsed value at all, coerced into a usable `Stats`. Never throws. */
export function sanitizeStats(raw: unknown): Stats {
  const source = isRecordObject(raw) ? raw : {};
  return {
    best: sanitizeBest(source['best']),
    headStart: sanitizeBest(source['headStart']),
    gamesPlayed: count(source['gamesPlayed']),
    totalLines: count(source['totalLines']),
  };
}

// ---------------------------------------------------------------------------
// The update
// ---------------------------------------------------------------------------

/** The ladder a run beginning on `startLevel` is measured against. */
export function bestFor(stats: Stats, startLevel: number): Best {
  return isHeadStart(startLevel) ? stats.headStart : stats.best;
}

/** Has this player finished anything at all on either ladder? */
export function hasAnyBest(stats: Stats): boolean {
  return stats.gamesPlayed > 0 || stats.best.score > 0 || stats.headStart.score > 0;
}

/**
 * Fold a finished run into the stats.
 *
 * Pure, and the only place records are decided. Records are strict: equalling
 * a best is not beating it, so a repeat of yesterday's score does not set off
 * the confetti. The duration stored beside a best belongs to the run that set
 * the *score* record, which is why it moves only when the score does.
 */
export function applyRun(stats: Stats, run: RunSummary): StatsUpdate {
  const headStart = isHeadStart(run.startLevel);
  const previousBest = headStart ? stats.headStart : stats.best;

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

  // In the order the game-over panel lists them, so a caller that wants to say
  // "score and lines" reads the list top to bottom.
  const records: RecordKind[] = [];
  if (counts && run.score > previousBest.score) {
    records.push('score');
  }
  if (counts && run.lines > previousBest.lines) {
    records.push('lines');
  }
  if (counts && run.level > previousBest.level) {
    records.push('level');
  }

  const isHighScore = records.includes('score');
  const nextBest: Best = {
    score: Math.max(previousBest.score, run.score),
    level: Math.max(previousBest.level, run.level),
    lines: Math.max(previousBest.lines, run.lines),
    durationMs: isHighScore ? Math.max(0, Math.floor(run.durationMs)) : previousBest.durationMs,
  };

  return {
    stats: {
      best: headStart ? stats.best : nextBest,
      headStart: headStart ? nextBest : stats.headStart,
      gamesPlayed: stats.gamesPlayed + 1,
      totalLines: stats.totalLines + count(run.lines),
    },
    run,
    previousBest,
    records,
    isHighScore,
    headStart,
  };
}
