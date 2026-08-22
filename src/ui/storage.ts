/**
 * Everything the cabinet remembers between visits, in one place.
 *
 * Before this module the settings were scattered: five ad-hoc `localStorage`
 * keys, each parsed and defaulted by whichever module happened to own it. That
 * works right up until you want to add a sixth, migrate a fifth, or let a
 * player wipe the lot — so it is now one namespaced key holding one versioned
 * object, and the modules that used to reach for storage are handed a typed
 * accessor instead.
 *
 * Three properties matter more than the API:
 *
 * **Nothing here may throw.** Safari's private mode throws from
 * `localStorage.getItem`, an enterprise policy can disable storage outright,
 * and a quota-full origin throws on write. Every call is wrapped, and every
 * failure degrades to "this player gets the defaults", never to a broken game.
 *
 * **Nothing here trusts what it reads.** The value is another program's output
 * as far as we are concerned: it may be truncated JSON, an array, a number, an
 * object with the right keys and the wrong types, or something a future version
 * of the game wrote. `migrate` takes *any* parsed value and returns a valid
 * store, so a corrupt entry costs a player their settings and never their game.
 *
 * **The version is a real hinge.** `SCHEMA_VERSION` names the current shape and
 * `MIGRATIONS` carries one entry per step between versions. Version 1 is the
 * settings-only era this game actually shipped with, and the loose keys from
 * that era are imported once, on the first load that finds no store.
 *
 * The dependency arrows all point *into* this file. `ui/motion.ts` and friends
 * import nothing from it but a type; `src/main.ts` builds the store and hands
 * each of them the one setting it owns.
 */

import { parseContrastSetting, type ContrastSetting } from './contrast';
import { parseMotionSetting, type MotionSetting } from './motion';
import {
  applyRun,
  clampStartLevel,
  defaultStats,
  sanitizeStats,
  type RunSummary,
  type Stats,
  type StatsUpdate,
} from './stats';
import { parsePadPreference, type PadPreference } from './touch';

// ---------------------------------------------------------------------------
// The stored shape
// ---------------------------------------------------------------------------

/** The one key. Everything the game remembers lives under it. */
export const STORAGE_KEY = 'mega-tetris:store';

/**
 * The shape `save` writes. Bump it whenever the shape changes and add the step
 * that gets the previous version here — a store written by an older build must
 * keep working, and a player's high score is not something to shrug about.
 */
export const SCHEMA_VERSION = 2;

/** Everything a player can set, as one object. */
export interface Settings {
  /** Are the synthesised cues audible? Sound is on out of the box. */
  readonly sound: boolean;
  readonly motion: MotionSetting;
  readonly contrast: ContrastSetting;
  /** Visibility of the on-screen control pad. */
  readonly pad: PadPreference;
  /** The help panel has been shown at least once, so it stops opening itself. */
  readonly seenHelp: boolean;
  /** The level the next run begins on, from the start screen's picker. */
  readonly startLevel: number;
}

export interface StoredData {
  readonly version: number;
  readonly settings: Settings;
  readonly stats: Stats;
}

export function defaultSettings(): Settings {
  return {
    sound: true,
    motion: 'auto',
    contrast: 'auto',
    pad: 'auto',
    seenHelp: false,
    startLevel: 1,
  };
}

export function defaultData(): StoredData {
  return { version: SCHEMA_VERSION, settings: defaultSettings(), stats: defaultStats() };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored boolean, or the default. Anything else — `'true'`, `1` — is not one. */
function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

/**
 * Any parsed value at all, coerced into usable `Settings`.
 *
 * Each field is validated by whoever owns its vocabulary — the three-way
 * preferences by their own `parse*` functions, so this file never keeps a
 * second copy of the list — and every one of them already answers "anything
 * unrecognised is `auto`". Never throws.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const source = isRecordObject(raw) ? raw : {};
  const defaults = defaultSettings();
  const startLevel = source['startLevel'];
  return {
    sound: flag(source['sound'], defaults.sound),
    motion: parseMotionSetting(typeof source['motion'] === 'string' ? source['motion'] : null),
    contrast: parseContrastSetting(
      typeof source['contrast'] === 'string' ? source['contrast'] : null,
    ),
    pad: parsePadPreference(typeof source['pad'] === 'string' ? source['pad'] : null),
    seenHelp: flag(source['seenHelp'], defaults.seenHelp),
    startLevel:
      typeof startLevel === 'number' ? clampStartLevel(startLevel) : defaults.startLevel,
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * One entry per version step: given the data as version *n* wrote it, return it
 * as version *n + 1* expects. Entries only ever move fields about; the final
 * sanitise pass is what guarantees the result is well-formed, so a migration
 * never has to be defensive as well as correct.
 */
const MIGRATIONS: Readonly<
  Record<number, (data: Record<string, unknown>) => Record<string, unknown>>
> = {
  // 1 → 2: personal bests arrived. Version 1 stored settings and nothing else,
  // which is exactly what the loose-key era amounted to.
  1: (data) => ({ ...data, stats: defaultStats() }),
};

/** The oldest version we know how to read. Anything older is treated as this. */
const OLDEST_VERSION = 1;

/**
 * Any parsed value → a valid, current `StoredData`.
 *
 * The three interesting inputs are all handled the same way: something older
 * walks the migration table up to the current version, something *newer* than
 * this build (a player who used a newer deploy and came back) is sanitised as
 * best it can be rather than discarded, and something unrecognisable falls all
 * the way through to the defaults.
 */
export function migrate(raw: unknown): StoredData {
  let data: Record<string, unknown> = isRecordObject(raw) ? { ...raw } : {};

  const declared = data['version'];
  let version =
    typeof declared === 'number' && Number.isFinite(declared)
      ? Math.floor(declared)
      : OLDEST_VERSION;
  if (version < OLDEST_VERSION) {
    version = OLDEST_VERSION;
  }

  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (step === undefined) {
      // A gap in the table means we cannot get from there to here. Losing the
      // stored data is bad; guessing at its shape would be worse.
      data = {};
      break;
    }
    data = step(data);
    version += 1;
  }

  return {
    version: SCHEMA_VERSION,
    settings: sanitizeSettings(data['settings']),
    stats: sanitizeStats(data['stats']),
  };
}

// ---------------------------------------------------------------------------
// The storage area
// ---------------------------------------------------------------------------

/** The slice of the `Storage` interface this module uses. Tests supply fakes. */
export interface StorageArea {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `localStorage`, if there is one and touching it does not throw.
 *
 * Merely *reading* `window.localStorage` throws in a Chrome with third-party
 * storage blocked, so even the feature detection has to be inside the guard.
 */
export function detectStorageArea(): StorageArea | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return localStorage;
  } catch {
    return null;
  }
}

/** The loose keys version 1 wrote, before there was a store to put them in. */
export const LEGACY_KEYS = {
  sound: 'mega-tetris:muted',
  motion: 'mega-tetris:motion',
  contrast: 'mega-tetris:contrast',
  pad: 'mega-tetris:touch-pad',
  seenHelp: 'mega-tetris:seen-help',
} as const;

/**
 * The version-1 store a player's loose keys amount to, or `null` if they have
 * none. Read once, on the first load that finds no store; the keys are removed
 * as soon as the consolidated version has been written in their place.
 */
export function readLegacy(area: StorageArea): Record<string, unknown> | null {
  const read = (key: string): string | null => {
    try {
      return area.getItem(key);
    } catch {
      return null;
    }
  };

  const raw = {
    sound: read(LEGACY_KEYS.sound),
    motion: read(LEGACY_KEYS.motion),
    contrast: read(LEGACY_KEYS.contrast),
    pad: read(LEGACY_KEYS.pad),
    seenHelp: read(LEGACY_KEYS.seenHelp),
  };
  if (Object.values(raw).every((value) => value === null)) {
    return null;
  }

  const settings: Record<string, unknown> = {};
  // The old key stored the *mute*, and this one stores the opposite. A missing
  // key means "never touched it", which is not the same as "asked for silence".
  if (raw.sound !== null) {
    settings['sound'] = raw.sound !== 'true';
  }
  if (raw.motion !== null) {
    settings['motion'] = raw.motion;
  }
  if (raw.contrast !== null) {
    settings['contrast'] = raw.contrast;
  }
  if (raw.pad !== null) {
    settings['pad'] = raw.pad;
  }
  if (raw.seenHelp !== null) {
    settings['seenHelp'] = raw.seenHelp === 'yes';
  }
  return { version: 1, settings };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One setting, handed to the module that owns it. */
export interface SettingAccess<T> {
  read(): T;
  write(value: T): void;
}

export interface Store {
  settings(): Settings;
  get<K extends keyof Settings>(key: K): Settings[K];
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  /** A single setting as a read/write pair, for the module that owns it. */
  access<K extends keyof Settings>(key: K): SettingAccess<Settings[K]>;
  stats(): Stats;
  /** Fold a finished run into the stats, persist, and say what it broke. */
  recordRun(run: RunSummary): StatsUpdate;
  /** Wipe every best and total. Settings are untouched. */
  resetStats(): Stats;
  /** Are writes actually landing? False in private mode and with storage off. */
  persistent(): boolean;
}

export interface StoreOptions {
  /**
   * Where to keep it. Defaults to `localStorage` when there is a usable one;
   * pass `null` for an explicitly in-memory store, or a fake in tests.
   */
  readonly area?: StorageArea | null;
}

/**
 * Load the store, migrating and repairing whatever is there.
 *
 * The whole load is in one `try`: a throwing `getItem`, a JSON syntax error and
 * an object of the wrong shape are all the same event as far as the game is
 * concerned, and the answer to all three is the defaults.
 */
export function createStore(options: StoreOptions = {}): Store {
  const area = options.area === undefined ? detectStorageArea() : options.area;

  let data = load();
  let writable = area !== null;

  function load(): StoredData {
    if (area === null) {
      return defaultData();
    }
    try {
      const raw = area.getItem(STORAGE_KEY);
      if (raw === null) {
        const legacy = readLegacy(area);
        return legacy === null ? defaultData() : migrate(legacy);
      }
      return migrate(JSON.parse(raw));
    } catch {
      return defaultData();
    }
  }

  function save(): void {
    if (area === null) {
      return;
    }
    try {
      area.setItem(STORAGE_KEY, JSON.stringify(data));
      writable = true;
    } catch {
      // Quota, private mode, a policy: the session keeps working from memory.
      writable = false;
    }
  }

  function forgetLegacy(): void {
    if (area === null) {
      return;
    }
    for (const key of Object.values(LEGACY_KEYS)) {
      try {
        area.removeItem(key);
      } catch {
        // Leaving them behind is harmless: they are only ever read when the
        // consolidated key is missing, and it is not missing any more.
      }
    }
  }

  function get<K extends keyof Settings>(key: K): Settings[K] {
    return data.settings[key];
  }

  function set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (data.settings[key] === value) {
      return;
    }
    const settings: { -readonly [P in keyof Settings]: Settings[P] } = { ...data.settings };
    settings[key] = value;
    data = { ...data, settings };
    save();
  }

  // Whatever we just made sense of is written straight back, which both
  // consolidates the loose keys and repairs a corrupt entry in place.
  save();
  forgetLegacy();

  return {
    settings: () => data.settings,
    get,
    set,

    access<K extends keyof Settings>(key: K): SettingAccess<Settings[K]> {
      return {
        read: () => get(key),
        write: (value) => set(key, value),
      };
    },

    stats: () => data.stats,

    recordRun(run: RunSummary): StatsUpdate {
      const update = applyRun(data.stats, run);
      data = { ...data, stats: update.stats };
      save();
      return update;
    },

    resetStats(): Stats {
      data = { ...data, stats: defaultStats() };
      save();
      return data.stats;
    },

    persistent: () => writable,
  };
}
