/**
 * The skin vocabulary.
 *
 * Everything here is a pure function of its arguments, so the whole of "which
 * cabinet am I looking at" is testable without a browser. What the *colours*
 * have to do is checked in `style.test.ts`, which measures them against the
 * stylesheet; this file is about the names, the fallback and the persistence.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME,
  THEMES,
  THEME_IDS,
  createThemePreference,
  parseTheme,
  themeAnnouncement,
  themeBlurb,
  themeLabel,
  type ThemeId,
} from './theme';

describe('the table of skins', () => {
  it('offers the default plus at least three more', () => {
    expect(THEME_IDS).toContain(DEFAULT_THEME);
    expect(THEME_IDS.length).toBeGreaterThanOrEqual(4);
  });

  it('opens on the default, which is what a player is already looking at', () => {
    expect(THEME_IDS[0]).toBe(DEFAULT_THEME);
  });

  it('gives every skin a distinct id, name and blurb', () => {
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    expect(new Set(THEMES.map((theme) => theme.name)).size).toBe(THEMES.length);
    expect(new Set(THEMES.map((theme) => theme.blurb)).size).toBe(THEMES.length);
    for (const theme of THEMES) {
      expect(theme.name.length).toBeGreaterThan(0);
      expect(theme.blurb.length).toBeGreaterThan(0);
    }
  });

  it('keeps every id safe to put in an attribute and a CSS selector', () => {
    // The id is the `data-theme` value *and* the selector that carries the
    // skin. Anything needing quoting or escaping would work in one and not the
    // other, and the failure would be a silently unstyled cabinet.
    for (const id of THEME_IDS) {
      expect(id, `${id} is not attribute-safe`).toMatch(/^[a-z][a-z-]*$/);
    }
  });
});

describe('parseTheme', () => {
  it('accepts every id and nothing else', () => {
    for (const id of THEME_IDS) {
      expect(parseTheme(id)).toBe(id);
    }
    // Corrupt, mis-cased, from a build that had a skin this one has retired,
    // or simply absent: all of them are the default, and none of them throws.
    for (const junk of [null, undefined, '', 'Midnight', 'LAGOON', 'chartreuse', ' lagoon']) {
      expect(parseTheme(junk)).toBe(DEFAULT_THEME);
    }
  });
});

describe('the labels', () => {
  it('names and describes every skin', () => {
    for (const id of THEME_IDS) {
      expect(themeLabel(id)).toBe(THEMES.find((theme) => theme.id === id)?.name);
      expect(themeAnnouncement(id)).toContain(themeLabel(id));
      expect(themeAnnouncement(id)).toContain(themeBlurb(id));
    }
  });
});

describe('the live preference', () => {
  /** A `SettingAccess` over one variable, as `src/main.ts` hands over. */
  function memory(initial: string = DEFAULT_THEME): {
    access: { read: () => ThemeId; write: (value: ThemeId) => void };
    value: () => string;
  } {
    let value = initial;
    return {
      access: { read: () => value as ThemeId, write: (next) => (value = next) },
      value: () => value,
    };
  }

  it('starts on whatever was stored', () => {
    const stored = memory('lagoon');

    expect(createThemePreference({ storage: stored.access }).theme()).toBe('lagoon');
  });

  it('starts on the default when the stored value is not a skin', () => {
    const stored = memory('chartreuse');

    expect(createThemePreference({ storage: stored.access }).theme()).toBe(DEFAULT_THEME);
  });

  it('starts on the default with no storage at all', () => {
    expect(createThemePreference().theme()).toBe(DEFAULT_THEME);
  });

  it('persists a choice and reports it', () => {
    const stored = memory();
    const preference = createThemePreference({ storage: stored.access });

    expect(preference.set('sunset')).toBe('sunset');
    expect(preference.theme()).toBe('sunset');
    expect(preference.label()).toBe(themeLabel('sunset'));
    expect(stored.value()).toBe('sunset');
  });

  it('refuses a value that is not a skin, and does not persist it', () => {
    const stored = memory();
    const preference = createThemePreference({ storage: stored.access });

    expect(preference.set('chartreuse' as ThemeId)).toBe(DEFAULT_THEME);
    expect(stored.value()).toBe(DEFAULT_THEME);
  });

  it('announces only a change, not every press', () => {
    // Same rule as `ui/motion.ts`: a player choosing the skin they are already
    // wearing has changed nothing, and repainting the canvas for it would be a
    // frame's work for no reason.
    const changes: ThemeId[] = [];
    const preference = createThemePreference({ onChange: (id) => changes.push(id) });

    preference.set(DEFAULT_THEME);
    preference.set('daybreak');
    preference.set('daybreak');
    preference.set(DEFAULT_THEME);

    expect(changes).toEqual(['daybreak', DEFAULT_THEME]);
  });

  it('works without a store, for the session at least', () => {
    const preference = createThemePreference();

    expect(preference.set('lagoon')).toBe('lagoon');
    expect(preference.theme()).toBe('lagoon');
  });
});
