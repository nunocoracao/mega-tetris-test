/**
 * The store, tested against the storage a browser actually hands out.
 *
 * Three of these matter more than the rest, because all three happen to real
 * players and none of them is visible in a happy-path browser: storage that
 * **throws** (Safari's private mode, a blocked third-party context), storage
 * that holds something **corrupt** (a truncated write, a hand-edited value, an
 * unrelated key collision), and storage written by an **older version** of the
 * game. In every one of them the answer has to be "the player gets sensible
 * defaults and the game keeps working", never an exception on the first frame.
 */

import { describe, expect, it } from 'vitest';

import { defaultStats, type RunSummary } from './stats';
import {
  LEGACY_KEYS,
  SCHEMA_VERSION,
  STORAGE_KEY,
  createStore,
  defaultSettings,
  migrate,
  readLegacy,
  sanitizeSettings,
  type StorageArea,
} from './storage';

// ---------------------------------------------------------------------------
// Fake storage areas
// ---------------------------------------------------------------------------

interface MemoryArea extends StorageArea {
  readonly map: Map<string, string>;
}

function memoryArea(entries: Readonly<Record<string, string>> = {}): MemoryArea {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** Every call throws, exactly as a locked-down browser does. */
function throwingArea(): StorageArea {
  const boom = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

/** Reads fine, refuses to write — a full quota. */
function readOnlyArea(entries: Readonly<Record<string, string>> = {}): StorageArea {
  const area = memoryArea(entries);
  return {
    getItem: area.getItem,
    setItem: () => {
      throw new DOMException('Quota exceeded.', 'QuotaExceededError');
    },
    removeItem: area.removeItem,
  };
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return { score: 4200, lines: 12, level: 3, startLevel: 1, durationMs: 61_000, ...overrides };
}

// ---------------------------------------------------------------------------

describe('a store with nowhere to keep anything', () => {
  it('falls back to the defaults when there is no storage at all', () => {
    const store = createStore({ area: null });

    expect(store.settings()).toEqual(defaultSettings());
    expect(store.stats()).toEqual(defaultStats());
    expect(store.persistent()).toBe(false);
  });

  it('survives storage that throws on every call', () => {
    const store = createStore({ area: throwingArea() });

    expect(store.settings()).toEqual(defaultSettings());
    expect(store.persistent()).toBe(false);
    // And the session still works: it just forgets when the tab closes.
    expect(() => store.set('sound', false)).not.toThrow();
    expect(store.get('sound')).toBe(false);
    expect(() => store.recordRun(run())).not.toThrow();
    expect(store.stats().best.score).toBe(4200);
  });

  it('keeps working when reads succeed but writes are refused', () => {
    const store = createStore({ area: readOnlyArea() });

    store.set('contrast', 'more');

    expect(store.get('contrast')).toBe('more');
    expect(store.persistent()).toBe(false);
  });
});

describe('a store over a corrupt value', () => {
  it('ignores anything that is not JSON', () => {
    const store = createStore({ area: memoryArea({ [STORAGE_KEY]: '{"version":2,' }) });

    expect(store.settings()).toEqual(defaultSettings());
    expect(store.stats()).toEqual(defaultStats());
  });

  it('ignores JSON that is not an object', () => {
    for (const raw of ['null', '7', '"settings"', '[1,2,3]', 'true']) {
      const store = createStore({ area: memoryArea({ [STORAGE_KEY]: raw }) });

      expect(store.settings(), raw).toEqual(defaultSettings());
    }
  });

  it('repairs the fields it cannot use and keeps the ones it can', () => {
    const area = memoryArea({
      [STORAGE_KEY]: JSON.stringify({
        version: SCHEMA_VERSION,
        settings: { sound: 'yes', motion: 'sideways', contrast: 'more', startLevel: 400 },
        stats: { best: { score: 900 }, gamesPlayed: 'lots' },
      }),
    });
    const store = createStore({ area });

    expect(store.get('sound')).toBe(true); // 'yes' is not a boolean
    expect(store.get('motion')).toBe('auto'); // not a motion setting
    expect(store.get('contrast')).toBe('more'); // this one was fine
    expect(store.get('startLevel')).toBe(10); // clamped, not discarded
    expect(store.stats().best.score).toBe(900);
    expect(store.stats().gamesPlayed).toBe(0);
  });

  it('writes the repaired version straight back, so it is only corrupt once', () => {
    const area = memoryArea({ [STORAGE_KEY]: 'not json at all' });

    createStore({ area });

    expect(JSON.parse(area.map.get(STORAGE_KEY) as string)).toEqual({
      version: SCHEMA_VERSION,
      settings: defaultSettings(),
      stats: defaultStats(),
    });
  });
});

describe('round tripping', () => {
  it('reads back what a previous session wrote', () => {
    const area = memoryArea();
    const first = createStore({ area });
    first.set('sound', false);
    first.set('motion', 'reduced');
    first.set('pad', 'on');
    first.set('seenHelp', true);
    first.set('startLevel', 6);
    first.recordRun(run({ score: 7777, lines: 30, level: 4 }));

    const second = createStore({ area });

    expect(second.settings()).toEqual({
      sound: false,
      motion: 'reduced',
      contrast: 'auto',
      pad: 'on',
      seenHelp: true,
      startLevel: 6,
    });
    expect(second.stats().best).toEqual({
      score: 7777,
      level: 4,
      lines: 30,
      durationMs: 61_000,
    });
    expect(second.persistent()).toBe(true);
  });

  it('hands a single setting out as a read/write pair', () => {
    const area = memoryArea();
    const store = createStore({ area });
    const access = store.access('motion');

    expect(access.read()).toBe('auto');
    access.write('full');

    expect(store.get('motion')).toBe('full');
    expect(createStore({ area }).get('motion')).toBe('full');
  });

  it('erases the stats on request and leaves the settings alone', () => {
    const area = memoryArea();
    const store = createStore({ area });
    store.set('contrast', 'more');
    store.recordRun(run());

    store.resetStats();

    expect(store.stats()).toEqual(defaultStats());
    expect(store.get('contrast')).toBe('more');
    expect(createStore({ area }).stats()).toEqual(defaultStats());
  });
});

describe('migration', () => {
  it('is a no-op on data this version wrote', () => {
    const current = {
      version: SCHEMA_VERSION,
      settings: defaultSettings(),
      stats: defaultStats(),
    };

    expect(migrate(current)).toEqual(current);
  });

  it('carries version 1 forward, keeping its settings and inventing its stats', () => {
    const migrated = migrate({
      version: 1,
      settings: { sound: false, motion: 'reduced', contrast: 'more', pad: 'off', seenHelp: true },
    });

    expect(migrated.version).toBe(SCHEMA_VERSION);
    expect(migrated.settings).toEqual({
      sound: false,
      motion: 'reduced',
      contrast: 'more',
      pad: 'off',
      seenHelp: true,
      startLevel: 1,
    });
    expect(migrated.stats).toEqual(defaultStats());
  });

  it('treats a missing version as the oldest one we know how to read', () => {
    const migrated = migrate({ settings: { pad: 'on' } });

    expect(migrated.version).toBe(SCHEMA_VERSION);
    expect(migrated.settings.pad).toBe('on');
    expect(migrated.stats).toEqual(defaultStats());
  });

  it('salvages what it can from a version newer than this build', () => {
    // A player who used a newer deploy and came back. We cannot know what its
    // extra fields meant, but their high score is not ours to throw away.
    const migrated = migrate({
      version: SCHEMA_VERSION + 5,
      settings: { contrast: 'more', somethingNew: 'shiny' },
      stats: { best: { score: 12_345, level: 9, lines: 88, durationMs: 400_000 } },
    });

    expect(migrated.version).toBe(SCHEMA_VERSION);
    expect(migrated.settings.contrast).toBe('more');
    expect(migrated.stats.best.score).toBe(12_345);
  });

  it('turns rubbish into the defaults rather than throwing', () => {
    for (const raw of [null, undefined, 42, 'store', [], { version: 'two' }]) {
      expect(migrate(raw).settings).toEqual(defaultSettings());
      expect(migrate(raw).stats).toEqual(defaultStats());
    }
  });
});

describe('the loose keys of the ad-hoc era', () => {
  const legacy = {
    [LEGACY_KEYS.sound]: 'true', // the old key stored the *mute*
    [LEGACY_KEYS.motion]: 'reduced',
    [LEGACY_KEYS.contrast]: 'standard',
    [LEGACY_KEYS.pad]: 'on',
    [LEGACY_KEYS.seenHelp]: 'yes',
  };

  it('reads as a version 1 store', () => {
    expect(readLegacy(memoryArea(legacy))).toEqual({
      version: 1,
      settings: {
        sound: false,
        motion: 'reduced',
        contrast: 'standard',
        pad: 'on',
        seenHelp: true,
      },
    });
  });

  it('is nothing at all when none of them exist', () => {
    expect(readLegacy(memoryArea())).toBeNull();
  });

  it('mentions only the keys that are actually there', () => {
    expect(readLegacy(memoryArea({ [LEGACY_KEYS.pad]: 'off' }))).toEqual({
      version: 1,
      settings: { pad: 'off' },
    });
  });

  it('is imported once, then cleaned up', () => {
    const area = memoryArea(legacy);

    const store = createStore({ area });

    expect(store.settings()).toEqual({
      sound: false,
      motion: 'reduced',
      contrast: 'standard',
      pad: 'on',
      seenHelp: true,
      startLevel: 1,
    });
    for (const key of Object.values(LEGACY_KEYS)) {
      expect(area.map.has(key), `${key} was left behind`).toBe(false);
    }
    expect(area.map.has(STORAGE_KEY)).toBe(true);
  });

  it('is not consulted once a real store exists', () => {
    const area = memoryArea({
      ...legacy,
      [STORAGE_KEY]: JSON.stringify({
        version: SCHEMA_VERSION,
        settings: { ...defaultSettings(), pad: 'off' },
        stats: defaultStats(),
      }),
    });

    expect(createStore({ area }).get('pad')).toBe('off');
  });
});

describe('sanitizeSettings', () => {
  it('turns anything at all into usable settings', () => {
    for (const raw of [null, undefined, 0, 'settings', [], { motion: 42 }]) {
      expect(sanitizeSettings(raw)).toEqual(defaultSettings());
    }
  });

  it('round-trips its own output', () => {
    const settings = { ...defaultSettings(), sound: false, pad: 'off' as const, startLevel: 9 };

    expect(sanitizeSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });
});
