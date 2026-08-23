/**
 * Composition-root checks.
 *
 * `src/main.ts` is the one file that cannot be unit-tested in a meaningful way:
 * every line of it is a listener, a hand-off or a piece of wiring, and running
 * it needs a browser. What *can* be checked cheaply is that the wiring is all
 * there — and it is worth checking, because the failure mode is silent.
 *
 * The bug that prompted this: `createTouchControls` takes an optional
 * `storage`, `main.ts` stopped passing it when storage was centralised, and the
 * Touchpad setting cycled happily and forgot the answer on every reload. No
 * type error, no exception, no test — just a preference that did not stick.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultSettings } from './ui/storage';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const MAIN = readFileSync(join(SRC_DIR, 'main.ts'), 'utf8');

/** Drop comments, so documentation may name the very things it forbids. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every non-test source file under `src/`, relative to it. */
function sources(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return sources(join(dir, entry.name), `${prefix}${entry.name}/`);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [`${prefix}${entry.name}`]
      : [];
  });
}

/** Every way `main.ts` is allowed to reach a setting. */
function isWired(key: string): boolean {
  return (
    MAIN.includes(`store.access('${key}')`) ||
    MAIN.includes(`store.get('${key}')`) ||
    MAIN.includes(`store.set('${key}', `)
  );
}

describe('the composition root', () => {
  it.each(Object.keys(defaultSettings()))('wires the %s setting to the store', (key) => {
    expect(isWired(key)).toBe(true);
  });

  it('reads the settings that other modules own through `access`', () => {
    // These four modules keep their own copy of a preference and need a way to
    // persist it. Handing them the whole store would put a second writer on the
    // format; handing them one accessor each is the arrangement that keeps
    // `storage.ts` the only file that knows the shape.
    for (const key of ['motion', 'contrast', 'sound', 'pad']) {
      expect(MAIN).toContain(`store.access('${key}')`);
    }
  });

  it('registers the service worker in production only', () => {
    // A cache-first worker in front of the dev server serves yesterday's game
    // and hot reload stops meaning anything. The guard lives inside `pwa.ts`
    // rather than at the call site, so the whole body — the registration, the
    // update watch, the reload — folds out of a development bundle; and it has
    // to come *before* the registration or it guards nothing.
    const pwa = stripComments(readFileSync(join(SRC_DIR, 'ui/pwa.ts'), 'utf8'));

    expect(pwa).toContain('import.meta.env.PROD');
    expect(pwa.indexOf('import.meta.env.PROD')).toBeLessThan(pwa.indexOf('.register('));
    expect(MAIN).toContain('registerServiceWorker(');
  });

  it('reloads for an update only when the player has pressed the button', () => {
    // The rule the update path exists for. Nothing in `pwa.ts` reloads on its
    // own: both calls are downstream of `applyUpdate`, which is wired to the
    // Reload button and to nothing else.
    const pwa = stripComments(readFileSync(join(SRC_DIR, 'ui/pwa.ts'), 'utf8'));

    expect([...pwa.matchAll(/location\.reload/g)]).toHaveLength(2);
    expect(pwa.indexOf('applyUpdate')).toBeLessThan(pwa.indexOf('location.reload'));
    expect(MAIN).toContain('shell.updateReload.addEventListener');
    expect(MAIN).toContain('serviceWorker.applyUpdate()');
    expect([...MAIN.matchAll(/applyUpdate\(\)/g)]).toHaveLength(1);
  });

  it('keeps the dev-only inspection hook behind an env guard', () => {
    // The hook is how the browser playtests read the game. Shipping it would
    // put the whole state machine on `window` for no one's benefit.
    expect(MAIN).toContain('if (import.meta.env.DEV)');
    expect(MAIN.indexOf('import.meta.env.DEV')).toBeLessThan(MAIN.indexOf("Reflect.set(window, 'megaTetris'"));
  });

});

describe('the recorder', () => {
  /**
   * **The recorder observes; it does not participate.**
   *
   * `engine/replay.test.ts` proves the recorder itself cannot change a run —
   * it plays the same script with and without one. What that test cannot see is
   * the composition root, where a well-meaning refactor could still put the
   * tape *in* the update path: wrapping `update`, adjusting a delta, or letting
   * a `record` call decide what gets applied. These checks pin the shape here.
   */
  const code = stripComments(MAIN);

  it('records the clock before the input it is recording', () => {
    // The log stores the clock as it stood when the key was pressed. Recording
    // after `applyInput` would write down the clock of the state the input
    // produced, and a replay built from it would be a frame out on every entry.
    const record = code.indexOf('recorder.record(state.elapsedMs, input.type)');
    const apply = code.indexOf('setState(applyInput(state, input))');
    expect(record).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(-1);
    expect(record).toBeLessThan(apply);
  });

  it('marks the clock after the engine has advanced it, never before', () => {
    // Inside the frame, where it would matter: the tape reads the clock the
    // engine has just set, and cannot have touched the delta on the way in.
    const frame = code.slice(code.indexOf('onFrame(deltaMs)'));
    const advance = frame.indexOf('setState(update(state, deltaMs))');
    const mark = frame.indexOf('recorder.mark(state.elapsedMs)');
    expect(advance).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(advance);
  });

  it('never stands between the loop and the engine', () => {
    // No `update(state, recorder.something())`, no recorder-derived delta. The
    // engine is fed the frame's own milliseconds and nothing else.
    expect(/update\(\s*state\s*,\s*deltaMs\s*\)/.test(code)).toBe(true);
    expect(/update\([^)]*recorder/.test(code)).toBe(false);
    expect(/applyInput\([^)]*recorder/.test(code)).toBe(false);
  });

  it('starts a fresh tape for every game it deals', () => {
    // A tape that survived a re-deal would be a recording of one run played
    // against the seed of another. Every `createGame` in the composition root
    // goes through `dealGame`, which resets it.
    expect(code).toContain('function dealGame(');
    const deals = [...code.matchAll(/createGame\(/g)].length;
    const throughDealGame = [...code.matchAll(/dealGame\(createGame\(/g)].length;
    // The one that is not: the opening snapshot, built before the tape exists.
    expect(deals - throughDealGame).toBe(1);
  });

  it('refuses to offer a truncated tape as a replay', () => {
    // A log that stopped at the cap is a correct prefix, not the whole run.
    expect(code).toContain('recorder.truncated()');
  });
});

describe('the replay viewer', () => {
  const code = stripComments(MAIN);

  it('paints a replay through the same renderer as a live game', () => {
    // The dividend of a pure painter: the replay changes *which* snapshot is
    // drawn, and nothing else. A second render path would be the bug.
    expect([...code.matchAll(/board\.render\(/g)]).toHaveLength(1);
    expect(code).toContain('replayViewer.state() ?? state');
  });

  it('does not advance the live game while a replay is playing', () => {
    // Watching a recording must not cost the player the piece they left
    // falling behind it.
    const frame = code.slice(code.indexOf('onFrame(deltaMs)'));
    const guard = frame.indexOf('if (replayViewer.active())');
    const advance = frame.indexOf('setState(update(state, deltaMs))');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(advance);
  });

  it('lets Escape out from anywhere', () => {
    expect(code).toContain("normalizeKey(event.key) !== 'Escape'");
    expect(code).toContain('leaveReplay(true)');
  });
});

describe('the engine boundary', () => {
  // `src/engine/index.ts` is the public surface. Reaching around it into
  // `../engine/game` works today and pins the UI to a file layout the engine
  // should be free to change; the barrel is the contract.
  const browserFiles = sources(SRC_DIR).filter((name) => !name.startsWith('engine/'));

  it.each(browserFiles)('%s imports the engine through its barrel', (name) => {
    const code = stripComments(readFileSync(join(SRC_DIR, name), 'utf8'));
    const deep = [...code.matchAll(/from '\.{1,2}\/(?:\.\.\/)?engine\/[^']+'/g)].map((m) => m[0]);
    expect(deep).toEqual([]);
  });
});

describe('the calendar boundary', () => {
  /**
   * **Only `main.ts` may ask what day it is.**
   *
   * The daily challenge turns on a date, and a date that is *fetched* where it
   * is used is a date no test can pin: the seed function, the streak arithmetic
   * and the history strip would all quietly mean something different at
   * midnight, in another timezone, or on a machine with a wrong clock. So the
   * clock is read once, at the composition root, and handed down as a string.
   *
   * This forbids the two calls that read the wall clock. `Date.UTC` and
   * `new Date(ms)` are deliberately still allowed — they are arithmetic on an
   * argument, which is exactly what `ui/daily.ts` uses them for.
   */
  const CLOCK_READS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
    { pattern: /\bDate\.now\s*\(/, what: 'Date.now()' },
    { pattern: /\bnew Date\s*\(\s*\)/, what: 'new Date()' },
  ];

  const others = sources(SRC_DIR).filter((name) => name !== 'main.ts');

  it.each(others)('%s does not read the clock', (name) => {
    const code = stripComments(readFileSync(join(SRC_DIR, name), 'utf8'));
    for (const { pattern, what } of CLOCK_READS) {
      expect(pattern.test(code), `${name} reads the clock with ${what}`).toBe(false);
    }
  });

  it('reads it exactly once, in the composition root', () => {
    const code = stripComments(MAIN);
    const reads = [...code.matchAll(/\bnew Date\s*\(\s*\)/g)];

    expect(reads).toHaveLength(1);
    expect(code).toContain('function todayStamp()');
  });
});

describe('the bindings boundary', () => {
  /**
   * **`ui/input.ts` is the only file that names a key.**
   *
   * The help panel, the controls card, the on-screen pad and the settings
   * dialog all show the player their keys, and every one of them is a view of
   * the one binding table rather than a copy of it. A second list is how a
   * rebound key ends up changing the game and not the help — which is worse
   * than no help panel at all.
   *
   * This scans for the key names themselves. `KEY_BINDINGS` and the small
   * vocabulary of keys the dialogs own (`Escape`, `Tab`, `Enter`) are the
   * exceptions, and they are named where they are enforced.
   */
  const KEY_LITERALS = /'(?:Arrow(?:Left|Right|Up|Down)|Shift|Control)'/;

  const others = sources(SRC_DIR).filter((name) => name !== 'ui/input.ts');

  it.each(others)('%s does not restate the key list', (name) => {
    const code = stripComments(readFileSync(join(SRC_DIR, name), 'utf8'));
    const found = [...code.matchAll(new RegExp(KEY_LITERALS, 'g'))].map((match) => match[0]);
    expect(found, `${name} names keys the binding table already owns`).toEqual([]);
  });

  it('keeps the pad and the help panel reading the live table', () => {
    // Both used to hold their own labels. `applyBindings` is the one call that
    // republishes the table into every place that prints it.
    const shell = stripComments(readFileSync(join(SRC_DIR, 'ui/shell.ts'), 'utf8'));
    expect(shell).toContain('export function applyBindings(');
    expect(shell).toContain('helpBodyMarkup(bindings)');
    expect(MAIN).toContain('bindings.listen(() => applyBindings(shell, bindings.table()))');
  });

  it('hands the bindings and the handling into the input layer', () => {
    // The whole point of the remapper: nothing reaches for a module constant.
    const code = stripComments(MAIN);
    expect(code).toContain('createLiveBindings(');
    expect(/createKeyboardInput\(\{[^}]*bindings:/s.test(code)).toBe(true);
    expect(/createKeyboardInput\(\{[^}]*handling:/s.test(code)).toBe(true);
  });
});

describe('the storage boundary', () => {
  // `ui/storage.ts` is the only file allowed to touch `localStorage`, which is
  // what keeps the "storage may be hostile" handling — and the stored format —
  // in exactly one testable place. Five modules used to own a key each.
  const others = sources(SRC_DIR).filter((name) => name !== 'ui/storage.ts');

  it('has files to check', () => {
    expect(others.length).toBeGreaterThan(5);
    expect(others).toContain('main.ts');
  });

  it.each(others)('%s does not reach localStorage', (name) => {
    const code = stripComments(readFileSync(join(SRC_DIR, name), 'utf8'));
    expect(/\blocalStorage\b/.test(code)).toBe(false);
  });
});
