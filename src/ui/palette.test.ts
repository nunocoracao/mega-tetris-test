import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PIECE_KINDS } from '../engine';
import {
  DEFAULT_PALETTE,
  DEFAULT_PIECE_HEX,
  DEFAULT_SURFACE_HEX,
  PIECE_PROPERTY,
  SURFACE_PROPERTY,
  blockColor,
  buildPalette,
  mixHex,
  parseHex,
  toHex,
  withAlpha,
  type SurfaceColors,
} from './palette';

const HEX = /^#[0-9a-f]{6}$/;

/**
 * The custom properties declared in the *default palette* block — Midnight,
 * not the skins below it and not the `prefers-contrast` overrides.
 *
 * Located by its second selector, which occurs exactly once: `:root {` names
 * the geometry block as well now that the palette has been split out of it, so
 * anchoring there would have found the wrong one without complaining.
 */
function rootProperties(): Map<string, string> {
  const css = readFileSync(fileURLToPath(new URL('../style.css', import.meta.url)), 'utf8');
  const start = css.indexOf(".swatch[data-theme='midnight'] {");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('\n}', start);
  const block = css.slice(start, end);

  const declarations = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      declarations.set(name, value.trim());
    }
  }
  return declarations;
}

describe('parseHex', () => {
  it('reads both hex spellings, case insensitively', () => {
    expect(parseHex('#ff8800')).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseHex('#F80')).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseHex('  #ff8800  ')).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('rejects anything that is not a hex colour', () => {
    for (const value of ['', 'red', 'rgb(1 2 3)', '#ff88', '#gggggg', 'var(--piece-i)']) {
      expect(parseHex(value)).toBeNull();
    }
  });

  it('round-trips through toHex', () => {
    expect(toHex({ r: 255, g: 136, b: 0 })).toBe('#ff8800');
    expect(toHex({ r: -20, g: 300, b: 7.6 })).toBe('#00ff08');
  });
});

describe('mixHex', () => {
  it('interpolates between two colours', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('clamps the amount and passes unparseable colours through', () => {
    expect(mixHex('#000000', '#ffffff', -3)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 9)).toBe('#ffffff');
    expect(mixHex('nonsense', '#ffffff', 0.5)).toBe('nonsense');
  });
});

describe('blockColor', () => {
  it('derives a lighter bevel and a darker edge from the face', () => {
    for (const kind of PIECE_KINDS) {
      const { fill, light, shade } = blockColor(DEFAULT_PIECE_HEX[kind]);
      const face = parseHex(fill);
      const lit = parseHex(light);
      const dark = parseHex(shade);
      expect(face).not.toBeNull();
      expect(lit).not.toBeNull();
      expect(dark).not.toBeNull();

      const luminance = (c: { r: number; g: number; b: number }): number =>
        0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      expect(luminance(lit!)).toBeGreaterThan(luminance(face!));
      expect(luminance(dark!)).toBeLessThan(luminance(face!));
    }
  });

  it('normalises the face it is given', () => {
    expect(blockColor('#F80').fill).toBe('#ff8800');
  });
});

describe('withAlpha', () => {
  it('builds valid translucent variants', () => {
    expect(withAlpha('#35d0ee', 0)).toBe('#35d0ee00');
    expect(withAlpha('#35d0ee', 1)).toBe('#35d0eeff');
    expect(withAlpha('#35d0ee', 0.5)).toBe('#35d0ee80');
    expect(withAlpha('#35d0ee', 5)).toBe('#35d0eeff');
  });
});

describe('buildPalette', () => {
  it('reads every colour from the properties it is given', () => {
    const palette = buildPalette((property) => (property === '--piece-i' ? '#123456' : null));

    expect(palette.pieces.I.fill).toBe('#123456');
    expect(palette.pieces.O.fill).toBe(DEFAULT_PIECE_HEX.O);
  });

  it('falls back per property when a value is missing or unusable', () => {
    const palette = buildPalette(() => '  ');

    for (const kind of PIECE_KINDS) {
      expect(palette.pieces[kind].fill).toBe(DEFAULT_PIECE_HEX[kind]);
    }
    expect(palette.surfaces.well).toBe(DEFAULT_SURFACE_HEX.well);
  });

  it('gives every piece and surface a usable colour', () => {
    for (const kind of PIECE_KINDS) {
      const color = DEFAULT_PALETTE.pieces[kind];
      expect(color.fill).toMatch(HEX);
      expect(color.light).toMatch(HEX);
      expect(color.shade).toMatch(HEX);
    }
    for (const key of Object.keys(SURFACE_PROPERTY) as (keyof SurfaceColors)[]) {
      expect(DEFAULT_PALETTE.surfaces[key]).toMatch(HEX);
    }
  });

  it('gives the seven pieces seven distinct faces', () => {
    const faces = new Set(PIECE_KINDS.map((kind) => DEFAULT_PALETTE.pieces[kind].fill));

    expect(faces.size).toBe(PIECE_KINDS.length);
  });
});

/**
 * The stylesheet is the source of truth; the constants in `palette.ts` are the
 * fallback used before first paint and in these DOM-free tests. If the two ever
 * disagree the game flickers on load, so pin them together here.
 */
describe('the stylesheet and the fallback palette agree', () => {
  const declared = rootProperties();

  it('declares every piece property', () => {
    for (const kind of PIECE_KINDS) {
      expect(declared.get(PIECE_PROPERTY[kind])).toBe(DEFAULT_PIECE_HEX[kind]);
    }
  });

  it('declares every surface property', () => {
    for (const key of Object.keys(SURFACE_PROPERTY) as (keyof SurfaceColors)[]) {
      expect(declared.get(SURFACE_PROPERTY[key])).toBe(DEFAULT_SURFACE_HEX[key]);
    }
  });
});
