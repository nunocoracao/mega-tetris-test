/**
 * WCAG contrast, checked against the stylesheet itself.
 *
 * An automated page audit cannot do this one: axe computes colour contrast by
 * asking a real rendering engine what pixels it painted, and neither jsdom nor
 * a headless build of this repo has one. What it *can* be done against is the
 * palette, which is the only place a colour is written down — so every pair
 * that matters is enumerated below and the ratios are computed from the actual
 * declarations in `style.css`. A colour edit that drops a pair under AA fails
 * the suite rather than shipping.
 *
 * Both palettes are checked: the default one, and the high-contrast overrides
 * layered on top of it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PIECE_KINDS } from '../engine';
import { PIECE_PROPERTY } from './palette';

const CSS = readFileSync(fileURLToPath(new URL('../style.css', import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// Reading the stylesheet
// ---------------------------------------------------------------------------

/** The declarations of the rule whose selector line starts at `from`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `stylesheet has no "${selector}" rule`).toBeGreaterThanOrEqual(0);
  // The selector argument carries its own `{`, so the search starts at `start`
  // rather than past it — otherwise this finds the *next* rule's brace.
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') {
      depth += 1;
    } else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, i);
      }
    }
  }
  throw new Error(`Unterminated rule for "${selector}".`);
}

function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>();
  // Comments can contain colons and semicolons; strip them before parsing.
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      found.set(name, value.trim());
    }
  }
  return found;
}

const BASE = declarations(ruleBody(CSS, ':root {'));
const HIGH_ATTRIBUTE = declarations(ruleBody(CSS, ":root[data-contrast='on'] {"));
const HIGH_MEDIA = declarations(ruleBody(CSS, ":root:not([data-contrast='off']) {"));

/** The palette a player actually sees, base with any overrides layered on. */
function palette(overrides: Map<string, string> = new Map()): Map<string, string> {
  return new Map([...BASE, ...overrides]);
}

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa` and `rgb(r g b / a)` — everything the sheet uses. */
function parseColor(value: string): Rgba {
  const text = value.trim();
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/i.exec(text);
  if (rgb !== null) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: Number(rgb[4]),
    };
  }
  let hex = text.replace('#', '');
  if (hex.length === 3) {
    hex = [...hex].map((c) => c + c).join('');
  }
  expect(hex, `cannot parse colour "${value}"`).toMatch(/^[0-9a-f]{6}([0-9a-f]{2})?$/i);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

/** `over` composited onto `under`, so a translucent surface can be measured. */
function composite(over: Rgba, under: Rgba): Rgba {
  return {
    r: over.r * over.a + under.r * (1 - over.a),
    g: over.g * over.a + under.g * (1 - over.a),
    b: over.b * over.a + under.b * (1 - over.a),
    a: 1,
  };
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Resolve a property to an opaque colour, compositing it over `backdrop` when
 * the declaration carries an alpha channel.
 */
function resolve(vars: Map<string, string>, property: string, backdrop?: Rgba): Rgba {
  const raw = vars.get(property);
  expect(raw, `stylesheet has no ${property}`).toBeDefined();
  const parsed = parseColor(raw as string);
  if (parsed.a >= 1) {
    return parsed;
  }
  expect(backdrop, `${property} is translucent and needs a backdrop`).toBeDefined();
  return composite(parsed, backdrop as Rgba);
}

// ---------------------------------------------------------------------------
// What has to pass, and against what
// ---------------------------------------------------------------------------

interface Pair {
  readonly what: string;
  readonly fg: string;
  readonly bg: string;
  /** Composited under `bg` first, when `bg` is translucent. */
  readonly under?: string;
}

/** Body text: WCAG AA wants 4.5:1. */
const TEXT_PAIRS: readonly Pair[] = [
  { what: 'body ink on the cabinet floor', fg: '--fg', bg: '--cabinet-deep' },
  { what: 'body ink under the marquee light', fg: '--fg', bg: '--cabinet-lit' },
  { what: 'stat values on a panel', fg: '--fg', bg: '--panel' },
  { what: 'button labels on the raised half of a control', fg: '--fg', bg: '--panel-hover' },
  { what: 'muted labels on a panel', fg: '--fg-muted', bg: '--panel' },
  { what: 'quiet buttons on the cabinet floor', fg: '--fg-muted', bg: '--cabinet-deep' },
  { what: 'quiet buttons under the marquee light', fg: '--fg-muted', bg: '--cabinet-lit' },
  { what: 'quiet buttons on a dialog panel', fg: '--fg-muted', bg: '--panel-hover' },
  { what: 'the score readout on a panel', fg: '--accent', bg: '--panel' },
  { what: 'keycap letters on their cap', fg: '--accent', bg: '--cabinet' },
  { what: 'dialog titles on a dialog panel', fg: '--accent', bg: '--panel-hover' },
  { what: 'the title on the cabinet', fg: '--accent', bg: '--cabinet-lit' },
  { what: 'the pink end of the title gradient', fg: '--accent-2', bg: '--cabinet-lit' },
  { what: 'primary button ink', fg: '--accent-ink', bg: '--accent' },
  { what: 'primary button ink on its lit edge', fg: '--accent-ink', bg: '--accent-lit' },
  {
    what: 'the overlay title over the veiled well',
    fg: '--accent',
    bg: '--overlay-veil',
    under: '--well',
  },
  {
    what: 'the overlay hint over the veiled well',
    fg: '--fg',
    bg: '--overlay-veil',
    under: '--well',
  },
];

/** Control boundaries and focus rings: WCAG 1.4.11 wants 3:1. */
const UI_PAIRS: readonly Pair[] = [
  { what: 'a control border on the cabinet floor', fg: '--edge', bg: '--cabinet-deep' },
  { what: 'a control border under the marquee light', fg: '--edge', bg: '--cabinet-lit' },
  { what: 'a control border against its own fill', fg: '--edge', bg: '--panel-hover' },
  { what: 'a control border against a panel', fg: '--edge', bg: '--panel' },
  { what: 'a keycap border against its cap', fg: '--edge', bg: '--cabinet' },
  { what: 'the well frame against the well', fg: '--field-frame', bg: '--well' },
  { what: 'the well frame against the floor of the well', fg: '--field-frame', bg: '--well-deep' },
  { what: 'the focus ring on the cabinet floor', fg: '--accent', bg: '--cabinet-deep' },
  { what: 'the focus ring on a panel', fg: '--accent', bg: '--panel' },
  { what: 'the focus ring on a control', fg: '--accent', bg: '--panel-hover' },
];

/** The ratio a pair actually achieves in a given palette. */
function ratioFor(vars: Map<string, string>, pair: Pair): number {
  const backdrop = pair.under === undefined ? undefined : resolve(vars, pair.under);
  const bg = resolve(vars, pair.bg, backdrop);
  const fg = resolve(vars, pair.fg, bg);
  return contrastRatio(fg, bg);
}

function check(vars: Map<string, string>, pairs: readonly Pair[], minimum: number): void {
  for (const pair of pairs) {
    const ratio = ratioFor(vars, pair);
    expect(
      Number(ratio.toFixed(2)),
      `${pair.what} (${pair.fg} on ${pair.bg}) is ${ratio.toFixed(2)}:1, under ${minimum}:1`,
    ).toBeGreaterThanOrEqual(minimum);
  }
}

/** Blocks against the well they sit in: they are UI, so 3:1. */
function checkPieces(vars: Map<string, string>): void {
  for (const kind of PIECE_KINDS) {
    for (const surface of ['--well', '--well-deep'] as const) {
      const bg = resolve(vars, surface);
      const fg = resolve(vars, PIECE_PROPERTY[kind], bg);
      const ratio = contrastRatio(fg, bg);
      expect(
        Number(ratio.toFixed(2)),
        `piece ${kind} on ${surface} is ${ratio.toFixed(2)}:1, under 3:1`,
      ).toBeGreaterThanOrEqual(3);
    }
  }
}

describe('the default palette', () => {
  it('meets AA for every piece of text', () => {
    check(palette(), TEXT_PAIRS, 4.5);
  });

  it('meets 3:1 for every control boundary and focus ring', () => {
    check(palette(), UI_PAIRS, 3);
  });

  it('keeps every block readable against the well', () => {
    checkPieces(palette());
  });
});

describe('the high-contrast palette', () => {
  it('meets AA for every piece of text', () => {
    check(palette(HIGH_ATTRIBUTE), TEXT_PAIRS, 4.5);
  });

  it('meets 3:1 for every control boundary and focus ring', () => {
    check(palette(HIGH_ATTRIBUTE), UI_PAIRS, 3);
  });

  it('keeps every block readable against the well', () => {
    checkPieces(palette(HIGH_ATTRIBUTE));
  });

  it('is genuinely higher contrast than the default, not just different', () => {
    const base = palette();
    const high = palette(HIGH_ATTRIBUTE);
    for (const pair of [...TEXT_PAIRS, ...UI_PAIRS]) {
      const before = ratioFor(base, pair);
      const after = ratioFor(high, pair);
      expect(
        Number(after.toFixed(2)),
        `${pair.what} got *less* contrast in high-contrast mode`,
      ).toBeGreaterThanOrEqual(Number(before.toFixed(2)));
    }
  });

  it('is written identically in both places it has to be written', () => {
    // CSS cannot share one body between a media query and an attribute
    // selector, so the two copies are compared here instead. Add a property to
    // one and this fails until it is added to the other.
    expect([...HIGH_MEDIA.entries()].sort()).toEqual([...HIGH_ATTRIBUTE.entries()].sort());
  });

  it('overrides only properties the base palette declares', () => {
    for (const name of HIGH_ATTRIBUTE.keys()) {
      expect(BASE.has(name), `--${name} is only declared in the high-contrast block`).toBe(true);
    }
  });
});

describe('the stylesheet', () => {
  it('never removes a focus indicator without replacing it', () => {
    // `outline: none` is the single most common way a stylesheet breaks
    // keyboard use. If one ever has to exist, it needs a replacement indicator
    // in the same rule — and this test updating to say so.
    const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(withoutComments).not.toMatch(/outline:\s*(none|0)\b/);
  });

  it('has a focus-visible baseline, so a new control cannot arrive without one', () => {
    expect(CSS).toMatch(/^:focus-visible \{/m);
  });
});
