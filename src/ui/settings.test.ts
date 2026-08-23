/**
 * The rules behind the settings dialog.
 *
 * Everything a player can do to their own controls is decided by a handful of
 * pure functions in `ui/input.ts` — bind, clear, reset, sanitise, clamp — and
 * this is where they are pinned. The dialog's *markup and focus behaviour* live
 * in `a11y.test.ts`, which has a document to run them in; what is here needs no
 * browser at all, which is the point of having split them this way.
 *
 * The last block is the one to read if you are ever tempted to let handling or
 * bindings anywhere near `src/engine/`: it proves a recorded run decodes and
 * replays identically no matter what the player has done to their keys.
 */

import { describe, expect, it } from 'vitest';

import {
  BOARD_WIDTH,
  REPLAY_FORMAT_VERSION,
  createGame,
  decodeShare,
  replay,
  type GameState,
} from '../engine';
import {
  DEFAULT_HANDLING,
  HANDLING_BOUNDS,
  MAX_KEYS_PER_ACTION,
  MAX_REPEATS_PER_FRAME,
  REQUIRED_ACTIONS,
  RESERVED_KEYS,
  UNBINDABLE_KEYS,
  actionForKey,
  bindKey,
  captureKey,
  clampHandlingValue,
  clearKey,
  createAutoRepeat,
  createBindingTable,
  createLiveBindings,
  defaultKeyMap,
  isDefaultHandling,
  isDefaultKeyMap,
  resetAction,
  sanitizeHandling,
  sanitizeKeyMap,
  stepRepeat,
  FRESH_REPEAT,
  type ActionId,
  type Handling,
  type KeyMap,
} from './input';
import { formatMs } from './settings';
import { createStore, type StorageArea } from './storage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function memoryArea(): StorageArea {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** The default map with one action's keys swapped out. */
function withAction(action: ActionId, keys: readonly string[]): KeyMap {
  return { ...defaultKeyMap(), [action]: [...keys] };
}

// ---------------------------------------------------------------------------
// Capturing a key
// ---------------------------------------------------------------------------

describe('captureKey', () => {
  it('takes an ordinary key, normalised', () => {
    expect(captureKey({ key: 'q' })).toEqual({ ok: true, key: 'Q' });
    expect(captureKey({ key: 'ArrowLeft' })).toEqual({ ok: true, key: 'ArrowLeft' });
    expect(captureKey({ key: ' ' })).toEqual({ ok: true, key: ' ' });
  });

  it('refuses the keys that would trap the player, and says which', () => {
    for (const key of RESERVED_KEYS) {
      const result = captureKey({ key });
      expect(result.ok, `${key} was captured`).toBe(false);
      if (!result.ok) {
        // A refusal has to be readable: a colour or a shake would tell some
        // players nothing at all.
        expect(result.reason).toMatch(/reserved/i);
      }
    }
  });

  it('refuses anything with a modifier held down', () => {
    expect(captureKey({ key: 'Q', ctrlKey: true }).ok).toBe(false);
    expect(captureKey({ key: 'Q', shiftKey: true }).ok).toBe(false);
    expect(captureKey({ key: 'Q', metaKey: true }).ok).toBe(false);
  });

  it('still takes a modifier pressed on its own, because two defaults are', () => {
    // `Shift` is Hold and `Control` is Rotate left out of the box, and both
    // arrive with their own flag set. A blanket "no modifier" rule would make
    // the shipped table unreachable from the dialog that resets to it.
    expect(captureKey({ key: 'Shift', shiftKey: true })).toEqual({ ok: true, key: 'Shift' });
    expect(captureKey({ key: 'Control', ctrlKey: true })).toEqual({ ok: true, key: 'Control' });
  });

  it('refuses a key with no name to store', () => {
    expect(captureKey({ key: 'Unidentified' }).ok).toBe(false);
    expect(captureKey({ key: 'Dead' }).ok).toBe(false);
    expect(captureKey({ key: '' }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Editing the map
// ---------------------------------------------------------------------------

describe('bindKey', () => {
  it('adds a free key to an action', () => {
    const result = bindKey(defaultKeyMap(), 'hardDrop', 'Q');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.map.hardDrop).toEqual([' ', 'Q']);
      // And nothing else moved.
      expect(result.map.moveLeft).toEqual(['ArrowLeft', 'A']);
    }
  });

  it('refuses a key another action already owns, and names that action', () => {
    const result = bindKey(defaultKeyMap(), 'hold', ' ');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Refused rather than stolen: taking a key away from another row without
      // saying so is how a player ends up unable to drop and none the wiser.
      expect(result.reason).toContain('Space');
      expect(result.reason).toContain('Hard drop');
    }
  });

  it('refuses a key the same action already has', () => {
    const result = bindKey(defaultKeyMap(), 'moveLeft', 'a');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Move left');
    }
  });

  it('refuses a reserved key however it got here', () => {
    for (const key of UNBINDABLE_KEYS) {
      expect(bindKey(defaultKeyMap(), 'hold', key).ok, key).toBe(false);
    }
  });

  it('caps how many keys one action may answer to', () => {
    let map = defaultKeyMap();
    for (const key of ['Q', 'W', 'E']) {
      const step = bindKey(map, 'hardDrop', key);
      if (step.ok) {
        map = step.map;
      }
    }

    expect(map.hardDrop).toHaveLength(MAX_KEYS_PER_ACTION);
    const overflow = bindKey(map, 'hardDrop', 'T');
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.reason).toContain(String(MAX_KEYS_PER_ACTION));
    }
  });

  it('normalises what it stores, so a and A are the same key', () => {
    const result = bindKey(defaultKeyMap(), 'hardDrop', 'q');

    expect(result.ok && result.map.hardDrop).toEqual([' ', 'Q']);
  });
});

describe('clearKey', () => {
  it('takes a key off an action', () => {
    const result = clearKey(defaultKeyMap(), 'moveLeft', 'A');

    expect(result.ok && result.map.moveLeft).toEqual(['ArrowLeft']);
  });

  it('refuses to unbind the last key of pause or restart', () => {
    // The lock-out rule: without a pause key there is no pause menu, and
    // without restart there is no way back into a game.
    for (const action of REQUIRED_ACTIONS) {
      const map = withAction(action, ['Q']);
      const result = clearKey(map, action, 'Q');

      expect(result.ok, action).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/at least one key/i);
      }
    }
  });

  it('will happily leave an ordinary action with nothing', () => {
    const result = clearKey(withAction('hold', ['C']), 'hold', 'C');

    expect(result.ok && result.map.hold).toEqual([]);
  });

  it('refuses a key that is not there', () => {
    expect(clearKey(defaultKeyMap(), 'hold', 'Q').ok).toBe(false);
  });
});

describe('resetAction', () => {
  it('puts one action back and moves whatever took its keys out of the way', () => {
    // Space has been given to Hold. Resetting Hard drop has to be able to take
    // it back, or a reset could refuse itself over a conflict it created.
    const map: KeyMap = { ...defaultKeyMap(), hardDrop: [], hold: ['C', ' '] };

    const reset = resetAction(map, 'hardDrop');

    expect(reset.hardDrop).toEqual([' ']);
    expect(reset.hold).toEqual(['C']);
  });

  it('leaves every other action alone', () => {
    const reset = resetAction(withAction('moveLeft', ['Q']), 'moveLeft');

    expect(isDefaultKeyMap(reset)).toBe(true);
  });
});

describe('actionForKey', () => {
  it('finds the owner of a key, or says there is none', () => {
    expect(actionForKey(defaultKeyMap(), ' ')).toBe('hardDrop');
    expect(actionForKey(defaultKeyMap(), 'Q')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reading a stored map
// ---------------------------------------------------------------------------

describe('sanitizeKeyMap', () => {
  it('accepts the default table unchanged', () => {
    expect(sanitizeKeyMap(defaultKeyMap())).toEqual(defaultKeyMap());
  });

  it('accepts a legitimately customised map', () => {
    const map = withAction('hardDrop', ['Q']);

    expect(sanitizeKeyMap(map)).toEqual(map);
  });

  it.each([
    ['not an object', 7],
    ['an array', [['moveLeft', ['A']]]],
    ['null', null],
    ['a string', '{"moveLeft":["A"]}'],
    ['an unknown action', { ...defaultKeyMap(), fly: ['F'] }],
    ['a missing action', { moveLeft: ['A'] }],
    ['keys that are not strings', { ...defaultKeyMap(), hold: [7] }],
    ['an empty key', { ...defaultKeyMap(), hold: [''] }],
    ['a reserved key', { ...defaultKeyMap(), hold: ['Tab'] }],
    ['too many keys on one action', { ...defaultKeyMap(), hold: ['Q', 'W', 'E', 'T'] }],
    ['an unbound pause', { ...defaultKeyMap(), togglePause: [] }],
    ['an unbound restart', { ...defaultKeyMap(), restart: [] }],
  ])('falls back to the whole default table given %s', (_what, raw) => {
    // All or nothing on purpose. A half-repaired map is controls that are
    // subtly wrong in a way nothing on the screen explains; the default table
    // is controls the player recognises.
    expect(sanitizeKeyMap(raw)).toEqual(defaultKeyMap());
  });

  it('falls back when one key has been given two meanings', () => {
    const map = { ...defaultKeyMap(), hold: ['C', 'Shift', ' '] };

    expect(sanitizeKeyMap(map)).toEqual(defaultKeyMap());
  });

  it('never throws, whatever it is handed', () => {
    for (const raw of [undefined, Number.NaN, Symbol('x'), new Map(), () => 0]) {
      expect(() => sanitizeKeyMap(raw)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Handling
// ---------------------------------------------------------------------------

describe('handling bounds', () => {
  it('covers every field of Handling exactly once', () => {
    const keys = HANDLING_BOUNDS.map((bound) => bound.key);

    expect([...keys].sort()).toEqual(Object.keys(DEFAULT_HANDLING).sort());
  });

  it('has a default inside its own range, on its own step', () => {
    for (const bound of HANDLING_BOUNDS) {
      const value = DEFAULT_HANDLING[bound.key];
      expect(value, bound.key).toBeGreaterThanOrEqual(bound.min);
      expect(value, bound.key).toBeLessThanOrEqual(bound.max);
      expect(value % bound.step, bound.key).toBe(0);
    }
  });

  it('offers an instant ARR and refuses an instant soft drop', () => {
    // Stated as a test because it is a decision, not an accident: sideways is
    // reversible and downwards is not.
    const arr = HANDLING_BOUNDS.find((bound) => bound.key === 'arrMs');
    const soft = HANDLING_BOUNDS.find((bound) => bound.key === 'softDropMs');

    expect(arr?.min).toBe(0);
    expect(soft?.min).toBeGreaterThan(0);
  });
});

describe('clampHandlingValue', () => {
  const das = HANDLING_BOUNDS[0] as (typeof HANDLING_BOUNDS)[number];

  it('holds a value inside its range', () => {
    expect(clampHandlingValue(-40, das)).toBe(das.min);
    expect(clampHandlingValue(9_000, das)).toBe(das.max);
  });

  it('snaps to the step', () => {
    expect(clampHandlingValue(102, das)).toBe(100);
    expect(clampHandlingValue(103, das)).toBe(105);
  });

  it('falls back for anything that is not a number', () => {
    for (const raw of ['170', null, undefined, Number.NaN, Infinity]) {
      expect(clampHandlingValue(raw, das)).toBe(DEFAULT_HANDLING.dasMs);
    }
  });
});

describe('sanitizeHandling', () => {
  it('repairs field by field rather than all at once', () => {
    // Unlike a key map, a slider that is out of range has an obvious right
    // answer — the nearest legal value — and nothing about it is ambiguous.
    const handling = sanitizeHandling({ dasMs: 10_000, arrMs: 20, softDropMs: 'fast' });

    expect(handling).toEqual({
      dasMs: 500,
      arrMs: 20,
      softDropMs: DEFAULT_HANDLING.softDropMs,
    });
  });

  it('never throws, whatever it is handed', () => {
    for (const raw of [undefined, null, 7, 'x', [], () => 0]) {
      expect(() => sanitizeHandling(raw)).not.toThrow();
      expect(isDefaultHandling(sanitizeHandling(raw))).toBe(true);
    }
  });
});

describe('an ARR of zero', () => {
  it('is a full frame of steps rather than nothing at all', () => {
    // The naive guard — "an interval of zero cannot repeat" — would make the
    // fastest setting the slowest one. It has to mean "as many as the frame
    // allows", capped so one long frame cannot flood the engine.
    const charged = stepRepeat(FRESH_REPEAT, 0, 0, 0);

    expect(charged.repeats).toBe(0); // no time has passed
    const stepped = stepRepeat(FRESH_REPEAT, 16, 0, 0);
    expect(stepped.repeats).toBe(MAX_REPEATS_PER_FRAME);
  });

  it('crosses the well in a couple of frames, not one', () => {
    // Honest about what "instant" buys: eight columns a frame, and the well is
    // ten wide. Documented in the README rather than pretended away.
    expect(MAX_REPEATS_PER_FRAME).toBeLessThan(BOARD_WIDTH);
  });

  it('is still refused for a negative or broken interval', () => {
    expect(stepRepeat(FRESH_REPEAT, 16, 0, -5).repeats).toBe(0);
    expect(stepRepeat(FRESH_REPEAT, 16, 0, Number.NaN).repeats).toBe(0);
  });
});

describe('the auto-repeat clock under a live handling', () => {
  it('reads the timing every frame, so a slider takes effect without a reload', () => {
    let handling: Handling = { dasMs: 200, arrMs: 500, softDropMs: 50 };
    const emitted: string[] = [];
    const repeat = createAutoRepeat((action) => emitted.push(action), () => handling);

    repeat.press('moveLeft');
    repeat.update(150);
    expect(emitted).toEqual(['moveLeft']); // 150 < 200, still charging

    handling = { ...handling, dasMs: 100 };
    repeat.update(1);
    // The clock had 150ms on it and the delay is now 100, so it fires at once.
    expect(emitted).toEqual(['moveLeft', 'moveLeft']);
  });
});

// ---------------------------------------------------------------------------
// The live bindings
// ---------------------------------------------------------------------------

describe('createLiveBindings', () => {
  it('starts from the defaults with no storage behind it', () => {
    const live = createLiveBindings();

    expect(isDefaultKeyMap(live.table().map)).toBe(true);
    expect(live.handling()).toEqual(DEFAULT_HANDLING);
  });

  it('survives a reload through the store', () => {
    const area = memoryArea();
    const first = createStore({ area });
    const live = createLiveBindings({
      keys: first.access('bindings'),
      handling: first.access('handling'),
    });
    const bound = bindKey(live.table().map, 'hardDrop', 'Q');
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      live.setKeyMap(bound.map);
    }
    live.setHandling({ dasMs: 90, arrMs: 0, softDropMs: 20 });

    const second = createStore({ area });
    const reloaded = createLiveBindings({
      keys: second.access('bindings'),
      handling: second.access('handling'),
    });

    expect(reloaded.table().keys('hardDrop')).toEqual([' ', 'Q']);
    expect(reloaded.handling()).toEqual({ dasMs: 90, arrMs: 0, softDropMs: 20 });
  });

  it('repairs a corrupt stored map on the way in, without throwing', () => {
    const area = memoryArea();
    area.setItem(
      'mega-tetris:store',
      JSON.stringify({
        version: 6,
        settings: { bindings: { moveLeft: ['A'] }, handling: { dasMs: 'quick' } },
      }),
    );

    const store = createStore({ area });
    const live = createLiveBindings({
      keys: store.access('bindings'),
      handling: store.access('handling'),
    });

    expect(isDefaultKeyMap(live.table().map)).toBe(true);
    expect(live.handling()).toEqual(DEFAULT_HANDLING);
  });

  it('tells its listeners when a key moves, and stops when they leave', () => {
    const live = createLiveBindings();
    let calls = 0;
    const stop = live.listen(() => {
      calls += 1;
    });

    live.setKeyMap(withAction('hold', ['Q']));
    expect(calls).toBe(1);

    stop();
    live.setKeyMap(defaultKeyMap());
    expect(calls).toBe(1);
  });

  it('resolves a map into a table a keyboard can look keys up in', () => {
    const table = createBindingTable(withAction('hardDrop', ['Q']));

    expect(table.find('q')?.action).toBe('hardDrop');
    expect(table.find(' ')).toBeUndefined();
    // Labels and repeat modes are ours, and come back even though they are
    // never stored.
    expect(table.find('Q')?.label).toBe('Hard drop');
    expect(table.list.find((binding) => binding.action === 'moveLeft')?.repeat).toBe('das');
  });
});

describe('the store', () => {
  it('does not wipe the bindings when the record book is erased', () => {
    // A key binding is not a score. Erasing every personal best is a thing
    // players do; relearning their own controls is not what they asked for.
    const store = createStore({ area: memoryArea() });
    store.set('bindings', withAction('hardDrop', ['Q']));

    store.resetStats();

    expect(store.get('bindings').hardDrop).toEqual(['Q']);
  });

  it('does wipe them when every setting is reset', () => {
    const store = createStore({ area: memoryArea() });
    store.set('bindings', withAction('hardDrop', ['Q']));
    store.set('handling', { dasMs: 0, arrMs: 0, softDropMs: 5 });

    const settings = store.resetSettings();

    expect(isDefaultKeyMap(settings.bindings)).toBe(true);
    expect(settings.handling).toEqual(DEFAULT_HANDLING);
  });

  it('leaves the record book alone when the settings are reset', () => {
    const store = createStore({ area: memoryArea() });
    store.recordRun({
      mode: 'marathon',
      outcome: 'toppedOut',
      score: 5_000,
      lines: 20,
      level: 3,
      startLevel: 1,
      durationMs: 60_000,
    });

    store.resetSettings();

    expect(store.stats().gamesPlayed).toBe(1);
  });
});

describe('formatMs', () => {
  it('shows the unit, because 170 on its own means nothing', () => {
    expect(formatMs(170)).toBe('170 ms');
    expect(formatMs(0)).toBe('0 ms');
  });
});

// ---------------------------------------------------------------------------
// Replays do not care what your keys are
// ---------------------------------------------------------------------------

/**
 * **The line this whole feature is on the right side of.**
 *
 * A replay records *inputs*, not keys, and the engine has never heard of DAS.
 * So a run recorded by one player must decode and reproduce identically for
 * another whose keyboard and handling look nothing like it — a link shared
 * eighteen months ago has to still be the same run today.
 *
 * The link below is a literal on purpose: it was produced by this codec and is
 * checked in, so a change to the format fails here rather than silently
 * invalidating every link anybody has ever pasted.
 */
const SHARED_LINK = 'AQCy8hkAAahGCgiUI5wE-BeXI50xliOTHLZUozg';

/** Everything about a finished state that a player would notice. */
function signature(state: GameState): Record<string, unknown> {
  return {
    status: state.status,
    score: state.score,
    lines: state.lines,
    level: state.level,
    elapsedMs: state.elapsedMs,
    board: state.board.cells.join(''),
    hold: state.hold,
    next: [...state.next],
  };
}

function playSharedLink(): Record<string, unknown> {
  const result = decodeShare(SHARED_LINK);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.message);
  }
  const { seed, startLevel, mode, log } = result.run;
  return signature(replay(seed, { startLevel, mode }, log));
}

describe('a shared replay under somebody else’s controls', () => {
  it('is decoded and reproduced identically whatever the bindings and handling', () => {
    const before = playSharedLink();

    // Now become a player with a thoroughly rearranged cabinet: every action
    // rebound, DAS at zero, ARR instant, soft drop as fast as it goes.
    const store = createStore({ area: memoryArea() });
    const live = createLiveBindings({
      keys: store.access('bindings'),
      handling: store.access('handling'),
    });
    live.setKeyMap({
      moveLeft: ['J'],
      moveRight: ['L'],
      softDrop: ['K'],
      hardDrop: ['I'],
      rotateCW: ['F'],
      rotateCCW: ['G'],
      hold: ['H'],
      togglePause: ['O'],
      restart: ['U'],
      help: ['Y'],
    });
    live.setHandling({ dasMs: 0, arrMs: 0, softDropMs: 5 });
    // And run their auto-repeat clock for a while, for good measure: nothing it
    // emits has a path to the engine except through an input the player made.
    const repeat = createAutoRepeat(() => {}, live.handling);
    repeat.press('moveLeft');
    repeat.update(500);
    repeat.releaseAll();

    expect(playSharedLink()).toEqual(before);
  });

  it('leaves the format version where it was, because nothing about it changed', () => {
    // Bindings and handling are `src/ui/` in their entirety. If this number
    // ever has to move for a controls change, something has gone into the
    // engine that should not have.
    expect(REPLAY_FORMAT_VERSION).toBe(1);
  });

  it('reaches a state a fresh game does not, so the comparison means something', () => {
    // A guard on the guard: if the link ever decoded to nothing, the test above
    // would pass by comparing two empty boards.
    const played = playSharedLink();
    const fresh = signature(createGame({ seed: 424242, startLevel: 1, mode: 'marathon' }));

    expect(played['board']).not.toEqual(fresh['board']);
    expect(played['elapsedMs']).toBeGreaterThan(0);
  });
});
