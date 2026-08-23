/**
 * WCAG contrast, checked against the stylesheet itself — for every skin, in
 * every contrast mode.
 *
 * An automated page audit cannot do this one: axe computes colour contrast by
 * asking a real rendering engine what pixels it painted, and neither jsdom nor
 * a headless build of this repo has one. What it *can* be done against is the
 * palette, which is the only place a colour is written down — so every pair
 * that matters is enumerated below and the ratios are computed from the actual
 * declarations in `style.css`. A colour edit that drops a pair under AA fails
 * the suite rather than shipping.
 *
 * The matrix is the point. There are four skins and three contrast settings,
 * and the settings compose *on top of* the skins rather than replacing them —
 * so every pair below is measured 4 × 3 times (with `auto` resolved both ways
 * through the real `isHighContrast`, which is what makes this a check on the
 * shipped decision rather than on a guess about it). A skin that is only legible
 * in standard contrast, or a high-contrast block that forgets a property and
 * silently inherits Midnight's, fails here.
 *
 * Three structural checks sit alongside the ratios, and they are the ones that
 * make adding a skin safe rather than merely possible:
 *
 *   - every skin declares the *complete* property set, so nothing half-inherits;
 *   - no skin declares a property the default does not;
 *   - the skins in the stylesheet and the skins in `ui/theme.ts` are the same
 *     list, so a picker entry can never point at a block that is not there.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PIECE_KINDS } from '../engine';
import { CONTRAST_SETTINGS, isHighContrast, type ContrastSetting } from './contrast';
import { PIECE_PROPERTY } from './palette';
import { DEFAULT_THEME, THEME_IDS, themeLabel, type ThemeId } from './theme';

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

/**
 * Where one skin's two blocks live.
 *
 * Both are found by a selector that occurs exactly once. The base block is
 * anchored on its `.swatch` half rather than its `:root` half, because every
 * skin — the default included — carries the pair so the picker's chips can be
 * painted by the very declarations they advertise.
 */
function baseSelector(theme: ThemeId): string {
  return `.swatch[data-theme='${theme}'] {`;
}

/**
 * The high-contrast override block. Midnight's is unqualified, because Midnight
 * is the absence of a `data-theme` attribute rather than a value of it.
 */
function highSelector(theme: ThemeId): string {
  return theme === DEFAULT_THEME
    ? ":root[data-contrast='on'] {"
    : `:root[data-theme='${theme}'][data-contrast='on'] {`;
}

const BASE = new Map(THEME_IDS.map((id) => [id, declarations(ruleBody(CSS, baseSelector(id)))]));
const HIGH = new Map(THEME_IDS.map((id) => [id, declarations(ruleBody(CSS, highSelector(id)))]));

/** Midnight's, and therefore everybody's. Absent means "not a themed property". */
const BASE_PROPERTIES = BASE.get(DEFAULT_THEME) as Map<string, string>;
const HIGH_PROPERTIES = HIGH.get(DEFAULT_THEME) as Map<string, string>;

/** The one media query: what a document is dressed in before the script runs. */
const HIGH_MEDIA = declarations(ruleBody(CSS, ":root:not([data-contrast='off']) {"));

/**
 * The palette a player on `theme` actually sees at `setting`, given what their
 * machine asked for. The overrides are layered on the skin, never instead of it
 * — which is exactly what the cascade does, and what the whole feature rests on.
 */
function palette(theme: ThemeId, setting: ContrastSetting, systemMore: boolean): Map<string, string> {
  const base = BASE.get(theme) as Map<string, string>;
  if (!isHighContrast(setting, systemMore)) {
    return new Map(base);
  }
  return new Map([...base, ...(HIGH.get(theme) as Map<string, string>)]);
}

/** Every combination the matrix runs over, named the way a failure should read. */
interface Mode {
  readonly what: string;
  readonly setting: ContrastSetting;
  readonly systemMore: boolean;
}

const MODES: readonly Mode[] = CONTRAST_SETTINGS.flatMap((setting) =>
  [false, true].map((systemMore) => ({
    what: `${setting} contrast on a machine asking for ${systemMore ? 'more' : 'standard'}`,
    setting,
    systemMore,
  })),
);

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

/** sRGB channel → linear light. Shared by luminance and the Lab conversion. */
function linear(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * CIE L*a*b*, via linear sRGB and D65.
 *
 * Needed because WCAG contrast is the *wrong* tool for "are these two blocks
 * telling themselves apart": it only knows about lightness, so turquoise and
 * mint at the same luminance come out at 1.05:1 and look identical to it while
 * looking nothing alike on screen. Lab knows about hue as well, and the
 * straight-line distance between two Lab points (ΔE*ab, CIE 1976) is the
 * cheapest honest answer to the question the pieces actually pose.
 */
function toLab({ r, g, b }: Rgba): readonly [number, number, number] {
  const [red, green, blue] = [linear(r), linear(g), linear(b)];
  const x = (red * 0.4124 + green * 0.3576 + blue * 0.1805) / 0.95047;
  const y = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const z = (red * 0.0193 + green * 0.1192 + blue * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(a: Rgba, b: Rgba): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
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
  // The last ten seconds of an Ultra, and the last few lines of a Sprint. It
  // has to clear AA on its own, because a player who has asked for stillness
  // gets the colour with no pulse under it.
  { what: 'the urgent readout on a panel', fg: '--accent-2', bg: '--panel' },
  { what: 'a mode blurb on its own button', fg: '--fg-muted', bg: '--panel-hover' },
  { what: 'the chosen mode’s name on its button', fg: '--accent', bg: '--panel-hover' },
  { what: 'the reset confirmation on its inset', fg: '--fg', bg: '--panel-canvas' },
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
  // The daily challenge's two lines — the date and the streak — sit on the same
  // veiled well as the hint above them.
  {
    what: 'the daily challenge’s lines over the veiled well',
    fg: '--fg-muted',
    bg: '--overlay-veil',
    under: '--well',
  },
  { what: 'the shareable line in its fallback box', fg: '--fg', bg: '--panel-canvas' },
  // The settings dialog: each key row sits on the same inset the reset
  // confirmation uses, and "Not bound" is muted text on it.
  { what: 'an unbound row in the key remapper', fg: '--fg-muted', bg: '--panel-canvas' },
];

/** Control boundaries and focus rings: WCAG 1.4.11 wants 3:1. */
const UI_PAIRS: readonly Pair[] = [
  { what: 'a control border on the cabinet floor', fg: '--edge', bg: '--cabinet-deep' },
  { what: 'a control border under the marquee light', fg: '--edge', bg: '--cabinet-lit' },
  { what: 'a control border against its own fill', fg: '--edge', bg: '--panel-hover' },
  { what: 'a control border against a panel', fg: '--edge', bg: '--panel' },
  { what: 'the level picker against its own fill', fg: '--edge', bg: '--panel' },
  { what: 'an unchosen mode button against its own fill', fg: '--edge', bg: '--panel' },
  { what: 'the chosen mode’s border against its own fill', fg: '--accent', bg: '--panel-hover' },
  { what: 'the reset confirmation border on its inset', fg: '--edge', bg: '--panel-canvas' },
  { what: 'a keycap border against its cap', fg: '--edge', bg: '--cabinet' },
  { what: 'the well frame against the well', fg: '--field-frame', bg: '--well' },
  { what: 'the well frame against the floor of the well', fg: '--field-frame', bg: '--well-deep' },
  // The skin picker's swatch is a well with a frame around it, so it inherits
  // the same requirement — a chip whose border vanished would be a colour blob.
  { what: 'a swatch’s frame against the swatch', fg: '--field-frame', bg: '--well' },
  { what: 'the focus ring on the cabinet floor', fg: '--accent', bg: '--cabinet-deep' },
  { what: 'the focus ring on a panel', fg: '--accent', bg: '--panel' },
  { what: 'the focus ring on a control', fg: '--accent', bg: '--panel-hover' },
  // The thirty-day strip. A missed day is an outline and a played one is a
  // fill, and both have to be visible on the veil before the shape difference
  // between them can tell anybody anything.
  {
    what: 'a missed day in the daily strip',
    fg: '--edge',
    bg: '--overlay-veil',
    under: '--well',
  },
  {
    what: 'a played day in the daily strip',
    fg: '--accent',
    bg: '--overlay-veil',
    under: '--well',
  },
  { what: 'the share fallback’s border on its inset', fg: '--edge', bg: '--panel-canvas' },
  // The try-it strip's block against the strip it slides along: the whole
  // point of it is watching the block move, so it has to be visible doing it.
  { what: 'the try-it block against its strip', fg: '--accent', bg: '--panel-canvas' },
];

/**
 * How far apart two block faces have to be before the shape of the stack can be
 * read without counting.
 *
 * ΔE*ab, not a contrast ratio — see `toLab`. 15 is a little under a JND at a
 * glance and is where the game already sits: Midnight's tightest pair in high
 * contrast (marigold against tangerine) is 16.2, and every skin below clears
 * 21. What the number deliberately does *not* have to carry is the whole job.
 * `ui/contrast.ts` stamps a distinct mark into every kind, so colour is a
 * convenience for telling two pieces apart and never the only cue.
 */
const MIN_PIECE_DELTA_E = 15;

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

/** And against each other: seven pieces have to stay seven pieces. */
function checkPiecesApart(vars: Map<string, string>): void {
  const faces = PIECE_KINDS.map((kind) => ({ kind, rgb: resolve(vars, PIECE_PROPERTY[kind]) }));

  for (let i = 0; i < faces.length; i += 1) {
    for (let j = i + 1; j < faces.length; j += 1) {
      const a = faces[i] as (typeof faces)[number];
      const b = faces[j] as (typeof faces)[number];
      const distance = deltaE(a.rgb, b.rgb);
      expect(
        Number(distance.toFixed(1)),
        `${a.kind} and ${b.kind} are ΔE ${distance.toFixed(1)} apart, under ${MIN_PIECE_DELTA_E}`,
      ).toBeGreaterThanOrEqual(MIN_PIECE_DELTA_E);
    }
  }
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

for (const theme of THEME_IDS) {
  describe(`the ${themeLabel(theme)} skin`, () => {
    for (const mode of MODES) {
      describe(`in ${mode.what}`, () => {
        const vars = palette(theme, mode.setting, mode.systemMore);

        it('meets AA for every piece of text', () => {
          check(vars, TEXT_PAIRS, 4.5);
        });

        it('meets 3:1 for every control boundary and focus ring', () => {
          check(vars, UI_PAIRS, 3);
        });

        it('keeps every block readable against the well', () => {
          checkPieces(vars);
        });

        it('keeps the seven blocks apart from each other', () => {
          checkPiecesApart(vars);
        });
      });
    }

    it('declares the complete palette, so nothing half-inherits the default', () => {
      // The failure this prevents is quiet rather than loud: a skin that omits
      // `--panel-canvas` does not break, it just wears Midnight's plum inset in
      // the middle of a daylight cabinet, and only a person looking at it would
      // ever know.
      const declared = BASE.get(theme) as Map<string, string>;
      const missing = [...BASE_PROPERTIES.keys()].filter((name) => !declared.has(name));

      expect(missing, `${themeLabel(theme)} leaves ${missing.join(', ')} to the default`).toEqual(
        [],
      );
    });

    it('declares a colour scheme, so the browser’s own widgets follow', () => {
      // Range sliders, checkboxes and scrollbars are painted by the browser,
      // not by us. A light skin under `color-scheme: dark` gets dark sliders on
      // a pale panel, which is the one part of the cabinet CSS cannot restyle.
      expect(ruleBody(CSS, baseSelector(theme))).toMatch(/color-scheme:\s*(light|dark);/);
    });

    it('declares the complete high-contrast override set', () => {
      const declared = HIGH.get(theme) as Map<string, string>;
      const missing = [...HIGH_PROPERTIES.keys()].filter((name) => !declared.has(name));

      expect(missing, `${themeLabel(theme)}'s high-contrast block omits ${missing.join(', ')}`)
        .toEqual([]);
    });

    it('declares nothing the default palette does not', () => {
      // A skin is a re-dressing, never an extension. A property invented here
      // would be defined for one skin and undefined for the rest, which is the
      // sort of thing that works until somebody switches skins.
      for (const name of [...(BASE.get(theme) as Map<string, string>).keys()]) {
        expect(BASE_PROPERTIES.has(name), `${name} is only declared by ${theme}`).toBe(true);
      }
      for (const name of [...(HIGH.get(theme) as Map<string, string>).keys()]) {
        expect(
          BASE_PROPERTIES.has(name) || HIGH_PROPERTIES.has(name),
          `${name} is only declared in ${theme}'s high-contrast block`,
        ).toBe(true);
      }
    });

    it('is genuinely higher contrast in high contrast, not just different', () => {
      const base = palette(theme, 'standard', false);
      const high = palette(theme, 'more', false);
      for (const pair of [...TEXT_PAIRS, ...UI_PAIRS]) {
        const before = ratioFor(base, pair);
        const after = ratioFor(high, pair);
        expect(
          Number(after.toFixed(2)),
          `${pair.what} got *less* contrast in ${theme}'s high-contrast mode`,
        ).toBeGreaterThanOrEqual(Number(before.toFixed(2)));
      }
    });
  });
}

describe('the set of skins', () => {
  it('is the same list in the stylesheet and in ui/theme.ts', () => {
    // `ruleBody` has already thrown for any id in `THEME_IDS` with no block.
    // This is the other direction: a block left behind after a skin was renamed
    // or dropped, which the picker would never offer and nobody would notice.
    const declared = [...CSS.matchAll(/\.swatch\[data-theme='([a-z-]+)'\]/g)]
      .map((match) => match[1] as string)
      .filter((id, index, all) => all.indexOf(id) === index);

    expect(declared.sort()).toEqual([...THEME_IDS].sort());
  });

  it('leaves the default on a bare `:root`, so an absent attribute is Midnight', () => {
    // The whole no-regression argument rests on this: a document that has never
    // run the script, or one whose script failed, is dressed exactly as the game
    // shipped. Midnight is therefore the *absence* of `data-theme`, never a
    // value of it — and no `:root[data-theme='midnight']` rule may exist.
    expect(CSS).toMatch(/^:root,\n\.swatch\[data-theme='midnight'\] \{/m);
    expect(CSS).not.toContain(":root[data-theme='midnight']");
  });

  it('gives only the default a `prefers-contrast` media copy', () => {
    // Midnight needs one: it is what a document is dressed in before the script
    // has had its say. A skin cannot be on screen until `data-theme` is set, by
    // which point `applyContrast` has already written `data-contrast` — so a
    // media copy for a skin could only ever duplicate its attribute block.
    for (const theme of THEME_IDS) {
      if (theme === DEFAULT_THEME) {
        continue;
      }
      expect(CSS).not.toContain(`:root[data-theme='${theme}']:not([data-contrast=`);
    }
  });
});

describe('the default skin’s high-contrast palette', () => {
  it('is written identically in both places it has to be written', () => {
    // CSS cannot share one body between a media query and an attribute
    // selector, so the two copies are compared here instead. Add a property to
    // one and this fails until it is added to the other.
    expect([...HIGH_MEDIA.entries()].sort()).toEqual([...HIGH_PROPERTIES.entries()].sort());
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
