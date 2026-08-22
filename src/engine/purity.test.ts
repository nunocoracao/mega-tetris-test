import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The engine is a pure state machine: it must run in a plain Node process and
 * replay identically from a seed. That rules out the DOM, the clock and
 * unseeded randomness — a rule which is easy to state and easy to break by
 * accident, so it is checked here rather than left to review.
 */

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));

/** Source files of the engine itself; tests may use whatever they like. */
const SOURCES = readdirSync(ENGINE_DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort();

/** Drop comments so documentation may name the very things it forbids. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bMath\.random\b/, why: 'randomness must come from the seeded bag' },
  { pattern: /\bDate\.now\b/, why: 'time arrives as an explicit deltaMs' },
  { pattern: /\bnew Date\b/, why: 'time arrives as an explicit deltaMs' },
  { pattern: /\bperformance\.now\b/, why: 'time arrives as an explicit deltaMs' },
  { pattern: /\b(document|window|navigator|localStorage)\b/, why: 'the engine has no DOM' },
  { pattern: /\bimport\.meta\.env\b/, why: 'the engine has no bundler-specific globals' },
];

describe('engine purity', () => {
  it('has source files to check', () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    expect(SOURCES).toContain('game.ts');
  });

  for (const name of SOURCES) {
    it(`${name} avoids the DOM, the clock and unseeded randomness`, () => {
      const code = stripComments(readFileSync(join(ENGINE_DIR, name), 'utf8'));
      for (const { pattern, why } of FORBIDDEN) {
        const match = pattern.exec(code);
        expect(match === null || `${name}: ${match[0]} — ${why}`).toBe(true);
      }
    });
  }
});
