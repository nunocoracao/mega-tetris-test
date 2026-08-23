/*
 * The service worker.
 *
 * Forty-odd lines of behaviour and no framework, because the cabinet is three
 * static files and a precache list is the whole requirement. What it does:
 *
 * 1. **Precaches the build, once, at install.** Every file the game needs is
 *    hashed by Vite, so the list below is generated at build time and the cache
 *    is named after a revision of it. A new deploy is a new list, a new name,
 *    and a new cache — there is no such thing as a half-updated cabinet.
 *
 * 2. **Serves those files cache-first, and touches nothing else.** The fetch
 *    handler answers only for URLs that are in the precache, and it never
 *    *writes* to a cache. That second half is the important one: a runtime
 *    `cache.put` on the response of something fetched mid-game is exactly how a
 *    service worker ends up stealing a frame, and there is nothing here worth
 *    caching opportunistically anyway.
 *
 * 3. **Waits its turn.** There is no `skipWaiting()` at install. A new worker
 *    installs, fills its cache and then sits in `waiting` until the page — which
 *    has offered the player a reload, and had it accepted — sends it the message
 *    below. Nothing reloads underneath a run.
 *
 * The two placeholders are replaced by `build/plugin.ts`; before substitution
 * this file is still valid JavaScript, which is what lets it be linted and read
 * as itself rather than as a string inside a generator.
 */

/** Every cache this project has ever written starts with this. */
const CACHE_PREFIX = 'mega-tetris-';

/** A hash of the built files. Changes exactly when the deployed bundle does. */
const REVISION = '__REVISION__';

const CACHE_NAME = CACHE_PREFIX + REVISION;

/** Paths relative to this worker — which is to say, to the deployment root. */
const PRECACHE = ['__PRECACHE__'];

/*
 * Resolved against the worker's own address rather than the origin, so the
 * whole thing works from `/mega-tetris-test/` exactly as it does from `/`. This
 * is the same constraint `base: './'` answers for the bundle.
 */
const PRECACHE_URLS = PRECACHE.map((path) => new URL(path, self.location.href).href);
const PRECACHED = new Set(PRECACHE_URLS);

/** What a navigation is answered with when the network is not there. */
const SHELL_URL = new URL('index.html', self.location.href).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // `cache: 'reload'` so a fresh worker fills itself from the network
      // rather than from an HTTP cache that may still hold the old build.
      cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' }))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      // Claim the pages so the reload the player just asked for lands on this
      // worker, and so `controllerchange` is a signal the page can rely on.
      await self.clients.claim();
    })(),
  );
});

/** Cache first, network as the fallback, and never a write. */
async function serve(url, request) {
  const cached = await caches.match(url, { cacheName: CACHE_NAME });
  return cached === undefined ? fetch(request) : cached;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Any navigation inside the scope is the same document: one page, no router.
  if (request.mode === 'navigate') {
    event.respondWith(serve(SHELL_URL, request));
    return;
  }

  // Everything else is answered only if it was precached. Anything else — a
  // request added by a future version, a browser's own probe — goes to the
  // network untouched, which is both faster and more honest than pretending
  // this worker knows what to do with it.
  const target = url.origin + url.pathname;
  if (!PRECACHED.has(target)) {
    return;
  }
  event.respondWith(serve(target, request));
});

/**
 * The page's half of the update handshake: "the player said yes, take over".
 * This is the only thing that promotes a waiting worker.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') {
    self.skipWaiting();
  }
});
