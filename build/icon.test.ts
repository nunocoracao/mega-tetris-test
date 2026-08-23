/**
 * The icon, checked against the palette it claims to be drawn from.
 *
 * The interesting properties are all "does this still agree with something
 * else": the fills against the seven faces the game paints blocks with, the
 * maskable variant against the safe circle a platform will crop it to, and the
 * favicon data URI against the drawing every other size comes from. A test that
 * only asserted the SVG parsed would pass an icon that had drifted into the
 * wrong colours.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_PIECE_HEX, DEFAULT_SURFACE_HEX } from '../src/ui/palette';
import { rootProperties } from './css';
import {
  ICON_BACKGROUND,
  ICON_FACES,
  ICON_TILE,
  faviconDataUri,
  iconShapes,
  iconSvg,
  type IconShape,
} from './icon';
import { encodePng, parseHex, rasterize } from './png';

const PROPERTIES = rootProperties();

/** The furthest any part of a rounded rectangle reaches from the tile's centre. */
function reach(shape: IconShape): number {
  const middle = ICON_TILE / 2;
  const corners: readonly (readonly [number, number])[] = [
    [shape.x + shape.r, shape.y + shape.r],
    [shape.x + shape.w - shape.r, shape.y + shape.r],
    [shape.x + shape.r, shape.y + shape.h - shape.r],
    [shape.x + shape.w - shape.r, shape.y + shape.h - shape.r],
  ];
  const arc = Math.max(...corners.map(([x, y]) => Math.hypot(x - middle, y - middle)));
  return arc + shape.r;
}

describe('the drawing', () => {
  it('is a background and the four blocks of a square piece', () => {
    const shapes = iconShapes('rounded', PROPERTIES);

    expect(shapes).toHaveLength(1 + ICON_FACES.length);
    const [background, ...blocks] = shapes;
    expect(background?.w).toBe(ICON_TILE);
    expect(background?.h).toBe(ICON_TILE);
    // Four squares of one size, in two rows of two.
    expect(new Set(blocks.map((block) => block.w))).toHaveLength(1);
    expect(new Set(blocks.map((block) => block.x))).toHaveLength(2);
    expect(new Set(blocks.map((block) => block.y))).toHaveLength(2);
  });

  it('paints in the game’s own colours and no others', () => {
    // `DEFAULT_PIECE_HEX` is pinned to `style.css` by `ui/palette.test.ts`, so
    // agreeing with it is agreeing with the stylesheet — by a different route
    // than the one the icon takes to get there, which is what makes it a check.
    const shapes = iconShapes('rounded', PROPERTIES);
    const fills = shapes.map((shape) => shape.fill);

    expect(fills.slice(1)).toEqual([
      DEFAULT_PIECE_HEX.I,
      DEFAULT_PIECE_HEX.O,
      DEFAULT_PIECE_HEX.Z,
      DEFAULT_PIECE_HEX.T,
    ]);
    // The tile's ground is the cabinet's deepest plum — the colour the page
    // itself is painted on, and the manifest's background.
    expect(fills[0]).toBe(PROPERTIES.get(ICON_BACKGROUND));
    expect(fills[0]).not.toBe(DEFAULT_SURFACE_HEX.well);
  });

  it('keeps every face distinct from the ground it sits on', () => {
    for (const shape of iconShapes('rounded', PROPERTIES).slice(1)) {
      expect(shape.fill).not.toBe(PROPERTIES.get(ICON_BACKGROUND));
    }
  });
});

describe('the variants', () => {
  it('rounds the tile for the icon proper and squares it for the rest', () => {
    expect(iconShapes('rounded', PROPERTIES)[0]?.r).toBeGreaterThan(0);
    expect(iconShapes('square', PROPERTIES)[0]?.r).toBe(0);
    expect(iconShapes('maskable', PROPERTIES)[0]?.r).toBe(0);
  });

  it('keeps the maskable blocks inside the 80% safe circle', () => {
    // The zone every platform promises not to crop: a circle of 80% the icon's
    // width, centred. A square's corners are the part that sticks out of one,
    // so this is computed rather than eyeballed.
    const safeRadius = 0.4 * ICON_TILE;
    for (const shape of iconShapes('maskable', PROPERTIES).slice(1)) {
      expect(reach(shape)).toBeLessThan(safeRadius);
    }
  });

  it('draws the maskable blocks smaller than the ordinary ones', () => {
    const ordinary = iconShapes('rounded', PROPERTIES)[1];
    const maskable = iconShapes('maskable', PROPERTIES)[1];

    expect(maskable?.w).toBeLessThan(ordinary?.w ?? 0);
  });

  it('centres every variant', () => {
    for (const variant of ['rounded', 'square', 'maskable'] as const) {
      const blocks = iconShapes(variant, PROPERTIES).slice(1);
      const left = Math.min(...blocks.map((block) => block.x));
      const right = Math.max(...blocks.map((block) => block.x + block.w));
      expect(left + right).toBeCloseTo(ICON_TILE, 6);
    }
  });
});

describe('the SVG', () => {
  it('carries a viewBox and every fill from the shapes', () => {
    const svg = iconSvg('rounded', { properties: PROPERTIES });

    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${ICON_TILE} ${ICON_TILE}"`);
    expect(svg.endsWith('</svg>')).toBe(true);
    for (const shape of iconShapes('rounded', PROPERTIES)) {
      expect(svg).toContain(`fill="${shape.fill}"`);
    }
  });

  it('is sized only when a size is asked for', () => {
    // The `<rect>`s have widths of their own; it is the root element that is
    // left unsized so the favicon can be asked for at any size.
    const openingTag = (svg: string): string => svg.slice(0, svg.indexOf('>'));

    expect(openingTag(iconSvg('rounded', { properties: PROPERTIES }))).not.toContain('width=');
    expect(openingTag(iconSvg('rounded', { size: 512, properties: PROPERTIES }))).toContain(
      'width="512"',
    );
  });
});

describe('the favicon data URI', () => {
  const uri = faviconDataUri(PROPERTIES);

  it('is the same drawing as everything else', () => {
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
    for (const shape of iconShapes('rounded', PROPERTIES)) {
      // `#` becomes `%23`; the rest of the colour is literal.
      expect(uri).toContain(shape.fill.replace('#', '%23'));
    }
  });

  it('escapes everything that would break out of an HTML attribute', () => {
    // Left unescaped, any of these four turns the attribute into markup, a
    // fragment, or a shorter URI than intended.
    for (const character of ['<', '>', '#', '"']) {
      expect(uri).not.toContain(character);
    }
  });

  it('costs no request, which is the whole reason it is inline', () => {
    expect(uri.length).toBeLessThan(1024);
  });
});

describe('the rasteriser', () => {
  it('writes a PNG a decoder will recognise', () => {
    const png = encodePng(rasterize(iconShapes('rounded', PROPERTIES), 32, ICON_TILE), 32);

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(32);
    // 8-bit truecolour with alpha, deflate, no interlace.
    expect([...png.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0]);
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
  });

  it('is deterministic, so a rebuild is not a new file', () => {
    const shapes = iconShapes('rounded', PROPERTIES);
    expect(encodePng(rasterize(shapes, 64, ICON_TILE), 64)).toEqual(
      encodePng(rasterize(shapes, 64, ICON_TILE), 64),
    );
  });

  it('paints the middle of a block in that block’s own colour', () => {
    const size = 64;
    const shapes = iconShapes('rounded', PROPERTIES);
    const pixels = rasterize(shapes, size, ICON_TILE);
    const block = shapes[1];
    expect(block).toBeDefined();

    const x = Math.floor(((block?.x ?? 0) + (block?.w ?? 0) / 2) * (size / ICON_TILE));
    const y = Math.floor(((block?.y ?? 0) + (block?.h ?? 0) / 2) * (size / ICON_TILE));
    const offset = (y * size + x) * 4;
    const expected = parseHex(block?.fill ?? '#000000');

    expect([pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]]).toEqual([
      expected.r,
      expected.g,
      expected.b,
      255,
    ]);
  });

  it('leaves the rounded tile’s corners transparent and fills the square one', () => {
    const size = 64;
    const rounded = rasterize(iconShapes('rounded', PROPERTIES), size, ICON_TILE);
    const square = rasterize(iconShapes('square', PROPERTIES), size, ICON_TILE);

    // The very first pixel: outside the corner arc, inside the square.
    expect(rounded[3]).toBe(0);
    expect(square[3]).toBe(255);
  });

  it('antialiases the corner rather than stepping it', () => {
    const size = 64;
    const pixels = rasterize(iconShapes('rounded', PROPERTIES), size, ICON_TILE);
    const alphas: number[] = [];
    for (let index = 3; index < pixels.length; index += 4) {
      alphas.push(pixels[index] ?? 0);
    }

    // A hard-edged rasteriser produces only 0 and 255; an antialiased one
    // produces a scattering of partial coverage along the four arcs.
    expect(alphas.some((alpha) => alpha > 0 && alpha < 255)).toBe(true);
  });
});

describe('parseHex', () => {
  it('reads both spellings', () => {
    expect(parseHex('#f80')).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseHex('#FF8800')).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('refuses anything the icon cannot be drawn in', () => {
    // The palette could grow an `rgb()` or a `color-mix()` one day. Better a
    // failed build than an icon quietly drawn in black.
    for (const value of ['red', 'rgb(1 2 3)', 'var(--piece-i)', '']) {
      expect(() => parseHex(value)).toThrow();
    }
  });
});
