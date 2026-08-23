/**
 * Which cabinet the player wants to look at.
 *
 * Four skins, each a complete set of the same custom properties in
 * `src/style.css`: Midnight (the default, on bare `:root`) plus Daybreak,
 * Sunset and Lagoon on `:root[data-theme='<id>']`. Nothing about a skin reaches
 * the game rules, the renderer or the replay format — colour is presentation,
 * and the canvas already reads every colour it paints back out of the
 * stylesheet through `ui/palette.ts`. Adding a skin is a stylesheet edit and one
 * line in the table below.
 *
 * Built to the same shape as `ui/motion.ts` and `ui/contrast.ts`, with one
 * difference: there is no system preference to fold in. An operating system has
 * an opinion about motion and about contrast; it has none about whether this
 * cabinet should be plum or teal. So the preference is a plain stored value,
 * and `auto` — which those two need to keep "follow the system" expressible —
 * would mean nothing here and is deliberately absent.
 *
 * Persistence is handed in rather than reached for, exactly as it is there:
 * `src/main.ts` owns `ui/storage.ts` and passes this module the one setting it
 * owns.
 */

import type { SettingAccess } from './storage';

/** One skin, as a value. `ThemeId` is derived from this table, not written twice. */
export interface ThemeOption {
  readonly id: string;
  /** What the picker prints beside the swatch. */
  readonly name: string;
  /** One sentence, for the announcement when it is chosen. */
  readonly blurb: string;
}

/**
 * Every skin, in picker order. The default comes first because it is the one a
 * player is looking at when they open the panel.
 *
 * Each `id` is also the `data-theme` value and the CSS selector that carries the
 * skin, so it stays lower-case and attribute-safe.
 */
export const THEMES = [
  {
    id: 'midnight',
    name: 'Midnight',
    blurb: 'A deep plum cabinet, lit from above.',
  },
  {
    id: 'daybreak',
    name: 'Daybreak',
    blurb: 'Warm paper in full daylight, with ink-dark blocks.',
  },
  {
    id: 'sunset',
    name: 'Sunset',
    blurb: 'Late light on a rose-brown cabinet.',
  },
  {
    id: 'lagoon',
    name: 'Lagoon',
    blurb: 'Deep water, lit from the surface.',
  },
] as const satisfies readonly ThemeOption[];

export type ThemeId = (typeof THEMES)[number]['id'];

export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id);

/**
 * The skin a player who has never opened the picker is looking at, and the one
 * anything unrecognised falls back to. It is the *absence* of a `data-theme`
 * attribute, not a value of it — see `applyTheme` in `src/main.ts`.
 */
export const DEFAULT_THEME: ThemeId = 'midnight';

/** Anything unrecognised — absent, corrupt, from a future version — is the default. */
export function parseTheme(raw: string | null | undefined): ThemeId {
  return THEME_IDS.find((id) => id === raw) ?? DEFAULT_THEME;
}

function option(id: ThemeId): ThemeOption {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function themeLabel(id: ThemeId): string {
  return option(id).name;
}

export function themeBlurb(id: ThemeId): string {
  return option(id).blurb;
}

/** The sentence the live region says when a skin is chosen. */
export function themeAnnouncement(id: ThemeId): string {
  return `${themeLabel(id)} theme. ${themeBlurb(id)}`;
}

// ---------------------------------------------------------------------------
// The live preference
// ---------------------------------------------------------------------------

export interface ThemePreference {
  /** The skin on the cabinet right now. */
  theme(): ThemeId;
  /** Choose one and persist it. Returns what is now live. */
  set(id: ThemeId): ThemeId;
  label(): string;
}

export interface ThemePreferenceOptions {
  /** Called only when the answer actually changes, as in `ui/motion.ts`. */
  readonly onChange?: (id: ThemeId) => void;
  /** Where the choice is kept between visits. */
  readonly storage?: SettingAccess<ThemeId>;
}

export function createThemePreference(options: ThemePreferenceOptions = {}): ThemePreference {
  let theme = parseTheme(options.storage?.read());

  return {
    theme: () => theme,
    label: () => themeLabel(theme),

    set(id: ThemeId): ThemeId {
      const next = parseTheme(id);
      if (next === theme) {
        return theme;
      }
      theme = next;
      options.storage?.write(theme);
      options.onChange?.(theme);
      return theme;
    },
  };
}
