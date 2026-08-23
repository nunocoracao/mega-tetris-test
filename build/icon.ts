/**
 * The cabinet's icon, drawn here.
 *
 * Four blocks in a square — the O piece, in four of the game's own seven face
 * colours, on the cabinet's deep plum. It is the drawing the favicon has always
 * been; what is new is that it is now *one* drawing, described as geometry and
 * rendered three ways: an SVG for the browsers that take one, PNGs rasterised
 * at build time for the ones that do not, and a full-bleed maskable variant for
 * the platforms that crop.
 *
 * Two rules held it to this shape. It has to read at 48px, where a piece
 * silhouette works and a wordmark does not; and every colour in it has to come
 * out of `src/style.css`, so that retuning the palette retunes the icon rather
 * than leaving it behind. There is no image file anywhere in the repository and
 * this is what replaces one.
 */

import { paletteColor, rootProperties } from './css';

/** The tile's coordinate space. 32 units square, as the favicon has always been. */
export const ICON_TILE = 32;

/** A rounded rectangle in tile units. The only primitive the icon needs. */
export interface IconShape {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Corner radius. `0` is a plain rectangle. */
  readonly r: number;
  readonly fill: string;
}

/**
 * Which of the three drawings.
 *
 * - `rounded` is the icon proper: a rounded tile with transparent corners.
 * - `square` is the same drawing full-bleed and opaque, which is what an Apple
 *   touch icon has to be — iOS composites it against nothing and rounds it
 *   itself, so a transparent corner comes out black.
 * - `maskable` is full-bleed too, with the blocks pulled into the middle so the
 *   whole drawing survives a platform cropping it to a circle.
 */
export type IconVariant = 'rounded' | 'square' | 'maskable';

/**
 * How much of the tile the four blocks span.
 *
 * `23 / 32` is the original favicon's geometry to the unit. The maskable
 * variant is smaller because the safe zone is a *circle* of 80% the width and a
 * square's corners are the part that sticks out of one: at 60% the furthest
 * point of the furthest rounded corner sits at 39% of the width from the
 * centre, inside the circle with a little to spare. `icon.test.ts` computes
 * that rather than trusting this paragraph.
 */
const BLOCK_FIELD: Readonly<Record<IconVariant, number>> = {
  rounded: 23 / 32,
  square: 23 / 32,
  maskable: 0.6,
};

/** The tile's own corner radius, as a fraction of its width. */
const TILE_RADIUS = 7 / 32;

/** A block's corner radius, as a fraction of the block's width. */
const BLOCK_RADIUS = 3 / 11;

/**
 * The four faces, in reading order: turquoise, marigold, coral, orchid. Four of
 * the seven, chosen for hue *and* value spread so the quarters stay distinct at
 * 16px and in greyscale.
 */
export const ICON_FACES: readonly string[] = ['--piece-i', '--piece-o', '--piece-z', '--piece-t'];

/** The property carrying the tile's background. */
export const ICON_BACKGROUND = '--cabinet-deep';

/**
 * The icon as a list of shapes, back to front.
 *
 * Everything downstream — the SVG writer and the rasteriser — consumes this,
 * so the drawing exists exactly once and the two renderings cannot disagree.
 */
export function iconShapes(
  variant: IconVariant,
  properties: ReadonlyMap<string, string> = rootProperties(),
): readonly IconShape[] {
  const field = BLOCK_FIELD[variant] * ICON_TILE;
  // Eleven units of block to one of gap, twice over: the proportion the tile
  // was drawn at, expressed so the maskable variant can be a different size
  // without being a different drawing.
  const block = (field * 11) / 23;
  const gap = field / 23;
  const origin = (ICON_TILE - field) / 2;

  const background: IconShape = {
    x: 0,
    y: 0,
    w: ICON_TILE,
    h: ICON_TILE,
    r: variant === 'rounded' ? TILE_RADIUS * ICON_TILE : 0,
    fill: paletteColor(ICON_BACKGROUND, properties),
  };

  const blocks = ICON_FACES.map((face, index) => ({
    x: origin + (index % 2) * (block + gap),
    y: origin + Math.floor(index / 2) * (block + gap),
    w: block,
    h: block,
    r: BLOCK_RADIUS * block,
    fill: paletteColor(face, properties),
  }));

  return [background, ...blocks];
}

/** Trim a coordinate to three decimals — enough for a 512px raster, and short. */
function unit(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * The icon as an SVG document.
 *
 * `size` fixes `width`/`height` for the files written to disk; leaving it out
 * gives a viewBox-only document, which is what the favicon data URI wants so it
 * can be asked for at whatever size the browser feels like.
 */
export function iconSvg(
  variant: IconVariant,
  options: { readonly size?: number; readonly properties?: ReadonlyMap<string, string> } = {},
): string {
  const shapes = iconShapes(variant, options.properties);
  const dimensions =
    options.size === undefined ? '' : ` width="${options.size}" height="${options.size}"`;
  const body = shapes
    .map(
      (shape) =>
        `<rect x="${unit(shape.x)}" y="${unit(shape.y)}" width="${unit(shape.w)}" height="${unit(shape.h)}"` +
        (shape.r > 0 ? ` rx="${unit(shape.r)}"` : '') +
        ` fill="${shape.fill}"/>`,
    )
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_TILE} ${ICON_TILE}"${dimensions}>` +
    `${body}</svg>`
  );
}

/**
 * The favicon, as the `data:` URI the document has always carried.
 *
 * Still no request and still nothing to block first paint — but generated from
 * the same geometry as every other size, so the tab icon and the home-screen
 * icon are the same drawing by construction rather than by somebody remembering.
 *
 * Only the four characters a `data:` URI in an HTML attribute cannot carry
 * literally are escaped — including the double quotes, so that nothing
 * downstream has to re-escape them and the URI stays the length it looks.
 */
export function faviconDataUri(properties?: ReadonlyMap<string, string>): string {
  const svg = iconSvg('rounded', properties === undefined ? {} : { properties });
  const escaped = svg.replace(/[<>#"]/g, (character) => {
    switch (character) {
      case '<':
        return '%3C';
      case '>':
        return '%3E';
      case '#':
        return '%23';
      default:
        return '%22';
    }
  });
  return `data:image/svg+xml,${escaped}`;
}
