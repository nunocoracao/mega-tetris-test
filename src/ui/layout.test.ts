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

// ---------------------------------------------------------------------------
// The second well
// ---------------------------------------------------------------------------

/** The root font size every `rem` in this stylesheet is measured against. */
const REM = 16;

/**
 * A CSS length in pixels at a given viewport.
 *
 * Only the four forms the geometry block actually uses — `rem`, `vmin`, `dvh`
 * and `clamp()` of those — because a general CSS evaluator is a different
 * project and this one only has to be right about the numbers below.
 */
function px(value: string, vw: number, vh: number): number {
  const text = value.trim();
  const clamp = /^clamp\(([^,]+),([^,]+),([^)]+)\)$/.exec(text);
  if (clamp !== null) {
    const [min, preferred, max] = clamp.slice(1).map((part) => px(part, vw, vh));
    return Math.min(Math.max(min ?? 0, preferred ?? 0), max ?? 0);
  }
  const number = Number.parseFloat(text);
  if (text.endsWith('rem')) {
    return number * REM;
  }
  if (text.endsWith('vmin')) {
    return (number / 100) * Math.min(vw, vh);
  }
  if (text.endsWith('dvh')) {
    return (number / 100) * vh;
  }
  if (text.endsWith('vw')) {
    return (number / 100) * vw;
  }
  return number;
}

/**
 * The player's well, and the whole row it sits in during a match, at a
 * viewport. This is the arithmetic the layout actually performs — the same
 * `min()` the stylesheet writes once as `--field-height`.
 */
function wellsRow(vw: number, vh: number, blockCap: string): { field: number; row: number } {
  const pagePad = px(rootValue('--page-pad'), vw, vh);
  const gap = px(rootValue('--gap'), vw, vh);
  const meter = px(rootValue('--meter-width'), vw, vh);
  const scale = Number(rootValue('--opponent-scale'));
  // Below 48rem the rails fold above the well, so the reserve is the page
  // padding and nothing else.
  const reserve = 2 * pagePad;
  const field = Math.min(
    px(blockCap, vw, vh),
    44 * REM,
    ((vw - reserve) * BOARD_HEIGHT) / BOARD_WIDTH,
  );
  const wellWidth = (field * BOARD_WIDTH) / BOARD_HEIGHT;
  const opponentWidth = (field * scale * BOARD_WIDTH) / BOARD_HEIGHT;
  return { field, row: meter + gap + wellWidth + gap + opponentWidth };
}

describe('the opponent’s well', () => {
  it('costs the player’s well nothing, because the wrapper is not a box', () => {
    // The whole of "nothing else moved": outside a match `.wells` generates no
    // box at all, so `.playfield` is a direct child of the body grid exactly as
    // it always was and every placement, percentage and media query below still
    // resolves against the same containing block.
    expect(/\.wells\s*\{\s*display:\s*contents;\s*\}/.test(CSS)).toBe(true);
  });

  it('changes nothing the player’s field is sized from', () => {
    // The structural proof of "not smaller than it is today at any viewport".
    // Every versus-scoped rule in the sheet is collected and checked against the
    // four properties `--field-height` is built out of. If a future tweak makes
    // the well smaller during a match, it has to go through one of these.
    const sizing = ['--field-block-cap', '--field-inline-reserve', '--field-height', '--rail'];
    const versusRules = [...CSS.matchAll(/:root\[data-versus='on'\][^{]*\{([^}]*)\}/g)].map(
      (match) => match[1] ?? '',
    );

    expect(versusRules.length).toBeGreaterThan(0);
    for (const body of versusRules) {
      for (const property of sizing) {
        expect(body, `a versus rule sets ${property}`).not.toContain(property);
      }
      expect(body).not.toContain('aspect-ratio');
    }
  });

  it('never squeezes the player’s well, whatever else has to give', () => {
    // `.playfield` cannot shrink and `.opponent` can, so a viewport too narrow
    // for the pair takes it out of the opponent — which is the right way round.
    const playfield = /\n\.playfield\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    const opponent = /\n\.opponent\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';

    expect(playfield).toContain('flex: 0 0 auto');
    expect(opponent).toContain('flex: 0 1 auto');
    expect(opponent).toContain('min-width: 0');
  });

  it('fits beside the player’s well on a 360x640 portrait phone', () => {
    // The viewport the brief names. The well there is height-bound — the cap is
    // a fraction of 640, and 360 is wide enough for a well twice as wide as the
    // one it gets — so the opponent goes in the horizontal space that was
    // already doing nothing, and the player's field keeps every pixel.
    const available = 360 - 2 * px(rootValue('--page-pad'), 360, 640);

    // With the on-screen pad up, which is the usual state of a phone...
    const withPad = wellsRow(360, 640, '62dvh');
    expect(withPad.field).toBeCloseTo(0.62 * 640, 5);
    expect(withPad.row).toBeLessThan(available);

    // ...and without it, which is the tighter of the two.
    const noPad = wellsRow(360, 640, '72dvh');
    expect(noPad.field).toBeCloseTo(0.72 * 640, 5);
    expect(noPad.row).toBeLessThan(available);
  });

  it('fits on the narrowest phone the layout claims to support', () => {
    const available = 320 - 2 * px(rootValue('--page-pad'), 320, 568);

    expect(wellsRow(320, 568, '72dvh').row).toBeLessThan(available);
  });

  it('keeps both caps the fit was measured against', () => {
    // The two numbers `wellsRow` is handed. If either moves, the arithmetic
    // above is measuring a layout that no longer exists.
    expect(CSS).toContain('--field-block-cap: 72dvh');
    expect(CSS).toContain('--field-block-cap: 62dvh');
  });

  it('draws the opponent smaller than the player, and at the same proportions', () => {
    const scale = Number(rootValue('--opponent-scale'));

    expect(scale).toBeGreaterThan(0.25);
    expect(scale).toBeLessThan(0.6);
    // Against the well's *actual* height — `--field-height` clamped by the row
    // it is in — rather than against what the field would like to be. On every
    // phone those differ, and reading the wrong one drew an opponent nearly as
    // wide as the player's well at 320px.
    expect(CSS).toContain('calc(var(--opponent-scale) * min(var(--field-height), 100%))');
    expect(CSS).toContain('.opponent__canvas');
  });
});
