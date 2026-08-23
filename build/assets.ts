/**
 * Everything the installed app needs that is not the bundle: the manifest and
 * the icon set, as a list of files with their contents.
 *
 * One list, three consumers — the production build emits it into `dist/`, the
 * dev server serves it out of memory so `npm run dev` behaves like the real
 * thing, and the tests assert on it directly. A file that exists in only two of
 * those three places is the classic way a manifest ends up working locally and
 * 404ing in production.
 */

import { rootProperties } from './css';
import { ICON_TILE, iconShapes, iconSvg } from './icon';
import {
  APPLE_TOUCH_ICON_FILE,
  APPLE_TOUCH_ICON_SIZE,
  ICON_192_FILE,
  ICON_512_FILE,
  ICON_MASKABLE_FILE,
  ICON_SVG_FILE,
  MANIFEST_FILE,
  manifestJson,
} from './manifest';
import { renderPng } from './png';

export interface GeneratedAsset {
  /** The name it is served and emitted under, at the root of the deployment. */
  readonly fileName: string;
  readonly mime: string;
  readonly source: Buffer | string;
}

export function generatedAssets(): readonly GeneratedAsset[] {
  const properties = rootProperties();
  const png = (variant: 'rounded' | 'square' | 'maskable', size: number): Buffer =>
    renderPng(iconShapes(variant, properties), size, ICON_TILE);

  return [
    {
      fileName: MANIFEST_FILE,
      mime: 'application/manifest+json',
      source: manifestJson(),
    },
    {
      fileName: ICON_SVG_FILE,
      mime: 'image/svg+xml',
      source: `${iconSvg('rounded', { size: 512, properties })}\n`,
    },
    { fileName: ICON_192_FILE, mime: 'image/png', source: png('rounded', 192) },
    { fileName: ICON_512_FILE, mime: 'image/png', source: png('rounded', 512) },
    { fileName: ICON_MASKABLE_FILE, mime: 'image/png', source: png('maskable', 512) },
    {
      // Opaque and square: iOS rounds the corners itself and composites the
      // icon against nothing, so a transparent corner arrives black.
      fileName: APPLE_TOUCH_ICON_FILE,
      mime: 'image/png',
      source: png('square', APPLE_TOUCH_ICON_SIZE),
    },
  ];
}
