/**
 * The installed cabinet: the service worker's page-side half, the install
 * button, and the status-bar colour.
 *
 * Three small things, each with one rule that is easy to get wrong:
 *
 * **The update must not arrive underneath a run.** A new worker installs and
 * waits. This file notices it waiting, tells `src/main.ts`, and does nothing
 * else until the player presses Reload — at which point the waiting worker is
 * asked to take over and the page reloads onto it. A worker promoted by *another*
 * tab changes the controller here too, and that case deliberately does nothing:
 * the page is already running the assets it loaded and has nothing left to fetch.
 *
 * **The install button is an offer, not a campaign.** It appears only if the
 * browser fired `beforeinstallprompt` — which is the browser saying the app is
 * installable *and* that it would have shown its own prompt — and it goes away
 * for good once the player has installed or declined. There is no banner and
 * nothing covers the well.
 *
 * **Development stays development.** `registerServiceWorker` is a no-op outside
 * a production bundle, and the branch folds away entirely: a cache-first worker
 * in front of a hot-reloading dev server would serve yesterday's game.
 */

import type { SettingAccess } from './storage';

/** Where the worker lives, relative to the document. Same trick as `base: './'`. */
const SERVICE_WORKER_URL = './sw.js';

/** The message the waiting worker is listening for. See `build/sw.js`. */
const SKIP_WAITING = { type: 'skip-waiting' } as const;

// ---------------------------------------------------------------------------
// The status bar
// ---------------------------------------------------------------------------

/**
 * Keep `<meta name="theme-color">` in step with the palette.
 *
 * In standalone display mode this is the colour of the system chrome around the
 * game — the status bar on Android, the surround on desktop — so leaving it on
 * the default palette's plum while the player is in high contrast would put a
 * seam across the top of the screen. It is read from the same custom property
 * the stylesheet paints the cabinet with, never written down twice.
 */
export function syncThemeColor(element: Element = document.documentElement): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta === null) {
    return null;
  }
  const color = getComputedStyle(element).getPropertyValue('--cabinet-deep').trim();
  if (color !== '') {
    meta.content = color;
  }
  return meta.content;
}

// ---------------------------------------------------------------------------
// The service worker
// ---------------------------------------------------------------------------

export interface ServiceWorkerOptions {
  /** A new version has finished installing and is waiting for the word. */
  readonly onUpdateReady: () => void;
}

export interface ServiceWorkerHandle {
  /**
   * Promote the waiting worker and reload onto it. Called from the player's
   * own press of Reload and from nowhere else.
   */
  applyUpdate(): void;
}

/**
 * Register the worker, and watch for a newer one.
 *
 * Everything here is guarded twice over: by `import.meta.env.PROD`, which
 * removes the whole body from a development bundle, and by the feature check,
 * because `navigator.serviceWorker` is absent over plain HTTP and in a few
 * embedded browsers. Both failures are silent by design — a cabinet that cannot
 * install is still a cabinet that plays.
 */
export function registerServiceWorker(options: ServiceWorkerOptions): ServiceWorkerHandle {
  let waiting: ServiceWorker | null = null;
  let reloading = false;

  const handle: ServiceWorkerHandle = {
    applyUpdate() {
      const worker = waiting;
      if (worker === null) {
        window.location.reload();
        return;
      }
      // Set before the message, because the controller can change fast.
      reloading = true;
      worker.postMessage(SKIP_WAITING);
    },
  };

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
    return handle;
  }

  const container = navigator.serviceWorker;

  container.addEventListener('controllerchange', () => {
    // Only a reload this page asked for. Another tab promoting the worker is
    // its business; reloading here would take the run with it.
    if (!reloading) {
      return;
    }
    reloading = false;
    window.location.reload();
  });

  const offer = (worker: ServiceWorker): void => {
    waiting = worker;
    options.onUpdateReady();
  };

  void container
    .register(SERVICE_WORKER_URL, { scope: './', updateViaCache: 'none' })
    .then((registration) => {
      // Already waiting when we got here — a second tab, or a reload that
      // happened while the new worker was installing.
      if (registration.waiting !== null && container.controller !== null) {
        offer(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (installing === null) {
          return;
        }
        installing.addEventListener('statechange', () => {
          // `installed` with a controller already in place means "this is an
          // update", not "this is the first install". The first install must
          // stay silent: there is nothing to reload onto.
          if (installing.state === 'installed' && container.controller !== null) {
            offer(installing);
          }
        });
      });

      // Coming back to the tab is the natural moment to ask. The browser checks
      // on its own schedule too; this makes "reload and you have it" true.
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          void registration.update();
        }
      });
    })
    .catch(() => {
      // An unregisterable worker is not a broken game.
    });

  return handle;
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/**
 * The event Chromium fires when it would have shown its own install prompt.
 * It is not in the DOM typings, so the shape it is used through is declared —
 * and only the two members that are used.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallOptions {
  /** The button in the footer. Hidden until there is something to offer. */
  readonly button: HTMLButtonElement;
  /** Remembers a decline, so the offer is made once and not every visit. */
  readonly dismissed: SettingAccess<boolean>;
  readonly announce: (message: string) => void;
}

/**
 * Is the game already running as an installed app?
 *
 * `display-mode: standalone` covers Android and desktop; `navigator.standalone`
 * is the iOS spelling of the same fact, and is not in the DOM typings.
 */
export function isStandalone(): boolean {
  if (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) {
    return true;
  }
  return Reflect.get(navigator, 'standalone') === true;
}

/**
 * Wire the install button.
 *
 * The button starts hidden and is only ever revealed by the browser's own
 * event, which is what keeps this from being an "install our app" nag on a
 * platform that has no such thing.
 */
export function createInstallPrompt(options: InstallOptions): void {
  const { button, dismissed } = options;
  let deferred: InstallPromptEvent | null = null;

  const retire = (): void => {
    deferred = null;
    button.hidden = true;
  };

  if (isStandalone()) {
    // Already installed: there is nothing to offer, and the browser will not
    // offer it either.
    return;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep the browser's own prompt off the screen; the footer button is the
    // offer, and it is the player's move.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    button.hidden = dismissed.read();
  });

  window.addEventListener('appinstalled', () => {
    retire();
    // Nothing more to say about installing to somebody who just did.
    dismissed.write(true);
    options.announce('Mega Tetris installed. It opens from your home screen now.');
  });

  button.addEventListener('click', () => {
    const event = deferred;
    // A prompt can be used once. Whatever happens next, the button's work here
    // is done — leaving it up would offer a prompt that no longer exists.
    retire();
    if (event === null) {
      return;
    }
    void event.prompt();
    void event.userChoice.then((choice) => {
      if (choice.outcome === 'dismissed') {
        // Asked and answered. The offer is not made again on this browser.
        dismissed.write(true);
      }
    });
  });
}
