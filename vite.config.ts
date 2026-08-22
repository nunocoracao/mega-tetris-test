/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built bundle works from any static path.
  base: './',
  test: {
    // `node`, deliberately: it is what stops a DOM reference sneaking into the
    // engine. The one file that genuinely needs a document — the accessibility
    // audit — opts in with a `@vitest-environment jsdom` docblock.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
