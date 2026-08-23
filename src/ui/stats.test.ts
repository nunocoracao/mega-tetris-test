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

import { SPRINT_GOAL_LINES } from '../engine';
import {
  MAX_START_LEVEL,
  applyRun,
  bestFor,
  clampStartLevel,
  defaultStats,
  emptyBest,
  emptyModeBests,
  hasAnyBest,
  isHeadStart,
  isSprintFinish,
  recordsFor,
  sanitizeStats,
  type RunSummary,
  type Stats,
} from './stats';

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    mode: 'marathon',
    outcome: 'toppedOut',
    score: 1000,
    lines: 10,
    level: 2,
    startLevel: 1,
    durationMs: 60_000,
    ...overrides,
  };
}

/** A finished Sprint: forty lines, in `durationMs`. */
function sprint(overrides: Partial<RunSummary> = {}): RunSummary {
  return run({
    mode: 'sprint',
    outcome: 'goalReached',
    lines: SPRINT_GOAL_LINES,
    durationMs: 102_000,
    ...overrides,
  });
}

/** An Ultra that ran its two minutes out. */
function ultra(overrides: Partial<RunSummary> = {}): RunSummary {
  return run({ mode: 'ultra', outcome: 'timeUp', durationMs: 120_000, ...overrides });
}

/** Marathon's honest ladder, which is where the plain `run` above lands. */
function marathonBest(stats: Stats) {
  return stats.modes.marathon.base;
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
    expect(update.isHeadlineRecord).toBe(true);
    expect(marathonBest(update.stats)).toEqual({
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
    expect(second.isHeadlineRecord).toBe(false);
  });

  it('does not call equalling a best beating it', () => {
    const first = applyRun(defaultStats(), run());
    const second = applyRun(first.stats, run());

    expect(second.records).toEqual([]);
    expect(marathonBest(second.stats)).toEqual(marathonBest(first.stats));
  });

  it('breaks one record at a time', () => {
    const first = applyRun(defaultStats(), run({ score: 5000, lines: 40, level: 5 }));
    const second = applyRun(first.stats, run({ score: 100, lines: 41, level: 1 }));

    expect(second.records).toEqual(['lines']);
    expect(second.isHeadlineRecord).toBe(false);
    expect(marathonBest(second.stats)).toEqual({ score: 5000, level: 5, lines: 41, durationMs: 60_000 });
  });

  it('reports the bests as they stood before the run, so the panel can compare', () => {
    const first = applyRun(defaultStats(), run({ score: 5000 }));
    const second = applyRun(first.stats, run({ score: 9000 }));

    expect(second.previousBest.score).toBe(5000);
    expect(marathonBest(second.stats).score).toBe(9000);
  });

  it('moves the stored duration only with the score record', () => {
    const first = applyRun(defaultStats(), run({ score: 5000, durationMs: 60_000 }));
    // A longer run that scored less: the clock beside the high score is the
    // high score's clock, not the longest one ever played.
    const second = applyRun(first.stats, run({ score: 100, lines: 99, durationMs: 900_000 }));

    expect(marathonBest(second.stats).durationMs).toBe(60_000);

    const third = applyRun(second.stats, run({ score: 9000, durationMs: 30_000 }));
    expect(marathonBest(third.stats).durationMs).toBe(30_000);
  });

  it('does not congratulate a run that did nothing', () => {
    // Topping out on the opening piece is not a personal best for anything,
    // even though it is technically the first level-1 run ever finished.
    const update = applyRun(defaultStats(), run({ score: 0, lines: 0, level: 1 }));

    expect(update.records).toEqual([]);
    expect(update.isHeadlineRecord).toBe(false);
    expect(update.stats.gamesPlayed).toBe(1);
    // The bests still absorb it, so the *next* scoreless run is not a record
    // either — it is the celebration that is withheld, not the bookkeeping.
    expect(marathonBest(update.stats).level).toBe(1);
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
    expect(marathonBest(update.stats)).toEqual(emptyBest());
    expect(update.stats.modes.marathon.headStart.score).toBe(99_999);
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
    expect(assisted.isHeadlineRecord).toBe(true);
    expect(marathonBest(assisted.stats).score).toBe(50_000);
  });

  it('reports the ladder a run belongs to', () => {
    const stats = applyRun(
      applyRun(defaultStats(), run({ score: 500, startLevel: 1 })).stats,
      run({ score: 300, startLevel: 5 }),
    ).stats;

    expect(bestFor(stats, 'marathon', 1).score).toBe(500);
    expect(bestFor(stats, 'marathon', 5).score).toBe(300);
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
      modes: {
        marathon: {
          base: { score: 1234, level: 5, lines: '40', durationMs: -1 },
          headStart: { score: Number.NaN },
        },
      },
      gamesPlayed: 3.9,
      totalLines: Number.POSITIVE_INFINITY,
    });

    expect(stats.modes.marathon.base).toEqual({ score: 1234, level: 5, lines: 0, durationMs: 0 });
    expect(stats.modes.marathon.headStart).toEqual(emptyBest());
    expect(stats.gamesPlayed).toBe(3);
    expect(stats.totalLines).toBe(0);
  });

  it('gives every mode a record book, even one the store has never heard of', () => {
    expect(sanitizeStats({ modes: { marathon: {} } }).modes.sprint).toEqual(emptyModeBests());
    expect(sanitizeStats({ modes: 'nope' }).modes.ultra).toEqual(emptyModeBests());
  });

  it('round-trips its own output', () => {
    const stats = applyRun(defaultStats(), run()).stats;

    expect(sanitizeStats(JSON.parse(JSON.stringify(stats)))).toEqual(stats);
  });
});

// ---------------------------------------------------------------------------
// One record book per mode
// ---------------------------------------------------------------------------

describe('a mode keeps its own records', () => {
  it('races each mode on the number that mode is played for', () => {
    expect(recordsFor('marathon')).toEqual(['score', 'lines', 'level']);
    expect(recordsFor('ultra')).toEqual(['score', 'lines', 'level']);
    // A completed sprint is always forty lines, so "most lines" would be a
    // record every player ties on their first finish. The clock is the race.
    expect(recordsFor('sprint')).toEqual(['time']);
  });

  it('does not let a run in one mode touch another mode’s bests', () => {
    const stats = applyRun(defaultStats(), run({ score: 50_000 })).stats;
    const after = applyRun(stats, ultra({ score: 100 }));

    expect(marathonBest(after.stats).score).toBe(50_000);
    expect(after.stats.modes.ultra.base.score).toBe(100);
    // Beating nothing on the Ultra ladder is still a record on the Ultra
    // ladder, however far short of the Marathon high score it is.
    expect(after.isHeadlineRecord).toBe(true);
    expect(after.previousBest).toEqual(emptyBest());
  });

  it('counts every mode in the totals', () => {
    const one = applyRun(defaultStats(), sprint()).stats;
    const two = applyRun(one, ultra({ lines: 21 })).stats;

    expect(two.gamesPlayed).toBe(2);
    expect(two.totalLines).toBe(SPRINT_GOAL_LINES + 21);
  });
});

describe('a Sprint best is a time, and lower wins', () => {
  it('takes the first finished forty as the record', () => {
    const update = applyRun(defaultStats(), sprint({ durationMs: 102_000 }));

    expect(update.records).toEqual(['time']);
    expect(update.isHeadlineRecord).toBe(true);
    expect(update.stats.modes.sprint.base.durationMs).toBe(102_000);
  });

  it('is beaten by a faster run and not by a slower one', () => {
    const first = applyRun(defaultStats(), sprint({ durationMs: 102_000 })).stats;
    const slower = applyRun(first, sprint({ durationMs: 140_000 }));
    const faster = applyRun(slower.stats, sprint({ durationMs: 91_500 }));

    expect(slower.records).toEqual([]);
    expect(slower.stats.modes.sprint.base.durationMs).toBe(102_000);
    expect(faster.records).toEqual(['time']);
    expect(faster.stats.modes.sprint.base.durationMs).toBe(91_500);
  });

  it('does not call equalling a time beating it', () => {
    const first = applyRun(defaultStats(), sprint({ durationMs: 102_000 })).stats;
    const tie = applyRun(first, sprint({ durationMs: 102_000 }));

    expect(tie.records).toEqual([]);
  });

  it('replaces the whole record with the run that set it', () => {
    // A best time is a run, not a collection of high-water marks: the score
    // and level beside it belong to the fastest forty, not to the best forty.
    const first = applyRun(defaultStats(), sprint({ durationMs: 102_000, score: 9_000, level: 5 }))
      .stats;
    const faster = applyRun(first, sprint({ durationMs: 91_500, score: 4_000, level: 4 }));

    expect(faster.stats.modes.sprint.base).toEqual({
      score: 4_000,
      level: 4,
      lines: SPRINT_GOAL_LINES,
      durationMs: 91_500,
    });
  });
});

describe('a Sprint that did not finish', () => {
  const dnf = (overrides: Partial<RunSummary> = {}): RunSummary =>
    sprint({ outcome: 'toppedOut', lines: 23, durationMs: 45_000, ...overrides });

  it('is a did-not-finish, not a fast time', () => {
    expect(isSprintFinish(sprint())).toBe(true);
    expect(isSprintFinish(dnf())).toBe(false);
  });

  it('sets no time record, however quickly it fell over', () => {
    const update = applyRun(defaultStats(), dnf({ durationMs: 12_000 }));

    expect(update.records).toEqual([]);
    expect(update.isHeadlineRecord).toBe(false);
    expect(update.stats.modes.sprint.base).toEqual(emptyBest());
  });

  it('cannot take a standing record off a run that actually finished', () => {
    const finished = applyRun(defaultStats(), sprint({ durationMs: 102_000 })).stats;
    const after = applyRun(finished, dnf({ durationMs: 8_000 }));

    expect(after.records).toEqual([]);
    expect(after.stats.modes.sprint.base.durationMs).toBe(102_000);
  });

  it('still counts in the totals — it was still a game played', () => {
    const update = applyRun(defaultStats(), dnf({ lines: 23 }));

    expect(update.stats.gamesPlayed).toBe(1);
    expect(update.stats.totalLines).toBe(23);
  });
});

describe('head starts, per mode', () => {
  it('keeps a Sprint begun above level 1 on its own ladder', () => {
    const update = applyRun(defaultStats(), sprint({ startLevel: 6, durationMs: 61_000 }));

    expect(update.headStart).toBe(true);
    expect(update.stats.modes.sprint.base).toEqual(emptyBest());
    expect(update.stats.modes.sprint.headStart.durationMs).toBe(61_000);
  });

  it('does not let a head-start Sprint beat an honest one', () => {
    const honest = applyRun(defaultStats(), sprint({ durationMs: 102_000 })).stats;
    const assisted = applyRun(honest, sprint({ startLevel: 9, durationMs: 55_000 }));

    expect(assisted.stats.modes.sprint.base.durationMs).toBe(102_000);
    expect(bestFor(assisted.stats, 'sprint', 9).durationMs).toBe(55_000);
    expect(bestFor(assisted.stats, 'sprint', 1).durationMs).toBe(102_000);
  });
});

describe('an Ultra best is a score', () => {
  it('is raced on the score and never on the clock', () => {
    const first = applyRun(defaultStats(), ultra({ score: 8_400 })).stats;
    // Every Ultra that runs its course lasts exactly two minutes, so a shorter
    // one is a run that ended early — never a better one.
    const shorter = applyRun(first, ultra({ score: 100, outcome: 'toppedOut', durationMs: 40_000 }));

    expect(shorter.records).toEqual([]);
    expect(shorter.stats.modes.ultra.base.score).toBe(8_400);
  });

  it('records a run that topped out early for whatever it scored', () => {
    const update = applyRun(
      defaultStats(),
      ultra({ score: 3_000, outcome: 'toppedOut', durationMs: 71_000 }),
    );

    expect(update.records).toContain('score');
    expect(update.stats.modes.ultra.base.score).toBe(3_000);
    expect(update.stats.modes.ultra.base.durationMs).toBe(71_000);
  });
});
