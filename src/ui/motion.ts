/**
 * How much movement the player wants.
 *
 * Two things decide it, and both have to be live. The operating system says
 * `prefers-reduced-motion: reduce`, which we honour by default and re-read
 * through `matchMedia` so flipping the switch in system settings takes effect
 * without a reload. And the player can override it from the cabinet itself,
 * because plenty of people want calm effects in one game and not in the rest of
 * their machine — or the other way round.
 *
 * The setting is a three-way `auto | full | reduced`, exactly like the touch
 * pad's, so "follow the system" stays expressible after an override.
 *
 * Everything above the `createMotionPreference` line is a pure function of its
 * arguments, so the whole decision table is testable without a browser.
 *
 * Persistence is *handed in*, not reached for: `ui/storage.ts` owns the one
 * `localStorage` key the game uses and `src/main.ts` passes this module the
 * single setting it owns. The type import below is erased at build time, so the
 * runtime dependency runs one way only — into storage, never out of it.
 */

import type { SettingAccess } from './storage';

/** `auto` follows the operating system; the other two override it. */
export type MotionSetting = 'auto' | 'full' | 'reduced';

export const MOTION_SETTINGS: readonly MotionSetting[] = ['auto', 'full', 'reduced'];

/** The media query the operating system answers. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Anything unrecognised — absent, corrupt, from a future version — is `auto`. */
export function parseMotionSetting(raw: string | null | undefined): MotionSetting {
  return MOTION_SETTINGS.find((value) => value === raw) ?? 'auto';
}

/** The cycle the toggle button walks: auto → full → reduced → auto. */
export function nextMotionSetting(current: MotionSetting): MotionSetting {
  const index = MOTION_SETTINGS.indexOf(current);
  return MOTION_SETTINGS[(index + 1) % MOTION_SETTINGS.length] ?? 'auto';
}

export function motionSettingLabel(setting: MotionSetting): string {
  switch (setting) {
    case 'auto':
      return 'Auto';
    case 'full':
      return 'Full';
    case 'reduced':
      return 'Reduced';
  }
}

/** The one rule the setting exists to override. */
export function isMotionReduced(setting: MotionSetting, systemReduced: boolean): boolean {
  switch (setting) {
    case 'full':
      return false;
    case 'reduced':
      return true;
    case 'auto':
      return systemReduced;
  }
}

export interface MotionPreference {
  /** Should motion be suppressed right now? Cheap; call it per spawn. */
  reduced(): boolean;
  setting(): MotionSetting;
  /** Advance the toggle one step and persist the result. */
  cycle(): MotionSetting;
  label(): string;
  destroy(): void;
}

export interface MotionPreferenceOptions {
  /** Called whenever `reduced()` would start answering differently. */
  readonly onChange?: (reduced: boolean, setting: MotionSetting) => void;
  /**
   * Where the override is kept between visits. `src/main.ts` hands over one
   * setting out of `ui/storage.ts`; leaving it out gives a preference that
   * lasts exactly as long as the page does, which is what the tests want.
   */
  readonly storage?: SettingAccess<MotionSetting>;
}

/**
 * The live preference: stored override plus the system query, watched.
 *
 * `onChange` fires only when the *answer* changes, not on every cycle of the
 * toggle — a player switching from `auto` to `reduced` on a machine that
 * already asked for reduced motion has changed nothing that needs undoing.
 */
export function createMotionPreference(options: MotionPreferenceOptions = {}): MotionPreference {
  const query = typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION_QUERY) : null;
  let setting = parseMotionSetting(options.storage?.read());
  let reduced = isMotionReduced(setting, query?.matches ?? false);

  function reconcile(): void {
    const next = isMotionReduced(setting, query?.matches ?? false);
    if (next === reduced) {
      return;
    }
    reduced = next;
    options.onChange?.(reduced, setting);
  }

  query?.addEventListener('change', reconcile);

  return {
    reduced: () => reduced,
    setting: () => setting,
    cycle(): MotionSetting {
      setting = nextMotionSetting(setting);
      options.storage?.write(setting);
      reconcile();
      return setting;
    },
    label: () => motionSettingLabel(setting),
    destroy(): void {
      query?.removeEventListener('change', reconcile);
    },
  };
}
