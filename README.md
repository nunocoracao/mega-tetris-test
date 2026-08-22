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
│   ├── engine/       # Game rules: board, pieces, seeded bag, state machine
│   ├── main.ts       # App entry module
│   ├── style.css     # Global styles
│   └── *.test.ts     # Unit tests, colocated with the code they cover
├── tsconfig.json     # Strict TypeScript config (noEmit — Vite handles emit)
└── vite.config.ts    # Vite + Vitest configuration
```

Game logic is kept separate from rendering so board and scoring rules can be
tested without a DOM.

## Game engine

`src/engine/` is the whole game as a pure state machine — no DOM, no clock, no
unseeded randomness (`purity.test.ts` enforces that). Three functions drive it,
each returning a new immutable snapshot:

```ts
import { applyInput, createGame, update } from './engine';

let state = createGame({ seed: 2026 });          // 'ready'
state = applyInput(state, { type: 'resume' });   // 'playing'
state = update(state, 16.7);                     // one frame of gravity
state = applyInput(state, { type: 'hardDrop' });
```

Every snapshot carries `events` — `spawn`, `lock`, `hardDrop`, `rowsCleared`,
`levelUp`, `hold`, `gameOver` — describing only what happened during the call
that produced it, so the UI can animate and play sound without inspecting
engine internals.

Because the piece stream lives in the snapshot as seeded data, the same seed
plus the same ordered calls always yields a deeply equal result.

### Rules

| Rule           | Behaviour                                                          |
| -------------- | ------------------------------------------------------------------ |
| Gravity        | `800ms × 0.85^(level−1)` per row, floored at `50ms` (level 18 on).   |
| Lock delay     | `500ms` once resting, refreshed by a move or rotation, 15 times max. |
| Soft drop      | One row down, 1 point per row.                                       |
| Hard drop      | Straight to the landing spot, locks at once, 2 points per row.        |
| Line clears    | 1/2/3/4 lines score 100/300/500/800, multiplied by the current level. |
| Levels         | One level per 10 cleared lines.                                       |
| Hold           | Swaps the active piece, resets it to spawn, locked until the next lock. |
| Game over      | A newly spawned piece has nowhere to sit.                             |

## Controls

Documented once gameplay exists.
