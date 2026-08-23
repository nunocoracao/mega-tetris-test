/**
 * Composition root.
 *
 * The engine is pure and knows nothing about the browser; the renderer paints
 * and knows nothing about the rules; the input layer reports intents and knows
 * nothing about either. This file is the one place they meet: it owns the
 * single mutable `state` reference, feeds real elapsed milliseconds into
 * `update`, turns key presses into engine inputs and repaints.
 *
 * Delight is wired here too, and the direction of the wiring matters. The
 * engine emits `GameEvent`s; `ui/effects.ts` and `ui/audio.ts` consume them.
 * Nothing flows back the other way, which is what keeps the rules
 * deterministic and the celebrations disposable.
 */

import './style.css';

import {
  GAME_MODES,
  applyInput,
  createGame,
  createRecorder,
  dailySeed,
  decodeShare,
  readShareFragment,
  update,
  type GameInput,
  type GameMode,
  type GameState,
  type ReplayLog,
} from './engine';
import { createGameAudio } from './ui/audio';
import {
  DAILY_MODE,
  DAILY_START_LEVEL,
  cellLabel,
  dailyButtonLabel,
  dailyRunNote,
  dailyStanding,
  dailyStatusLine,
  dailyStreakLine,
  hasPlayedOn,
  historyCells,
  shareText,
  streakOn,
} from './ui/daily';
import { createContrastPreference, setHighContrast } from './ui/contrast';
import { createCountdown } from './ui/countdown';
import { createModal } from './ui/dialog';
import { createEffects } from './ui/effects';
import {
  MENU_STATS,
  MODE_BLURBS,
  MODE_LABELS,
  createHud,
  describeEvent,
  describeRunEnd,
  menuStatValues,
  runUrgency,
} from './ui/hud';
import { createKeyboardInput, createLiveBindings, normalizeKey, type ActionId } from './ui/input';
import { createLoop } from './ui/loop';
import { REPLAY_SPEEDS, createReplayViewer, type ReplayRequest } from './ui/replay';
import { buildShareLink, runShareText } from './ui/share';
import { createMotionPreference } from './ui/motion';
import { refreshPalette, watchPalette } from './ui/palette';
import { createInstallPrompt, registerServiceWorker, syncThemeColor } from './ui/pwa';
import { createBoardRenderer, createPiecePanelRenderer } from './ui/renderer';
import { createSettingsPanel } from './ui/settings';
import { applyBindings, createShell } from './ui/shell';
import { clampStartLevel, type StatsUpdate } from './ui/stats';
import { createStore } from './ui/storage';
import { createHaptics, createTouchControls } from './ui/touch';

/** How many upcoming pieces the preview shows. */
const PREVIEW_COUNT = 3;

/**
 * A fresh seed per run. The engine forbids `Math.random` so that replays are
 * reproducible; picking the seed is the UI's job, and doing it here is what
 * keeps every visit to the page a different game.
 */
function newSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

/**
 * Today, as `YYYY-MM-DD` in UTC. **The only clock read in the program.**
 *
 * The engine may not read one at all, and `ui/daily.ts` takes the day as an
 * argument for the same reason: a date that arrives as a string is a date a
 * test can name. UTC rather than local time is what makes the daily challenge
 * *shared* — two players comparing scores are on the same day everywhere in the
 * world, at the cost of the day turning over at an odd hour for some of them,
 * which is the right way round for a puzzle nobody has to synchronise.
 *
 * Read once, at boot. A tab left open across midnight keeps the day it started
 * with until it is reloaded, which is far kinder than swapping the seed out
 * from under a run in progress.
 */
function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

const today = todayStamp();

/**
 * What kind of run is on the field.
 *
 * `daily` is today's one recorded attempt; `practice` is the same seed once the
 * attempt is spent, which is playable as often as you like and recorded nowhere.
 */
type RunKind = 'free' | 'daily' | 'practice';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) {
  throw new Error('Missing the #app mount point.');
}

// The stylesheet owns every colour; read it into the renderer once the sheet
// is applied, and again whenever a colour preference changes it underneath us.
refreshPalette();

const shell = createShell(root);
const hud = createHud(shell);

/**
 * Everything the cabinet remembers: the settings, and the personal bests.
 *
 * Built here and nowhere else. The modules that used to reach into
 * `localStorage` for one key each are handed the single setting they own, which
 * is what keeps the storage format in one file and testable.
 */
const store = createStore();

/**
 * The controls, as the player has them.
 *
 * `ui/input.ts` owns the default table and the rules; this is the live copy
 * every consumer reads — the keyboard per keypress, the auto-repeat clocks per
 * frame, and the three places that *print* the keys whenever it changes. There
 * is no second copy of the list anywhere, which is why rebinding "hard drop"
 * moves the help panel, the controls card and the pad's tooltip together.
 */
const bindings = createLiveBindings({
  keys: store.access('bindings'),
  handling: store.access('handling'),
});

/**
 * How much movement the player wants, from the operating system and from the
 * cabinet's own toggle. Both the canvas effects and the CSS transitions read
 * it — the canvas through `effects`, the stylesheet through the root
 * `data-motion` attribute this keeps in sync.
 */
const motion = createMotionPreference({
  storage: store.access('motion'),
  onChange: () => {
    applyMotion();
    // Turning motion off mid-burst should be immediate, not "once the shards
    // land". Everything in flight goes.
    effects.clear();
    draw();
  },
});

/**
 * How much contrast the player wants, from the operating system and from the
 * cabinet's own toggle. The stylesheet swaps to a brighter palette, and the
 * canvas thickens every block outline and stamps each piece kind with its own
 * mark — so two pieces are never told apart by colour alone.
 */
const contrast = createContrastPreference({
  storage: store.access('contrast'),
  onChange: () => {
    applyContrast();
    draw();
  },
});

const effects = createEffects({ reducedMotion: () => motion.reduced() });

const audio = createGameAudio({ storage: store.access('sound') });

const board = createBoardRenderer(shell.boardCanvas, {
  shake: (cell) => effects.shake(cell),
  cellSquash: (x, y) => effects.cellSquash(x, y),
  decorate: (ctx, view) => effects.render(ctx, view),
});
const next = createPiecePanelRenderer(shell.nextCanvas, {
  slots: PREVIEW_COUNT,
  emphasiseFirst: true,
});
const hold = createPiecePanelRenderer(shell.holdCanvas, { slots: 1 });

/**
 * Which run the player is on, and which one "play again" should deal.
 *
 * Resolved rather than remembered: a daily attempt whose run has ended is spent,
 * so the next press of the same button is a practice run on the same seed. The
 * attempt is spent by the *record*, not by this variable, which is what makes a
 * refresh mid-run free — nothing was written down.
 */
let runKind: RunKind = 'free';

function resolveRunKind(kind: RunKind): RunKind {
  if (kind === 'free') {
    return 'free';
  }
  return hasPlayedOn(store.daily(), today) ? 'practice' : 'daily';
}

/** The options a run of this kind is dealt with. */
function runOptions(kind: RunKind): { seed: number; startLevel: number; mode: GameMode } {
  if (kind === 'free') {
    return {
      seed: newSeed(),
      startLevel: store.get('startLevel'),
      mode: store.get('mode'),
    };
  }
  // Level 1, Marathon, and the day's own seed. The constraint is the whole
  // point: a score is only comparable if the run that produced it was.
  return { seed: dailySeed(today), startLevel: DAILY_START_LEVEL, mode: DAILY_MODE };
}

let state: GameState = createGame(runOptions('free'));

/**
 * The tape.
 *
 * An observer, and nothing more: it is handed the run clock and the input by
 * the two lines below that were about to apply them, and it hands nothing back.
 * There is no path from the recorder into the engine — no wrapped `update`, no
 * adjusted delta — which is what makes "recording does not change the game" a
 * fact about the shape of the code rather than a promise.
 *
 * `engine/replay.test.ts` proves it anyway, by playing the same script twice.
 */
const recorder = createRecorder();

/** A finished run, ready to be watched or handed to somebody. */
interface RecordedRun {
  readonly seed: number;
  readonly startLevel: number;
  readonly mode: GameMode;
  readonly log: ReplayLog;
}

/**
 * The run that just ended, on tape, or `null` when there is nothing to watch —
 * before the first game over, after a restart, or when the run was so long the
 * recorder hit its cap and stopped.
 */
let lastRun: RecordedRun | null = null;

/**
 * What the last run did to the personal bests, or `null` before the first game
 * over of this visit. The game-over panel is written from it.
 */
let lastResult: StatsUpdate | null = null;

/**
 * The daily footnote for the run that just ended, or `null` after an ordinary
 * one. `ui/daily.ts` writes the words; the HUD only puts them on the panel.
 */
let dailyNote: string | null = null;

/**
 * The replay viewer.
 *
 * It owns a `ReplayPlayer` and a speed and nothing else; the engine steps the
 * run, the renderer paints it, and this file moves text into elements. That
 * division is the whole reason a replay was a day's work rather than a rewrite:
 * `(seed, ordered list of calls) -> state` was already true, and a `GameState`
 * was already the only thing the renderer knew how to draw.
 *
 * Declared up here with the rest of the mutable state because `draw` reads it,
 * and `draw` runs long before the block of listeners further down.
 */
const replayViewer = createReplayViewer();

/**
 * A note on the start screen: a link that did not work, or one that did.
 *
 * The live region says it too, but an announcement is not a message — somebody
 * who clicked a friend's link and got a start screen deserves a sentence they
 * can actually read about why.
 */
let startNotice: string | null = null;

/**
 * Set when a run has just ended, so the loop can put focus on "Play again" as
 * soon as the panel is in the DOM. Focus cannot move to it from inside
 * `setState`: the overlay is still hidden until the next `draw`.
 */
let focusPlayAgain = false;

function draw(): void {
  // A replay is an ordinary snapshot going through the ordinary renderer: the
  // *only* difference here is which snapshot. That is the dividend of having
  // made the renderer a pure painter — there is no replay code in it at all.
  const replaying = replayViewer.active();
  const shown = replayViewer.state() ?? state;

  // The attract screen's drifting pieces belong to the one state that has no
  // game going on behind the panel — and a replay is not that state.
  effects.setAttract(!replaying && state.status === 'ready');
  board.render(shown);
  next.render({ kinds: shown.next.slice(0, PREVIEW_COUNT) });
  hold.render({ kinds: [shown.hold], dimmed: shown.holdLocked });
  // The overlay doubles as the help text, so it needs to know which controls
  // the player actually has in front of them.
  hud.render(shown, {
    touch: touch.touchLikely(),
    score: effects.displayScore(),
    countdown: countdown.digit(),
    stats: store.stats(),
    result: lastResult,
    startLevel: store.get('startLevel'),
    dailyNote,
    notice: startNotice,
    canReplay: lastRun !== null,
    replay: replaying,
    // A dialog is the conversation while it is open; two "Paused" panels
    // stacked on top of each other is one too many. A replay owns the well
    // outright, and the bar under it is that conversation.
    suppressOverlay: replaying || menusOpen(),
  });

  if (replaying) {
    renderReplayBar();
    // The footer's primary button belongs to the live game, and during a replay
    // there is not one. Saying what it now does beats leaving it saying "Pause".
    shell.playButton.textContent = 'Leave replay';
  }
}

/**
 * Put a brand-new game on the field and start a fresh tape.
 *
 * Every path that deals a different game goes through here — the restart
 * button, the mode picker, the level picker — because a tape that survived a
 * re-deal would be a recording of one run played against the seed of another.
 */
function dealGame(next: GameState): void {
  recorder.reset();
  lastRun = null;
  // Whatever the start screen was explaining is answered by a new game.
  startNotice = null;
  hideShareFallback();
  setState(next);
}

/** Take the new snapshot and say anything worth saying about how we got here. */
function setState(nextState: GameState): void {
  const previous = state;
  state = nextState;
  if (state.events.length === 0) {
    return;
  }

  // The board as it was before these events is the only place the colours of
  // an already-collapsed row still exist, so the effects layer gets it too.
  effects.observe(state.events, previous.board);

  // A hard drop is its own slam; letting the lock cue play underneath it just
  // muddies the landing.
  const slammed = state.events.some((event) => event.type === 'hardDrop');

  for (const event of state.events) {
    // Two events are worth feeling as well as seeing. Everything else would be
    // noise in the hand, so the phone stays still for it.
    if (event.type === 'lock') {
      haptics.lock();
      if (!slammed) {
        audio.play('lock');
      }
    } else if (event.type === 'rowsCleared') {
      haptics.clear();
      // The combo step is what pitches the cue up; the engine counts it.
      audio.play('clear', event.count, event.combo);
    } else if (event.type === 'spin') {
      // A spin that goes on to clear gets the clear's cue; the twist would only
      // muddy the front of it.
      if (event.cleared === 0) {
        audio.play('spin');
      }
    } else if (event.type === 'hardDrop') {
      audio.play('hardDrop');
    } else if (event.type === 'levelUp') {
      audio.play('levelUp');
    } else if (event.type === 'runEnd') {
      // Reaching a finish line and falling over are not the same news, and the
      // cabinet should not use the same three notes for both.
      audio.play(event.outcome === 'toppedOut' ? 'gameOver' : 'finish');
      // The one moment the stats change. Recording it here — rather than from
      // the panel that shows it — means a run counts even if the player closes
      // the tab before the panel finishes fading in.
      lastResult = store.recordRun({
        mode: event.mode,
        outcome: event.outcome,
        score: event.score,
        lines: event.lines,
        level: event.level,
        startLevel: state.startLevel,
        durationMs: event.durationMs,
      });
      // And the one moment the day's attempt is spent — at the *end* of the
      // run, never at the start of it, so a refresh, a crash or a closed laptop
      // mid-game costs the player nothing.
      recordDailyRun(event.score, event.lines, event.level, event.durationMs);
      // The tape, sealed. A truncated one is deliberately *not* offered: it is
      // a correct prefix of the run rather than the whole of it, and a "watch
      // replay" that stopped forty seconds early would be worse than no button.
      recorder.mark(state.elapsedMs);
      lastRun = recorder.truncated()
        ? null
        : {
            seed: state.seed,
            startLevel: state.startLevel,
            mode: state.mode,
            log: recorder.log(),
          };
      focusPlayAgain = true;
    } else if (event.type === 'hold') {
      audio.play('rotate');
    }

    // The end of a run is the one event whose sentence depends on more than
    // the event: "game over" plus what it did to the bests.
    const message =
      event.type === 'runEnd' && lastResult !== null
        ? describeRunEnd(lastResult)
        : describeEvent(event);
    if (message !== null) {
      hud.announce(message);
    }
  }
}

function send(input: GameInput): void {
  // Before, not after: the log records the clock as it stood when the player
  // pressed the key, which is the moment a replay has to press it again.
  recorder.record(state.elapsedMs, input.type);
  setState(applyInput(state, input));
}

/**
 * Abandon this run and deal a brand-new one, already in play.
 *
 * This is the whole of "play again": a new snapshot, a repaint, and the
 * keyboard back on the well. No reload, no rebuilt DOM, nothing to wait for —
 * which is what makes the loop worth closing.
 */
function startFreshGame(): void {
  effects.clear();
  countdown.cancel();
  // A replay is a thing you are watching, not a thing you are playing; dealing
  // a game is the clearest possible statement that you are done watching.
  leaveReplay(false);
  // A restart is not a resume: whatever menu asked for it should close without
  // counting the player back into a game that no longer exists.
  closeMenus();
  lastResult = null;
  dailyNote = null;
  focusPlayAgain = false;
  urgencyStep = null;
  // A daily run that is restarted — by the button, by R, or by finishing and
  // playing again — stays on the day's seed, and becomes a practice run once
  // the attempt has been spent. Free play deals a brand-new sequence.
  runKind = resolveRunKind(runKind);
  dealGame(createGame(runOptions(runKind)));
  send({ type: 'resume' });
  draw();
  shell.playfield.focus();
}

/**
 * Blip for the three actions the engine does not report.
 *
 * Moves and rotations produce no events — they are not things that *happened*
 * to the game, just the piece being where the player put it. Comparing the
 * snapshots is how we tell a real move from one the wall refused, so a piece
 * held against the left edge stays silent instead of machine-gunning.
 */
function soundForAction(action: ActionId, before: GameState, after: GameState): void {
  const was = before.active;
  const now = after.active;
  if (was === null || now === null) {
    return;
  }
  switch (action) {
    case 'moveLeft':
    case 'moveRight':
      if (now.x !== was.x) {
        audio.play('move');
      }
      break;
    case 'rotateCW':
    case 'rotateCCW':
      if (now.rotation !== was.rotation) {
        audio.play('rotate');
      }
      break;
    case 'softDrop':
      if (now.y !== was.y) {
        audio.play('softDrop');
      }
      break;
    default:
      break;
  }
}

/**
 * Resolve the intents the keyboard deliberately leaves open, and pass the rest
 * straight through. Whether "pause" means pause or resume depends on the
 * status, a restart after a game over should deal a new sequence rather than
 * replay the old seed, and "help" is not a game input at all — all three are
 * UI policy, not game rules.
 */
function dispatch(action: ActionId): void {
  // While a dialog owns the screen, the game behind it is `inert` and the
  // keyboard layer treats every key inside a dialog as the dialog's. This is
  // the belt to those braces rather than the only guard.
  if (menusOpen()) {
    return;
  }

  // A replay is watched, not played. The four keys that still mean something
  // are the four a video player would have: Escape (and P) leave, Space is
  // play/pause, R starts it over, and help is help. Everything else — every
  // move, turn and drop — is deliberately swallowed, because pressing left
  // during a recording of somebody else's game should do nothing at all.
  if (replayViewer.active()) {
    switch (action) {
      case 'togglePause':
        leaveReplay(true);
        break;
      case 'hardDrop':
        replayViewer.togglePlay();
        draw();
        break;
      case 'restart':
        replayViewer.restart();
        draw();
        break;
      case 'help':
        toggleHelp();
        break;
      default:
        break;
    }
    return;
  }

  // A finished run is a one-key affair: the two keys that mean "go" both mean
  // "play again", so nobody has to find the button to get back in.
  if (state.status === 'over' && (action === 'hardDrop' || action === 'restart')) {
    startFreshGame();
    return;
  }

  const before = state;
  switch (action) {
    case 'togglePause':
      togglePause();
      break;
    case 'restart':
      startFreshGame();
      break;
    case 'help':
      toggleHelp();
      break;
    default:
      send({ type: action });
      break;
  }
  soundForAction(action, before, state);
  draw();
}

const input = createKeyboardInput({
  onAction: dispatch,
  bindings: () => bindings.table(),
  handling: () => bindings.handling(),
});

const haptics = createHaptics();

/**
 * Touch is a second input path, not a second game: gestures and pad buttons
 * arrive as the same `ActionId`s the keyboard produces and go through the same
 * `dispatch`, so there is exactly one place that turns an intent into a move.
 */
const touch = createTouchControls({
  surface: shell.playfield,
  boardCanvas: shell.boardCanvas,
  pad: shell.touchPad,
  padToggle: shell.padToggle,
  // The one setting `touch.ts` owns. Without this it cycles happily and forgets
  // the answer on reload, which is the worst of both.
  storage: store.access('pad'),
  // The same clock the keyboard reads, so a held ◀ and a held arrow key feel
  // identical — including after the DAS slider has moved.
  handling: () => bindings.handling(),
  onAction: dispatch,
  onPreferenceChange(preference, visible) {
    hud.announce(
      `On-screen controls ${preference === 'auto' ? 'set to automatic' : preference}, currently ${visible ? 'shown' : 'hidden'}.`,
    );
    draw();
  },
});

// -- dialogs, and the way back into the game --------------------------------

/**
 * Three, two, one.
 *
 * A pause menu that drops the player straight back onto a falling piece is a
 * pause menu that costs them the run. The count is driven by the loop's real
 * delta rather than a timer, so it stops with the tab and cannot get ahead of
 * the frame it is drawn on.
 */
const countdown = createCountdown({
  onFinish() {
    send({ type: 'resume' });
    draw();
    shell.playfield.focus();
  },
});

/**
 * Set while a menu is closing for a reason that is *not* "carry on playing" —
 * a restart, or stepping sideways into the help panel. Without it, every close
 * would start a countdown into a game the player did not ask to resume.
 */
let resumeOnMenuClose = true;

/** Run after the help panel closes: how it hands control back to the pause menu. */
let afterHelp: (() => void) | null = null;

/** Run after the settings dialog closes: how it hands control back. */
let afterSettings: (() => void) | null = null;

const pauseMenu = createModal({
  element: shell.pauseDialog,
  background: [...shell.background, shell.helpDialog, shell.settingsDialog],
  initialFocus: () => shell.pauseResume,
  // Repaint on both edges: opening hides the overlay behind the dialog, and
  // closing brings back whatever the status now calls for.
  onOpen() {
    renderMenuStats();
    // A confirmation left standing from last time is a confirmation nobody
    // asked for. The menu always opens in its resting state.
    showResetConfirm(false);
    draw();
  },
  onClose() {
    if (resumeOnMenuClose && state.status === 'paused') {
      countdown.start();
    }
    resumeOnMenuClose = true;
    draw();
  },
});

const helpPanel = createModal({
  element: shell.helpDialog,
  background: [...shell.background, shell.pauseDialog, shell.settingsDialog],
  initialFocus: () => shell.helpPanel,
  onOpen() {
    store.set('seenHelp', true);
    draw();
  },
  onClose() {
    const next = afterHelp;
    afterHelp = null;
    next?.();
    draw();
  },
});

/**
 * The settings dialog: the four cabinet preferences, the handling sliders and
 * the key remapper, in the same modal machinery as the other two.
 *
 * It is a dialog and not a screen, which is the whole point — the run behind it
 * is exactly where it was left, and a player can nudge DAS mid-game and carry
 * on with the same piece still falling.
 */
const settingsMenu = createModal({
  element: shell.settingsDialog,
  background: [...shell.background, shell.pauseDialog, shell.helpDialog],
  initialFocus: () => shell.settings.panel,
  onOpen() {
    settingsPanel.reset();
    draw();
  },
  onClose() {
    // A capture left running would go on eating keys with nothing to put them
    // in. It ends with the dialog, whichever way the dialog ended.
    settingsPanel.cancelCapture();
    const next = afterSettings;
    afterSettings = null;
    next?.();
    draw();
  },
});

const settingsPanel = createSettingsPanel({
  elements: shell.settings,
  bindings,
  // Every control writes through the accessor the live module already owns, so
  // this dialog and the pause menu's quick toggles are two views of one answer.
  sound: {
    read: () => !audio.muted(),
    write: (on) => {
      audio.setSound(on);
      applySound();
    },
  },
  motion: {
    read: () => motion.setting(),
    write: (setting) => {
      motion.set(setting);
      applyMotion();
      effects.clear();
      draw();
    },
  },
  contrast: {
    read: () => contrast.setting(),
    write: (setting) => {
      contrast.set(setting);
      applyContrast();
      draw();
    },
  },
  pad: {
    read: () => touch.preference(),
    write: (preference) => touch.setPreference(preference),
  },
  announce: (message) => hud.announce(message),
  refresh: () => settingsMenu.refresh(),
  resetAll: resetAllSettings,
});

function menusOpen(): boolean {
  return pauseMenu.isOpen() || helpPanel.isOpen() || settingsMenu.isOpen();
}

function closeMenus(): void {
  resumeOnMenuClose = false;
  afterHelp = null;
  afterSettings = null;
  settingsMenu.close();
  helpPanel.close();
  pauseMenu.close();
  resumeOnMenuClose = true;
}

/** Pause and show the menu, or close it and count the player back in. */
function togglePause(): void {
  if (state.status === 'playing') {
    send({ type: 'pause' });
    pauseMenu.open();
    return;
  }
  if (state.status === 'paused') {
    if (countdown.active()) {
      // Second thoughts during the count: stop it and put the menu back.
      countdown.cancel();
      pauseMenu.open();
      return;
    }
    countdown.start();
    return;
  }
  // 'ready' starts the first game with no ceremony; 'over' has nothing to
  // resume, and the engine ignores the input.
  send({ type: 'resume' });
}

function toggleHelp(): void {
  if (helpPanel.isOpen()) {
    helpPanel.close();
  } else {
    helpPanel.open();
  }
}

shell.helpButton.addEventListener('click', () => helpPanel.open());
shell.helpClose.addEventListener('click', () => helpPanel.close());
shell.helpDone.addEventListener('click', () => helpPanel.close());

shell.settingsButton.addEventListener('click', () => settingsMenu.open());
shell.overlaySettings.addEventListener('click', () => settingsMenu.open());
shell.settings.close.addEventListener('click', () => settingsMenu.close());
shell.settings.done.addEventListener('click', () => settingsMenu.close());

shell.pauseSettings.addEventListener('click', () => {
  // Step sideways rather than stacking one modal on another, exactly as the
  // pause menu's Help button does: the menu steps out, settings takes over,
  // and the menu comes back when it is done.
  resumeOnMenuClose = false;
  pauseMenu.close();
  afterSettings = () => pauseMenu.open();
  settingsMenu.open();
});

/**
 * Put every setting back to the way it shipped.
 *
 * The store is the source of truth, so it is reset first and the live modules
 * are then told what it now says — rather than each of them being reset on its
 * own and the store left to catch up. The record book is deliberately not
 * touched: that is the *other* reset, in the pause menu.
 */
function resetAllSettings(): void {
  const defaults = store.resetSettings();
  audio.setSound(defaults.sound);
  motion.set(defaults.motion);
  contrast.set(defaults.contrast);
  touch.setPreference(defaults.pad);
  bindings.setKeyMap(defaults.bindings);
  bindings.setHandling(defaults.handling);
  applySound();
  applyMotion();
  applyContrast();
  effects.clear();
  // The start screen's two pickers are settings as well, and both are markup
  // that has to be told what the store now says.
  shell.startLevel.value = String(defaults.startLevel);
  applyMode();
  if (state.status === 'ready') {
    dealGame(createGame({ seed: state.seed, startLevel: defaults.startLevel, mode: defaults.mode }));
  }
  draw();
}

// -- personal bests, and erasing them ---------------------------------------

/** Fill the pause menu's list from the store. Cheap, and only on open. */
function renderMenuStats(): void {
  const values = menuStatValues(store.stats());
  for (const { key } of MENU_STATS) {
    const row = shell.menuStats.querySelector<HTMLElement>(`[data-stat-row="${key}"]`);
    const cell = shell.menuStats.querySelector<HTMLElement>(`[data-stat="${key}"]`);
    if (row === null || cell === null) {
      continue;
    }
    const value = values[key];
    row.hidden = value === null;
    if (value !== null) {
      cell.textContent = value;
    }
  }
}

/**
 * Swap between "Reset stats…" and the confirmation that actually does it.
 *
 * Focus follows the swap in both directions, so the keyboard never lands on a
 * control that has just disappeared — and it lands on *Keep them*, because the
 * safe answer should be the one a stray Enter picks.
 */
function showResetConfirm(show: boolean): void {
  const changed = shell.statsConfirm.hidden === show;
  shell.statsConfirm.hidden = !show;
  shell.statsReset.hidden = show;
  pauseMenu.refresh();
  if (!changed) {
    return;
  }
  if (show) {
    shell.statsConfirmNo.focus();
  } else if (pauseMenu.isOpen()) {
    shell.statsReset.focus();
  }
}

shell.statsReset.addEventListener('click', () => showResetConfirm(true));
shell.statsConfirmNo.addEventListener('click', () => showResetConfirm(false));
shell.statsConfirmYes.addEventListener('click', () => {
  store.resetStats();
  // The panel behind the menu is written from the last run, and that run's
  // comparison is now against nothing.
  lastResult = null;
  dailyNote = null;
  renderMenuStats();
  renderDaily();
  showResetConfirm(false);
  hud.announce('Personal bests, totals and daily results erased.');
  draw();
});

// -- the daily challenge ----------------------------------------------------

/**
 * The whole of the daily challenge's browser half.
 *
 * The rules and the words are in `ui/daily.ts`, the seed is in the engine, and
 * the history is in the store; what is left here is what is always left here —
 * reading the clock once, moving text into elements, and deciding policy the
 * other layers deliberately do not have an opinion about.
 */
function renderDaily(): void {
  const daily = store.daily();
  setDailyText(shell.dailyStatus, dailyStatusLine(daily, today));
  setDailyText(shell.dailyStreak, dailyStreakLine(daily, today));
  shell.dailyPlay.textContent = dailyButtonLabel(daily, today);

  const cells = historyCells(daily, today);
  for (const [index, cell] of cells.entries()) {
    const node = shell.dailyCells[index];
    if (node === undefined) {
      continue;
    }
    const label = cellLabel(cell);
    // Two descriptions of the same cell, on purpose: the title is the tooltip a
    // mouse gets, and the hidden span is what a screen reader reads. Neither is
    // a colour, which is the requirement the tint alone could never meet.
    node.title = label;
    const text = node.querySelector<HTMLElement>('[data-daily-cell-text]');
    if (text !== null) {
      text.textContent = label;
    }
    node.dataset['played'] = cell.played ? 'yes' : 'no';
    node.dataset['tier'] = String(cell.tier);
    node.dataset['today'] = cell.isToday ? 'yes' : 'no';
  }

  // Nothing to copy until there is a result to copy.
  shell.dailyCopy.hidden = !hasPlayedOn(daily, today);
}

function setDailyText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

/** Put the clipboard fallbacks away. Called whenever the panel changes meaning. */
function hideShareFallback(): void {
  shell.dailyFallback.hidden = true;
  shell.shareFallback.hidden = true;
}

/**
 * Spend the day's attempt, and write the footnote the panel will show.
 *
 * A practice run reaches here too and is deliberately recorded nowhere: it only
 * earns the sentence that says so, because a panel that looked identical either
 * way would make every daily score suspect.
 */
function recordDailyRun(score: number, lines: number, level: number, durationMs: number): void {
  if (runKind === 'free') {
    dailyNote = null;
    return;
  }
  if (runKind === 'practice') {
    dailyNote = dailyRunNote({ date: today, practice: true });
    return;
  }
  const daily = store.recordDaily({ date: today, score, lines, level, durationMs });
  dailyNote = dailyRunNote({
    date: today,
    practice: false,
    standing: dailyStanding(daily, today),
    streak: streakOn(daily, today),
  });
  renderDaily();
}

/** Start today's daily — or a practice run on the same seed, if it is spent. */
function startDailyRun(): void {
  const practice = hasPlayedOn(store.daily(), today);
  runKind = 'daily';
  startFreshGame();
  hud.announce(
    practice
      ? `Practice run on the ${today} seed. It is not recorded.`
      : `Daily challenge for ${today}. One attempt, Marathon, level 1.`,
  );
}

shell.dailyPlay.addEventListener('click', startDailyRun);

/**
 * Copy the day's result, with a way out when the clipboard says no.
 *
 * `navigator.clipboard` is missing entirely over plain HTTP and in a few
 * embedded browsers, and `writeText` rejects when the permission is denied or
 * the click did not look like a gesture — so the failure path is not exotic,
 * it is Tuesday. When it fails the same text appears in a labelled, read-only
 * field with its contents selected, which is one keystroke from the clipboard
 * and works everywhere.
 */
shell.dailyCopy.addEventListener('click', () => {
  const daily = store.daily();
  const entry = daily.history.find((item) => item.date === today);
  if (entry === undefined) {
    return;
  }
  const text = shareText({
    date: today,
    score: entry.score,
    lines: entry.lines,
    streak: streakOn(daily, today),
    url: shareUrl(),
  });

  // Typed as always present, and absent in real browsers over plain HTTP.
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) {
    offerDailyCopy(text);
    return;
  }
  void clipboard.writeText(text).then(
    () => {
      hideShareFallback();
      hud.announce('Result copied to the clipboard.');
    },
    () => {
      offerDailyCopy(text);
    },
  );
});

/** The page's own address, without whatever query or hash it was opened with. */
function shareUrl(): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}`;
}

/**
 * The daily result's own fallback box, which lives inside the daily block
 * rather than under the panel's buttons — it belongs to that section, and the
 * section is hidden on every run that was not a daily one.
 */
function offerDailyCopy(text: string): void {
  shell.dailyShare.value = text;
  shell.dailyFallback.hidden = false;
  shell.dailyShare.focus();
  shell.dailyShare.select();
  hud.announce('Clipboard unavailable. The result is in the box below, ready to copy.');
}

// -- watching a run back ----------------------------------------------------

/** Write `text` into `element` only when it differs from what is there. */
function setBarText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

/** Push the viewer's caption into the bar. Called from `draw`, so per frame. */
function renderReplayBar(): void {
  const caption = replayViewer.caption();
  if (caption === null) {
    return;
  }
  setBarText(shell.replayTitle, caption.title);
  setBarText(shell.replayDetail, caption.detail);
  setBarText(shell.replayProgress, caption.progress);
  setBarText(shell.replayPlay, caption.playLabel);
  const width = `${(caption.fraction * 100).toFixed(2)}%`;
  if (shell.replayFill.style.width !== width) {
    shell.replayFill.style.width = width;
  }
  const speed = replayViewer.speed();
  for (const [index, button] of shell.replaySpeeds.entries()) {
    const pressed = String(REPLAY_SPEEDS[index] === speed);
    if (button.getAttribute('aria-pressed') !== pressed) {
      button.setAttribute('aria-pressed', pressed);
    }
  }
}

/**
 * Start watching a run.
 *
 * The three tells that this is not a live game all go on here: the root's
 * `data-replay` (which tints the field frame), the badge in the corner, and the
 * playfield's own accessible name. None of them is only a colour, and the last
 * one is the one that matters most.
 */
function openReplay(request: ReplayRequest): void {
  effects.clear();
  countdown.cancel();
  closeMenus();
  hideShareFallback();
  // Keys held down when the replay opened belong to the game that has just
  // stopped being on screen.
  input.releaseAll();
  touch.releaseAll();

  replayViewer.open(request);
  document.documentElement.dataset['replay'] = 'on';
  shell.replayBadge.hidden = false;
  shell.replayBar.hidden = false;
  shell.playfield.setAttribute('aria-label', 'Replay playfield');
  draw();
  shell.replayPlay.focus();

  const caption = replayViewer.caption();
  if (caption !== null) {
    hud.announce(caption.announcement);
  }
}

/** Stop watching, and put the cabinet back the way it was. */
function leaveReplay(focusWell: boolean): void {
  if (!replayViewer.active()) {
    return;
  }
  const shared = replayViewer.origin() === 'link';
  replayViewer.close();
  delete document.documentElement.dataset['replay'];
  shell.replayBadge.hidden = true;
  shell.replayBar.hidden = true;
  shell.playfield.setAttribute('aria-label', 'Playfield');
  effects.clear();
  // The address bar goes back to the plain page: a fragment left behind would
  // replay the same run on every reload, which is not what "play" should mean.
  clearShareFragment();
  if (shared) {
    startNotice = 'That was somebody else’s run. Press Play for one of your own.';
  }
  draw();
  if (focusWell) {
    shell.playfield.focus();
    hud.announce('Left the replay.');
  }
}

/** Take the replay out of the address bar, if the browser will let us. */
function clearShareFragment(): void {
  if (window.location.hash === '') {
    return;
  }
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  } catch {
    // Some embedded browsers refuse `replaceState`. A stale fragment is a
    // cosmetic problem; a thrown exception on the way out of a replay is not.
  }
}

shell.overlayReplay.addEventListener('click', () => {
  if (lastRun === null) {
    return;
  }
  openReplay({ ...lastRun, origin: 'own' });
});

shell.replayPlay.addEventListener('click', () => {
  replayViewer.togglePlay();
  draw();
});

shell.replayRestart.addEventListener('click', () => {
  replayViewer.restart();
  draw();
});

shell.replayExit.addEventListener('click', () => leaveReplay(true));

for (const [index, button] of shell.replaySpeeds.entries()) {
  const speed = REPLAY_SPEEDS[index];
  if (speed === undefined) {
    continue;
  }
  button.addEventListener('click', () => {
    replayViewer.setSpeed(speed);
    draw();
    hud.announce(`Replay speed ${speed} times.`);
  });
}

// -- handing a run to somebody ----------------------------------------------

/**
 * Put the whole run in a link.
 *
 * The run goes in the **fragment**, which is the half of a URL a browser never
 * sends to a server — and there is no server. Encoding is asynchronous because
 * `CompressionStream` is; the button is disabled for the handful of
 * milliseconds it takes, so a double click cannot produce two links.
 *
 * A run too long to fit gets an honest sentence and the score-only line from
 * the daily challenge instead. A link that arrives cut in half by a chat client
 * would be worse than no link at all, and quietly producing one is exactly the
 * kind of thing a player only discovers when a friend tells them it did not
 * work.
 */
shell.overlayShare.addEventListener('click', () => {
  const run = lastRun;
  if (run === null) {
    return;
  }
  shell.overlayShare.disabled = true;
  void buildShareLink(shareUrl(), {
    mode: run.mode,
    seed: run.seed,
    startLevel: run.startLevel,
    log: run.log,
  })
    .then((link) => {
      if (link.ok) {
        copyToClipboard(link.url, 'Replay link copied to the clipboard.');
        return;
      }
      const fallback = runShareText({
        mode: state.mode,
        score: state.score,
        lines: state.lines,
        level: state.level,
        durationMs: state.elapsedMs,
        url: shareUrl(),
      });
      offerManualCopy(
        fallback,
        'That run is too long to fit in a link. Here is the score instead, ready to copy.',
      );
    })
    .catch(() => {
      hud.announce('The replay link could not be made.');
    })
    .finally(() => {
      shell.overlayShare.disabled = false;
    });
});

/**
 * Copy some text, with a way out when the clipboard says no.
 *
 * The same reasoning as the daily challenge's copy button, and now the same
 * code: `navigator.clipboard` is missing entirely over plain HTTP and rejects
 * when the permission is denied or the click did not look like a gesture, so
 * the failure path is Tuesday rather than an exotic case.
 */
function copyToClipboard(text: string, success: string): void {
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) {
    offerManualCopy(text, 'Clipboard unavailable. The link is in the box below, ready to copy.');
    return;
  }
  void clipboard.writeText(text).then(
    () => {
      hideShareFallback();
      hud.announce(success);
    },
    () => {
      offerManualCopy(text, 'Clipboard unavailable. The link is in the box below, ready to copy.');
    },
  );
}

function offerManualCopy(text: string, message: string): void {
  shell.shareText.value = text;
  shell.shareFallback.hidden = false;
  shell.shareText.focus();
  shell.shareText.select();
  hud.announce(message);
}

/**
 * A run somebody sent us.
 *
 * The fragment is a stranger's input and is treated like one: `decodeShare` is
 * total, so the worst a hostile, truncated or simply ancient link can do is
 * produce a sentence and an ordinary start screen. Nothing here can throw and
 * nothing here allocates on the strength of a number it read out of the URL —
 * see `engine/share.ts`, which is where all of that is enforced and tested.
 */
function openSharedRun(): boolean {
  const fragment = readShareFragment(window.location.hash);
  if (fragment === null) {
    return false;
  }
  const result = decodeShare(fragment);
  if (!result.ok) {
    clearShareFragment();
    startNotice = result.message;
    hud.announce(`${result.message} Starting a new game instead.`);
    draw();
    return false;
  }
  openReplay({
    seed: result.run.seed,
    startLevel: result.run.startLevel,
    mode: result.run.mode,
    log: result.run.log,
    origin: 'link',
  });
  return true;
}

shell.pauseResume.addEventListener('click', () => pauseMenu.close());
shell.pauseClose.addEventListener('click', () => pauseMenu.close());
shell.pauseRestart.addEventListener('click', startFreshGame);
shell.pauseHelp.addEventListener('click', () => {
  // Step sideways rather than stacking one modal on another: the pause menu
  // steps out, help takes over, and the pause menu comes back when it is done.
  resumeOnMenuClose = false;
  pauseMenu.close();
  afterHelp = () => pauseMenu.open();
  helpPanel.open();
});

/**
 * The step of the countdown the cabinet has already blipped for.
 *
 * The last ten seconds of an Ultra and the last few lines of a Sprint each want
 * one cue *per step*, not one per frame — so the step the engine is on is
 * compared with the last one that made a noise, and only a change is audible.
 * The visible half of the same tell is a class on the readout, which the HUD
 * puts there from the same `runUrgency` call.
 */
let urgencyStep: number | null = null;

/** Blip once each time the finish line gets one step closer. */
function soundForUrgency(): void {
  const { urgent, step } = runUrgency(state);
  if (!urgent || step === null) {
    urgencyStep = null;
    return;
  }
  if (step !== urgencyStep) {
    urgencyStep = step;
    audio.play('tick');
  }
}

const loop = createLoop({
  onFrame(deltaMs) {
    // The try-it strip is the one thing inside a dialog that has to keep
    // ticking, and it ticks before every other branch — it is the handling
    // sliders' output, and a block that only moved on a repaint would be
    // showing the frame rate rather than the setting.
    if (settingsMenu.isOpen()) {
      settingsPanel.update(deltaMs);
    }

    // A replay owns the frame outright: no input, no countdown, and above all
    // no `update` on the live game — the run behind the viewer is exactly where
    // the player left it, and watching a recording must not cost them a piece.
    if (replayViewer.active()) {
      const previousBoard = replayViewer.previousBoard();
      replayViewer.update(deltaMs);
      const shown = replayViewer.state();
      if (shown !== null && previousBoard !== null) {
        // The same events, through the same effects layer. A replay gets its
        // line-clear bursts for free; it deliberately gets no *sound*, because
        // four minutes of cues at 4x is not a celebration, it is a fire alarm.
        effects.observe(replayViewer.events(), previousBoard);
        effects.update(deltaMs, shown.score);
      }
      draw();
      return;
    }

    input.update(deltaMs);
    touch.update(deltaMs);
    countdown.update(deltaMs);
    setState(update(state, deltaMs));
    // One number, once a frame, after the fact. The recorder cannot change what
    // the engine just did because it runs after the engine has done it.
    recorder.mark(state.elapsedMs);
    soundForUrgency();
    // After the state, so the score count-up is always chasing a current
    // target, and with the same delta the engine got.
    effects.update(deltaMs, state.score);
    draw();
    // Only now is the panel showing, and so focusable. The flag survives frames
    // rather than being spent on the first one, because a run can end with the
    // help panel open — and taking focus out of a dialog would be worse than
    // waiting for it. The stylesheet fades the panel in behind the field sweep;
    // the focus ring arrives with it.
    if (focusPlayAgain && !menusOpen()) {
      focusPlayAgain = false;
      shell.overlayButton.focus();
    }
  },
});

/** The play/pause button and the overlay button both mean "carry on". */
function primaryAction(): void {
  if (replayViewer.active()) {
    leaveReplay(true);
    return;
  }
  if (state.status === 'over') {
    startFreshGame();
    return;
  }
  dispatch('togglePause');
  // Unless that opened the pause menu — which now owns focus, and must keep it.
  if (!menusOpen()) {
    shell.playfield.focus();
  }
}

// -- settings ---------------------------------------------------------------

/** Publish the motion decision to the stylesheet, which gates its own fades. */
function applyMotion(): void {
  document.documentElement.dataset['motion'] = motion.reduced() ? 'reduced' : 'full';
  shell.motionToggle.textContent = `Effects: ${motion.label()}`;
  shell.motionToggle.title =
    motion.setting() === 'auto'
      ? 'Animations follow your system’s reduced-motion setting. Tap to override.'
      : `Animations forced ${motion.label().toLowerCase()}. Tap to change.`;
}

function applySound(): void {
  shell.soundToggle.textContent = `Sound: ${audio.muted() ? 'Off' : 'On'}`;
  shell.soundToggle.title = audio.muted() ? 'Sound is off. Tap to turn it on.' : 'Sound is on. Tap to mute.';
}

/**
 * Publish the contrast decision to the stylesheet *and* to the canvas.
 *
 * Order matters: the root attribute is what swaps the CSS palette, so the
 * custom properties have to be re-read afterwards or the blocks would keep
 * painting in the old colours.
 *
 * The status bar goes with them. Installed, `theme-color` is the colour of the
 * system chrome around the game rather than a nicety in a tab, and a cabinet in
 * high contrast under a default-palette status bar has a seam across the top of
 * the phone.
 */
function applyContrast(): void {
  const high = contrast.high();
  document.documentElement.dataset['contrast'] = high ? 'on' : 'off';
  setHighContrast(high);
  refreshPalette();
  syncThemeColor();
  shell.contrastToggle.textContent = `Contrast: ${contrast.label()}`;
  shell.contrastToggle.title =
    contrast.setting() === 'auto'
      ? 'Contrast follows your system’s setting. Tap to override.'
      : `Contrast forced to ${contrast.label().toLowerCase()}. Tap to change.`;
}

shell.motionToggle.addEventListener('click', () => {
  const setting = motion.cycle();
  applyMotion();
  effects.clear();
  hud.announce(
    setting === 'auto'
      ? 'Effects follow your system setting.'
      : `Effects set to ${motion.label().toLowerCase()}.`,
  );
  draw();
});

shell.soundToggle.addEventListener('click', () => {
  const muted = audio.toggleMute();
  applySound();
  hud.announce(muted ? 'Sound off.' : 'Sound on.');
});

shell.contrastToggle.addEventListener('click', () => {
  const setting = contrast.cycle();
  applyContrast();
  hud.announce(
    setting === 'auto'
      ? 'Contrast follows your system setting.'
      : `Contrast set to ${contrast.label().toLowerCase()}.`,
  );
  draw();
});

watchPalette(() => {
  // The system changed the palette under us; the status bar is part of it.
  syncThemeColor();
  draw();
});

// -- installing, and updating -----------------------------------------------

/**
 * The service worker's page-side half.
 *
 * `registerServiceWorker` does nothing at all outside a production bundle, so
 * `npm run dev` keeps hot-reloading. What it does in production is notice a new
 * deploy finishing its install and say so — and then wait, because the one
 * thing an update must never do is arrive underneath a run.
 */
const serviceWorker = registerServiceWorker({
  onUpdateReady() {
    shell.updateBar.hidden = false;
    hud.announce('A new version is ready. Reload when you are between games.');
  },
});

shell.updateReload.addEventListener('click', () => {
  serviceWorker.applyUpdate();
});

shell.updateDismiss.addEventListener('click', () => {
  shell.updateBar.hidden = true;
  // The button that had focus has just gone; put it back on the well rather
  // than letting it fall to the top of the document.
  shell.playfield.focus();
});

/**
 * The install offer.
 *
 * Only ever shown because the browser fired `beforeinstallprompt` — which is
 * the browser saying it would have offered installation itself — and only until
 * the player answers. The answer is remembered in the same store as everything
 * else, so a browser that fires the event on every visit still only asks once.
 */
createInstallPrompt({
  button: shell.installButton,
  dismissed: store.access('installDismissed'),
  announce: (message) => hud.announce(message),
});

shell.playButton.addEventListener('click', primaryAction);
shell.overlayButton.addEventListener('click', primaryAction);
shell.restartButton.addEventListener('click', startFreshGame);
shell.overlayHelp.addEventListener('click', () => helpPanel.open());

/**
 * The start screen's mode picker.
 *
 * Three real buttons rather than a fourth select, because the choice deserves
 * its blurb: "clear 40 lines as fast as you can" is the thing that makes
 * somebody try Sprint, and it does not fit in an `<option>`. `aria-pressed` is
 * what makes the current choice a fact rather than a colour — the stylesheet
 * reads off the same attribute, so the two cannot disagree.
 */
function applyMode(): void {
  const current = store.get('mode');
  for (const [index, button] of shell.modeButtons.entries()) {
    button.setAttribute('aria-pressed', String(GAME_MODES[index] === current));
  }
}

for (const [index, button] of shell.modeButtons.entries()) {
  const mode = GAME_MODES[index];
  if (mode === undefined) {
    continue;
  }
  button.addEventListener('click', () => {
    store.set('mode', mode);
    applyMode();
    // Re-deal the waiting game rather than only remembering the answer, so the
    // readout beside the well is already showing the mode's own clock and the
    // panel is already quoting the right personal best.
    if (state.status === 'ready') {
      dealGame(createGame({ seed: state.seed, startLevel: store.get('startLevel'), mode }));
    }
    hud.announce(`${MODE_LABELS[mode]}. ${MODE_BLURBS[mode]}.`);
    draw();
  });
}

/**
 * The start screen's level picker.
 *
 * Changing it re-deals the waiting game rather than only remembering a number,
 * so the level readout and the personal best beside it are already telling the
 * truth about the run that is about to start. Runs begun above level 1 are
 * scored on their own ladder — see `ui/stats.ts`.
 */
shell.startLevel.addEventListener('change', () => {
  const level = clampStartLevel(Number(shell.startLevel.value));
  store.set('startLevel', level);
  shell.startLevel.value = String(level);
  if (state.status === 'ready') {
    dealGame(createGame({ seed: state.seed, startLevel: level, mode: store.get('mode') }));
  }
  hud.announce(level === 1 ? 'Starting on level 1.' : `Starting on level ${level}.`);
  draw();
});

/**
 * "Play again", from wherever focus happens to be.
 *
 * The panel opens with its button focused, so Enter and Space are already the
 * button's own; and with the well focused, Space and R already arrive as bound
 * actions. That leaves exactly two gaps, and this fills them: **R while a
 * control has focus** — the keyboard layer deliberately leaves keys inside
 * controls alone — and **Enter while the well has it**, where nothing is
 * listening at all.
 *
 * `defaultPrevented` is the seam. The game layer prevents the default of every
 * key it claims, so a prevented R is one that has already restarted the game
 * and must not restart it twice.
 */
const PLAY_AGAIN_KEYS: ReadonlySet<string> = new Set(['Enter', 'R']);

window.addEventListener('keydown', (event) => {
  if (state.status !== 'over' || menusOpen() || replayViewer.active() || event.defaultPrevented) {
    return;
  }
  if (event.metaKey || event.altKey || event.ctrlKey) {
    return;
  }
  const key = normalizeKey(event.key);
  if (!PLAY_AGAIN_KEYS.has(key)) {
    return;
  }
  const active = document.activeElement;
  const inControl =
    active instanceof HTMLElement && active.closest('button, a, input, select, textarea') !== null;
  // Enter on a real control belongs to that control: it is about to be
  // activated, and a restart underneath it would be one too many.
  if (key === 'Enter' && inControl) {
    return;
  }
  event.preventDefault();
  startFreshGame();
});

/**
 * Escape leaves a replay, from wherever focus happens to be.
 *
 * With the well focused, Escape already arrives as a bound action and
 * `dispatch` handles it — and prevents the default, which is the seam that
 * stops this firing a second time. What this fills is the other case: focus on
 * one of the bar's own buttons, where the keyboard layer deliberately leaves
 * keys inside controls alone. Exactly the arrangement "play again" uses.
 */
window.addEventListener('keydown', (event) => {
  if (!replayViewer.active() || menusOpen() || event.defaultPrevented) {
    return;
  }
  if (event.metaKey || event.altKey || event.ctrlKey) {
    return;
  }
  if (normalizeKey(event.key) !== 'Escape') {
    return;
  }
  event.preventDefault();
  leaveReplay(true);
});

// A hidden tab should not keep playing behind the player's back. The loop
// suspends itself too, but pausing the game is what makes the return honest.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    input.releaseAll();
    touch.releaseAll();
    // A count that resumed the game while nobody was looking would be worse
    // than no count at all.
    countdown.cancel();
    if (replayViewer.active() && replayViewer.playing()) {
      replayViewer.togglePlay();
      draw();
    }
    if (state.status === 'playing') {
      send({ type: 'pause' });
      draw();
    }
  }
});

/**
 * Republish the bindings into the three places that print them — the controls
 * card, the help panel and the pad's tooltips — now, and again whenever a key
 * moves. None of them holds a copy, so this is the whole of "rebinding hard
 * drop changes what the help panel says".
 */
bindings.listen(() => applyBindings(shell, bindings.table()));
applyBindings(shell, bindings.table());

applyMotion();
applySound();
applyContrast();
// The pickers are markup; the remembered choices are data. Publish one into the
// other before the first paint, so the attract screen opens already set.
shell.startLevel.value = String(store.get('startLevel'));
applyMode();
renderDaily();
loop.start();
draw();

// A link in the address bar is somebody handing over a run to watch. It opens
// the viewer instead of a game — over the start screen, so leaving it lands on
// the panel that offers one.
const watchingSharedRun = openSharedRun();

// A player who has never been here before gets the controls without having to
// go looking for them. Everyone else lands on the start screen's Play button.
//
// Neither happens to somebody who arrived on a friend's link: the replay is
// already playing and already has focus, and a help panel thrown over it would
// be answering a question nobody asked. Help is a button away.
if (watchingSharedRun) {
  // Nothing to do — `openReplay` has already put focus on the bar.
} else if (store.get('seenHelp')) {
  shell.overlayButton.focus();
} else {
  helpPanel.open();
}
draw();

if (import.meta.env.DEV) {
  // A window on the current snapshot, for the dev console and for automated
  // playtests. Folded away entirely by the production build.
  Reflect.set(window, 'megaTetris', {
    state: () => state,
    effects: () => ({ particles: effects.particleCount(), score: effects.displayScore() }),
    reducedMotion: () => motion.reduced(),
    highContrast: () => contrast.high(),
    menus: () => ({
      pause: pauseMenu.isOpen(),
      help: helpPanel.isOpen(),
      settings: settingsMenu.isOpen(),
      capturing: settingsPanel.capturing(),
      countdown: countdown.digit(),
    }),
    openHelp: () => helpPanel.open(),
    openSettings: () => settingsMenu.open(),
    bindings: () => ({ map: bindings.table().map, handling: bindings.handling() }),
    closeMenus,
    stats: () => store.stats(),
    settings: () => store.settings(),
    result: () => lastResult,
    daily: () => ({ today, kind: runKind, record: store.daily(), note: dailyNote }),
    startDaily: startDailyRun,
    recorder: () => ({ entries: recorder.size(), truncated: recorder.truncated() }),
    lastRun: () => lastRun,
    replay: () => ({
      active: replayViewer.active(),
      playing: replayViewer.playing(),
      done: replayViewer.done(),
      speed: replayViewer.speed(),
      origin: replayViewer.origin(),
      caption: replayViewer.caption(),
      result: replayViewer.result(),
      state: replayViewer.state(),
    }),
    watchLastRun: () => {
      if (lastRun !== null) {
        openReplay({ ...lastRun, origin: 'own' });
      }
    },
    leaveReplay: () => leaveReplay(false),
  });
}
