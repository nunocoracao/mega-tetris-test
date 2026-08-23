/**
 * How much contrast the player wants.
 *
 * Built to exactly the same shape as `ui/motion.ts`, and for the same reason:
 * the operating system has an opinion (`prefers-contrast: more`), we honour it
 * by default, and the cabinet lets the player override it in either direction
 * because a preference set for a whole machine is not always the preference for
 * one game. The setting is three-way — `auto | more | standard` — so "follow
 * the system" stays expressible after an override.
 *
 * High contrast is not only a palette swap. Colour alone must never be the
 * thing that tells two pieces apart, so each kind also gets a distinct mark
 * stamped into its blocks. `PIECE_MARK` below is that mapping; the renderer
 * draws it, and `blockMark` is a pure function so the "every kind is distinct"
 * property is a unit test rather than a claim.
 *
 * Everything above `createContrastPreference` is pure, and persistence is handed
 * in from `src/main.ts` rather than reached for — see `ui/motion.ts`, which this
 * module deliberately mirrors.
 */

import { GARBAGE_CELL, PIECE_KINDS, type Cell, type PieceKind } from '../engine';
import type { SettingAccess } from './storage';

/** `auto` follows the operating system; the other two override it. */
export type ContrastSetting = 'auto' | 'more' | 'standard';

export const CONTRAST_SETTINGS: readonly ContrastSetting[] = ['auto', 'more', 'standard'];

/** The media query the operating system answers. */
export const MORE_CONTRAST_QUERY = '(prefers-contrast: more)';

/** Anything unrecognised — absent, corrupt, from a future version — is `auto`. */
export function parseContrastSetting(raw: string | null | undefined): ContrastSetting {
  return CONTRAST_SETTINGS.find((value) => value === raw) ?? 'auto';
}

/** The cycle the toggle button walks: auto → more → standard → auto. */
export function nextContrastSetting(current: ContrastSetting): ContrastSetting {
  const index = CONTRAST_SETTINGS.indexOf(current);
  return CONTRAST_SETTINGS[(index + 1) % CONTRAST_SETTINGS.length] ?? 'auto';
}

export function contrastSettingLabel(setting: ContrastSetting): string {
  switch (setting) {
    case 'auto':
      return 'Auto';
    case 'more':
      return 'High';
    case 'standard':
      return 'Standard';
  }
}

/** The one rule the setting exists to override. */
export function isHighContrast(setting: ContrastSetting, systemMore: boolean): boolean {
  switch (setting) {
    case 'more':
      return true;
    case 'standard':
      return false;
    case 'auto':
      return systemMore;
  }
}

// ---------------------------------------------------------------------------
// Marks: telling the pieces apart without colour
// ---------------------------------------------------------------------------

/**
 * A shape stamped into a block's face. Seven kinds, seven marks, all drawn from
 * one or two strokes so they cost nothing at 220 blocks a frame and still read
 * at a 12px cell.
 */
export type BlockMark =
  /** One horizontal bar across the middle. */
  | 'bar'
  /** A small square outline, centred. */
  | 'ring'
  /** A plus. */
  | 'cross'
  /** A single diagonal, bottom-left to top-right. */
  | 'slashUp'
  /** A single diagonal, top-left to bottom-right. */
  | 'slashDown'
  /** One vertical bar down the middle. */
  | 'pillar'
  /** Two short horizontal bars, one above the other. */
  | 'stack';

/**
 * Which mark belongs to which piece.
 *
 * The pairs that are easiest to confuse get the most separated marks: S and Z
 * are mirrored diagonals, J and L are a vertical against a pair of horizontals.
 */
export const PIECE_MARK: Readonly<Record<PieceKind, BlockMark>> = {
  I: 'bar',
  O: 'ring',
  T: 'cross',
  S: 'slashUp',
  Z: 'slashDown',
  J: 'pillar',
  L: 'stack',
};

/**
 * The mark for a filled cell, or `null` when it does not get one.
 *
 * Total over `Cell` — a test says so. Garbage is the one filled cell with no
 * mark, and deliberately: marks exist to tell the seven pieces apart without
 * colour, and garbage is not one of them. It is already the only block on the
 * well that is grey and the only one with a flat face, which is two non-colour
 * cues without stamping a shape it would then share with a piece.
 */
export function blockMark(cell: Cell): BlockMark | null {
  return cell === null || cell === GARBAGE_CELL ? null : PIECE_MARK[cell];
}

/** Every kind's mark, in `PIECE_KINDS` order. Handy for tests and docs. */
export function allMarks(): readonly BlockMark[] {
  return PIECE_KINDS.map((kind) => PIECE_MARK[kind]);
}

// ---------------------------------------------------------------------------
// The live flag the renderer reads
// ---------------------------------------------------------------------------

let active = false;

/**
 * Is high contrast on right now?
 *
 * Module-level state, deliberately: the renderer already reads the live palette
 * out of `getPalette()` rather than being handed one, and the contrast decision
 * travels the same way rather than threading a boolean through every paint.
 */
export function highContrast(): boolean {
  return active;
}

/** Publish the decision. `main.ts` owns it; everything else reads it. */
export function setHighContrast(value: boolean): void {
  active = value;
}

// ---------------------------------------------------------------------------
// The live preference
// ---------------------------------------------------------------------------

export interface ContrastPreference {
  /** Should the cabinet be painted for high contrast right now? */
  high(): boolean;
  setting(): ContrastSetting;
  /** Advance the toggle one step and persist the result. */
  cycle(): ContrastSetting;
  /** Set it outright, as the settings dialog's radio group does. */
  set(setting: ContrastSetting): ContrastSetting;
  label(): string;
  destroy(): void;
}

export interface ContrastPreferenceOptions {
  /** Called whenever `high()` would start answering differently. */
  readonly onChange?: (high: boolean, setting: ContrastSetting) => void;
  /** Where the override is kept between visits; see `ui/motion.ts`. */
  readonly storage?: SettingAccess<ContrastSetting>;
}

export function createContrastPreference(
  options: ContrastPreferenceOptions = {},
): ContrastPreference {
  const query = typeof matchMedia === 'function' ? matchMedia(MORE_CONTRAST_QUERY) : null;
  let setting = parseContrastSetting(options.storage?.read());
  let high = isHighContrast(setting, query?.matches ?? false);

  function reconcile(): void {
    const next = isHighContrast(setting, query?.matches ?? false);
    if (next === high) {
      return;
    }
    high = next;
    options.onChange?.(high, setting);
  }

  function set(next: ContrastSetting): ContrastSetting {
    setting = next;
    options.storage?.write(setting);
    reconcile();
    return setting;
  }

  query?.addEventListener('change', reconcile);

  return {
    high: () => high,
    setting: () => setting,
    cycle: () => set(nextContrastSetting(setting)),
    set,
    label: () => contrastSettingLabel(setting),
    destroy(): void {
      query?.removeEventListener('change', reconcile);
    },
  };
}
