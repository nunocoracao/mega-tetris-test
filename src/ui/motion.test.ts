import { describe, expect, it } from 'vitest';

import {
  MOTION_SETTINGS,
  isMotionReduced,
  motionSettingLabel,
  nextMotionSetting,
  parseMotionSetting,
} from './motion';

describe('parseMotionSetting', () => {
  it('accepts the three settings verbatim', () => {
    for (const setting of MOTION_SETTINGS) {
      expect(parseMotionSetting(setting)).toBe(setting);
    }
  });

  it('treats anything else as "follow the system"', () => {
    for (const raw of ['', 'REDUCED', 'off', 'true', null, undefined]) {
      expect(parseMotionSetting(raw)).toBe('auto');
    }
  });
});

describe('nextMotionSetting', () => {
  it('cycles through every setting and comes back round', () => {
    const seen = [];
    let setting = MOTION_SETTINGS[0] ?? 'auto';
    for (let step = 0; step < MOTION_SETTINGS.length; step += 1) {
      seen.push(setting);
      setting = nextMotionSetting(setting);
    }

    expect(seen).toEqual([...MOTION_SETTINGS]);
    expect(setting).toBe('auto');
  });
});

describe('motionSettingLabel', () => {
  it('gives every setting a short button label', () => {
    for (const setting of MOTION_SETTINGS) {
      expect(motionSettingLabel(setting)).toMatch(/^[A-Z][a-z]+$/);
    }
  });
});

describe('isMotionReduced', () => {
  it('follows the system while the setting is auto', () => {
    expect(isMotionReduced('auto', true)).toBe(true);
    expect(isMotionReduced('auto', false)).toBe(false);
  });

  it('overrides the system in both directions', () => {
    // The point of the in-game toggle: a player who wants calm effects in this
    // game only, and a player whose OS is calm but who wants the confetti here.
    expect(isMotionReduced('reduced', false)).toBe(true);
    expect(isMotionReduced('full', true)).toBe(false);
  });
});
