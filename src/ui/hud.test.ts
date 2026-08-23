import { describe, expect, it } from 'vitest';

import {
  applyInput,
  boardFromStrings,
  createGame,
  type GameEvent,
  type GameState,
} from '../engine';
import {
  CLEAR_NAMES,
  COMBO_ANNOUNCE_STEP,
  MENU_STATS,
  announcesCombo,
  bestLine,
  clearName,
  comboName,
  describeEvent,
  describeHold,
  describePlayfield,
  describeQueue,
  describeRunEnd,
  formatDuration,
  formatNumber,
  menuStatValues,
  overlayContent,
  playButtonLabel,
  spinName,
  stackHeight,
  summaryLine,
} from './hud';
import { applyRun, defaultStats, type RunSummary } from './stats';

const ready = createGame({ seed: 7 });
const playing = applyInput(ready, { type: 'resume' });
const paused = applyInput(playing, { type: 'pause' });
const over: GameState = { ...playing, status: 'over', score: 12_345, level: 4 };

describe('formatNumber', () => {
  it('groups thousands', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(1_234_567)).toBe('1,234,567');
  });
});

describe('overlayContent', () => {
  it('covers the well whenever the game is not live', () => {
    expect(overlayContent(ready)?.button).toBe('Play');
    expect(overlayContent(paused)?.title).toBe('Paused');
    expect(overlayContent(over)?.hint).toContain('12,345');
  });

  it('gets out of the way while playing', () => {
    expect(overlayContent(playing)).toBeNull();
  });

  it('tells a touch player about gestures rather than about keys', () => {
    expect(overlayContent(ready, { touch: true })?.hint).toMatch(/drag/i);
    expect(overlayContent(ready, { touch: true })?.hint).not.toMatch(/arrow/i);
    expect(overlayContent(paused, { touch: true })?.hint).not.toMatch(/press/i);

    // Everything else reads the same whichever controls are in front of them.
    expect(overlayContent(over, { touch: true })?.hint).toBe(overlayContent(over)?.hint);
    expect(overlayContent(playing, { touch: true })).toBeNull();
  });
});

describe('playButtonLabel', () => {
  it('says what pressing it will do', () => {
    expect(playButtonLabel(ready)).toBe('Play');
    expect(playButtonLabel(playing)).toBe('Pause');
    expect(playButtonLabel(paused)).toBe('Resume');
    expect(playButtonLabel(over)).toBe('Play again');
  });
});

/** A `rowsCleared` event with the boring fields already filled in. */
function cleared(
  extra: Partial<Extract<GameEvent, { type: 'rowsCleared' }>> = {},
): Extract<GameEvent, { type: 'rowsCleared' }> {
  return {
    type: 'rowsCleared',
    kind: 'T',
    rows: [20],
    count: 1,
    quad: false,
    spin: 'none',
    combo: 1,
    backToBack: false,
    backToBackChain: 0,
    points: 100,
    ...extra,
  };
}

describe('describeEvent', () => {
  it('announces the things worth hearing', () => {
    expect(describeEvent(cleared({ rows: [20], count: 1, points: 100 }))).toBe(
      '1 line cleared, 100 points.',
    );
    expect(
      describeEvent(
        cleared({
          rows: [17, 18, 19, 20],
          count: 4,
          quad: true,
          backToBack: true,
          backToBackChain: 2,
          points: 1600,
        }),
      ),
    ).toBe('4 lines cleared, back to back, 1,600 points.');
    expect(describeEvent({ type: 'levelUp', level: 3, previousLevel: 2 })).toBe('Level 3.');
    expect(describeEvent({ type: 'gameOver', score: 4200, lines: 21, level: 3 })).toContain('4,200');
  });

  it('stays quiet about the constant background chatter', () => {
    expect(describeEvent({ type: 'spawn', kind: 'T' })).toBeNull();
    expect(describeEvent({ type: 'lock', kind: 'T', cells: [] })).toBeNull();
    expect(describeEvent({ type: 'hardDrop', kind: 'T', distance: 4 })).toBeNull();
    // A hold is a thing the *player* just did, and they can see the slot. It
    // used to be announced; interrupting on every one is exactly the chatter a
    // live region has to stay out of.
    expect(describeEvent({ type: 'hold', held: 'T', active: 'I' })).toBeNull();
  });
});

describe('stackHeight', () => {
  it('is zero on an empty well', () => {
    expect(stackHeight(playing)).toBe(0);
  });

  it('measures from the floor up to the highest filled row', () => {
    const board = boardFromStrings([
      ...Array.from({ length: 20 }, () => '..........'),
      'T.........',
      'TTT.......',
    ]);

    expect(stackHeight({ ...playing, board })).toBe(2);
  });
});

describe('describeQueue and describeHold', () => {
  it('read the queue out in order', () => {
    expect(describeQueue({ ...playing, next: ['I', 'O', 'T', 'S'] })).toBe(
      'Next: I, then O, then T.',
    );
    expect(describeQueue({ ...playing, next: [] })).toBe('Next: nothing queued.');
  });

  it('says whether the hold slot can still be used', () => {
    expect(describeHold({ ...playing, hold: null })).toBe('Hold is empty.');
    expect(describeHold({ ...playing, hold: 'L', holdLocked: false })).toBe('Holding L.');
    expect(describeHold({ ...playing, hold: 'L', holdLocked: true })).toContain(
      'Already used this piece',
    );
  });
});

describe('describePlayfield', () => {
  it('is the canvas in words: shape, numbers, queue and slot', () => {
    const text = describePlayfield({
      ...playing,
      score: 1200,
      level: 2,
      lines: 14,
      next: ['I', 'O', 'T'],
      hold: 'S',
    });

    expect(text).toContain('Playfield, 10 columns wide.');
    expect(text).toContain('The well is empty.');
    expect(text).toContain('Score 1,200, level 2, 14 lines cleared.');
    expect(text).toContain('Next: I, then O, then T.');
    expect(text).toContain('Holding S.');
  });

  it('says nothing about where the falling piece is', () => {
    // A description that changed on every gravity tick would be unusable, and
    // the live region would be reading it out. Position is deliberately absent.
    const high = describePlayfield(playing);
    const lower = describePlayfield({
      ...playing,
      active: playing.active === null ? null : { ...playing.active, y: 12, x: 3 },
    });

    expect(lower).toBe(high);
  });

  it('names the status when the game is not live', () => {
    expect(describePlayfield(paused)).toContain('Paused.');
    expect(describePlayfield(over)).toContain('Game over.');
    expect(describePlayfield(ready)).toContain('Ready to play.');
    expect(describePlayfield(playing)).not.toContain('Paused');
  });
});


// ---------------------------------------------------------------------------
// Persistence, stats and the one-more-game loop
// ---------------------------------------------------------------------------

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return { score: 4200, lines: 12, level: 3, startLevel: 1, durationMs: 161_000, ...overrides };
}

describe('formatDuration', () => {
  it('reads as a clock, without an hour nobody played', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9_400)).toBe('0:09');
    expect(formatDuration(161_000)).toBe('2:41');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });

  it('never shows a negative clock', () => {
    expect(formatDuration(-5000)).toBe('0:00');
  });
});

describe('summaryLine', () => {
  it('leads with what the player did, not with what happened to them', () => {
    expect(summaryLine(run())).toBe('12 lines, level 3, 4,200 points');
  });

  it('counts one line as one line', () => {
    expect(summaryLine(run({ lines: 1 }))).toBe('1 line, level 3, 4,200 points');
  });
});

describe('bestLine', () => {
  it('says all three numbers of a personal best', () => {
    const stats = applyRun(defaultStats(), run()).stats;

    expect(bestLine(stats.best)).toBe('4,200 points, level 3, 12 lines');
  });
});

describe('describeRunEnd', () => {
  it('celebrates a high score out loud, not only on the panel', () => {
    const update = applyRun(defaultStats(), run());

    expect(describeRunEnd(update)).toContain('A new high score!');
  });

  it('distinguishes a lesser record from the headline one', () => {
    const first = applyRun(defaultStats(), run({ score: 9000, lines: 5 })).stats;
    const update = applyRun(first, run({ score: 100, lines: 40 }));

    expect(describeRunEnd(update)).toContain('A new personal best.');
    expect(describeRunEnd(update)).not.toContain('high score');
  });

  it('names the target to beat when nothing was broken', () => {
    const first = applyRun(defaultStats(), run({ score: 9000, lines: 40, level: 9 })).stats;
    const update = applyRun(first, run({ score: 100, lines: 1, level: 1 }));

    expect(describeRunEnd(update)).toContain('Your best is 9,000.');
  });

  it('does not mention a best of nothing on a first, scoreless game', () => {
    const update = applyRun(defaultStats(), run({ score: 0, lines: 0, level: 1 }));

    expect(describeRunEnd(update)).toBe('Game over. Final score 0, 0 lines.');
  });
});

describe('the start screen', () => {
  it('names the game, pitches it, and offers the level picker', () => {
    const content = overlayContent(ready);

    expect(content?.kind).toBe('start');
    expect(content?.eyebrow).toBe('Mega Tetris');
    expect(content?.button).toBe('Play');
    expect(content?.showLevelSelect).toBe(true);
    expect(content?.showHelp).toBe(true);
  });

  it('says nothing about a personal best before there is one', () => {
    expect(overlayContent(ready, { stats: defaultStats() })?.note).toBeNull();
  });

  it('shows the best for the ladder the picker is set to', () => {
    const stats = applyRun(
      applyRun(defaultStats(), run({ score: 9000, startLevel: 1 })).stats,
      run({ score: 300, startLevel: 5 }),
    ).stats;

    expect(overlayContent(ready, { stats, startLevel: 1 })?.note).toContain('9,000 points');
    expect(overlayContent(ready, { stats, startLevel: 5 })?.note).toContain('300 points');
  });
});

describe('the game-over panel', () => {
  const previous = applyRun(defaultStats(), run({ score: 9000, lines: 40, level: 9 })).stats;

  it('leads with Play again and a one-line summary of the run', () => {
    const result = applyRun(previous, run({ score: 4200, lines: 12, level: 3 }));
    const content = overlayContent(over, { result });

    expect(content?.kind).toBe('over');
    expect(content?.button).toBe('Play again');
    expect(content?.hint).toBe('12 lines, level 3, 4,200 points');
  });

  it('puts this run beside the best on every row', () => {
    const result = applyRun(previous, run({ score: 4200, lines: 12, level: 3 }));
    const rows = overlayContent(over, { result })?.rows ?? [];

    expect(rows.map((row) => row.key)).toEqual(['score', 'lines', 'level', 'time']);
    expect(rows[0]).toMatchObject({ value: '4,200', best: '9,000', record: false });
    expect(rows[3]).toMatchObject({ value: '2:41', record: false });
  });

  it('celebrates a new best and marks the rows that moved', () => {
    const result = applyRun(previous, run({ score: 50_000, lines: 12, level: 3 }));
    const content = overlayContent(over, { result });

    expect(content?.eyebrow).toBe('New high score!');
    expect(content?.rows.filter((row) => row.record).map((row) => row.key)).toEqual(['score']);
  });

  it('stays quiet when nothing was broken', () => {
    const result = applyRun(previous, run({ score: 10, lines: 0, level: 1 }));

    expect(overlayContent(over, { result })?.eyebrow).toBeNull();
  });

  it('leaves the best column empty rather than showing a zero', () => {
    const result = applyRun(defaultStats(), run());
    const rows = overlayContent(over, { result })?.rows ?? [];

    expect(rows.every((row) => row.best === null)).toBe(true);
  });

  it('says when a run was measured on the head-start ladder', () => {
    const result = applyRun(defaultStats(), run({ startLevel: 7 }));

    expect(overlayContent(over, { result })?.note).toContain('level 7');
  });

  it('falls back to the snapshot when the run was never recorded', () => {
    const content = overlayContent(over);

    expect(content?.hint).toContain('12,345');
    expect(content?.rows).toHaveLength(4);
  });
});

describe('menuStatValues', () => {
  it('has a value for every row the menu shows', () => {
    const values = menuStatValues(applyRun(defaultStats(), run()).stats);

    for (const { key } of MENU_STATS) {
      // Every key resolves; only the head-start row is allowed to be absent.
      expect(Object.hasOwn(values, key), key).toBe(true);
    }
    expect(values.highScore).toBe('4,200');
    expect(values.gamesPlayed).toBe('1');
    expect(values.totalLines).toBe('12');
  });

  it('hides the head-start row until there is a head start to show', () => {
    expect(menuStatValues(defaultStats()).headStart).toBeNull();
    expect(menuStatValues(applyRun(defaultStats(), run({ startLevel: 4 })).stats).headStart).toBe(
      '4,200',
    );
  });
});

describe('naming a clear', () => {
  it('names the four sizes', () => {
    expect(clearName({ kind: 'T', count: 1, spin: 'none', backToBack: false })).toBe('single');
    expect(clearName({ kind: 'T', count: 2, spin: 'none', backToBack: false })).toBe('double');
    expect(clearName({ kind: 'T', count: 3, spin: 'none', backToBack: false })).toBe('triple');
    expect(clearName({ kind: 'T', count: 4, spin: 'none', backToBack: false })).toBe('quad');
    expect(CLEAR_NAMES).toHaveLength(5);
  });

  it('names a spin after the piece that did it', () => {
    expect(clearName({ kind: 'T', count: 2, spin: 'full', backToBack: false })).toBe(
      'T-spin double',
    );
    expect(clearName({ kind: 'S', count: 1, spin: 'kick', backToBack: false })).toBe(
      'S-spin single',
    );
    expect(spinName('L')).toBe('L-spin');
  });

  it('puts the chain on the front', () => {
    expect(clearName({ kind: 'I', count: 4, spin: 'none', backToBack: true })).toBe(
      'back-to-back quad',
    );
    expect(clearName({ kind: 'T', count: 3, spin: 'full', backToBack: true })).toBe(
      'back-to-back T-spin triple',
    );
  });

  it('does not fall off the end of the table', () => {
    expect(clearName({ kind: 'T', count: 9, spin: 'none', backToBack: false })).toBe('quad');
    expect(clearName({ kind: 'T', count: 0, spin: 'none', backToBack: false })).toBe('single');
  });

  it('counts a combo', () => {
    expect(comboName(4)).toBe('combo ×4');
    expect(comboName(1200)).toBe('combo ×1,200');
  });
});

describe('what the live region hears about the new scoring', () => {
  it('names a spin clear, and says so once rather than twice', () => {
    expect(describeEvent(cleared({ count: 2, spin: 'full', points: 800 }))).toBe(
      'T-spin, 2 lines cleared, 800 points.',
    );
    // The `spin` event that came with it stays quiet, because the clear said it.
    expect(
      describeEvent({ type: 'spin', kind: 'T', spin: 'full', cells: [], cleared: 2, points: 0 }),
    ).toBeNull();
  });

  it('announces a spin that cleared nothing, because nothing else will', () => {
    expect(
      describeEvent({ type: 'spin', kind: 'S', spin: 'kick', cells: [], cleared: 0, points: 100 }),
    ).toBe('S-spin, 100 points.');
  });

  it('does not read out every step of a combo', () => {
    for (let combo = 1; combo < COMBO_ANNOUNCE_STEP; combo += 1) {
      expect(announcesCombo(combo)).toBe(false);
      expect(describeEvent(cleared({ combo }))).not.toContain('combo');
    }
  });

  it('does mention the milestones', () => {
    expect(announcesCombo(COMBO_ANNOUNCE_STEP)).toBe(true);
    expect(announcesCombo(COMBO_ANNOUNCE_STEP * 2)).toBe(true);
    expect(announcesCombo(COMBO_ANNOUNCE_STEP + 1)).toBe(false);
    expect(describeEvent(cleared({ combo: COMBO_ANNOUNCE_STEP, points: 300 }))).toBe(
      `1 line cleared, combo ×${COMBO_ANNOUNCE_STEP}, 300 points.`,
    );
  });

  it('puts a spin, a chain and a milestone combo in one sentence', () => {
    expect(
      describeEvent(
        cleared({
          kind: 'L',
          count: 2,
          spin: 'kick',
          combo: 10,
          backToBack: true,
          backToBackChain: 3,
          points: 1_400,
        }),
      ),
    ).toBe('L-spin, 2 lines cleared, back to back, combo ×10, 1,400 points.');
  });
});
