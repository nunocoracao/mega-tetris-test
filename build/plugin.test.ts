/**
 * The generated service worker and the files that go with it.
 *
 * Every assertion here is about the article that ships rather than the template
 * that is checked in, because the two differ in exactly the place that matters:
 * the precache list. And most of them are about what the worker *does not* do —
 * it does not write to a cache from a fetch handler, and it does not promote
 * itself. Both are easy to add in a hurry and both are invisible until they
 * cost somebody a run.
 */

import { describe, expect, it } from 'vitest';

import { generatedAssets } from './assets';
import { APPLE_TOUCH_ICON_FILE, MANIFEST_FILE } from './manifest';
import {
  SERVICE_WORKER_FILE,
  buildServiceWorker,
  headTags,
  readServiceWorkerTemplate,
  revisionOf,
} from './plugin';

const PRECACHE = ['./', 'index.html', 'assets/index-abc123.js', 'assets/index-def456.css'];
const WORKER = buildServiceWorker(PRECACHE, 'r3v1s10n');

/**
 * The worker with its documentation removed.
 *
 * The comments in `build/sw.js` name the very things the code must not do —
 * "there is no `skipWaiting()` at install" is a sentence about an absence — so
 * every assertion below reads the code rather than the prose. The engine tests
 * strip comments for the same reason.
 */
const CODE = WORKER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The body of the `fetch` listener — where a careless cache write would go. */
function fetchHandler(source: string): string {
  const start = source.indexOf("addEventListener('fetch'");
  expect(start).toBeGreaterThan(0);
  return source.slice(start);
}

describe('the substitution', () => {
  it('leaves no placeholder behind', () => {
    expect(WORKER).not.toContain('__PRECACHE__');
    expect(WORKER).not.toContain('__REVISION__');
  });

  it('writes the precache list and the revision in', () => {
    for (const path of PRECACHE) {
      expect(WORKER).toContain(JSON.stringify(path));
    }
    expect(WORKER).toContain('"r3v1s10n"');
  });

  it('fails loudly if the template stops carrying its tokens', () => {
    // The template is valid JavaScript before substitution, which is what makes
    // it lintable — and also what makes a silently-renamed token possible.
    const template = readServiceWorkerTemplate();
    expect(template).toContain("'__REVISION__'");
    expect(template).toContain("['__PRECACHE__']");
  });
});

describe('the worker’s caching', () => {
  it('precaches at install and nowhere else', () => {
    expect(CODE).toContain('cache.addAll');
    expect([...CODE.matchAll(/addAll/g)]).toHaveLength(1);
  });

  it('never writes to a cache while serving a request', () => {
    // The rule this file exists for. A `cache.put` in a fetch handler is how a
    // service worker ends up doing storage I/O in the middle of a frame.
    const handler = fetchHandler(CODE);
    expect(handler).not.toContain('.put(');
    expect(handler).not.toContain('addAll');
    expect(handler).not.toContain('caches.open');
  });

  it('resolves its precache against the worker rather than the origin', () => {
    // `/mega-tetris-test/` is not the origin root, and a worker that assumed it
    // was would precache four 404s.
    expect(CODE).toContain('new URL(path, self.location.href)');
    expect(CODE).not.toContain('new URL(path, self.location.origin)');
  });

  it('drops old caches on activate, and only its own', () => {
    expect(CODE).toContain('caches.delete');
    expect(CODE).toContain('name.startsWith(CACHE_PREFIX)');
  });
});

describe('the worker’s update path', () => {
  it('waits rather than taking over', () => {
    // Exactly one `skipWaiting`, and it is inside the message handler: nothing
    // reloads under a player until the page has asked on their behalf.
    const calls = [...CODE.matchAll(/skipWaiting/g)];
    expect(calls).toHaveLength(1);

    const message = CODE.slice(CODE.indexOf("addEventListener('message'"));
    expect(message).toContain('skipWaiting');
    expect(message).toContain("'skip-waiting'");
  });

  it('claims its clients, so the page can reload onto it', () => {
    const activate = CODE.slice(
      CODE.indexOf("addEventListener('activate'"),
      CODE.indexOf("addEventListener('fetch'"),
    );
    expect(activate).toContain('clients.claim');
  });

  it('names its cache after the revision, so a new build is a new cache', () => {
    const other = buildServiceWorker(PRECACHE, 'different');
    expect(WORKER).not.toBe(other);
    expect(CODE).toContain('CACHE_PREFIX + REVISION');
  });
});

describe('the revision', () => {
  it('is stable for the same files', () => {
    const files = [['index.html', 'hello'], ['a.js', 'x']] as const;
    expect(revisionOf(files)).toBe(revisionOf(files));
  });

  it('does not depend on the order they arrive in', () => {
    expect(revisionOf([['a', '1'], ['b', '2']])).toBe(revisionOf([['b', '2'], ['a', '1']]));
  });

  it('changes when any file changes', () => {
    expect(revisionOf([['a', '1']])).not.toBe(revisionOf([['a', '2']]));
    expect(revisionOf([['a', '1']])).not.toBe(revisionOf([['b', '1']]));
  });

  it('is short enough to read in a cache name', () => {
    expect(revisionOf([['a', '1']])).toHaveLength(12);
  });
});

describe('the head tags', () => {
  const tags = headTags();
  const attrs = (rel: string): Record<string, string> | undefined =>
    tags.find((tag) => tag.attrs['rel'] === rel)?.attrs;

  it('links the manifest and the Apple touch icon, relatively', () => {
    expect(attrs('manifest')?.['href']).toBe(`./${MANIFEST_FILE}`);
    expect(attrs('apple-touch-icon')?.['href']).toBe(`./${APPLE_TOUCH_ICON_FILE}`);
  });

  it('inlines the favicon rather than adding a request', () => {
    expect(attrs('icon')?.['href']?.startsWith('data:image/svg+xml,')).toBe(true);
  });

  it('asks both platforms for a standalone window', () => {
    const named = (name: string): string | undefined =>
      tags.find((tag) => tag.attrs['name'] === name)?.attrs['content'];

    expect(named('mobile-web-app-capable')).toBe('yes');
    expect(named('apple-mobile-web-app-capable')).toBe('yes');
    // Translucent, because the stylesheet pays the safe-area insets and the
    // cabinet's own colour should run under the status bar.
    expect(named('apple-mobile-web-app-status-bar-style')).toBe('black-translucent');
    expect(named('apple-mobile-web-app-title')).toBe('Mega Tetris');
  });

  it('never writes an absolute path, which a subdirectory would break', () => {
    for (const tag of tags) {
      const href = tag.attrs['href'];
      if (href !== undefined && !href.startsWith('data:')) {
        expect(href.startsWith('./')).toBe(true);
      }
    }
  });
});

describe('the generated files', () => {
  const assets = generatedAssets();
  const named = (fileName: string) => assets.find((asset) => asset.fileName === fileName);

  it('are the manifest, the icon set and nothing else', () => {
    expect(assets.map((asset) => asset.fileName).sort()).toEqual([
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'icon-maskable-512.png',
      'icon.svg',
      MANIFEST_FILE,
    ]);
    expect(assets.map((asset) => asset.fileName)).not.toContain(SERVICE_WORKER_FILE);
  });

  it('writes real PNGs', () => {
    for (const asset of assets.filter((candidate) => candidate.mime === 'image/png')) {
      expect(Buffer.isBuffer(asset.source)).toBe(true);
      expect((asset.source as Buffer).subarray(1, 4).toString('ascii')).toBe('PNG');
    }
  });

  it('writes a manifest that parses', () => {
    const manifest = named(MANIFEST_FILE);
    expect(manifest?.mime).toBe('application/manifest+json');
    expect(JSON.parse(String(manifest?.source)).name).toBe('Mega Tetris');
  });

  it('keeps the icon set small enough not to matter', () => {
    // Flat colour on flat colour: the whole set should cost less than a single
    // photograph, or something has gone wrong in the rasteriser.
    const total = assets.reduce((sum, asset) => sum + asset.source.length, 0);
    expect(total).toBeLessThan(64 * 1024);
  });
});
