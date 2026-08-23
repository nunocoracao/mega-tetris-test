/**
 * The manifest, checked against the two things it is generated from.
 *
 * A manifest is the least visible file in a deployment: nothing fails when its
 * `theme_color` is a palette out of date, the splash screen is simply the wrong
 * colour on somebody's phone, and nobody who could fix it ever sees it. So the
 * colours are read out of `src/style.css` here — by a parser deliberately
 * unlike the one `build/css.ts` uses, so the test is a second opinion rather
 * than an echo — and compared with what the build actually writes.
 *
 * The same check catches the one hex still written by hand: the `theme-color`
 * meta in `index.html`, which exists because the manifest arrives too late to
 * colour the browser's chrome on a first paint.
 */

import { describe, expect, it } from 'vitest';

import { metaDescription, metaThemeColor, readStylesheet } from './css';
import { ICON_SVG_FILE, buildManifest, manifestJson } from './manifest';

const CSS = readStylesheet();

/**
 * A custom property's value, read straight out of the default palette block by
 * a line-by-line scan rather than by the block parser the build uses.
 *
 * Anchored on the swatch selector the palette block carries, for the same
 * reason `build/css.ts` is: `:root {` names the geometry block too.
 */
const PALETTE = ".swatch[data-theme='midnight'] {";

function declared(name: string): string {
  const root = CSS.slice(CSS.indexOf(PALETTE), CSS.indexOf('\n}', CSS.indexOf(PALETTE)));
  for (const line of root.split('\n')) {
    const [property, ...rest] = line.split(':');
    if (property?.trim() === name) {
      return (rest.join(':').split(';')[0] ?? '').trim();
    }
  }
  throw new Error(`style.css declares no ${name}`);
}

const manifest = buildManifest();

describe('the manifest’s colours', () => {
  it('takes its theme colour from the stylesheet', () => {
    expect(manifest.theme_color).toBe(declared('--cabinet-deep'));
  });

  it('takes its splash background from the stylesheet', () => {
    expect(manifest.background_color).toBe(declared('--cabinet-deep'));
  });

  it('agrees with the theme-color the document ships before any script runs', () => {
    // This one *is* written by hand, in `index.html`, because the browser
    // colours its chrome from it long before it has read a manifest. It is the
    // only hex in the project outside the stylesheet, and this is what stops it
    // drifting.
    expect(metaThemeColor()).toBe(declared('--cabinet-deep'));
  });
});

describe('the manifest’s addresses', () => {
  it('is relative throughout, so a subdirectory deployment works', () => {
    // GitHub Pages serves this from `/mega-tetris-test/`. A `start_url` of `/`
    // would launch the installed app at the account's root page — the classic
    // way a PWA installs and then opens somebody else's site.
    for (const url of [manifest.id, manifest.start_url, manifest.scope]) {
      expect(url.startsWith('/')).toBe(false);
      expect(url.startsWith('http')).toBe(false);
      expect(url).toBe('./');
    }
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('./')).toBe(true);
    }
  });

  it('resolves to the deployment directory from either kind of host', () => {
    for (const base of [
      'https://nunocoracao.github.io/mega-tetris-test/manifest.webmanifest',
      'https://example.test/manifest.webmanifest',
    ]) {
      const start = new URL(manifest.start_url, base);
      expect(start.href).toBe(base.replace('manifest.webmanifest', ''));
      expect(new URL(manifest.scope, base).href).toBe(start.href);
    }
  });
});

describe('the manifest’s copy and icons', () => {
  it('says what the document says', () => {
    expect(manifest.description).toBe(metaDescription());
    expect(manifest.description.length).toBeGreaterThan(40);
  });

  it('is short enough to sit under a home-screen icon', () => {
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  it('asks for a standalone portrait window', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('portrait');
  });

  it('offers a scalable icon, both PNG sizes, and a maskable one', () => {
    const svg = manifest.icons.filter((icon) => icon.type === 'image/svg+xml');
    expect(svg).toHaveLength(1);
    expect(svg[0]?.src).toBe(`./${ICON_SVG_FILE}`);

    const sizes = manifest.icons.filter((icon) => icon.type === 'image/png').map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');

    const maskable = manifest.icons.filter((icon) => icon.purpose === 'maskable');
    expect(maskable).toHaveLength(1);
    expect(maskable[0]?.sizes).toBe('512x512');
  });
});

describe('the file that is written', () => {
  it('is JSON, and parses back to the same object', () => {
    expect(JSON.parse(manifestJson(manifest))).toEqual(manifest);
  });
});
