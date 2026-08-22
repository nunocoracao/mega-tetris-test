import { describe, expect, it } from 'vitest';

import { applyInput, createGame, type GameState } from '../engine';
import { describeEvent, formatNumber, overlayContent, playButtonLabel } from './hud';

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
  });
});
