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

import { applyInput, createGame, update, type GameInput, type GameState } from './engine';
import { createGameAudio } from './ui/audio';
import { createContrastPreference, setHighContrast } from './ui/contrast';
import { createCountdown } from './ui/countdown';
import { createModal } from './ui/dialog';
import { createEffects } from './ui/effects';
import {
  MENU_STATS,
  createHud,
  describeEvent,
  describeRunEnd,
  menuStatValues,
} from './ui/hud';
import { createKeyboardInput, normalizeKey, type ActionId } from './ui/input';
import { createLoop } from './ui/loop';
import { createMotionPreference } from './ui/motion';
import { refreshPalette, watchPalette } from './ui/palette';
import { createBoardRenderer, createPiecePanelRenderer } from './ui/renderer';
import { createShell } from './ui/shell';
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

let state: GameState = createGame({
  seed: newSeed(),
  startLevel: store.get('startLevel'),
});

/**
 * What the last run did to the personal bests, or `null` before the first game
 * over of this visit. The game-over panel is written from it.
 */
let lastResult: StatsUpdate | null = null;

/**
 * Set when a run has just ended, so the loop can put focus on "Play again" as
 * soon as the panel is in the DOM. Focus cannot move to it from inside
 * `setState`: the overlay is still hidden until the next `draw`.
 */
let focusPlayAgain = false;

function draw(): void {
  // The attract screen's drifting pieces belong to the one state that has no
  // game going on behind the panel.
  effects.setAttract(state.status === 'ready');
  board.render(state);
  next.render({ kinds: state.next.slice(0, PREVIEW_COUNT) });
  hold.render({ kinds: [state.hold], dimmed: state.holdLocked });
  // The overlay doubles as the help text, so it needs to know which controls
  // the player actually has in front of them.
  hud.render(state, {
    touch: touch.touchLikely(),
    score: effects.displayScore(),
    countdown: countdown.digit(),
    stats: store.stats(),
    result: lastResult,
    startLevel: store.get('startLevel'),
    // A dialog is the conversation while it is open; two "Paused" panels
    // stacked on top of each other is one too many.
    suppressOverlay: pauseMenu.isOpen() || helpPanel.isOpen(),
  });
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
      audio.play('clear', event.count);
    } else if (event.type === 'hardDrop') {
      audio.play('hardDrop');
    } else if (event.type === 'levelUp') {
      audio.play('levelUp');
    } else if (event.type === 'gameOver') {
      audio.play('gameOver');
      // The one moment the stats change. Recording it here — rather than from
      // the panel that shows it — means a run counts even if the player closes
      // the tab before the panel finishes fading in.
      lastResult = store.recordRun({
        score: event.score,
        lines: event.lines,
        level: event.level,
        startLevel: state.startLevel,
        durationMs: state.elapsedMs,
      });
      focusPlayAgain = true;
    } else if (event.type === 'hold') {
      audio.play('rotate');
    }

    // The end of a run is the one event whose sentence depends on more than
    // the event: "game over" plus what it did to the bests.
    const message =
      event.type === 'gameOver' && lastResult !== null
        ? describeRunEnd(lastResult)
        : describeEvent(event);
    if (message !== null) {
      hud.announce(message);
    }
  }
}

function send(input: GameInput): void {
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
  // A restart is not a resume: whatever menu asked for it should close without
  // counting the player back into a game that no longer exists.
  closeMenus();
  lastResult = null;
  focusPlayAgain = false;
  setState(createGame({ seed: newSeed(), startLevel: store.get('startLevel') }));
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

const input = createKeyboardInput({ onAction: dispatch });

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

const pauseMenu = createModal({
  element: shell.pauseDialog,
  background: [...shell.background, shell.helpDialog],
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
  background: [...shell.background, shell.pauseDialog],
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

function menusOpen(): boolean {
  return pauseMenu.isOpen() || helpPanel.isOpen();
}

function closeMenus(): void {
  resumeOnMenuClose = false;
  afterHelp = null;
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
  renderMenuStats();
  showResetConfirm(false);
  hud.announce('Personal bests and totals erased.');
  draw();
});

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

const loop = createLoop({
  onFrame(deltaMs) {
    input.update(deltaMs);
    touch.update(deltaMs);
    countdown.update(deltaMs);
    setState(update(state, deltaMs));
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
 */
function applyContrast(): void {
  const high = contrast.high();
  document.documentElement.dataset['contrast'] = high ? 'on' : 'off';
  setHighContrast(high);
  refreshPalette();
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

watchPalette(() => draw());

shell.playButton.addEventListener('click', primaryAction);
shell.overlayButton.addEventListener('click', primaryAction);
shell.restartButton.addEventListener('click', startFreshGame);
shell.overlayHelp.addEventListener('click', () => helpPanel.open());

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
    setState(createGame({ seed: state.seed, startLevel: level }));
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
  if (state.status !== 'over' || menusOpen() || event.defaultPrevented) {
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

// A hidden tab should not keep playing behind the player's back. The loop
// suspends itself too, but pausing the game is what makes the return honest.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    input.releaseAll();
    touch.releaseAll();
    // A count that resumed the game while nobody was looking would be worse
    // than no count at all.
    countdown.cancel();
    if (state.status === 'playing') {
      send({ type: 'pause' });
      draw();
    }
  }
});

applyMotion();
applySound();
applyContrast();
// The picker is markup; the remembered choice is data. Publish one into the
// other before the first paint, so the attract screen opens already set.
shell.startLevel.value = String(store.get('startLevel'));
loop.start();
draw();

// A player who has never been here before gets the controls without having to
// go looking for them. Everyone else lands on the start screen's Play button.
if (store.get('seenHelp')) {
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
      countdown: countdown.digit(),
    }),
    openHelp: () => helpPanel.open(),
    closeMenus,
    stats: () => store.stats(),
    settings: () => store.settings(),
    result: () => lastResult,
  });
}
