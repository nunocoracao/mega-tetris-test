/// <reference types="vite/client" />

// Vite's ambient types: `import.meta.env`, asset imports and friends. Only the
// browser layer may use them — `src/engine/purity.test.ts` fails the build if
// anything under `src/engine/` reaches for a bundler global.
