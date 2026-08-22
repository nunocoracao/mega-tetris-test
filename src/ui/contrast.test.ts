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
});
