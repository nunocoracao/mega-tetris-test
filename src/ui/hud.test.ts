import { describe, expect, it } from 'vitest';

import { applyInput, boardFromStrings, createGame, type GameState } from '../engine';
import {
  describeEvent,
  describeHold,
  describePlayfield,
  describeQueue,
  formatNumber,
  overlayContent,
  playButtonLabel,
  stackHeight,
} from './hud';

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
    expect(overlayContent(ready, true)?.hint).toMatch(/drag/i);
    expect(overlayContent(ready, true)?.hint).not.toMatch(/arrow/i);
    expect(overlayContent(paused, true)?.hint).not.toMatch(/press/i);

    // Everything else reads the same whichever controls are in front of them.
    expect(overlayContent(over, true)?.hint).toBe(overlayContent(over)?.hint);
    expect(overlayContent(playing, true)).toBeNull();
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

describe('describeEvent', () => {
  it('announces the things worth hearing', () => {
    expect(
      describeEvent({ type: 'rowsCleared', rows: [20], count: 1, quad: false, backToBack: false, points: 100 }),
    ).toBe('1 line cleared, 100 points.');
    expect(
      describeEvent({ type: 'rowsCleared', rows: [17, 18, 19, 20], count: 4, quad: true, backToBack: true, points: 1600 }),
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
