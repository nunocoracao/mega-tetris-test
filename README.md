# Mega Tetris

A cheerful, fast-loading falling-block puzzle game that lives entirely in the
browser — a tiny arcade cabinet at a URL. No backend, no accounts, no build
server: just static files.

This repository is currently a scaffold. Gameplay lands in later work; what is
here today is the toolchain the game is built on.

## Tech

- [Vite](https://vite.dev) 7 for dev server and static builds
- [TypeScript](https://www.typescriptlang.org) 5 in `strict` mode
- [Vitest](https://vitest.dev) 3 for unit tests

Zero runtime dependencies — the game is plain TypeScript and CSS.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer (ships with Node 20+)

## Getting started

```bash
npm install     # install dev dependencies
npm run dev     # start the dev server at http://localhost:5173
```

## Commands

| Command              | What it does                                            |
| -------------------- | ------------------------------------------------------- |
| `npm run dev`        | Start the Vite dev server with hot module replacement.   |
| `npm run build`      | Typecheck, then build the static bundle into `dist/`.    |
| `npm run preview`    | Serve the built `dist/` bundle locally.                  |
| `npm test`           | Run the test suite once.                                 |
| `npm run test:watch` | Run tests in watch mode.                                 |
| `npm run typecheck`  | Typecheck without emitting output.                       |

The build uses a relative `base`, so the contents of `dist/` can be dropped on
any static host or subdirectory and will work as-is.

## Project layout

```
.
├── index.html        # Vite entry point and document shell
├── src/
│   ├── main.ts       # App entry module
│   ├── style.css     # Global styles
│   └── *.test.ts     # Unit tests, colocated with the code they cover
├── tsconfig.json     # Strict TypeScript config (noEmit — Vite handles emit)
└── vite.config.ts    # Vite + Vitest configuration
```

Game logic is kept separate from rendering so board and scoring rules can be
tested without a DOM.

## Controls

Documented once gameplay exists.
