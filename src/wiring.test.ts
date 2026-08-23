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

  it('keeps the dev-only inspection hook behind an env guard', () => {
    // The hook is how the browser playtests read the game. Shipping it would
    // put the whole state machine on `window` for no one's benefit.
    expect(MAIN).toContain('if (import.meta.env.DEV)');
    expect(MAIN.indexOf('import.meta.env.DEV')).toBeLessThan(MAIN.indexOf("Reflect.set(window, 'megaTetris'"));
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
