/**
 * The stylesheet, read at build time.
 *
 * `src/style.css` is the only place a colour is written down — the canvas reads
 * it back through `ui/palette.ts`, and everything generated for the installed
 * app (the manifest's two colours, the icon set) reads it through here. That is
 * the difference between "the manifest happens to say #120b1b" and "the
 * manifest says whatever `--cabinet-deep` says", which is the only version that
 * survives somebody retuning the palette.
 *
 * Node-only, by design: it runs inside the Vite plugin and inside the tests,
 * and never reaches the browser bundle.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where the one palette lives. */
export const STYLESHEET_PATH = fileURLToPath(new URL('../src/style.css', import.meta.url));

/** The document shell, for the handful of strings generated from it. */
export const INDEX_HTML_PATH = fileURLToPath(new URL('../index.html', import.meta.url));

export function readStylesheet(): string {
  return readFileSync(STYLESHEET_PATH, 'utf8');
}

export function readIndexHtml(): string {
  return readFileSync(INDEX_HTML_PATH, 'utf8');
}

/**
 * The custom properties of the *first* `:root` block — the base palette, not
 * the `prefers-contrast` overrides that follow it. Same slice
 * `ui/palette.test.ts` takes, and for the same reason: the default palette is
 * the one an icon and a splash screen are painted in.
 */
export function rootProperties(css: string = readStylesheet()): ReadonlyMap<string, string> {
  const start = css.indexOf(':root {');
  if (start < 0) {
    throw new Error('style.css has no `:root` block.');
  }
  const end = css.indexOf('\n}', start);
  // Comments can carry colons and semicolons; strip them before parsing.
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');

  const declarations = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      declarations.set(name, value.trim());
    }
  }
  return declarations;
}

/** One custom property, or a loud failure. A missing colour is a broken icon. */
export function paletteColor(
  name: string,
  properties: ReadonlyMap<string, string> = rootProperties(),
): string {
  const value = properties.get(name);
  if (value === undefined) {
    throw new Error(`style.css declares no ${name} in :root.`);
  }
  return value;
}

/**
 * The page's own description, taken off the `<meta>` tag rather than written
 * down a second time. The manifest and the document should say the same thing
 * about the game, and this is the cheapest way to make that structural.
 */
export function metaDescription(html: string = readIndexHtml()): string {
  const match = /name="description"[\s\S]*?content="([\s\S]*?)"/.exec(html);
  if (match?.[1] === undefined) {
    throw new Error('index.html has no description meta tag.');
  }
  return match[1].replace(/\s+/g, ' ').trim();
}

/** The `<meta name="theme-color">` the document ships with, before any script. */
export function metaThemeColor(html: string = readIndexHtml()): string {
  const match = /name="theme-color"\s+content="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) {
    throw new Error('index.html has no theme-color meta tag.');
  }
  return match[1].trim();
}
