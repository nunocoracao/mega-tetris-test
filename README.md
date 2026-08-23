# Mega Tetris

A cheerful falling-block puzzle game that lives entirely in the browser — a
tiny arcade cabinet at a URL. No backend and no accounts: three static files
totalling **53 KB gzipped**, and you are playing. Install it and it is a cabinet
on your home screen too, playable with the network switched off.

**▶ [Play it](https://nunocoracao.github.io/mega-tetris-test/)**

Arrow keys on a desktop; drag, tap and flick on a phone. It remembers your
settings and your personal bests between visits, and nothing ever leaves your
browser.

## What is in it

- **The whole genre, done properly.** Seven pieces from a shuffled bag, wall
  kicks, a ghost showing where the piece will land, soft and hard drop, hold, a
  five-deep preview, lock delay with a reset cap, levels that speed up, spins,
  combos, a back-to-back chain, and a seeded piece stream that makes every run
  reproducible.
- **Three ways to play.** Marathon until you top out, Sprint for the fastest 40
  lines, Ultra for the highest score in two minutes — the same game with a
  different finish line, each with its own record book. See [Modes](#modes).
- **Replays, and a run in a link.** Every game is recorded as the keys you
  pressed and when — watch it back in the well at 1×, 2× or 4×, or put the whole
  run in a URL and hand it to somebody. Nothing is uploaded: the run travels in
  the fragment, which browsers never send to a server. See
  [Replays and shared runs](#replays-and-shared-runs).
- **A daily challenge, with no server.** Everyone who opens the page on the same
  UTC day gets the same pieces, because the seed is a hash of the date. One
  attempt, a streak, a thirty-day strip, and a line you can paste to a friend.
  See [The daily challenge](#the-daily-challenge).
- **Plays with a thumb.** Gestures over the well *and* a seven-button on-screen
  pad, both producing exactly the actions the keyboard does.
- **Feels like something.** Line clears flash and throw shards in their own
  colours, a quad shakes the cabinet, the score counts up, a combo walks the
  clear cue up the scale, and every sound is synthesised from oscillators —
  there is not one media file in the repository.
- **Yours to set up.** Every key is remappable, and DAS, ARR and the soft-drop
  rate are sliders with a strip beside them that lets you feel the numbers.
  Rebinding a key moves the help panel with it, because there is only one list.
  See [Making it yours](#making-it-yours).
- **Remembers you.** Personal bests, totals, your keys, your handling and every
  preference, in one versioned `localStorage` key that is written on the
  assumption that storage is hostile — plus your daily streak and the last
  thirty days of it.
- **Four cabinets, one game.** Midnight, Daybreak, Sunset and Lagoon: complete
  skins rather than hue rotations, chosen from a labelled picker with swatches
  and remembered between visits. Every one of them is measured against WCAG AA
  in both contrast modes by the test suite. See
  [Skins](#skins--the-four-cabinets).
- **Meant to be usable.** Full keyboard operation, real modal dialogs, a
  screen-reader description of the well, a high-contrast variant of every skin,
  per-piece shape marks so nothing depends on colour alone, and
  `prefers-reduced-motion` honoured live.
- **Installs, and then plays on a plane.** A manifest, an icon set drawn in this
  repository, and a forty-line service worker that precaches the build and is
  honest about updates: a new deploy offers you a reload rather than taking one.
  See [Installing it](#installing-it).
- **Starts instantly.** No web fonts, no image files, no runtime dependencies,
  no network request after the first three.

## Getting started

Node.js 20 or newer, and the npm that ships with it.

```bash
npm install     # dev dependencies only — the game itself has none
npm run dev     # http://localhost:5173
```

## Commands

| Command              | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Vite dev server with hot module replacement.               |
| `npm run build`      | Typecheck, then build the static bundle into `dist/`.      |
| `npm run preview`    | Serve the built `dist/` locally, as a static host would.   |
| `npm test`           | The whole suite, once. Takes about five seconds.           |
| `npm run test:watch` | The suite, in watch mode.                                  |
| `npm run coverage`   | The suite plus a coverage report (`coverage/index.html`).  |
| `npm run typecheck`  | `tsc --noEmit`, in `strict` mode.                          |
| `npm run lint`       | ESLint, with type-aware TypeScript rules.                  |
| `npm run a11y`       | The axe-core audit and the contrast check on their own.    |

`npm run coverage` enforces a floor on `src/engine/**` — 90% statements, 85%
branches — and fails the command if an edit drops below it. It currently sits
at **98% statements, 96% branches, 100% functions**. The browser layer is
reported but not gated; see [Testing](#testing) for why.

`vite.config.ts` sets `base: './'`, so the contents of `dist/` work from any
static host and from any subdirectory path.

## Modes

The rules never change between modes: same gravity curve, same scoring, same
levels every ten lines. All a mode decides is when the run stops and what the
result is called.

| Mode         | Ends when                        | The result is | Beaten by     |
| ------------ | -------------------------------- | ------------- | ------------- |
| **Marathon** | You top out. *(the default)*     | A score       | A higher one  |
| **Sprint**   | The 40th line clears             | A time        | A **lower** one |
| **Ultra**    | Two minutes are up               | A score       | A higher one  |

Pick one on the start screen — three buttons beside the level picker, and the
choice is remembered between visits. `Restart` keeps the mode you are in;
changing it is a fresh game.

Every run ends with a `runEnd` carrying an **outcome**, and the panel says what
actually happened rather than only that it stopped:

| Outcome       | What it means                       | The panel says          |
| ------------- | ----------------------------------- | ----------------------- |
| `toppedOut`   | A piece had nowhere to spawn        | *Topped out on level 6* |
| `goalReached` | Sprint met its line goal            | *40 lines in 1:42*      |
| `timeUp`      | Ultra's clock ran out               | *Time up — 8,400*       |

A Sprint that tops out before 40 lines is a **did-not-finish**: it counts in
your games played and your lifetime lines, and it sets no time, however quickly
it fell over. Nothing else in the game distinguishes losing from stopping, and
this is the one place where it matters.

The readout beside the well follows the mode — Marathon leads with the score,
Sprint with a clock counting up and the lines still to go, Ultra with a clock
counting down and the score beside it. It is one HUD parameterised three ways,
not three HUDs. Over the last ten seconds of an Ultra and the last five lines
of a Sprint the readout turns pink and pulses, and a dry tick counts each step
out loud; with reduced motion the colour and the tick stay and only the pulse
goes.

Both timed modes end **at the deadline, not at the end of the frame that
crossed it**. `update` consumes its delta in slices bounded by the finish line
along with every other timer, so a 100 ms frame stops an Ultra on 120000 ms
exactly, and a Sprint's clock is the clock as it stood on the fortieth line —
not after the line-clear pause that would have followed.

## The daily challenge

Two facts about this project make a daily challenge free. The engine is a pure
function of `(seed, ordered list of calls)`, so a seed *is* a run. And nothing
here talks to a server, so there was never a scoreboard to upload to. Put those
together and a shared calendar date is all two strangers need to play the same
game and compare the result.

**The seed is the date.** `dailySeed('2026-08-23')` in `src/engine/daily.ts` is
FNV-1a over the `YYYY-MM-DD` string — a few lines of 32-bit arithmetic with no
clock, no locale and no table in it. The same day gives the same pieces on every
machine, forever; `src/engine/daily.test.ts` pins a handful of dates to their
seeds so a refactor that quietly moved them fails the suite. The day is **UTC**,
which is what makes it shared: everyone is on the same day at the same moment,
at the cost of it turning over at an awkward hour for some.

The engine is not allowed to read a clock (`purity.test.ts` says so), so the
date arrives as an argument. `src/main.ts` is the one file in the project that
asks what day it is, once, at boot — and `src/wiring.test.ts` fails if any other
file calls `Date.now()` or `new Date()`.

**One attempt a day, Marathon, from level 1.** The constraint is what makes the
score mean anything. It is spent when the run *ends*, never when it starts, so a
refresh, a crash or a closed laptop mid-game costs you nothing. Once it is
spent, the same seed is still playable as a **practice run**, which is labelled
as such on the panel and recorded nowhere.

The record lives in the same versioned `localStorage` key as everything else,
which means a determined player can obviously reset it. There is no anti-cheat
here and there should not be: the aim is that cheating is not the *default*
path, not that it is impossible in a program running on your own computer.

**Streaks and the strip.** The current streak, the longest streak and the last
30 days are stored; a missed day breaks the streak, and the streak is still
alive the morning after until the day after that. It is counted at write time
rather than derived, because a fifty-day streak does not fit in a thirty-day
window. The strip on the start screen is 30 cells, oldest first, ending today:
a **hollow circle** for a day missed, a **filled square** for one played, tinted
in four bands by how the run went against your best day in the window, and every
cell carries the date and the score in a `title` *and* in visually hidden text.
The tint is the last thing that carries meaning, never the only one.

**Copy result** puts three lines on the clipboard — the date, the score, the
lines, the streak and the game's URL — and deliberately says nothing about the
seed's contents, because spoiling the day for whoever reads it would defeat the
point. `navigator.clipboard` is absent over plain HTTP and rejects when the
permission is denied, so when it fails the same text appears in a labelled,
read-only, pre-selected field instead.

## Replays and shared runs

The README has said from the first week that the game is a pure function of
`(seed, ordered list of calls)`. This is what that claim was for.

**A run is its inputs.** While you play, a recorder writes down every input and
the run clock it happened on. It writes down nothing else — no board states, no
frames, no positions — because it does not need to: `update` consumes its delta
in slices bounded by the next deadline, which makes it *additive*, so `update(a)`
then `update(b)` produces exactly the state `update(a + b)` does. A log therefore
needs the moments something happened, not the sixty frame deltas a second the
browser actually fed the engine. A two-minute Ultra comes to a few hundred
entries.

```ts
import { createRecorder, replay } from './engine';

const log = recorder.log();               // { durationMs, entries, truncated }
const final = replay(seed, { startLevel, mode }, log);
// final is deeply equal to the state the run ended on — board, bag, score,
// combo, back-to-back chain, hold, the lot.
```

`src/engine/replay.test.ts` is the test the whole feature exists for: it plays
five seeds through a placement bot, records five hundred to a thousand inputs
each, replays them, and asserts the final `GameState` with `toEqual`. **If that
goes red the engine has grown a hidden piece of state, and that is the bug** —
not the test. A stepped variant, `startReplay`/`advanceReplay`, is what the
viewer drives; speed is nothing but a bigger delta, so there is no second code
path for 4×.

**The recorder observes; it does not participate.** It is handed the clock and
the input by the two lines that were about to apply them, and it hands nothing
back — no wrapped `update`, no adjusted delta, no callback the game waits on.
`replay.test.ts` proves it by playing the same script twice, once watched and
once not; `wiring.test.ts` pins the shape in `src/main.ts`. The log is capped at
20,000 entries, and at the cap the recorder **stops and says so** rather than
dropping the oldest entries: a log with a hole in it is not a shorter replay, it
is a wrong one.

One thing did change for this: `ui/loop.ts` now hands the engine **whole
milliseconds**, carrying the fraction over to a later frame (`splitWholeMs`).
`requestAnimationFrame` deals in 16.666…, and a run clock reading 4283.9994
cannot be written down in a link somebody else's browser will rebuild the same
run from. The carry is what keeps the game running at exactly the speed it
always did.

**Watching it back** reuses the renderer exactly as it is, because a replay is
just a `GameState` being painted — that is what the renderer being a pure
painter buys. Nothing in `ui/renderer.ts` knows a replay from a live game. What
does know is the chrome, and it says so three ways at once, none of them only a
colour: the well takes an orchid ring, a **Replay** badge sits in its corner, and
the playfield's accessible name and description both start with the word. The
bar under the well has Play/Pause, 1× / 2× / 4×, Start over and Leave; with the
well focused, Space is play/pause, `R` starts over and **Escape leaves**, from
wherever focus happens to be. The live game underneath is not advanced by a
single millisecond while you watch.

**Copy replay link** puts `{version, mode, seed, startLevel, log}` in the URL
fragment. The format is a two-byte header — a format version and a codec — and
then a body of LEB128 varints in which the time gap and the input index are
folded into one number, so an ordinary keypress costs two bytes. The body is
deflated with `CompressionStream` where the browser has one and stored as it is
where it does not, whichever comes out smaller. The 294-input run this paragraph
was measured against came to **365 characters** of URL.

The fragment, deliberately: it is the half of a URL a browser never sends
anywhere, and there is nowhere for it to be sent. **A run too long to fit says
so** and offers the score-only share line instead — a link that arrives cut in
half by a chat client is worse than no link at all.

**Opening one is opening a stranger's input**, and it is guarded exactly the way
`ui/storage.ts` guards `localStorage`. `decodeShare` is pure, synchronous and
total: every path out of it is a result, none of them throws, and every length in
the payload is checked against a cap *before* it is used — a four-byte varint can
claim a hundred million entries, and believing it would be the whole attack.
Malformed, truncated, oversized, junk and hostile payloads all produce one
friendly sentence and an ordinary start screen. `src/engine/share.test.ts` feeds
it several thousand pieces of deliberate garbage, every truncation of a real
link, and real links with a character swapped, and asserts it never throws and
never hands back a run the replayer cannot be given.

Decompression is **ours** — about a hundred and thirty lines of raw DEFLATE at
the bottom of `src/engine/share.ts`, checked against `node:zlib` at four
compression levels so it is a real decoder rather than something that happens to
undo our own compressor. `DecompressionStream` is asynchronous and merely widely
available; a friend's link has to open on the first frame in whatever browser
they clicked it in. No compression dependency was added and none should be.

### The replay format is a contract

A replay is a recording of *decisions*, not of pixels, and it only means
anything against the rules that were in force when it was made. **Change gravity,
scoring, the bag, the wall kicks, the lock delay, spawn positions or the mode
rules and every log ever written decodes into a different run.**

So: `REPLAY_FORMAT_VERSION` in `src/engine/replay.ts` goes up whenever an engine
rule changes. Every payload carries it, and a version this build does not
understand is refused with a clear message rather than played back into a run
that never happened. This is the one place in the project where the determinism
rule has an external contract — a link somebody sent last month is a promise
about the rules, and the version number is how it is kept.

## Installing it

The game was always three static files and no runtime dependencies, which is
most of the work of being installable already done. What was missing was a
manifest, an icon set and a service worker — about two hundred lines in
`build/`, and no new dependency.

**Install** appears in the footer, beside Play and Restart, and **only when the
browser has actually offered an installation** — `beforeinstallprompt` is the
browser saying it would have shown its own prompt, and the button is that offer
moved somewhere it cannot cover the well. Declining it, or installing, retires
it for good; the answer lives in the same `localStorage` key as everything else.
On a platform with no such event — iOS, where it is *Add to Home Screen* in the
share sheet — no button ever appears.

**Offline.** The worker precaches the built bundle at install and serves it
cache-first. It never writes to a cache while answering a request: a
`cache.put` in a fetch handler is how a service worker ends up doing storage I/O
in the middle of a frame, and there is nothing here worth caching
opportunistically anyway. Everything the game needs is in the precache, so with
the network off it starts, plays, ends and restarts exactly as it does online.

**Updates, offered rather than applied.** This is the part most projects get
wrong. A new deploy is a new precache list, a new revision and a new cache; the
new worker installs, fills its cache, and then **waits**. The page notices it
waiting and shows a row under the footer — *A new version is ready. Reload / Not
now* — and does nothing else. Pressing Reload promotes the waiting worker and
reloads onto it; pressing *Not now* puts the row away and leaves it waiting for
the next visit. Nothing reloads underneath a run, not even when another tab
takes the update: a controller change this page did not ask for is deliberately
ignored.

**Standalone.** With no browser chrome there is no chrome keeping the cabinet
off the notch, so the page pays the safe-area insets itself — the on-screen pad
sits above the home indicator rather than under it. `theme-color` follows the
palette, so the status bar changes with the skin *and* with the contrast setting
rather than leaving a seam across the top of the phone. Nothing in the game ever depended on a back
button, an address bar or the word "tab".

**In development none of this happens.** `registerServiceWorker` is a no-op
outside a production bundle and the whole body folds out of the dev build, so
`npm run dev` still hot-reloads; the dev server answers `/sw.js` with a 404, and
serves the manifest and icons out of memory so they are checkable without a
build.

### The icon

Drawn here, in `build/icon.ts`: four blocks in a square — the O piece — in four
of the game's own face colours on the cabinet's deepest plum. It is described
once as geometry and rendered three ways, so the tab icon and the home-screen
icon cannot drift apart:

| File                     | What it is                                              |
| ------------------------ | ------------------------------------------------------- |
| the `rel="icon"` data URI | The favicon, still inline, still not a request.         |
| `icon.svg`               | The scalable entry in the manifest.                     |
| `icon-192.png` / `icon-512.png` | Rasterised at build time from the same shapes.   |
| `icon-maskable-512.png`  | Full-bleed, blocks inside the 80% safe circle.          |
| `apple-touch-icon.png`   | 180px, opaque and square — iOS rounds it itself.        |

The PNGs are rasterised by `build/png.ts`: a point-in-rounded-rect test, 4×4
supersampling and `node:zlib`, in about a hundred lines. Five rounded rectangles
do not need an image library with a native binary attached to it, and this is
why the repository still contains no image file and no runtime dependency. The
colours come out of `src/style.css` at build time — `build/icon.test.ts` and
`build/manifest.test.ts` fail if the icon or the manifest's two colours stop
agreeing with the palette.

**The icon set stays on the default palette, on purpose.** It is generated once,
at build time, from the Midnight block; choosing Daybreak does not redraw it,
and should not. A home-screen icon is how somebody *finds* the game among forty
others, and one that changed colour with a preference — or differed between two
devices signed into the same account — would be worse than one that does not.
The manifest's `theme_color` and `background_color` are the same argument: they
are what the platform paints before a single line of our code has run, so they
have to be constants. `theme-color` in the live document is the part that *does*
follow the skin, because by then there is a running page to follow it.

## Controls

### Keyboard

**This table is the default, not the law.** Every row of it can be changed from
**Settings** — see [Making it yours](#making-it-yours) below.

| Keys           | Action         |
| -------------- | -------------- |
| `←` / `A`      | Move left      |
| `→` / `D`      | Move right     |
| `↓` / `S`      | Soft drop      |
| `Space`        | Hard drop      |
| `↑` / `X`      | Rotate right   |
| `Z` / `Ctrl`   | Rotate left    |
| `C` / `Shift`  | Hold piece     |
| `P` / `Esc`    | Pause / resume |
| `R`            | Restart        |
| `?` / `H`      | Help           |

Left, right and soft drop auto-repeat: 170 ms before the first repeat, then one
every 40 ms sideways and every 35 ms down — all three adjustable. `Enter` and
`Space` both mean "play again" on the game-over panel, from wherever focus
happens to be.

Keys pressed while a dialog is open belong to the dialog, so arrows scroll a
long help panel rather than moving a piece nobody can see.

While a **replay** is on the well, four of those keys do a second job and every
other one is deliberately swallowed — pressing left during a recording of
somebody else's game should do nothing at all:

| Keys        | In a replay              |
| ----------- | ------------------------ |
| `Space`     | Play / pause             |
| `R`         | Watch it again           |
| `P` / `Esc` | Leave the replay         |
| `?` / `H`   | Help                     |

`Escape` also works from the replay bar's own buttons, where the game layer
leaves keys inside controls alone.

### Touch — gestures over the well

| Gesture                           | Action                            |
| --------------------------------- | --------------------------------- |
| Drag sideways                     | One column per step, continuously |
| Drag down                         | Soft drop, one row per step       |
| Fast flick down                   | Hard drop                         |
| Tap                               | Rotate right                      |
| Tap in the left fifth of the well | Rotate left                       |
| Two-finger tap                    | Rotate left                       |
| Swipe up                          | Hold                              |

Every threshold is a multiple of the *rendered cell size* rather than a pixel
count, so a gesture feels the same on a 320 px phone and on a tablet. A flick
must cross 2.2 cells **and** still be moving at 0.045 cells/ms to count as a
slam, measured over the last 70 ms — which is what keeps a deliberate drag to
the floor from reading as a hard drop.

### Touch — the on-screen pad

Seven real buttons with accessible names and 44 px minimum targets: hold,
rotate left, rotate right, hard drop, move left, soft drop, move right. Left,
right and soft drop auto-repeat while held, driven by the same clock the
keyboard uses.

The pad appears on touch-capable or narrow screens by default; **Touchpad** in
the pause menu cycles auto → on → off.

### Making it yours

**Settings** opens from the footer, from the start screen, and from the pause
menu ("Keys and handling…"). It is a dialog rather than a screen: the run
behind it is exactly where you left it, so you can nudge a slider mid-game and
carry on with the same piece still falling. `Escape` always closes it.

#### Remapping a key

Each action has a row: the keys it answers to, **Add key**, and **Default**.
Press *Add key*, then press the key you want. Every key on a row has its own
`×` that takes it off again.

Four rules, each of them a sentence in the dialog when it bites — never a
colour, and never a silent refusal:

- **A key already in use is refused, not stolen.** "Space is already Hard drop.
  Clear it there first, then try again." Taking a key off another row without
  saying so is how a player ends up unable to drop and none the wiser; being
  told costs one more click and never costs a binding.
- **`Tab`, `Enter` and `Escape` cannot be captured**, nor can `Alt` or `Meta`,
  nor any key with a modifier held down. They are how you move around the
  dialog, press the button under focus, and get out — a capture that swallowed
  them would be exactly the trap a remapper exists to prevent. (`Esc` keeps its
  default place on *Pause / resume*, which is safe because a dialog claims the
  key before the game ever sees it. You can clear it; you cannot move it.)
- **`Pause / resume` and `Restart` must keep at least one key.** Without them
  you could not reopen this dialog or deal a new game.
- **At most three keys per action**, so a row stays a row.

*Default* on a row restores that action's keys — taking them back off whatever
had claimed them. **Reset every key** does the lot.

#### Handling

Three sliders, in milliseconds, with a strip beside them that moves a block on
your own move keys at the settings you have chosen — the same repeat clock the
game uses, so what you feel there is what the piece will do.

| Setting               | Range        | Default |
| --------------------- | ------------ | ------- |
| Delay before repeat   | 0–500 ms     | 170 ms  |
| Repeat rate (ARR)     | 0–100 ms     | 40 ms   |
| Soft drop rate        | 5–200 ms     | 35 ms   |

**ARR may be zero and soft drop may not**, which is a decision rather than an
oversight. Instant sideways movement is a setting a real population of players
wants and it is safe to give them: a piece that slides to the wall in one frame
can be slid straight back. The same trick downwards is not reversible — a piece
cannot come back up — so a zero there would be a hard drop with extra steps and
would cost you placements you meant to make.

Zero ARR is implemented as *eight steps per frame*, not a literal teleport.
Eight is the same flood guard every other repeat obeys, and it crosses a
ten-wide well in two frames — about 33 ms, which is below the threshold of
noticing. The cap is what stops one long frame queueing hundreds of moves into
the engine and the replay tape.

#### Skins — the four cabinets

The cabinet comes in four dresses. **Midnight** is the default and has not
changed: deep plum lit from above. **Daybreak** opens the shutters — warm paper,
ink-dark blocks, a marmalade accent. **Sunset** is late light on a rose-brown
interior. **Lagoon** is deep water lit from the surface, with a coral accent.
Each is a point of view rather than a hue rotation: every one of the thirty-one
palette properties moves, including which way the veils wash and whether the
seven faces are bright on dark or deep on light.

Pick one under **Cabinet skin** in the settings dialog. It is a radio group with
a swatch and a visible name per skin, so arrow keys walk it and the chosen one
is announced without anybody having to press it to find out; the choice is
stored with the rest of your settings and survives a reload. A stored value this
build does not recognise falls all the way back to Midnight.

Three rules hold whichever one you are wearing:

- **The contrast setting composes with it.** Every skin has a high-contrast
  variant, so `Auto / High / Standard` still works on top of the skin rather
  than instead of it — that is twelve palettes, and `src/ui/style.test.ts`
  measures every AA and 1.4.11 pair in all twelve.
- **The seven pieces stay seven pieces.** Pairwise face distinctness is checked
  per skin, and the per-piece marks are identical across all of them.
- **Nothing about the game changes.** Colour is presentation: the engine has
  never heard of a skin, `REPLAY_FORMAT_VERSION` does not move, and a run
  recorded on Lagoon replays cell for cell on Midnight.

The installed app's icon set and the manifest's two colours deliberately stay on
Midnight — see [The icon](#the-icon) for why that is a feature and not an
oversight.

#### Where the settings live

The four quick toggles — Sound, Effects, Contrast, Touchpad — stay in the pause
menu **as well as** appearing in the settings dialog in labelled groups. The
skin picker is only in the dialog: it is a choice you make once and then forget,
not something to reach for mid-run, and four swatches do not belong in a footer.
That
is a deliberate duplication of *controls* and not of state: both write through
the same accessor into the same field of `ui/storage.ts`, so they cannot
disagree, and moving one changes the other. The reason to keep them is
mid-run: "turn the sound off" should be one tap from the pause menu, not two
dialogs deep.

#### What is remembered, and what a reset does

Bindings and handling are stored as data alongside the other settings and
validated on the way in. A map with an unknown action, a key bound twice, a
corrupt shape, or `Pause` left with no key at all falls back to *the whole
default table* rather than being half-repaired — controls you recognise beat
controls that are subtly wrong in a way nothing on the screen explains. The
sliders are repaired field by field instead, because an out-of-range number has
an obvious right answer.

There are two resets and they do not overlap:

- **Reset stats** (pause menu) erases every personal best, total and daily
  result. It leaves your keys alone — a binding is not a score.
- **Reset all settings** (settings dialog) puts keys, handling and every
  preference back to the way the game shipped. It leaves your record book alone.

#### Replays do not care what your keys are

A replay records *inputs*, not keys, and the engine has never heard of DAS. A
link shared eighteen months ago decodes and reproduces identically for somebody
whose cabinet looks nothing like yours — `settings.test.ts` plays a checked-in
link under a completely rearranged keyboard and a zeroed handling and compares
the resulting board cell for cell. `REPLAY_FORMAT_VERSION` is untouched by any
of this, and if it ever has to move for a *controls* change, something has gone
into the engine that should not have.

## Scoring

| Event            | Plain       | Spin        | Kicked spin |
| ---------------- | ----------- | ----------- | ----------- |
| No lines         | —           | 100 × level | 50 × level  |
| Single (1 line)  | 100 × level | 400 × level | 200 × level |
| Double (2 lines) | 300 × level | 800 × level | 400 × level |
| Triple (3 lines) | 500 × level | 1200 × level | 600 × level |
| Quad (4 lines)   | 800 × level | 1600 × level | 900 × level |
| Soft drop        | 1 per row   |             |             |
| Hard drop        | 2 per row   |             |             |

| Rule       | Behaviour                                                            |
| ---------- | -------------------------------------------------------------------- |
| Gravity    | `800ms × 0.85^(level−1)` per row, floored at `50ms` from level 18 on. |
| Levels     | One level per 10 lines cleared, in every mode.                        |
| Lock delay | `500ms` once resting, refreshed by a move or rotation, 15 times max.  |
| Hold       | Swaps the active piece and resets it to spawn; locked until the next piece commits. |
| Spin       | The last thing that moved the piece was a rotation, **and** it can no longer go left, right or down. Any piece kind; a turn that needed a wall kick is paid from the cheaper column. |
| Combo      | Consecutive locks that each clear at least one row. `50 × combo × level` from the second clear onwards; a lock that clears nothing resets it. |
| Back to back | A quad or a spin clear straight after another one scores **1.5×** its base, rounded down. Any plain 1–3 line clear breaks the chain; a lock that clears nothing leaves it alone. |
| Game over  | A newly spawned piece has nowhere to sit.                             |
| Sprint     | Ends the instant the 40th line clears. A top-out first is a did-not-finish and records no time. |
| Ultra      | Ends at exactly 120000 ms of play, evaluated at the deadline rather than at the end of the frame. |

The help panel builds both of these tables from the engine's own constants, so
retuning a score changes the help text with it.

The spin rule turns on one piece of history rather than on the shape of the
piece, which is why `GameState` carries a `lastAction`. Sliding a piece into a
slot, soft-dropping into it, or letting gravity carry it the last row all clear
that flag — only a rotation immediately before the lock counts. A hard drop that
falls *no* rows is the one exception: it moves nothing, so turning into a slot
and slamming to confirm still scores the spin.

Starting above level 1 is a **head start**: faster gravity, but ten levels of
easy scoring skipped. Those runs keep their own personal bests and stay out of
the headline high score. Totals — games played, lines all-time — count
everything, because they record time spent rather than skill.

## Accessibility

Everything here is checked by `npm run a11y` or by a unit test, not merely
asserted.

- **Structure.** `<header>` with the one `<h1>`, `<main>` around the well,
  `<footer>` for the actions; headings that only ever step down one level; a
  real `<button>` with an accessible name behind every control.
- **The well, in words.** The playfield canvas is `role="img"`, labelled by a
  visually hidden paragraph the HUD keeps current: *"Playfield, 10 columns
  wide. The stack is 6 rows high, of 20. Score 1,200, level 2, 14 lines
  cleared. Falling piece: T. Next: I, then O, then S. Holding L."* It says
  nothing about *where* the falling piece is — a description that changed on
  every gravity tick would be unusable.
- **A high bar for announcements.** One polite live region, and only line
  clears, level ups, pause and resume, game over with the final score, and
  setting changes reach it. Locks, spawns, holds and moves are silent.
- **Keyboard.** Full operability, no traps, no positive `tabindex`, and a
  single `:focus-visible` baseline rule so a control added later cannot arrive
  without a focus ring. There is no `outline: none` in the stylesheet and a
  test says so.
- **Real dialogs.** The pause menu, the help panel and the settings dialog trap
  focus, wrap `Tab` at both ends, close on `Escape`, restore focus to whatever
  opened them, and mark everything behind them `inert`. axe audits the page in
  every state one of them can be in, the settings dialog's key capture
  included.
- **Rebinding is an accessibility feature.** One hand, a left hand, a laptop
  with no numpad, a keyboard where `Z` is somewhere else — every action can be
  moved, cleared and reset, and the capture is itself fully keyboard-operable
  and announces what it took. Refusals are sentences in the panel *and* through
  the live region, never a colour or a shake. `Tab`, `Enter` and `Escape` are
  never capturable, so the dialog cannot become a trap. See
  [Making it yours](#making-it-yours).
- **Contrast, across the whole matrix.** Every text pair meets WCAG AA (4.5:1)
  and every control boundary meets 1.4.11 (3:1) — in every one of the four
  skins, in every one of the three contrast settings, computed from the real
  declarations in `style.css` by `src/ui/style.test.ts`. Twelve palettes, every
  pair, every time; an edit that drops one below the bar fails the suite.
- **Seven pieces stay seven pieces.** Every pair of block faces in every skin is
  at least ΔE\*ab 15 apart, measured in CIE L\*a\*b\* rather than as a contrast
  ratio — WCAG contrast only knows about lightness, and would happily call
  turquoise and mint identical.
- **Not just colour.** Each piece kind carries a mark stamped into its blocks —
  a bar for I, a ring for O, a plus for T, mirrored diagonals for S and Z, a
  pillar for J, a double bar for L — at 7:1 or better against its own face. The
  marks do not vary by skin: a cue that moves is not a cue.
- **Reduced motion.** `prefers-reduced-motion` is read through `matchMedia`, so
  changing it in system settings takes effect without a reload. With motion off
  there are no particles, no shake and no count-up; the information all stays,
  only the movement goes. The **Effects** setting overrides it in both
  directions.
- **Nothing destructive without a second answer.** Erasing your personal bests
  takes two differently-worded controls, and focus lands on the safe one.
- **A history you can read without seeing colour.** Each of the daily strip's 30
  cells is a hollow circle or a filled square before it is a shade, and carries
  the date and the score as text as well as in a tooltip.
- **News, not interruptions.** The install offer and the "a new version is
  ready" row are ordinary page content in the tab order, after the footer — not
  a toast over the well, and not a second live region. The update announcement
  goes through the one polite region like everything else, and dismissing the
  row puts focus back on the well rather than dropping it.

## Bundle size

The production build is still three files to start a game, and no runtime
dependencies:

| File         | Raw      | Gzipped     |
| ------------ | -------- | ----------- |
| `index.js`   | 135.9 KB | **45.0 KB** |
| `index.css`  | 33.2 KB  | **7.1 KB**  |
| `index.html` | 2.5 KB   | **1.1 KB**  |
| **Total**    | 171.6 KB | **53.2 KB** |

JS + CSS is **52.1 KB gzipped**, against a budget of 100 KB.

The three new skins cost **+1.8 KB gzipped** (1.2 KB of CSS, 0.6 KB of JS),
against a ceiling of about 2 KB set before any of them was written. Six blocks
of thirty-odd hex values is more raw bytes than that sounds like — the CSS grew
4.8 KB — but the property names repeat exactly from block to block, which is the
case gzip is best at. Two decisions kept it there: the skins have no
`prefers-contrast` media copy (only the default needs one, because only the
default can be on screen before the script runs), and the picker's swatches are
painted by the skins' own declarations rather than by a second set of swatch
colours. A fourth new skin would have cost another ~0.4 KB; three was the point
at which the set felt complete, not the point at which the budget bit.

The settings dialog before it cost **+6.6 KB gzipped** (5.9 KB of JS, 0.6 KB of
CSS) — the remapper's rules and copy, three sliders, the try-it strip, and about
two hundred lines of markup. Rather more than a settings screen sounds like, and
the reason is that most of it is *sentences*: every refusal the remapper can
make is a written explanation rather than a red border, and there are a dozen
of them.

Replays and shared runs remain the largest single rise this project has had, at
**+7.6 KB gzipped**, and it is worth saying where that went:

| Module                             | Gzipped    |
| ---------------------------------- | ---------- |
| `engine/share.ts` — codec, base64url, **and a whole raw-DEFLATE decoder** | 3.1 KB |
| `ui/replay.ts` — the viewer's machine and its copy | 1.0 KB |
| `engine/replay.ts` — log, replayer, recorder | 0.9 KB |
| `ui/share.ts` — the compressor and the link | 0.6 KB |
| the replay bar, the share controls, the CSS and the wiring | ~2.0 KB |

Most of it is the decompressor, and it is still the cheap option: `pako`'s
inflate alone is several times this, and it would have been a runtime dependency
in a project that has none. The favicon is still an inline SVG data URI, there
are still no web fonts and no audio files, and starting a game still costs
exactly those three requests.

Everything else is fetched by the service worker after the first paint, or by
the platform when the app is installed, and none of it is on the path to a game:

| File                      | Raw     |
| ------------------------- | ------- |
| `sw.js`                   | 4.7 KB  |
| `manifest.webmanifest`    | 1.0 KB  |
| `icon.svg`                | 0.4 KB  |
| the four PNG icons        | 17.7 KB |

Re-measure with `npm run build` — Vite prints the gzipped figure for every
asset.

## Architecture

```
.
├── index.html          # Document shell and Vite entry point
├── src/
│   ├── engine/         # The game. Pure, deterministic, DOM-free.
│   │                   #   game.ts, board.ts, pieces.ts, random.ts, daily.ts,
│   │                   #   replay.ts (record and play back), share.ts (a run
│   │                   #   in a link, plus a raw-DEFLATE decoder)
│   ├── ui/             # The browser layer: canvas, input, DOM, storage.
│   ├── main.ts         # Composition root — the one place they meet
│   ├── style.css       # The four skins, and the layout
│   └── *.test.ts       # Tests, colocated with the code they cover
├── build/              # Build-time generators. Never shipped as code.
│   ├── css.ts          # Reads the palette back out of style.css
│   ├── icon.ts         # The icon, as geometry, in one place
│   ├── png.ts          # A rasteriser and a PNG encoder, in ~100 lines
│   ├── manifest.ts     # The web app manifest, from the palette
│   ├── sw.js           # The service worker, shipped as it is written
│   └── plugin.ts       # The Vite plugin that emits all of the above
├── eslint.config.js
├── tsconfig.json       # strict, plus `noUncheckedIndexedAccess`
└── vite.config.ts      # Vite + the plugin + Vitest + coverage thresholds
```

### The engine is a pure state machine

`src/engine/` is the whole game as data and three functions. There is no DOM,
no clock, no `Math.random`: the only source of randomness is a seeded bag
carried *inside* the state itself.

```ts
import { applyInput, createGame, update } from './engine';

let state = createGame({ seed: 2026 });          // 'ready'
state = applyInput(state, { type: 'resume' });   // 'playing'
state = update(state, 16.7);                     // one frame of gravity
state = applyInput(state, { type: 'hardDrop' });
```

Every call returns a brand-new immutable snapshot and never touches its input.
That makes the game a pure function of `(seed, ordered list of calls)`: the same
seed and the same script always produce a deeply equal result, which is what
lets the tests assert real behaviour instead of poking at internals — and what
[replays and shared runs](#replays-and-shared-runs) are built on. Any new state
must go *in the snapshot*: a module-level counter or a closure is invisible to a
replay and desynchronises it.

`update` consumes its delta in slices bounded by the next deadline — the next
gravity step, the end of the lock delay, the end of a line-clear pause — so one
long frame produces exactly the same sequence of events as the many short
frames it stands in for. `src/engine/purity.test.ts` scans every engine source
file for `Math.random`, `Date.now`, `performance.now`, DOM globals and
`import.meta.env`, so adding an engine file adds a check.

### Events drive the effects, and nothing flows back

Each snapshot carries `events` — `spawn`, `lock`, `hardDrop`, `spin`,
`rowsCleared`, `levelUp`, `hold`, `runEnd` — describing only what happened
during the call that produced it, in game terms with no colours, durations or
sounds in them. `rowsCleared` says how many rows went, whether it was a spin,
how long the combo and back-to-back chains are, and what it was worth; it does
not say "T-spin double", because naming it is copy. `ui/effects.ts` and
`ui/audio.ts` consume those and decide how it feels. The arrow only points one
way, which is what keeps the rules deterministic and every celebration
disposable.

### The browser layer holds no rules

`src/ui/` turns the state machine into a game you can play, and each module does
one job: `renderer.ts` paints a `GameState`, `palette.ts` reads every colour out
of the stylesheet, `input.ts` and `touch.ts` report intents, `loop.ts` times
frames, `shell.ts` builds the DOM, `hud.ts` writes the readouts, `dialog.ts` is
the modal machinery, `storage.ts` is the only file that touches `localStorage`,
`daily.ts` owns the streak arithmetic and the daily copy, `settings.ts` fills
the settings dialog (the dialog *behaviour* is still `dialog.ts`'s), and
`stats.ts` is the only place a personal best is decided — including what
"best" even means in a mode raced on a clock. `hud.ts` is also
the only place a clear gets a *name* — "T-spin double", "combo ×4" — which is
why `effects.ts` imports it for its floating labels rather than writing its own.

`src/main.ts` is the one file that knows about both halves. It owns the single
mutable `state` reference, feeds real elapsed milliseconds into `update`, turns
key presses and gestures into engine inputs, and decides policy the engine
deliberately leaves open — whether "pause" means pause or resume, whether a
restart replays the seed or deals a new one, what a help panel even is.

Four boundaries are enforced by tests rather than by review
(`src/wiring.test.ts`): the UI imports the engine only through its barrel
`src/engine/index.ts`, no file outside `ui/storage.ts` names `localStorage`, no
file outside `main.ts` reads the wall clock, and **no file outside
`ui/input.ts` names a key**. That last one is what makes rebinding `Hard drop`
change what the help panel says: the help list, the controls card beside the
well and the on-screen pad's tooltips are three views of one binding table, and
`applyBindings` republishes it into all three whenever it moves.

### The palette lives in CSS, and so do the skins

Every colour is declared in `src/style.css` and nowhere else. The canvas keeps
no second copy: `ui/palette.ts` reads the custom properties out of the computed
style at startup and again whenever a colour preference changes, and each
block's lit bevel, shaded edge and outline are derived from its face colour
arithmetically. `src/wiring.test.ts` enforces the rule directly — every browser
file except `palette.ts` is scanned for hex and `rgb()` literals, and finding
one fails the suite.

That is what makes a skin a stylesheet edit rather than a feature. Four blocks
of the same thirty-one properties, four selectors, and the renderer, the
particles, the score popups and the ghost all follow with no change at all:
they ask `getPalette()`, and `applyTheme` changes the answer by moving one
attribute and re-reading.

`src/ui/palette.test.ts` parses the stylesheet and fails if the pre-first-paint
fallback constants drift from it; `src/ui/layout.test.ts` does the same for the
two geometry numbers CSS has to duplicate.

## Testing

Around 1,300 tests, in about fifteen seconds.

The engine carries a coverage floor because it is the part that must not rot.
The browser layer does not, deliberately: the tests there cover the **pure**
parts — the gesture recogniser, the storage format and its migrations, the
stats ladder, HUD formatting, the auto-repeat clock, layout arithmetic, the
audio cue table — and leave rendering to be verified by looking at it. Chasing
a coverage number through the canvas would buy brittle tests rather than
confidence.

`build/` is tested the same way and for the same reason: the icon's fills
against the palette, the maskable variant against the safe circle, the
manifest's colours against `style.css` (by a parser deliberately unlike the
one the build uses, so it is a second opinion rather than an echo), and the
*generated* service worker — that it precaches, that it never writes to a cache
while serving a request, and that its one `skipWaiting` is inside the message
handler.

`src/ui/style.test.ts` is the one that makes a fifth skin safe to add. It parses
`style.css` itself and walks four skins × three contrast settings, measuring
every WCAG text and boundary pair, every block against the well, and every pair
of blocks against each other — then checks the structure: that each skin
declares the *complete* property set (a missing one silently inherits the
default and produces a half-dressed cabinet), that no skin invents a property
the default lacks, and that the skins in the stylesheet and the skins in
`ui/theme.ts` are the same list.

The two files that carry the most weight are `src/engine/replay.test.ts` and
`src/engine/share.test.ts`. The first is the determinism claim, cashed: five
seeds, a placement bot, five hundred to a thousand recorded inputs each, and a
`toEqual` on the final `GameState`. The second is the only decoder in the
project that reads something a stranger wrote, so it gets several thousand
pieces of deliberate junk, every truncation of a real link, real links with a
character swapped, a deflate bomb, and a check of the hand-rolled inflate
against `node:zlib` at four compression levels.

Two files run in jsdom rather than Node: `src/ui/a11y.test.ts` runs axe-core
over the real shell five times (dialogs closed, the start screen and its two
pickers showing, a replay playing, pause menu open, help panel open) and then
checks the things a
static audit cannot see — focus moving in and back out, `Tab` wrapping,
`Escape` not reaching the game underneath, the background going `inert`, and
the mode picker being three real buttons that take focus and say which one is
chosen. Everything else runs in `node`, which is what stops a
DOM reference sneaking into the engine.

### Playtesting

Behaviour that only exists in a browser is verified by driving one. Playwright
is not a dependency; install it when you need it:

```bash
npm install --no-save playwright
npx playwright install chromium
```

Then drive `npm run dev` and read the game through `window.megaTetris`, a
dev-only inspection hook that the production build folds away entirely. The
sweep this project uses covers: full games at level 1 and at head starts up to
level 10, both with hard drops and with gravity alone; rotation against both
walls, on the floor and in a one-column well; hold spam, pause spam, restart
mid-animation and hard drop into a game over; input hammered through the
line-clear pause; a direction held into a wall for seconds; resize and
orientation changes mid-game; backgrounding the tab; a full two-minute Ultra
run checked to stop on 120000 ms exactly with the last ten seconds lit; a
Sprint played to a did-not-finish; a daily attempt played out, refreshed
mid-run to prove the attempt survives it, copied to a real clipboard *and*
through the fallback with `navigator.clipboard` deleted; a full game played by
a placement bot, recorded, replayed in the page and checked cell-for-cell
against the live board; a share link built through the real button, opened in a
fresh browser context and watched back; and the same URL with a mangled,
truncated, oversized and non-base64url fragment, each of which has to produce a
sentence and an ordinary start screen; and a layout measurement at ten viewport
sizes checking for page scroll, overlapping bands and a playable cell size.

## Contributing

The one rule that matters: **keep the engine deterministic.**

`(seed, ordered list of calls) → state` must stay a pure function. In practice
that means, for anything you add under `src/engine/`:

1. **No ambient inputs.** No `Math.random`, no `Date.now`, no `performance.now`,
   no DOM. Randomness comes from the bag in the snapshot; time arrives as an
   explicit `deltaMs` argument. `purity.test.ts` enforces this, and it scans
   files it has never seen before.
2. **No mutation.** `update` and `applyInput` return a new snapshot and leave
   their input untouched. New state goes in `GameState` as plain data, so a
   snapshot stays comparable with `toEqual` and cloneable.
3. **New state must be part of the snapshot.** A module-level counter or a
   closure is invisible to a replay and will desynchronise it. If the rules need
   to remember something, it is a field.
4. **Slice time at deadlines.** If you add a timer, consume `deltaMs` in slices
   bounded by it, the way gravity, lock delay and the clear pause already do, so
   a 100 ms frame behaves exactly like six 16 ms ones.
5. **Say what happened, not how to show it.** New behaviour worth animating gets
   a new `GameEvent` in game terms. Durations, colours and sounds belong in
   `src/ui/`.
6. **If you change a rule, bump `REPLAY_FORMAT_VERSION`.** Gravity, scoring, the
   bag, the wall kicks, the lock delay, spawn positions, the mode rules — change
   any of them and every replay ever recorded decodes into a different run. The
   version in `src/engine/replay.ts` is what turns "this link is from an older
   game" into a clear message instead of a silent lie. It is the one place the
   determinism rule has an **external contract**: somebody may have sent that
   link to a friend last month. See
   [Replays and shared runs](#replays-and-shared-runs).

And in the other direction: **no game rules in `src/ui/`.** If you find yourself
writing a score, a level threshold or a board dimension there, import the
engine's constant instead — the help panel, the HUD and the stylesheet all get
theirs that way.

Before opening a change, run:

```bash
npm run lint && npm run typecheck && npm test && npm run coverage && npm run build
```

If you touched a colour or anything in `style.css`, `npm run a11y` is the one
that will tell you whether it still meets AA.

## Deployment

`.github/workflows/deploy.yml` publishes to GitHub Pages on every push to
`main`: `npm ci`, `npm test`, `npm run build`, then upload `dist/`. There is no
`gh-pages` branch — `dist/` stays gitignored.

The site is served from `/mega-tetris-test/`, which is why `base: './'` in
`vite.config.ts`, `start_url` and `scope` in the manifest, and every URL in the
service worker are all relative. It is one constraint answered four times, and
the way to check it is to serve the built `dist/` **under a path** rather than
at the root:

```bash
npm run build
mkdir -p /tmp/site/mega-tetris-test && cp -r dist/. /tmp/site/mega-tetris-test/
cd /tmp/site && python3 -m http.server 8099
# then open http://127.0.0.1:8099/mega-tetris-test/
```

Every deploy is picked up by an already-installed cabinet through the update
path above; nothing is ever stranded on an old build.

## Credits and licensing

Mega Tetris is an **original implementation**, written from scratch and
inspired by the falling-block puzzle genre. No code, artwork, sound, font or
level data is copied from any commercial implementation of the genre, and the
project contains **no third-party or copyrighted assets of any kind** — the
seven piece colours, all four cabinet palettes, the piece marks, the icon set and
every sound are its own, defined in CSS or generated — the favicon and the
installed app's icons are drawn as geometry in `build/icon.ts` and rasterised
at build time, so there is not one image file in the repository either. The rotation kick
tables are this project's own small ordered lists, not a reproduction of any
published system.

The only third-party code is the development toolchain — Vite, TypeScript,
Vitest, ESLint, axe-core and jsdom — none of which is shipped to a player.
