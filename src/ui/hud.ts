/**
 * The heads-up display: the numbers beside the well, the overlay that covers
 * it between runs, and the words a screen reader hears when something happens.
 *
 * The interesting parts — what a status looks like, how an event reads aloud —
 * are pure functions of the state, so they can be tested without a DOM. The
 * only stateful bit is the writer, which remembers what it last wrote so a
 * 60Hz render loop does not rewrite identical text sixty times a second.
 */

import type { GameEvent, GameState } from '../engine';
import type { Shell } from './shell';

/** Thousands separators, without dragging in locale differences. */
export function formatNumber(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** What the overlay says over the well, or `null` while the game is live. */
export interface OverlayContent {
  readonly title: string;
  readonly hint: string;
  readonly button: string;
}

/**
 * The overlay is also the game's help panel, so it says what to *do* — and on
 * a phone that is a different sentence. `touch` is the one bit of presentation
 * state the copy needs; everything else it can read off the snapshot.
 */
export function overlayContent(state: GameState, touch = false): OverlayContent | null {
  switch (state.status) {
    case 'ready':
      return {
        title: 'Ready?',
        hint: touch
          ? 'Drag to slide, tap to spin, flick down to drop, swipe up to hold.'
          : 'Arrows to move and rotate, space to drop.',
        button: 'Play',
      };
    case 'paused':
      return {
        title: 'Paused',
        hint: touch
          ? 'Tap Resume to pick up where you left off.'
          : 'Press P or Esc to pick up where you left off.',
        button: 'Resume',
      };
    case 'over':
      return {
        title: 'Game over',
        hint: `You scored ${formatNumber(state.score)} on level ${formatNumber(state.level)}.`,
        button: 'Play again',
      };
    case 'playing':
      return null;
  }
}

/** Label for the play/pause button, which changes meaning with the status. */
export function playButtonLabel(state: GameState): string {
  switch (state.status) {
    case 'playing':
      return 'Pause';
    case 'paused':
      return 'Resume';
    case 'over':
      return 'Play again';
    case 'ready':
      return 'Play';
  }
}

/**
 * An event as a sentence, or `null` for events not worth interrupting for.
 * Locks and spawns happen constantly; scores, levels and endings do not.
 */
export function describeEvent(event: GameEvent): string | null {
  switch (event.type) {
    case 'rowsCleared': {
      const lines = event.count === 1 ? '1 line' : `${event.count} lines`;
      const bonus = event.backToBack ? ', back to back' : '';
      return `${lines} cleared${bonus}, ${formatNumber(event.points)} points.`;
    }
    case 'levelUp':
      return `Level ${formatNumber(event.level)}.`;
    case 'hold':
      return `Held ${event.held}, now playing ${event.active}.`;
    case 'gameOver':
      return `Game over. Final score ${formatNumber(event.score)}, ${formatNumber(event.lines)} lines.`;
    default:
      return null;
  }
}

export interface Hud {
  /** Push the state into the DOM. Cheap to call every frame. */
  render(state: GameState, touch?: boolean): void;
  /** Say something in the live region. */
  announce(message: string): void;
}

/** Write `text` into `element` only when it differs from what is there. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

export function createHud(shell: Shell): Hud {
  let lastStatus: GameState['status'] | null = null;

  return {
    render(state: GameState, touch = false): void {
      setText(shell.score, formatNumber(state.score));
      setText(shell.level, formatNumber(state.level));
      setText(shell.lines, formatNumber(state.lines));
      setText(shell.playButton, playButtonLabel(state));

      const overlay = overlayContent(state, touch);
      if (overlay === null) {
        shell.overlay.hidden = true;
      } else {
        setText(shell.overlayTitle, overlay.title);
        setText(shell.overlayHint, overlay.hint);
        setText(shell.overlayButton, overlay.button);
        shell.overlay.hidden = false;
      }

      if (state.status !== lastStatus) {
        if (lastStatus !== null && state.status === 'paused') {
          this.announce('Paused.');
        }
        if (lastStatus === 'paused' && state.status === 'playing') {
          this.announce('Resumed.');
        }
        lastStatus = state.status;
      }
    },

    announce(message: string): void {
      // Clearing first makes repeats of the same sentence announce again.
      shell.status.textContent = '';
      shell.status.textContent = message;
    },
  };
}
