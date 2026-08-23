/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

import { megaTetrisPwa } from './build/plugin';

export default defineConfig({
  // Relative base so the built bundle works from any static path.
  base: './',
  // The manifest, the icon set and the service worker — all generated from the
  // palette and the bundle rather than checked in. See `build/plugin.ts`.
  plugins: [megaTetrisPwa()],
  test: {
    // `node`, deliberately: it is what stops a DOM reference sneaking into the
    // engine. The one file that genuinely needs a document — the accessibility
    // audit — opts in with a `@vitest-environment jsdom` docblock.
    environment: 'node',
    // `build/` holds the generators for the manifest, the icons and the
    // service worker; their tests live beside them and run in the same suite.
    include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // `main.ts` is the composition root — a wiring file whose every line is a
      // listener or a hand-off, and which cannot run without a browser. It is
      // covered by playing the game, not by a test that would only assert the
      // wiring back to itself. The renderer is the same argument: pixels are
      // verified by looking at them.
      exclude: ['src/main.ts', 'src/**/*.test.ts', 'src/vite-env.d.ts'],
      reporter: ['text', 'html'],
      // The engine is the part that must not rot. The bar is deliberately set
      // only for it: chasing the same number through the browser layer buys
      // brittle tests rather than confidence.
      thresholds: {
        'src/engine/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
