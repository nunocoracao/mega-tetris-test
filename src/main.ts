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
import { hasSeenHelp, markHelpSeen } from './ui/help';
import { createHud, describeEvent } from './ui/hud';
import { createKeyboardInput, type ActionId } from './ui/input';
import { createLoop } from './ui/loop';
import { createMotionPreference } from './ui/motion';
import { refreshPalette, watchPalette } from './ui/palette';
import { createBoardRenderer, createPiecePanelRenderer } from './ui/renderer';
import { createShell } from './ui/shell';
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
 * How much movement the player wants, from the operating system and from the
 * cabinet's own toggle. Both the canvas effects and the CSS transitions read
 * it — the canvas through `effects`, the stylesheet through the root
 * `data-motion` attribute this keeps in sync.
 */
const motion = createMotionPreference({
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
  onChange: () => {
    applyContrast();
    draw();
  },
});

const effects = createEffects({ reducedMotion: () => motion.reduced() });

const audio = createGameAudio();

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

let state: GameState = createGame({ seed: newSeed() });

function draw(): void {
  board.render(state);
  next.render({ kinds: state.next.slice(0, PREVIEW_COUNT) });
  hold.render({ kinds: [state.hold], dimmed: state.holdLocked });
  // The overlay doubles as the help text, so it needs to know which controls
  // the player actually has in front of them.
  hud.render(state, {
    touch: touch.touchLikely(),
    score: effects.displayScore(),
    countdown: countdown.digit(),
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
    } else if (event.type === 'hold') {
      audio.play('rotate');
    }

    const message = describeEvent(event);
    if (message !== null) {
      hud.announce(message);
    }
  }
}

function send(input: GameInput): void {
  setState(applyInput(state, input));
}

/** Abandon this run and deal a brand-new one, already in play. */
function startFreshGame(): void {
  effects.clear();
  countdown.cancel();
  // A restart is not a resume: whatever menu asked for it should close without
  // counting the player back into a game that no longer exists.
  closeMenus();
  setState(createGame({ seed: newSeed() }));
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
  onOpen: () => draw(),
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
    markHelpSeen();
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
loop.start();
draw();

// A player who has never been here before gets the controls without having to
// go looking for them. Everyone else lands on the Play button.
if (hasSeenHelp()) {
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
  });
}
