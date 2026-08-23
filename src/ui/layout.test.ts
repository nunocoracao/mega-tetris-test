/**
 * The numbers the stylesheet and the modules both have to agree about.
 *
 * `style.css` cannot import a constant, so a handful of values are written down
 * twice: the field's proportions, and the timing of the game-over panel against
 * the canvas sweep it waits for. Both have a comment saying "if one moves, move
 * the other", which is exactly the kind of instruction that gets missed. This
 * file is the version of that instruction that fails the build.
 *
 * `palette.test.ts` does the same job for the colours.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BOARD_HEIGHT, BOARD_WIDTH } from '../engine';
import { GAME_OVER_ROW_MS } from './effects';

const CSS = readFileSync(fileURLToPath(new URL('../style.css', import.meta.url)), 'utf8');

/**
 * The value of a custom property in the geometry block.
 *
 * That block is the one whose selector is a bare `:root` on its own line — the
 * palette blocks above and below it all carry a second selector or an
 * attribute, and the header comment mentions `:root` in prose.
 */
const GEOMETRY = '\n:root {';

function rootValue(name: string): string {
  const root = CSS.slice(CSS.indexOf(GEOMETRY), CSS.indexOf('\n}', CSS.indexOf(GEOMETRY)));
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(root);
  expect(match, `stylesheet has no ${name} in :root`).not.toBeNull();
  return (match?.[1] ?? '').trim();
}

describe('the field geometry', () => {
  it('declares the same column count the engine plays on', () => {
    expect(Number(rootValue('--field-cols'))).toBe(BOARD_WIDTH);
  });

  it('declares the full board height, spawn strip included', () => {
    // 22, not 20. The renderer paints the two buffer rows faintly above the
    // well so a new piece is visible the moment it appears, and `.playfield`
    // has to leave room for them or the aspect ratio lies.
    expect(Number(rootValue('--field-rows'))).toBe(BOARD_HEIGHT);
  });

  it('derives the playfield aspect ratio from those two properties', () => {
    expect(CSS).toContain('aspect-ratio: var(--field-cols) / var(--field-rows)');
  });
});

describe('the game-over panel', () => {
  /** The `animation` shorthand's delay, in milliseconds. */
  const delayMs = (() => {
    const rule = /\.overlay\[data-state='over'\]\s*\{([^}]*)\}/.exec(CSS);
    expect(rule, 'stylesheet has no game-over overlay rule').not.toBeNull();
    // `animation: <name> <duration> <easing> <delay> backwards` — the delay is
    // the second time value in the shorthand.
    const times = [...(rule?.[1] ?? '').matchAll(/(\d+(?:\.\d+)?)ms/g)].map((m) => Number(m[1]));
    expect(times.length).toBeGreaterThanOrEqual(2);
    return times[1] ?? 0;
  })();

  const sweepMs = BOARD_HEIGHT * GAME_OVER_ROW_MS;

  it('waits for most of the canvas sweep before it rises', () => {
    // Not the whole sweep, deliberately: the last rows to grey out are the ones
    // furthest from the eye, and waiting for them makes the panel feel late.
    // The window is what stops the two drifting into "panel first, sweep after".
    expect(delayMs).toBeGreaterThan(sweepMs * 0.6);
    expect(delayMs).toBeLessThanOrEqual(sweepMs);
  });
});
