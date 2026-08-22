# Mega Tetris

A cheerful, fast-loading falling-block puzzle game that lives entirely in the
browser — a tiny arcade cabinet at a URL. No backend, no accounts, no build
server: just static files.

The game is playable: `npm run dev`, then press Play and use the arrow keys — or
open it on a phone and drag, tap and flick.

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
│   ├── style.css     # Visual identity: the `:root` palette and the layout
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
| `palette.ts`  | Reads the CSS custom properties and derives each block's shading.      |
| `input.ts`    | Keyboard bindings, and the auto-repeat clock every held control shares. |
| `touch.ts`    | Gesture recogniser, on-screen pad, pad setting, haptics.               |
| `loop.ts`     | `requestAnimationFrame` timing, delta clamping, pause when hidden.     |
| `shell.ts`    | Builds the DOM: canvases, readouts, overlay, buttons, live region.     |
| `hud.ts`      | Score/level/lines, overlay copy, screen-reader announcements.          |
| `effects.ts`  | Flashes, shards, dust, popups and shake, driven by engine events.      |
| `audio.ts`    | Synthesised cues — oscillators and envelopes, no audio files.          |
| `motion.ts`   | How much movement the player wants: the OS preference and the toggle.  |

Canvases are sized to their CSS box times `devicePixelRatio` and redrawn from a
`ResizeObserver`, so the grid stays crisp on any display. The two rows above the
playfield are the spawn area: a new piece is drawn there faintly, so it is
visible from the moment it appears rather than a second later.

Frame deltas are clamped to 100 ms and the loop suspends while the tab is
hidden, so coming back to a backgrounded game never costs a burst of dropped
rows — the game simply pauses.

## Look and layout

Every colour is declared once, as a custom property in the single `:root` block
of `src/style.css`. The canvas does not keep a second copy: `ui/palette.ts`
reads those properties out of the computed style at startup, and again whenever
a colour preference changes, so restyling the game — including the seven block
faces — is a matter of editing CSS. Each block's lit bevel and shaded edge are
derived from its face colour and drawn programmatically; there are no image
assets anywhere in the project, and the favicon is an inline SVG data URI.

The playfield is sized by one rule rather than a table of breakpoints: it takes
the smallest of the height the layout can spare, a ceiling for large screens,
and the height implied by the width left over once the rails are paid for. A
single rem-based media query moves the rails from beside the well to above and
below it. The page itself never scrolls — the field shrinks instead.

Verified at 320x568, 375x812, 768x1024, 1440x900 and 800x400: no horizontal
overflow, no page scrolling, and the whole 22-row field visible in every case.
`prefers-contrast: more` brightens the palette in both the chrome and the
canvas.

## Feel: effects and sound

The engine says *what* happened; `src/ui/effects.ts` and `src/ui/audio.ts`
decide how it feels. Nothing flows back the other way, so the rules stay
deterministic and every celebration is disposable.

| Event      | What you see                                                          | What you hear                     |
| ---------- | --------------------------------------------------------------------- | --------------------------------- |
| Line clear | Cleared rows flash white and shrink; shards fly in their block colours. | A chord, higher for more rows.    |
| Quad       | Twice the shards, a brighter flash, a few pixels of screen shake, a `QUAD` label. | The same chord, up a fifth and a note fuller. |
| Back to back | A harder shake and a `BACK TO BACK` label.                           | —                                 |
| Hard drop  | A streak down the piece's columns, dust at the landing row, the locked cells squash. | A whoosh into a thud.    |
| Level up   | The well's lip lights up and the new level reads across the field, gone in under a second. | Three notes up a major triad. |
| Game over  | The stack greys out row by row from the floor, then the panel fades in. | Three notes down.                |
| Score      | A `+800` label rises out of the clear; the HUD score counts up to it.  | —                                 |

Every sound is synthesised on the spot from oscillators and gain envelopes —
there is not one audio file in the repository. The musical decisions live in
`cueTones`, a pure function from cue to a list of tones, which is why "a quad is
a fifth above a single" is a unit test rather than a matter of opinion. The
`AudioContext` is not created until the player's first tap or keypress (browsers
block it before that) and a suspended context is nudged rather than assumed. The
**Sound** button mutes it; the choice is remembered in `localStorage` under
`mega-tetris:muted`.

Effects are measured in cells, not pixels, so a burst looks the same on a phone
and a desktop, and every particle, label and flash comes from a fixed-size pool
built once — a quad clear allocates nothing per frame. The pool caps at 168
shards; a burst that would overflow it thins out rather than growing.

Measured in Chromium at 1280x900: a real in-game back-to-back quad peaked at 164
live shards across 89 sampled frames with a median frame of **16.7 ms**, a worst
frame of **16.8 ms** and nothing over 20 ms — a locked 60fps. Rendered on its own
against a 300x660 canvas, the whole effects layer costs **0.2 ms median, 0.3 ms
p95** per frame while a quad is in flight.

### Reduced motion

`prefers-reduced-motion: reduce` is honoured, read through `matchMedia` so
flipping it in system settings takes effect without a reload. With motion off
there are no particles, no shake, no rise on the score labels and no count-up;
the cleared rows get a held, static highlight instead, the game-over grey lands
in one step and the panel appears without a fade. The information is all still
there — only the movement goes.

The **Effects** button overrides it in both directions (auto → full → reduced),
because plenty of people want calm effects in one game and not across their whole
machine. It persists under `mega-tetris:motion`, and the decision is published to
the stylesheet as `data-motion` on the root element so the CSS transitions follow
exactly the same rule the canvas does.

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

## Touch

The game is fully playable with a thumb. There are two ways to play, and both
produce exactly the same actions the keyboard does — `src/main.ts` has one
`dispatch`, and gestures, buttons and keys all arrive there.

### Gestures, over the well

| Gesture                            | Action                     |
| ---------------------------------- | -------------------------- |
| Drag sideways                      | One column per step, continuously |
| Drag down                          | Soft drop, one row per step |
| Fast flick down                    | Hard drop                  |
| Tap                                | Rotate right               |
| Tap in the left fifth of the well  | Rotate left                |
| Two-finger tap                     | Rotate left                |
| Swipe up                           | Hold                       |

Every threshold is a multiple of the **rendered cell size** rather than a pixel
count, so the same gesture feels the same on a 320 px phone and a tablet. The
constants — and one line of reasoning each — are at the top of
`src/ui/touch.ts`. The recogniser itself is a pure module: it takes plain
`{pointerId, x, y, timeMs}` records and returns actions, which is why the feel
of the gestures can be unit-tested rather than only waved at.

### The on-screen pad

Seven real `<button>` elements with accessible names and 44 px minimum targets:
hold, both rotations, hard drop, left, soft drop, right. Left, right and soft
drop auto-repeat while held, driven by the same `createAutoRepeat` clock the
keyboard uses — a held ◀ and a held arrow key are literally the same code.

The pad shows on touch-capable or narrow screens by default. The **Touchpad**
button cycles auto → on → off and the choice is remembered in `localStorage`
under `mega-tetris:touch-pad`. With the pad up, the readouts fold from two rails
into one strip across the top of the well so the field keeps its height, and the
keyboard help — no use to a thumb — steps aside.

Pointer Events throughout, one primary pointer for gestures, so a second finger
on the pad never disturbs a drag in progress. `touch-action: none` on the page
and the play surface means nothing scrolls, pinch-zooms or pulls to refresh
while playing; `touch-action: manipulation` on the controls keeps taps instant
without giving double-tap zoom back. Locks and line clears get a short
`navigator.vibrate` where the device supports it, silenced by
`prefers-reduced-motion`.

Below the well, three quiet buttons hold the three settings that persist:
**Touchpad**, **Sound** and **Effects**.

Verified with touch emulation at 390x664, 412x823, 320x568, 812x375 (landscape)
and 768x1024: every gesture and button lands the right action, nothing scrolls,
no target is under 44 px, and the setting survives a reload.
