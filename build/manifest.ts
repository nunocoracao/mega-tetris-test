/**
 * The web app manifest, generated rather than written down.
 *
 * Two of its fields are colours the stylesheet already owns and one is a
 * sentence the document already carries, so all three are read from source at
 * build time. A manifest with a hand-copied `theme_color` is a manifest that is
 * wrong one palette edit later, and nothing about an installed app makes that
 * failure visible — the splash screen is simply the wrong colour on somebody
 * else's phone.
 *
 * `start_url` and `scope` are relative on purpose. The manifest is served from
 * the same directory as the document, so `'.'` resolves to
 * `/mega-tetris-test/` on GitHub Pages and to `/` on a root deployment — the
 * same problem `base: './'` in `vite.config.ts` solves for the bundle, solved
 * the same way.
 */

import { metaDescription, paletteColor, rootProperties } from './css';

export const MANIFEST_FILE = 'manifest.webmanifest';

export const ICON_SVG_FILE = 'icon.svg';
export const ICON_192_FILE = 'icon-192.png';
export const ICON_512_FILE = 'icon-512.png';
export const ICON_MASKABLE_FILE = 'icon-maskable-512.png';
export const APPLE_TOUCH_ICON_FILE = 'apple-touch-icon.png';

/** The Apple touch icon's one size. iOS scales it down for smaller slots. */
export const APPLE_TOUCH_ICON_SIZE = 180;

/** Which stylesheet property each generated colour comes from. */
export const THEME_COLOR_PROPERTY = '--cabinet-deep';
export const BACKGROUND_COLOR_PROPERTY = '--cabinet-deep';

export interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: string;
}

export interface WebManifest {
  readonly id: string;
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly orientation: string;
  readonly theme_color: string;
  readonly background_color: string;
  readonly lang: string;
  readonly dir: string;
  readonly categories: readonly string[];
  readonly icons: readonly ManifestIcon[];
}

export function buildManifest(
  properties: ReadonlyMap<string, string> = rootProperties(),
  description: string = metaDescription(),
): WebManifest {
  return {
    // Relative, like the two URLs below: an `id` is resolved against the
    // manifest's own address, so this names the app at whatever path it is
    // deployed to without ever naming a host.
    id: './',
    name: 'Mega Tetris',
    // Eleven characters, which fits under a home-screen icon without the
    // platform truncating it into an ellipsis.
    short_name: 'Mega Tetris',
    description,
    start_url: './',
    scope: './',
    // The cabinet is the whole app; browser chrome around it buys the player
    // nothing they can use.
    display: 'standalone',
    // The well is 10 by 22. There is no landscape layout worth locking a phone
    // into, and the stylesheet already handles a phone held sideways anyway.
    orientation: 'portrait',
    theme_color: paletteColor(THEME_COLOR_PROPERTY, properties),
    background_color: paletteColor(BACKGROUND_COLOR_PROPERTY, properties),
    lang: 'en',
    dir: 'ltr',
    categories: ['games'],
    icons: [
      {
        // The scalable one, for everything that will take an SVG.
        src: `./${ICON_SVG_FILE}`,
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      { src: `./${ICON_192_FILE}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `./${ICON_512_FILE}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        // Full-bleed, with the blocks inside the safe circle, for the platforms
        // that crop an icon to their own shape.
        src: `./${ICON_MASKABLE_FILE}`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

export function manifestJson(manifest: WebManifest = buildManifest()): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
