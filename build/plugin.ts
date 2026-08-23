/**
 * The one build plugin: manifest, icons, service worker.
 *
 * It exists because three of the installed app's files have to be generated
 * from something else — the manifest from the palette, the icons from the
 * geometry in `build/icon.ts`, and the service worker's precache list from the
 * hashed names Vite only knows once it has finished. None of that is a
 * dependency's job; all of it is thirty lines of hooks.
 *
 * The same files are served by the dev server out of memory, so `npm run dev`
 * is not a different application with a different manifest. The service worker
 * is the deliberate exception: it is emitted by the production build only, and
 * `src/ui/pwa.ts` refuses to register one outside a production bundle, because
 * a cache-first worker in front of a hot-reloading dev server is a morning
 * wasted.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Plugin } from 'vite';

import { generatedAssets, type GeneratedAsset } from './assets';
import { faviconDataUri } from './icon';
import { APPLE_TOUCH_ICON_FILE, MANIFEST_FILE } from './manifest';

/** The name the worker is emitted under, at the root of the deployment. */
export const SERVICE_WORKER_FILE = 'sw.js';

const SERVICE_WORKER_SOURCE = fileURLToPath(new URL('./sw.js', import.meta.url));

/** Where the substitutions go. Both are valid JavaScript before replacement. */
const REVISION_TOKEN = "'__REVISION__'";
const PRECACHE_TOKEN = "['__PRECACHE__']";

export function readServiceWorkerTemplate(): string {
  return readFileSync(SERVICE_WORKER_SOURCE, 'utf8');
}

/**
 * The worker, with its precache list and revision written in.
 *
 * Exported so a test can read the generated article rather than the template —
 * "the precache list is not empty" and "the fetch handler never writes" are
 * properties of what ships, not of what is checked in.
 */
export function buildServiceWorker(precache: readonly string[], revision: string): string {
  const template = readServiceWorkerTemplate();
  if (!template.includes(REVISION_TOKEN) || !template.includes(PRECACHE_TOKEN)) {
    throw new Error('build/sw.js no longer carries both substitution tokens.');
  }
  return template
    .replace(REVISION_TOKEN, JSON.stringify(revision))
    .replace(PRECACHE_TOKEN, JSON.stringify([...precache], null, 2));
}

/** A short, content-derived name for the deployed build. */
export function revisionOf(entries: readonly (readonly [string, string | Uint8Array])[]): string {
  const hash = createHash('sha256');
  for (const [name, content] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    hash.update(name);
    hash.update(typeof content === 'string' ? content : Buffer.from(content));
  }
  return hash.digest('hex').slice(0, 12);
}

/** The head tags every deployment needs and none of which belong in the source. */
export function headTags(): { tag: string; attrs: Record<string, string> }[] {
  return [
    // The favicon, drawn by `build/icon.ts` and inlined so it is still not a
    // request. The home-screen icon and the tab icon are now one drawing.
    { tag: 'link', attrs: { rel: 'icon', href: faviconDataUri() } },
    { tag: 'link', attrs: { rel: 'manifest', href: `./${MANIFEST_FILE}` } },
    { tag: 'link', attrs: { rel: 'apple-touch-icon', href: `./${APPLE_TOUCH_ICON_FILE}` } },
    { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' } },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
    // Translucent, with the document already `viewport-fit=cover` and the
    // stylesheet already paying the safe-area insets: the cabinet's own colour
    // runs under the status bar instead of a black band above it.
    {
      tag: 'meta',
      attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
    },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: 'Mega Tetris' } },
  ];
}

function bodyOf(asset: GeneratedAsset): Buffer {
  return typeof asset.source === 'string' ? Buffer.from(asset.source, 'utf8') : asset.source;
}

export function megaTetrisPwa(): Plugin {
  let assets: readonly GeneratedAsset[] = [];

  return {
    name: 'mega-tetris-pwa',

    buildStart() {
      // Drawn once per build, and once per dev-server start. The rasteriser is
      // fast, but there is no reason to run it per request.
      assets = generatedAssets();
    },

    transformIndexHtml() {
      // Tags only. Returning an `html` alongside them would *replace* the
      // document, which is emphatically not the intention here.
      return headTags().map((tag) => ({ ...tag, injectTo: 'head' as const }));
    },

    configureServer(server) {
      // The dev server has no `dist/` to read these out of, so it answers for
      // them itself. Without this the manifest 404s in development and the one
      // thing you cannot check is the thing you just changed.
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0] ?? '';

        // There is no worker in development, and saying so matters: Vite's HTML
        // fallback would answer this with a document, and a worker script that
        // comes back as HTML fails to update — leaving a worker registered from
        // some earlier experiment in charge of the dev server for good. A 404 is
        // what makes the browser drop it.
        if (path === `/${SERVICE_WORKER_FILE}`) {
          response.statusCode = 404;
          response.end('No service worker in development.');
          return;
        }

        const asset = assets.find((candidate) => path === `/${candidate.fileName}`);
        if (asset === undefined) {
          next();
          return;
        }
        const body = bodyOf(asset);
        response.setHeader('Content-Type', asset.mime);
        response.setHeader('Content-Length', body.length);
        response.setHeader('Cache-Control', 'no-cache');
        response.end(body);
      });
    },

    // `post`, because `index.html` is itself emitted from a `generateBundle`
    // hook — Vite's own. Running before it would precache the bundle and quietly
    // leave out the document, which is the one file an offline navigation needs.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const asset of assets) {
          this.emitFile({ type: 'asset', fileName: asset.fileName, source: asset.source });
        }

        // Everything in the bundle, plus everything just emitted, plus the
        // directory itself — which is the URL a player actually opens. A Map
        // because a file emitted above may already have landed in `bundle`.
        const contents = new Map<string, string | Uint8Array>();
        for (const asset of assets) {
          contents.set(asset.fileName, bodyOf(asset));
        }
        for (const [name, output] of Object.entries(bundle)) {
          contents.set(name, output.type === 'chunk' ? output.code : output.source);
        }

        const precache = [
          './',
          ...[...contents.keys()]
            .filter((name) => name !== SERVICE_WORKER_FILE && !name.endsWith('.map'))
            .sort(),
        ];

        // The one file an offline navigation cannot do without. If a future
        // Vite reorders its hooks and this runs before the document is emitted
        // again, the build should stop rather than ship a worker that answers
        // every navigation with a network error.
        if (!precache.includes('index.html')) {
          throw new Error('The precache list has no index.html; the worker could not serve it.');
        }

        const revision = revisionOf([...contents, ['sw', readServiceWorkerTemplate()] as const]);
        this.emitFile({
          type: 'asset',
          fileName: SERVICE_WORKER_FILE,
          source: buildServiceWorker(precache, revision),
        });
      },
    },
  };
}
