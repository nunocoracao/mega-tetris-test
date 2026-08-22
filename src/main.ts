/**
 * Composition root.
 *
 * The engine is pure and knows nothing about the browser; the renderer paints
 * and knows nothing about the rules; the input layer reports intents and knows
 * nothing about either. This file is the one place they meet: it owns the
 * single mutable `state` reference, feeds real elapsed milliseconds into
 * `update`, turns key presses into engine inputs and repaints.
 */

import './style.css';

import { applyInput, createGame, update, type GameInput, type GameState } from './engine';
import { createHud, describeEvent } from './ui/hud';
import { createKeyboardInput, type ActionId } from './ui/input';
import { createLoop } from './ui/loop';
import { createBoardRenderer, createPiecePanelRenderer } from './ui/renderer';
import { createShell } from './ui/shell';

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

const shell = createShell(root);
const hud = createHud(shell);
const board = createBoardRenderer(shell.boardCanvas);
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
  hud.render(state);
}

/** Take the new snapshot and say anything worth saying about how we got here. */
function setState(nextState: GameState): void {
  state = nextState;
  for (const event of state.events) {
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
  setState(createGame({ seed: newSeed() }));
  send({ type: 'resume' });
  draw();
  shell.playfield.focus();
}

/**
 * Resolve the two intents the keyboard deliberately leaves open, and pass the
 * rest straight through. Whether "pause" means pause or resume depends on the
 * status, and a restart after a game over should deal a new sequence rather
 * than replay the old seed — both are UI policy, not game rules.
 */
function dispatch(action: ActionId): void {
  switch (action) {
    case 'togglePause':
      send({ type: state.status === 'playing' ? 'pause' : 'resume' });
      break;
    case 'restart':
      startFreshGame();
      break;
    default:
      send({ type: action });
      break;
  }
  draw();
}

const input = createKeyboardInput({ onAction: dispatch });

const loop = createLoop({
  onFrame(deltaMs) {
    input.update(deltaMs);
    setState(update(state, deltaMs));
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
  shell.playfield.focus();
}

shell.playButton.addEventListener('click', primaryAction);
shell.overlayButton.addEventListener('click', primaryAction);
shell.restartButton.addEventListener('click', startFreshGame);

// A hidden tab should not keep playing behind the player's back. The loop
// suspends itself too, but pausing the game is what makes the return honest.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    input.releaseAll();
    if (state.status === 'playing') {
      send({ type: 'pause' });
      draw();
    }
  }
});

loop.start();
draw();
shell.overlayButton.focus();

if (import.meta.env.DEV) {
  // A window on the current snapshot, for the dev console and for automated
  // playtests. Folded away entirely by the production build.
  Reflect.set(window, 'megaTetris', { state: () => state });
}
