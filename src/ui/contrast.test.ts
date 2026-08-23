/**
 * The contrast setting, and the cue that survives it.
 *
 * The colour half of high contrast is measured in `style.test.ts`, against the
 * stylesheet, for every skin. What is here is the other half: the decision
 * table, and the per-piece marks — which exist precisely because a palette,
 * however carefully checked, can never be the *only* thing telling two blocks
 * apart.
 */

import { describe, expect, it } from 'vitest';

import { PIECE_KINDS } from '../engine';
import {
  CONTRAST_SETTINGS,
  PIECE_MARK,
  allMarks,
  blockMark,
  contrastSettingLabel,
  highContrast,
  isHighContrast,
  nextContrastSetting,
  parseContrastSetting,
  setHighContrast,
} from './contrast';
import { THEME_IDS } from './theme';

describe('parseContrastSetting', () => {
  it('accepts the three settings and nothing else', () => {
    for (const setting of CONTRAST_SETTINGS) {
      expect(parseContrastSetting(setting)).toBe(setting);
    }
    for (const junk of [null, undefined, '', 'high', 'MORE', '1']) {
      expect(parseContrastSetting(junk)).toBe('auto');
    }
  });
});

describe('nextContrastSetting', () => {
  it('walks the cycle and comes back to auto', () => {
    expect(nextContrastSetting('auto')).toBe('more');
    expect(nextContrastSetting('more')).toBe('standard');
    expect(nextContrastSetting('standard')).toBe('auto');
  });

  it('gives every setting a label', () => {
    const labels = CONTRAST_SETTINGS.map(contrastSettingLabel);

    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('High');
  });
});

describe('isHighContrast', () => {
  it('lets an explicit choice override the system in both directions', () => {
    expect(isHighContrast('more', false)).toBe(true);
    expect(isHighContrast('standard', true)).toBe(false);
  });

  it('follows the system on auto', () => {
    expect(isHighContrast('auto', true)).toBe(true);
    expect(isHighContrast('auto', false)).toBe(false);
  });
});

describe('the live flag', () => {
  it('is off until something publishes a decision', () => {
    expect(highContrast()).toBe(false);
    setHighContrast(true);
    expect(highContrast()).toBe(true);
    setHighContrast(false);
    expect(highContrast()).toBe(false);
  });
});

describe('piece marks', () => {
  it('gives every kind a mark', () => {
    for (const kind of PIECE_KINDS) {
      expect(blockMark(kind)).toBe(PIECE_MARK[kind]);
    }
    expect(allMarks()).toHaveLength(PIECE_KINDS.length);
  });

  it('never gives two kinds the same one — that is the whole point', () => {
    // If two pieces shared a mark, high contrast would be back to telling them
    // apart by colour alone, which is exactly what it exists to avoid.
    expect(new Set(allMarks()).size).toBe(PIECE_KINDS.length);
  });

  it('keeps the mirrored pairs mirrored', () => {
    expect(blockMark('S')).toBe('slashUp');
    expect(blockMark('Z')).toBe('slashDown');
  });

  it('is the same seven marks under every skin, in every contrast mode', () => {
    // The marks are deliberately *not* a function of the palette. Four skins
    // times three settings is twelve different sets of seven colours, and the
    // shape stamped into each kind is the one thing that does not move across
    // any of them — which is what makes it something a player can learn once.
    //
    // If a skin ever wanted its own marks, this is the test that would have to
    // change, and the reason it should not: a cue that varies is not a cue.
    for (const theme of THEME_IDS) {
      for (const setting of CONTRAST_SETTINGS) {
        for (const systemMore of [false, true]) {
          setHighContrast(isHighContrast(setting, systemMore));
          const marks = allMarks();

          expect(marks, `${theme} in ${setting} contrast lost a mark`).toEqual(
            PIECE_KINDS.map((kind) => PIECE_MARK[kind]),
          );
          expect(new Set(marks).size).toBe(PIECE_KINDS.length);
        }
      }
    }
    setHighContrast(false);
  });
});
