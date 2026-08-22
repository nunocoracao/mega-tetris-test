/**
 * The rules about records, tested as rules.
 *
 * `applyRun` is the only place the game decides what a personal best is, and it
 * is a pure function of "the stats you had" and "the run you just finished", so
 * every case worth arguing about — a tie, a first game, a head start, a run
 * that beats one number and not another — is a two-line test rather than
 * something you would have to play well to discover.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_START_LEVEL,
  applyRun,
  bestFor,
  clampStartLevel,
  defaultStats,
  emptyBest,
  hasAnyBest,
  isHeadStart,
  sanitizeStats,
  type RunSummary,
  type Stats,
} from './stats';

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return { score: 1000, lines: 10, level: 2, startLevel: 1, durationMs: 60_000, ...overrides };
}

describe('start levels', () => {
  it('keeps a level inside the range the picker offers', () => {
    expect(clampStartLevel(1)).toBe(1);
    expect(clampStartLevel(MAX_START_LEVEL)).toBe(MAX_START_LEVEL);
    expect(clampStartLevel(0)).toBe(1);
    expect(clampStartLevel(-5)).toBe(1);
    expect(clampStartLevel(999)).toBe(MAX_START_LEVEL);
    expect(clampStartLevel(3.7)).toBe(3);
  });

  it('treats anything that is not a finite number as the bottom of the ladder', () => {
    // Not "clamp the infinity to ten": a value this far outside the range is a
    // corrupt store rather than an ambitious player, and the safe reading of a
    // corrupt store is always the default.
    expect(clampStartLevel(Number.NaN)).toBe(1);
    expect(clampStartLevel(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('calls anything above level 1 a head start', () => {
    expect(isHeadStart(1)).toBe(false);
    expect(isHeadStart(2)).toBe(true);
    expect(isHeadStart(0)).toBe(false);
  });
});

describe('applyRun', () => {
  it('makes the first finished run the record on every count', () => {
    const update = applyRun(defaultStats(), run({ score: 4200, lines: 12, level: 3 }));

    expect(update.records).toEqual(['score', 'lines', 'level']);
    expect(update.isHighScore).toBe(true);
    expect(update.stats.best).toEqual({
      score: 4200,
      level: 3,
      lines: 12,
      durationMs: 60_000,
    });
  });

  it('counts every run in the totals, record or not', () => {
    const first = applyRun(defaultStats(), run({ lines: 12 }));
    const second = applyRun(first.stats, run({ score: 1, lines: 3 }));

    expect(second.stats.gamesPlayed).toBe(2);
    expect(second.stats.totalLines).toBe(15);
    expect(second.records).toEqual([]);
    expect(second.isHighScore).toBe(false);
  });

  it('does not call equalling a best beating it', () => {
    const first = applyRun(defaultStats(), run());
    const second = applyRun(first.stats, run());

    expect(second.records).toEqual([]);
    expect(second.stats.best).toEqual(first.stats.best);
  });

  it('breaks one record at a time', () => {
    const first = applyRun(defaultStats(), run({ score: 5000, lines: 40, level: 5 }));
    const second = applyRun(first.stats, run({ score: 100, lines: 41, level: 1 }));

    expect(second.records).toEqual(['lines']);
    expect(second.isHighScore).toBe(false);
    expect(second.stats.best).toEqual({ score: 5000, level: 5, lines: 41, durationMs: 60_000 });
  });

  it('reports the bests as they stood before the run, so the panel can compare', () => {
    const first = applyRun(defaultStats(), run({ score: 5000 }));
    const second = applyRun(first.stats, run({ score: 9000 }));

    expect(second.previousBest.score).toBe(5000);
    expect(second.stats.best.score).toBe(9000);
  });

  it('moves the stored duration only with the score record', () => {
    const first = applyRun(defaultStats(), run({ score: 5000, durationMs: 60_000 }));
    // A longer run that scored less: the clock beside the high score is the
    // high score's clock, not the longest one ever played.
    const second = applyRun(first.stats, run({ score: 100, lines: 99, durationMs: 900_000 }));

    expect(second.stats.best.durationMs).toBe(60_000);

    const third = applyRun(second.stats, run({ score: 9000, durationMs: 30_000 }));
    expect(third.stats.best.durationMs).toBe(30_000);
  });

  it('does not congratulate a run that did nothing', () => {
    // Topping out on the opening piece is not a personal best for anything,
    // even though it is technically the first level-1 run ever finished.
    const update = applyRun(defaultStats(), run({ score: 0, lines: 0, level: 1 }));

    expect(update.records).toEqual([]);
    expect(update.isHighScore).toBe(false);
    expect(update.stats.gamesPlayed).toBe(1);
    // The bests still absorb it, so the *next* scoreless run is not a record
    // either — it is the celebration that is withheld, not the bookkeeping.
    expect(update.stats.best.level).toBe(1);
  });

  it('never mutates the stats it was given', () => {
    const before = defaultStats();
    const snapshot = JSON.parse(JSON.stringify(before)) as Stats;

    applyRun(before, run());

    expect(before).toEqual(snapshot);
  });
});

describe('head starts', () => {
  it('keeps a run begun above level 1 off the headline best', () => {
    const update = applyRun(defaultStats(), run({ score: 99_999, startLevel: 8 }));

    expect(update.headStart).toBe(true);
    expect(update.stats.best).toEqual(emptyBest());
    expect(update.stats.headStart.score).toBe(99_999);
  });

  it('still counts it in the totals — those are time spent, not skill', () => {
    const update = applyRun(defaultStats(), run({ lines: 7, startLevel: 4 }));

    expect(update.stats.gamesPlayed).toBe(1);
    expect(update.stats.totalLines).toBe(7);
  });

  it('measures a head start against other head starts, not against level 1', () => {
    const honest = applyRun(defaultStats(), run({ score: 50_000, startLevel: 1 }));
    const assisted = applyRun(honest.stats, run({ score: 1000, startLevel: 6 }));

    // A thousand points would be nothing next to the real best, but it is the
    // first thing on this ladder, so it is a record on it.
    expect(assisted.previousBest).toEqual(emptyBest());
    expect(assisted.isHighScore).toBe(true);
    expect(assisted.stats.best.score).toBe(50_000);
  });

  it('reports the ladder a run belongs to', () => {
    const stats = applyRun(
      applyRun(defaultStats(), run({ score: 500, startLevel: 1 })).stats,
      run({ score: 300, startLevel: 5 }),
    ).stats;

    expect(bestFor(stats, 1).score).toBe(500);
    expect(bestFor(stats, 5).score).toBe(300);
  });
});

describe('hasAnyBest', () => {
  it('is false out of the box and true once anything has been played', () => {
    expect(hasAnyBest(defaultStats())).toBe(false);
    expect(hasAnyBest(applyRun(defaultStats(), run({ score: 0, lines: 0 })).stats)).toBe(true);
  });
});

describe('sanitizeStats', () => {
  it('turns anything at all into usable stats', () => {
    for (const raw of [null, undefined, 7, 'nope', [], true, { best: 'no' }]) {
      expect(sanitizeStats(raw)).toEqual(defaultStats());
    }
  });

  it('keeps the numbers it recognises and drops the ones it does not', () => {
    const stats = sanitizeStats({
      best: { score: 1234, level: 5, lines: '40', durationMs: -1 },
      headStart: { score: Number.NaN },
      gamesPlayed: 3.9,
      totalLines: Number.POSITIVE_INFINITY,
    });

    expect(stats.best).toEqual({ score: 1234, level: 5, lines: 0, durationMs: 0 });
    expect(stats.headStart).toEqual(emptyBest());
    expect(stats.gamesPlayed).toBe(3);
    expect(stats.totalLines).toBe(0);
  });

  it('round-trips its own output', () => {
    const stats = applyRun(defaultStats(), run()).stats;

    expect(sanitizeStats(JSON.parse(JSON.stringify(stats)))).toEqual(stats);
  });
});
