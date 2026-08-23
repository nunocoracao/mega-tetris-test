/**
 * The daily challenge's record: streaks, history and the words around them.
 *
 * Every function under test takes the date as an argument, so all of this is
 * fixed dates and plain data — no fake timers, no mocked `Date`, no test that
 * only passes in one timezone or only on a Tuesday. That was the point of
 * making the clock `src/main.ts`'s problem: the interesting arithmetic is right
 * here, and it is arithmetic.
 */

import { describe, expect, it } from 'vitest';

import {
  DAILY_HISTORY_DAYS,
  applyDailyRun,
  cellLabel,
  dailyButtonLabel,
  dailyEntryOn,
  dailyRunNote,
  dailyStanding,
  dailyStatusLine,
  dailyStreakLine,
  dayCount,
  dayNumber,
  dayOffset,
  daysBetween,
  defaultDaily,
  formatDay,
  hasPlayedOn,
  historyCells,
  lastDailyDate,
  ordinal,
  sanitizeDaily,
  shareText,
  standingLine,
  streakOn,
  type DailyEntry,
  type DailyStats,
} from './daily';

function entry(date: string, overrides: Partial<DailyEntry> = {}): DailyEntry {
  return { date, score: 1_000, lines: 10, level: 2, durationMs: 60_000, ...overrides };
}

/** A record built by playing the given days in order, as a player would. */
function played(...days: readonly (string | DailyEntry)[]): DailyStats {
  return days.reduce<DailyStats>(
    (stats, day) => applyDailyRun(stats, typeof day === 'string' ? entry(day) : day),
    defaultDaily(),
  );
}

// ---------------------------------------------------------------------------

describe('date arithmetic', () => {
  it('reads a date stamp as a day number', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('1970-01-02')).toBe(1);
    expect(dayNumber('2026-08-23')).toBe(20_688);
  });

  it('rejects a day that does not exist rather than rolling it over', () => {
    // `Date.UTC` would happily turn this into the 3rd of March, which is how a
    // corrupt store could quietly acquire a day nobody played.
    expect(dayNumber('2026-02-31')).toBeNull();
    expect(dayNumber('2025-02-29')).toBeNull();
    expect(dayNumber('2026-04-31')).toBeNull();
    expect(dayNumber('not a day')).toBeNull();
  });

  it('knows which Februaries have a 29th', () => {
    expect(dayNumber('2024-02-29')).not.toBeNull();
    expect(dayNumber('2000-02-29')).not.toBeNull();
    expect(dayNumber('1900-02-29')).toBeNull();
  });

  it('steps forwards and backwards across every kind of boundary', () => {
    expect(dayOffset('2026-08-23', 1)).toBe('2026-08-24');
    expect(dayOffset('2026-08-23', -1)).toBe('2026-08-22');
    expect(dayOffset('2026-08-31', 1)).toBe('2026-09-01');
    expect(dayOffset('2026-12-31', 1)).toBe('2027-01-01');
    expect(dayOffset('2027-01-01', -1)).toBe('2026-12-31');
    expect(dayOffset('2024-02-28', 1)).toBe('2024-02-29');
    expect(dayOffset('2026-08-23', -30)).toBe('2026-07-24');
    expect(dayOffset('nonsense', 1)).toBeNull();
  });

  it('counts the days between two dates, signed', () => {
    expect(daysBetween('2026-08-23', '2026-08-24')).toBe(1);
    expect(daysBetween('2026-08-23', '2026-08-23')).toBe(0);
    expect(daysBetween('2026-08-24', '2026-08-23')).toBe(-1);
    expect(daysBetween('2026-08-23', '2026-09-22')).toBe(30);
    expect(daysBetween('2026-08-23', 'never')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the streak', () => {
  it('is zero before anything has ever been played', () => {
    const stats = defaultDaily();

    expect(streakOn(stats, '2026-08-23')).toBe(0);
    expect(lastDailyDate(stats)).toBeNull();
    expect(hasPlayedOn(stats, '2026-08-23')).toBe(false);
  });

  it('starts at one on the first day ever played', () => {
    const stats = played('2026-08-23');

    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(1);
    expect(streakOn(stats, '2026-08-23')).toBe(1);
    expect(stats.history).toEqual([entry('2026-08-23')]);
  });

  it('grows by one on a consecutive day', () => {
    const stats = played('2026-08-21', '2026-08-22', '2026-08-23');

    expect(stats.currentStreak).toBe(3);
    expect(stats.longestStreak).toBe(3);
    expect(streakOn(stats, '2026-08-23')).toBe(3);
  });

  it('breaks on a one-day gap and starts again at one', () => {
    // Played the 21st and the 23rd. The 22nd was missed, and that is the whole
    // rule: a streak is consecutive days, and softening it would make the
    // number worthless.
    const stats = played('2026-08-21', '2026-08-23');

    expect(stats.currentStreak).toBe(1);
    expect(stats.history).toHaveLength(2);
  });

  it('remembers the longest streak after a break', () => {
    const stats = played('2026-08-18', '2026-08-19', '2026-08-20', '2026-08-23');

    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(3);
  });

  it('does nothing at all the second time the same day is recorded', () => {
    const once = played('2026-08-22', '2026-08-23');

    const twice = applyDailyRun(once, entry('2026-08-23', { score: 999_999 }));

    expect(twice).toEqual(once);
    expect(twice.currentStreak).toBe(2);
    expect(dailyEntryOn(twice, '2026-08-23')?.score).toBe(1_000);
  });

  it('ignores a day older than the last one recorded', () => {
    // A clock that went backwards, or a store carried between machines. Either
    // way, rewriting history is not the answer.
    const stats = played('2026-08-23');

    expect(applyDailyRun(stats, entry('2026-08-20'))).toEqual(stats);
  });

  it('ignores an entry whose date is not a real day', () => {
    const stats = played('2026-08-23');

    expect(applyDailyRun(stats, entry('2026-02-31'))).toEqual(stats);
    expect(applyDailyRun(defaultDaily(), entry('tomorrow'))).toEqual(defaultDaily());
  });

  it('survives a month and a year boundary without noticing', () => {
    const stats = played('2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02');

    expect(stats.currentStreak).toBe(4);
  });

  it('is still alive the morning after, before today has been played', () => {
    // A player who has not opened the game yet today has not lost anything.
    const stats = played('2026-08-21', '2026-08-22');

    expect(streakOn(stats, '2026-08-23')).toBe(2);
    expect(hasPlayedOn(stats, '2026-08-23')).toBe(false);
  });

  it('is broken by the time the day after that comes round', () => {
    const stats = played('2026-08-21', '2026-08-22');

    expect(streakOn(stats, '2026-08-24')).toBe(0);
    // The stored counter is untouched — it is what the *next* run builds on,
    // and `applyDailyRun` is the only thing allowed to move it.
    expect(stats.currentStreak).toBe(2);
  });

  it('keeps counting past the history window', () => {
    // Forty consecutive days: the history only holds thirty of them, and the
    // streak has to be the forty it actually was. This is the whole reason the
    // counter is stored rather than derived.
    let stats = defaultDaily();
    for (let day = 0; day < 40; day += 1) {
      stats = applyDailyRun(stats, entry(dayOffset('2026-07-15', day) as string));
    }

    expect(stats.currentStreak).toBe(40);
    expect(stats.longestStreak).toBe(40);
    expect(stats.history).toHaveLength(DAILY_HISTORY_DAYS);
    expect(lastDailyDate(stats)).toBe('2026-08-23');
  });
});

// ---------------------------------------------------------------------------

describe('sanitizeDaily', () => {
  it('turns anything at all into a usable record', () => {
    for (const raw of [null, undefined, 42, 'daily', [], { history: 'yesterday' }]) {
      expect(sanitizeDaily(raw)).toEqual(defaultDaily());
    }
  });

  it('drops entries that are not real days and repairs the numbers', () => {
    const daily = sanitizeDaily({
      history: [
        { date: '2026-08-23', score: -5, lines: 1.7, level: 'three', durationMs: null },
        { date: '2026-02-31', score: 100 },
        'not an entry',
        null,
      ],
      currentStreak: 1,
      longestStreak: 1,
    });

    expect(daily.history).toEqual([
      { date: '2026-08-23', score: 0, lines: 1, level: 0, durationMs: 0 },
    ]);
  });

  it('puts the history in order and keeps one entry per day', () => {
    const daily = sanitizeDaily({
      history: [entry('2026-08-24'), entry('2026-08-22'), entry('2026-08-24', { score: 9 })],
    });

    expect(daily.history.map((item) => item.date)).toEqual(['2026-08-22', '2026-08-24']);
    expect(dailyEntryOn(daily, '2026-08-24')?.score).toBe(1_000);
  });

  it('caps the history at the window even when the store holds more', () => {
    const history = Array.from({ length: 60 }, (_, index) =>
      entry(dayOffset('2026-06-01', index) as string),
    );

    const daily = sanitizeDaily({ history });

    expect(daily.history).toHaveLength(DAILY_HISTORY_DAYS);
    // The *newest* thirty, not the oldest.
    expect(lastDailyDate(daily)).toBe(dayOffset('2026-06-01', 59));
  });

  it('never lets the longest streak be shorter than the current one', () => {
    expect(sanitizeDaily({ currentStreak: 9, longestStreak: 2 }).longestStreak).toBe(9);
  });
});

// ---------------------------------------------------------------------------

describe('where a run stands', () => {
  const stats = played(
    entry('2026-08-20', { score: 5_000 }),
    entry('2026-08-21', { score: 9_000 }),
    entry('2026-08-22', { score: 1_000 }),
    entry('2026-08-23', { score: 7_000 }),
  );

  it('ranks a day against the rest of the history', () => {
    expect(dailyStanding(stats, '2026-08-21')).toEqual({ rank: 1, total: 4 });
    expect(dailyStanding(stats, '2026-08-23')).toEqual({ rank: 2, total: 4 });
    expect(dailyStanding(stats, '2026-08-22')).toEqual({ rank: 4, total: 4 });
  });

  it('has nothing to say about a day that was never played', () => {
    expect(dailyStanding(stats, '2026-08-19')).toBeNull();
  });

  it('phrases the first run, the best run and the rest differently', () => {
    expect(standingLine({ rank: 1, total: 1 })).toBe('Your first daily run.');
    expect(standingLine({ rank: 1, total: 12 })).toBe('Your best daily yet.');
    expect(standingLine({ rank: 3, total: 12 })).toBe('Your third best of 12.');
    expect(standingLine({ rank: 12, total: 30 })).toBe('Your 12th best of 30.');
  });

  it('counts out loud in words for the numbers people say in words', () => {
    expect(ordinal(1)).toBe('first');
    expect(ordinal(10)).toBe('tenth');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(22)).toBe('22nd');
    expect(ordinal(23)).toBe('23rd');
    expect(ordinal(24)).toBe('24th');
  });
});

// ---------------------------------------------------------------------------

describe('the history strip', () => {
  it('is always a full window, oldest first, ending today', () => {
    const cells = historyCells(defaultDaily(), '2026-08-23');

    expect(cells).toHaveLength(DAILY_HISTORY_DAYS);
    expect(cells[0]?.date).toBe('2026-07-25');
    expect(cells[DAILY_HISTORY_DAYS - 1]?.date).toBe('2026-08-23');
    expect(cells[DAILY_HISTORY_DAYS - 1]?.isToday).toBe(true);
    expect(cells.filter((cell) => cell.isToday)).toHaveLength(1);
  });

  it('marks the days that were missed', () => {
    const cells = historyCells(played('2026-08-22'), '2026-08-23');
    const byDate = new Map(cells.map((cell) => [cell.date, cell]));

    expect(byDate.get('2026-08-22')?.played).toBe(true);
    expect(byDate.get('2026-08-23')?.played).toBe(false);
    expect(byDate.get('2026-08-23')?.tier).toBe(0);
  });

  it('tints a played day by how it went, against the best in the window', () => {
    const stats = played(
      entry('2026-08-20', { score: 1_000 }),
      entry('2026-08-21', { score: 4_000 }),
      entry('2026-08-22', { score: 6_000 }),
      entry('2026-08-23', { score: 8_000 }),
    );

    const byDate = new Map(historyCells(stats, '2026-08-23').map((cell) => [cell.date, cell]));

    expect(byDate.get('2026-08-20')?.tier).toBe(1); // an eighth of the best
    expect(byDate.get('2026-08-21')?.tier).toBe(2); // a half
    expect(byDate.get('2026-08-22')?.tier).toBe(3); // three quarters
    expect(byDate.get('2026-08-23')?.tier).toBe(4); // the best itself
  });

  it('labels every cell with a date and a result, not a colour', () => {
    const stats = played(entry('2026-08-22', { score: 4_200, lines: 12 }));
    const cells = historyCells(stats, '2026-08-23');

    const labels = cells.map(cellLabel);
    expect(labels).toHaveLength(DAILY_HISTORY_DAYS);
    for (const label of labels) {
      expect(label).not.toBe('');
    }
    expect(labels).toContain('22 August 2026: 4,200 points, 12 lines.');
    expect(labels).toContain('23 August 2026 (today): not played yet.');
    expect(labels).toContain('25 July 2026: not played.');
  });
});

// ---------------------------------------------------------------------------

describe('the words on the panel', () => {
  it('writes a date the way a person reads one', () => {
    expect(formatDay('2026-08-23')).toBe('23 August 2026');
    expect(formatDay('2026-01-01')).toBe('1 January 2026');
    expect(formatDay('2026-12-31')).toBe('31 December 2026');
    // A date it cannot read is still a date a player can.
    expect(formatDay('whenever')).toBe('whenever');
  });

  it('counts days singly and plurally', () => {
    expect(dayCount(1)).toBe('1 day');
    expect(dayCount(2)).toBe('2 days');
    expect(dayCount(1_000)).toBe('1,000 days');
  });

  it('says whether today is still waiting', () => {
    expect(dailyStatusLine(defaultDaily(), '2026-08-23')).toContain('23 August 2026');
    expect(dailyStatusLine(defaultDaily(), '2026-08-23')).toContain('waiting');

    const stats = played(entry('2026-08-23', { score: 4_200, lines: 12 }));
    expect(dailyStatusLine(stats, '2026-08-23')).toBe(
      '23 August 2026 — played: 4,200 points, 12 lines.',
    );
  });

  it('offers a first streak, reports a live one and mourns a broken one', () => {
    expect(dailyStreakLine(defaultDaily(), '2026-08-23')).toBe(
      'No streak yet — today is a good day to start one.',
    );
    expect(dailyStreakLine(played('2026-08-22', '2026-08-23'), '2026-08-23')).toBe(
      'Streak: 2 days (longest 2 days).',
    );
    expect(dailyStreakLine(played('2026-08-01'), '2026-08-23')).toBe(
      'Streak broken. Your longest was 1 day.',
    );
  });

  it('offers the day, then practice once the day is spent', () => {
    expect(dailyButtonLabel(defaultDaily(), '2026-08-23')).toBe('Play today’s daily');
    expect(dailyButtonLabel(played('2026-08-23'), '2026-08-23')).toBe('Practice today’s seed');
  });

  it('says where a recorded run landed, and how long the streak is', () => {
    const note = dailyRunNote({
      date: '2026-08-23',
      practice: false,
      standing: { rank: 3, total: 12 },
      streak: 5,
    });

    expect(note).toBe(
      'Daily challenge, 23 August 2026. Your third best of 12. Streak: 5 days.',
    );
  });

  it('says plainly that a practice run is not recorded', () => {
    const note = dailyRunNote({ date: '2026-08-23', practice: true });

    expect(note).toContain('Practice');
    expect(note).toContain('not recorded');
    // And nothing about standings or streaks, which it did not earn.
    expect(note).not.toContain('best');
    expect(note).not.toContain('Streak');
  });
});

// ---------------------------------------------------------------------------

describe('the shareable line', () => {
  const options = {
    date: '2026-08-23',
    score: 12_400,
    lines: 42,
    streak: 5,
    url: 'https://example.test/mega-tetris/',
  };

  it('is three lines: what, how it went, and where', () => {
    expect(shareText(options)).toBe(
      [
        'Mega Tetris — Daily 2026-08-23',
        '12,400 points · 42 lines · streak 5',
        'https://example.test/mega-tetris/',
      ].join('\n'),
    );
  });

  it('leaves the streak out when there is not one', () => {
    const text = shareText({ ...options, streak: 0 });

    expect(text).toContain('12,400 points · 42 lines');
    expect(text).not.toContain('streak');
  });

  it('gives nothing away about the seed', () => {
    // The whole appeal of a shared seed is that the other player meets it
    // fresh. Anything about the piece order in here would spoil the day.
    const text = shareText(options);

    for (const spoiler of ['seed', 'I', 'O', 'T', 'S', 'Z', 'J', 'L']) {
      expect(text.split('\n')[1]).not.toContain(spoiler);
    }
  });

  it('is plain text with no markup in it', () => {
    expect(shareText(options)).not.toMatch(/[<>]/);
  });
});
