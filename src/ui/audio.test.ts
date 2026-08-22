import { describe, expect, it } from 'vitest';

import { MASTER_GAIN, cueDurationMs, cueTones, type SoundCue, type ToneSpec } from './audio';

const CUES: readonly SoundCue[] = [
  'move',
  'rotate',
  'softDrop',
  'hardDrop',
  'lock',
  'clear',
  'levelUp',
  'gameOver',
];

function allTones(): ToneSpec[] {
  const tones: ToneSpec[] = [];
  for (const cue of CUES) {
    for (let rows = 1; rows <= 4; rows += 1) {
      tones.push(...cueTones(cue, rows));
    }
  }
  return tones;
}

describe('cueTones', () => {
  it('gives every cue at least one tone', () => {
    for (const cue of CUES) {
      expect(cueTones(cue).length).toBeGreaterThan(0);
    }
  });

  it('only ever asks for sounds a browser can actually schedule', () => {
    for (const tone of allTones()) {
      // `exponentialRampToValueAtTime` rejects zero, and an oscillator cannot
      // be told to run backwards — both would throw at schedule time.
      expect(tone.startHz).toBeGreaterThan(0);
      expect(tone.endHz).toBeGreaterThan(0);
      expect(tone.durationMs).toBeGreaterThan(0);
      expect(tone.delayMs).toBeGreaterThanOrEqual(0);
      expect(tone.gain).toBeGreaterThan(0);
      expect(tone.gain).toBeLessThanOrEqual(1);
    }
  });

  it('keeps everything inside human hearing and out of dog-whistle territory', () => {
    for (const tone of allTones()) {
      expect(tone.startHz).toBeGreaterThan(40);
      expect(tone.startHz).toBeLessThan(5000);
      expect(tone.endHz).toBeGreaterThan(40);
      expect(tone.endHz).toBeLessThan(5000);
    }
  });

  it('stays quiet enough to sit under whatever else is playing', () => {
    for (const tone of allTones()) {
      expect(MASTER_GAIN * tone.gain).toBeLessThan(0.1);
    }
  });

  it('pitches a line clear higher the more rows it took', () => {
    const roots = [1, 2, 3, 4].map((rows) => cueTones('clear', rows)[0]?.startHz ?? 0);

    for (let index = 1; index < roots.length; index += 1) {
      expect(roots[index]!).toBeGreaterThan(roots[index - 1]!);
    }
  });

  it('makes a bigger clear a fuller chord, not just a higher one', () => {
    expect(cueTones('clear', 4).length).toBeGreaterThan(cueTones('clear', 1).length);
  });

  it('clamps a nonsense row count instead of inventing a chord for it', () => {
    expect(cueTones('clear', 0)).toEqual(cueTones('clear', 1));
    expect(cueTones('clear', 99)).toEqual(cueTones('clear', 4));
  });

  it('ignores the row count for every other cue', () => {
    expect(cueTones('lock', 1)).toEqual(cueTones('lock', 4));
  });
});

describe('cueDurationMs', () => {
  it('measures to the end of the last tone, delay included', () => {
    const tones = cueTones('gameOver');
    const last = tones[tones.length - 1]!;

    expect(cueDurationMs('gameOver')).toBe(last.delayMs + last.durationMs);
  });

  it('keeps the everyday cues short enough to fire back to back', () => {
    // Soft drop repeats at DAS speed; anything that rings for longer than a
    // repeat interval turns into a drone.
    for (const cue of ['move', 'rotate', 'softDrop'] as const) {
      expect(cueDurationMs(cue)).toBeLessThan(60);
    }
  });

  it('lets the celebrations ring, but not for a whole piece drop', () => {
    for (const cue of ['clear', 'levelUp', 'gameOver'] as const) {
      expect(cueDurationMs(cue, 4)).toBeGreaterThan(150);
      expect(cueDurationMs(cue, 4)).toBeLessThan(1000);
    }
  });
});
