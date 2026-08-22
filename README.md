# Mega Tetris

A cheerful, fast-loading falling-block puzzle game that lives entirely in the
browser — a tiny arcade cabinet at a URL. No backend, no accounts, no build
server: just static files.

The game is playable: `npm run dev`, then press Play and use the arrow keys.

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
│   ├── ui/           # Browser layer: canvas renderer, input, loop, HUD, shell
│   ├── main.ts       # Composition root — wires the engine to the browser
│   ├── style.css     # Global styles
│   └── *.test.ts     # Unit tests, colocated with the code they cover
├── tsconfig.json     # Strict TypeScript config (noEmit — Vite handles emit)
└── vite.config.ts    # Vite + Vitest configuration
```

Game logic is kept separate from rendering so board and scoring rules can be
tested without a DOM. Nothing in `src/ui/` knows a game rule, and nothing in
`src/engine/` knows the browser exists.

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

## Browser layer

`src/ui/` turns the state machine into a game you can play. Each module does one
job and holds no rules of its own:

| Module        | Responsibility                                                        |
| ------------- | --------------------------------------------------------------------- |
| `renderer.ts` | Paints a `GameState` onto a canvas: well, stack, ghost, active piece.  |
| `palette.ts`  | Every colour in the game, in one map.                                  |
| `input.ts`    | Keyboard bindings and DAS/ARR auto-repeat, exported as data.           |
| `loop.ts`     | `requestAnimationFrame` timing, delta clamping, pause when hidden.     |
| `shell.ts`    | Builds the DOM: canvases, readouts, overlay, buttons, live region.     |
| `hud.ts`      | Score/level/lines, overlay copy, screen-reader announcements.          |

Canvases are sized to their CSS box times `devicePixelRatio` and redrawn from a
`ResizeObserver`, so the grid stays crisp on any display. The two rows above the
playfield are the spawn area: a new piece is drawn there faintly, so it is
visible from the moment it appears rather than a second later.

Frame deltas are clamped to 100 ms and the loop suspends while the tab is
hidden, so coming back to a backgrounded game never costs a burst of dropped
rows — the game simply pauses.

## Controls

| Keys        | Action                |
| ----------- | --------------------- |
| `←` / `A`   | Move left             |
| `→` / `D`   | Move right            |
| `↓` / `S`   | Soft drop             |
| `Space`     | Hard drop             |
| `↑` / `X`   | Rotate right          |
| `Z` / `Ctrl`| Rotate left           |
| `C` / `Shift`| Hold piece           |
| `P` / `Esc` | Pause / resume        |
| `R`         | Restart               |

Left and right auto-repeat after a 170 ms delay, then every 40 ms. The bindings
live in `KEY_BINDINGS` in `src/ui/input.ts` and the on-screen controls list is
generated from that table, so the two cannot drift apart.
