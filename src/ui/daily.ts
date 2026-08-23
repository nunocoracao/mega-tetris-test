/**
 * The daily challenge: one shared seed a day, and the history it leaves behind.
 *
 * The seed itself lives in `src/engine/daily.ts`, because it is part of what
 * makes a run reproducible. Everything *around* it lives here: which days have
 * been played, how long the streak is, where today's score sits among the ones
 * before it, and the line a player can paste to a friend.
 *
 * Three properties shape the module.
 *
 * **It never reads the clock.** Every function that needs to know what day it
 * is takes a `YYYY-MM-DD` string. `src/main.ts` asks the browser once and hands
 * the answer down, which is what makes streak arithmetic — the part with real
 * edge cases in it — a thing that can be tested with fixed dates instead of
 * with a mocked global.
 *
 * **The record is honest but not defended.** One attempt a day, spent when the
 * run *ends* rather than when it starts, so a refresh mid-run costs nothing.
 * Storage is a player's own `localStorage`; anybody determined enough to open
 * devtools can hand themselves a fresh attempt, and no amount of obfuscation
 * here would change that. The aim is only that cheating is not the *default*
 * path — the interesting number is the one you post against the same pieces
 * everyone else got.
 *
 * **The history is a window, not an archive.** The last thirty days, capped, so
 * the store stays small and the strip on the start screen has a fixed size. The
 * streak counters are therefore *stored* rather than recomputed: a fifty-day
 * streak is not visible in a thirty-day window, and losing it to a cap would be
 * the rudest possible bug.
 */

import { isDateStamp } from '../engine';
import { formatNumber } from './hud';

/** How many days the history keeps, and how many cells the strip draws. */
export const DAILY_HISTORY_DAYS = 30;

/** The mode and level the daily challenge is always played on. */
export const DAILY_MODE = 'marathon' as const;
export const DAILY_START_LEVEL = 1;

/** Milliseconds in a day. The daily challenge runs on UTC days, which have no
 *  daylight saving and are therefore all exactly this long. */
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// The stored shape
// ---------------------------------------------------------------------------

/** One day's recorded attempt. */
export interface DailyEntry {
  /** The UTC day it was played, as `YYYY-MM-DD`. */
  readonly date: string;
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  readonly durationMs: number;
}

export interface DailyStats {
  /** The last `DAILY_HISTORY_DAYS` recorded days, oldest first, one per date. */
  readonly history: readonly DailyEntry[];
  /**
   * Consecutive days played, as of the most recent entry. Stored rather than
   * derived because a streak can outrun the history window — see the module
   * docblock. `streakOn` is what turns it into "the streak *today*".
   */
  readonly currentStreak: number;
  readonly longestStreak: number;
}

export function defaultDaily(): DailyStats {
  return { history: [], currentStreak: 0, longestStreak: 0 };
}

// ---------------------------------------------------------------------------
// Date arithmetic
// ---------------------------------------------------------------------------

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored non-negative whole number, or zero. Same rule as `ui/stats.ts`. */
function count(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

/**
 * A date stamp as a whole number of days since the epoch, or `null` if it is
 * not a real day.
 *
 * `Date.UTC` does the calendar — leap years included — and the round-trip
 * through `dayStamp` is what rejects the dates that pass a regex but do not
 * exist, like `2026-02-31`, which `Date.UTC` would silently roll into March.
 * Nothing here reads the clock: both calls are arithmetic on the argument.
 */
export function dayNumber(date: string): number | null {
  if (!isDateStamp(date)) {
    return null;
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const ms = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const number = Math.floor(ms / MS_PER_DAY);
  return dayStamp(number) === date ? number : null;
}

/** The inverse: a day number back to `YYYY-MM-DD`. */
export function dayStamp(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The day `days` after `date` (negative for before), or `null` if `date` is not one. */
export function dayOffset(date: string, days: number): string | null {
  const number = dayNumber(date);
  return number === null ? null : dayStamp(number + days);
}

/**
 * Whole days from `from` to `to`, or `null` if either is not a real date.
 * Positive when `to` is later, which is the direction every caller reads it in.
 */
export function daysBetween(from: string, to: string): number | null {
  const start = dayNumber(from);
  const end = dayNumber(to);
  return start === null || end === null ? null : end - start;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function sanitizeEntry(raw: unknown): DailyEntry | null {
  if (!isRecordObject(raw)) {
    return null;
  }
  const date = raw['date'];
  if (typeof date !== 'string' || dayNumber(date) === null) {
    return null;
  }
  return {
    date,
    score: count(raw['score']),
    lines: count(raw['lines']),
    level: count(raw['level']),
    durationMs: count(raw['durationMs']),
  };
}

/**
 * Any parsed value at all, coerced into a usable `DailyStats`. Never throws.
 *
 * The history is put back in order and deduplicated as well as validated: a
 * hand-edited store could hold two entries for one day or a day out of
 * sequence, and every function below is written against "oldest first, one per
 * date, all real days". Repairing it once here is cheaper than defending
 * everywhere else.
 */
export function sanitizeDaily(raw: unknown): DailyStats {
  const source = isRecordObject(raw) ? raw : {};
  const rawHistory = Array.isArray(source['history']) ? source['history'] : [];

  const byDate = new Map<string, DailyEntry>();
  for (const item of rawHistory) {
    const entry = sanitizeEntry(item);
    if (entry !== null && !byDate.has(entry.date)) {
      byDate.set(entry.date, entry);
    }
  }
  const history = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-DAILY_HISTORY_DAYS);

  const currentStreak = count(source['currentStreak']);
  return {
    history,
    currentStreak,
    // A longest that is shorter than the current one is not a number to keep;
    // the current streak is proof it happened.
    longestStreak: Math.max(count(source['longestStreak']), currentStreak),
  };
}

// ---------------------------------------------------------------------------
// Reading the history
// ---------------------------------------------------------------------------

/** The most recent day recorded, or `null` for a player who has never played. */
export function lastDailyDate(stats: DailyStats): string | null {
  return stats.history[stats.history.length - 1]?.date ?? null;
}

/** The entry for one day, if there is one. */
export function dailyEntryOn(stats: DailyStats, date: string): DailyEntry | null {
  return stats.history.find((entry) => entry.date === date) ?? null;
}

/** Has the one attempt for this day been used? */
export function hasPlayedOn(stats: DailyStats, date: string): boolean {
  return dailyEntryOn(stats, date) !== null;
}

/**
 * The streak *as it stands on `today`*, which is not always the stored one.
 *
 * The stored counter is the streak as of the last day played. It is still alive
 * if that day was today or yesterday — a player who has not opened the game yet
 * this morning has not lost anything — and broken by any longer gap. Doing this
 * here rather than at write time is what stops the number needing a nightly
 * cron job nobody can run in a static page.
 */
export function streakOn(stats: DailyStats, today: string): number {
  const last = lastDailyDate(stats);
  if (last === null) {
    return 0;
  }
  const gap = daysBetween(last, today);
  return gap !== null && gap >= 0 && gap <= 1 ? stats.currentStreak : 0;
}

/**
 * Fold a finished daily run into the record.
 *
 * Pure, and the whole of the streak rule:
 *
 * - the first day ever recorded starts a streak of one;
 * - the day after the last one continues it;
 * - any longer gap starts again at one — a missed day is a broken streak, and
 *   softening that would make the number mean nothing;
 * - **the same day twice changes nothing at all.** The attempt was spent when
 *   the first run ended, so a second recorded run on that date is either a
 *   practice run that should never have reached here or a clock that went
 *   backwards, and neither is a reason to move the counters.
 */
export function applyDailyRun(stats: DailyStats, entry: DailyEntry): DailyStats {
  if (dayNumber(entry.date) === null) {
    return stats;
  }
  const last = lastDailyDate(stats);

  let currentStreak = 1;
  if (last !== null) {
    const gap = daysBetween(last, entry.date);
    if (gap === null || gap <= 0) {
      // Already recorded, or older than what we have. Either way, not news.
      return stats;
    }
    currentStreak = gap === 1 ? stats.currentStreak + 1 : 1;
  }

  return {
    history: [...stats.history, entry].slice(-DAILY_HISTORY_DAYS),
    currentStreak,
    longestStreak: Math.max(stats.longestStreak, currentStreak),
  };
}

// ---------------------------------------------------------------------------
// Where a run sits among its neighbours
// ---------------------------------------------------------------------------

/** One day's place in the player's own daily history. */
export interface DailyStanding {
  /** 1 is the best score in the history. Ties share the better rank. */
  readonly rank: number;
  /** How many days the history holds, this one included. */
  readonly total: number;
}

/**
 * Where the run on `date` sits against the player's other daily runs.
 *
 * Against *their own* history, and only the part of it still stored — thirty
 * days is the window, and the copy says "of 12" rather than pretending to know
 * about a run it threw away. `null` when that day was never played.
 */
export function dailyStanding(stats: DailyStats, date: string): DailyStanding | null {
  const entry = dailyEntryOn(stats, date);
  if (entry === null) {
    return null;
  }
  const better = stats.history.filter((other) => other.score > entry.score).length;
  return { rank: better + 1, total: stats.history.length };
}

// ---------------------------------------------------------------------------
// The history strip
// ---------------------------------------------------------------------------

/** How many shades of "how well it went" the strip draws. */
export const DAILY_TIERS = 4;

/** One cell of the thirty-day strip. */
export interface DailyCell {
  readonly date: string;
  readonly played: boolean;
  readonly score: number;
  readonly lines: number;
  /**
   * How good the run was, 1 to `DAILY_TIERS`, relative to the best day in the
   * window. Zero for a day that was not played. It is *only* a tint: the strip
   * also differs in shape, and every cell carries its own label, because a
   * quarter of the population cannot reliably tell four purples apart.
   */
  readonly tier: number;
  /** The last cell of the strip — the day the player is looking at it on. */
  readonly isToday: boolean;
}

/** Which of the four bands a score falls in, against the best in the window. */
function tierFor(score: number, best: number): number {
  if (score <= 0 || best <= 0) {
    return 1;
  }
  const share = score / best;
  for (let tier = 1; tier < DAILY_TIERS; tier += 1) {
    if (share <= tier / DAILY_TIERS) {
      return tier;
    }
  }
  return DAILY_TIERS;
}

/**
 * The strip, oldest first, ending on `today`.
 *
 * Always `days` cells long whatever the history holds, because a strip that
 * changed width as it filled up would move the button underneath it. A day with
 * no entry is a real cell that says it was missed.
 */
export function historyCells(
  stats: DailyStats,
  today: string,
  days: number = DAILY_HISTORY_DAYS,
): readonly DailyCell[] {
  const best = stats.history.reduce((max, entry) => Math.max(max, entry.score), 0);
  const cells: DailyCell[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = dayOffset(today, -offset);
    if (date === null) {
      continue;
    }
    const entry = dailyEntryOn(stats, date);
    cells.push({
      date,
      played: entry !== null,
      score: entry?.score ?? 0,
      lines: entry?.lines ?? 0,
      tier: entry === null ? 0 : tierFor(entry.score, best),
      isToday: offset === 0,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * `'2026-08-23'` → `'23 August 2026'`.
 *
 * Written out rather than run through `toLocaleDateString`, so the string is
 * the same in a test as it is in a browser in Tokyo — the same reason the seed
 * takes a string in the first place. A date it cannot read comes back
 * unchanged, which is still a date a player can read.
 */
export function formatDay(date: string): string {
  if (dayNumber(date) === null) {
    return date;
  }
  const month = MONTH_NAMES[Number(date.slice(5, 7)) - 1] ?? '';
  return `${Number(date.slice(8, 10))} ${month} ${date.slice(0, 4)}`;
}

/** `3` → `'third'`, for the handful of places the copy counts out loud. */
export function ordinal(value: number): string {
  const names = [
    'first',
    'second',
    'third',
    'fourth',
    'fifth',
    'sixth',
    'seventh',
    'eighth',
    'ninth',
    'tenth',
  ];
  const name = names[value - 1];
  if (name !== undefined) {
    return name;
  }
  const remainder = value % 100;
  if (remainder >= 11 && remainder <= 13) {
    return `${formatNumber(value)}th`;
  }
  const suffix = ['th', 'st', 'nd', 'rd'][value % 10] ?? 'th';
  return `${formatNumber(value)}${suffix}`;
}

/** `5` → `'5 days'`; `1` → `'1 day'`. */
export function dayCount(days: number): string {
  return days === 1 ? '1 day' : `${formatNumber(days)} days`;
}

/** The day's line on the start screen: what today is, and whether it is spent. */
export function dailyStatusLine(stats: DailyStats, today: string): string {
  const entry = dailyEntryOn(stats, today);
  if (entry === null) {
    return `${formatDay(today)} — today’s run is waiting. Everyone gets these pieces.`;
  }
  return `${formatDay(today)} — played: ${formatNumber(entry.score)} points, ${formatNumber(entry.lines)} lines.`;
}

/** The line under it: the streak, or the invitation to start one. */
export function dailyStreakLine(stats: DailyStats, today: string): string {
  const streak = streakOn(stats, today);
  if (streak === 0) {
    return stats.longestStreak > 0
      ? `Streak broken. Your longest was ${dayCount(stats.longestStreak)}.`
      : 'No streak yet — today is a good day to start one.';
  }
  const longest = `longest ${dayCount(stats.longestStreak)}`;
  return `Streak: ${dayCount(streak)} (${longest}).`;
}

/** What the daily button offers, which depends on whether the day is spent. */
export function dailyButtonLabel(stats: DailyStats, today: string): string {
  return hasPlayedOn(stats, today) ? 'Practice today’s seed' : 'Play today’s daily';
}

/** One cell of the strip, in words. Every cell gets one; none of them is a colour. */
export function cellLabel(cell: DailyCell): string {
  const day = `${formatDay(cell.date)}${cell.isToday ? ' (today)' : ''}`;
  if (!cell.played) {
    return cell.isToday ? `${day}: not played yet.` : `${day}: not played.`;
  }
  return `${day}: ${formatNumber(cell.score)} points, ${formatNumber(cell.lines)} lines.`;
}

/** Where today's run landed, for the run-summary panel. */
export function standingLine(standing: DailyStanding): string {
  if (standing.total <= 1) {
    return 'Your first daily run.';
  }
  if (standing.rank === 1) {
    return 'Your best daily yet.';
  }
  return `Your ${ordinal(standing.rank)} best of ${formatNumber(standing.total)}.`;
}

/**
 * The footnote under the run-summary panel for a daily run.
 *
 * A practice run says so first and says nothing else: the whole point of the
 * label is that nobody reads a practice score as a result.
 */
export function dailyRunNote(options: {
  readonly date: string;
  readonly practice: boolean;
  readonly standing?: DailyStanding | null;
  readonly streak?: number;
}): string {
  if (options.practice) {
    return `Practice on the ${formatDay(options.date)} seed — not recorded, and not counted in your streak.`;
  }
  const standing = options.standing ?? null;
  const place = standing === null ? '' : ` ${standingLine(standing)}`;
  const days = options.streak ?? 0;
  const streak = days > 0 ? ` Streak: ${dayCount(days)}.` : '';
  return `Daily challenge, ${formatDay(options.date)}.${place}${streak}`;
}

/** Everything the shareable line says. Nothing else is ever put on a clipboard. */
export interface ShareOptions {
  readonly date: string;
  readonly score: number;
  readonly lines: number;
  readonly streak: number;
  /** Where to play it. The page's own address; `main.ts` supplies it. */
  readonly url: string;
}

/**
 * The line the copy button puts on the clipboard.
 *
 * Three short lines: what and when, how it went, and where to try it. It
 * deliberately says **nothing about the seed's contents** — no piece order, no
 * opening, nothing that would spoil the day for whoever reads it — and it is
 * plain text, because a share that only pastes into one app is not a share.
 */
export function shareText(options: ShareOptions): string {
  const streak =
    options.streak > 0 ? ` · streak ${formatNumber(options.streak)}` : '';
  return [
    `Mega Tetris — Daily ${options.date}`,
    `${formatNumber(options.score)} points · ${formatNumber(options.lines)} lines${streak}`,
    options.url,
  ].join('\n');
}
