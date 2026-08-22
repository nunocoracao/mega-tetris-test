/**
 * The bridge between the stylesheet and the canvas.
 *
 * Every colour in the game is declared exactly once, in the `:root` block of
 * `style.css`. This module reads those custom properties back out of the
 * computed style and hands the renderer plain hex it can paint with, so the
 * chrome and the blocks can never drift apart and there is no second copy of
 * the palette living in TypeScript.
 *
 * The stylesheet only names the seven *face* colours. The lit bevel and the
 * shaded edge of a block are derived here by mixing the face toward white and
 * toward the cabinet's shadow ink — shading is drawn programmatically, so it
 * stays consistent across all seven pieces for free.
 *
 * The `DEFAULT_*` values below mirror the stylesheet. They are a fallback for
 * the window between module evaluation and first paint (and for tests, which
 * run without a DOM), not a second source of truth: if they and the CSS ever
 * disagree, the CSS wins the moment `refreshPalette` runs.
 */

import { PIECE_KINDS, type PieceKind } from '../engine';

/** One block's three tones: the face, its lit bevel and its shaded edge. */
export interface BlockColor {
  readonly fill: string;
  readonly light: string;
  readonly shade: string;
}

/** Colours for everything that is not a block: the well, its grid and frame. */
export interface SurfaceColors {
  /** Background of the playfield itself, at the top of the well. */
  readonly well: string;
  /** Background at the bottom of the well — the well is a soft vertical fade. */
  readonly wellDeep: string;
  /** Faint rule that makes the columns countable. */
  readonly gridLine: string;
  /** Frame drawn just inside the playfield edge. */
  readonly frame: string;
  /** Background of the small preview and hold canvases. */
  readonly panel: string;
  /** Drawn over the whole well while the run is not `playing`. */
  readonly veil: string;
  /** The cabinet's highlight colour — score popups and the level banner. */
  readonly accent: string;
  /** Body ink. Also the white a line clear flashes toward. */
  readonly ink: string;
}

export interface Palette {
  readonly pieces: Readonly<Record<PieceKind, BlockColor>>;
  readonly surfaces: SurfaceColors;
}

/** Which custom property carries each piece's face colour. */
export const PIECE_PROPERTY: Readonly<Record<PieceKind, string>> = {
  I: '--piece-i',
  O: '--piece-o',
  T: '--piece-t',
  S: '--piece-s',
  Z: '--piece-z',
  J: '--piece-j',
  L: '--piece-l',
};

/** Which custom property carries each surface colour. */
export const SURFACE_PROPERTY: Readonly<Record<keyof SurfaceColors, string>> = {
  well: '--well',
  wellDeep: '--well-deep',
  gridLine: '--grid-line',
  frame: '--field-frame',
  panel: '--panel-canvas',
  veil: '--veil',
  accent: '--accent',
  ink: '--fg',
};

/** Mirrors the `--piece-*` properties in `style.css`. */
export const DEFAULT_PIECE_HEX: Readonly<Record<PieceKind, string>> = {
  I: '#3ddad7',
  O: '#ffc857',
  T: '#c77dff',
  S: '#7ee081',
  Z: '#ff5d73',
  J: '#5b8cff',
  L: '#ff9f1c',
};

/** Mirrors the surface properties in `style.css`. */
export const DEFAULT_SURFACE_HEX: Readonly<Record<keyof SurfaceColors, string>> = {
  well: '#1a1126',
  wellDeep: '#100a19',
  gridLine: '#ffffff',
  frame: '#5a4478',
  panel: '#1d1529',
  veil: '#0b0712',
  accent: '#ffc857',
  ink: '#fbf4ff',
};

/** What a bevel is mixed toward: daylight above, cabinet shadow below. */
const HIGHLIGHT = '#ffffff';
const SHADOW = '#170f22';

/** How far the bevels travel from the face colour. */
const LIGHT_MIX = 0.5;
const SHADE_MIX = 0.52;

/** How strongly the ghost piece is painted, as fill and outline alpha. */
export const GHOST_ALPHA = { fill: 0.16, stroke: 0.7 } as const;

/** Grid line alpha — low enough to read as texture, not as content. */
export const GRID_ALPHA = 0.06;

// ---------------------------------------------------------------------------
// Colour arithmetic (pure)
// ---------------------------------------------------------------------------

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** `#rgb` or `#rrggbb` as channel bytes, or `null` for anything else. */
export function parseHex(value: string): Rgb | null {
  const text = value.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short !== null) {
    const [, r = '0', g = '0', b = '0'] = short;
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16) };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (long !== null) {
    const [, r = '00', g = '00', b = '00'] = long;
    return { r: parseInt(r, 16), g: parseInt(g, 16), b: parseInt(b, 16) };
  }
  return null;
}

function channel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

/** Channel bytes back to a lower-case `#rrggbb` string. */
export function toHex(rgb: Rgb): string {
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

/**
 * `amount` of the way from `from` to `to`, in plain sRGB.
 *
 * Not perceptually uniform, and deliberately so: it is the same arithmetic a
 * designer does by eye when picking a bevel, and it keeps the hue put.
 */
export function mixHex(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (a === null || b === null) {
    return from;
  }
  const t = Math.max(0, Math.min(1, amount));
  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

/** A face colour plus the two bevels derived from it. */
export function blockColor(fill: string): BlockColor {
  const parsed = parseHex(fill);
  const face = parsed === null ? fill : toHex(parsed);
  return {
    fill: face,
    light: mixHex(face, HIGHLIGHT, LIGHT_MIX),
    shade: mixHex(face, SHADOW, SHADE_MIX),
  };
}

/**
 * `#rrggbb` plus an alpha channel, as `#rrggbbaa`.
 *
 * Alpha is clamped to 0..1 and rounded to a byte, so the result is always a
 * valid CSS colour that canvas accepts directly.
 */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color);
  const clamped = Math.max(0, Math.min(1, alpha));
  const byte = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
  return rgb === null ? color : `${toHex(rgb)}${byte}`;
}

// ---------------------------------------------------------------------------
// Building a palette
// ---------------------------------------------------------------------------

/** Reads one custom property. Anything falsy means "not set". */
export type PropertyReader = (property: string) => string | null | undefined;

function hexFrom(read: PropertyReader, property: string, fallback: string): string {
  const raw = read(property);
  const parsed = typeof raw === 'string' ? parseHex(raw) : null;
  return parsed === null ? fallback : toHex(parsed);
}

/**
 * Build a palette from a property reader, falling back per-property.
 *
 * Pure, so the whole CSS-to-canvas contract is testable without a browser: a
 * reader is just a function from property name to string.
 */
export function buildPalette(read: PropertyReader): Palette {
  const pieces = {} as Record<PieceKind, BlockColor>;
  for (const kind of PIECE_KINDS) {
    pieces[kind] = blockColor(hexFrom(read, PIECE_PROPERTY[kind], DEFAULT_PIECE_HEX[kind]));
  }

  const surfaces = {} as Record<keyof SurfaceColors, string>;
  for (const key of Object.keys(SURFACE_PROPERTY) as (keyof SurfaceColors)[]) {
    surfaces[key] = hexFrom(read, SURFACE_PROPERTY[key], DEFAULT_SURFACE_HEX[key]);
  }

  return { pieces, surfaces };
}

/** The stylesheet's palette as this module last understood it. */
export const DEFAULT_PALETTE: Palette = buildPalette(() => null);

let current: Palette = DEFAULT_PALETTE;

/** The palette the renderer should paint with right now. */
export function getPalette(): Palette {
  return current;
}

/** Override the live palette. Exists for tests and for `refreshPalette`. */
export function setPalette(palette: Palette): void {
  current = palette;
}

/**
 * Re-read the palette from the document (or any element) and make it live.
 *
 * Called once at startup and again whenever the user's colour preferences
 * change, so a `prefers-contrast` or `prefers-color-scheme` override in the
 * stylesheet reaches the canvas as well as the chrome.
 */
export function refreshPalette(element: Element = document.documentElement): Palette {
  const computed = getComputedStyle(element);
  const palette = buildPalette((property) => computed.getPropertyValue(property));
  setPalette(palette);
  return palette;
}

/** The preference queries whose changes can restyle the cabinet. */
const THEME_QUERIES = ['(prefers-color-scheme: light)', '(prefers-contrast: more)'] as const;

/**
 * Refresh the palette whenever a colour preference changes, calling `onChange`
 * afterwards so the caller can repaint. Returns an unsubscribe function.
 */
export function watchPalette(onChange: (palette: Palette) => void): () => void {
  if (typeof matchMedia !== 'function') {
    return () => {};
  }

  const stops = THEME_QUERIES.map((query) => {
    const list = matchMedia(query);
    const handler = (): void => onChange(refreshPalette());
    list.addEventListener('change', handler);
    return () => list.removeEventListener('change', handler);
  });

  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}
