/**
 * The heads-up display: the numbers beside the well, the overlay that covers
 * it between runs, and the words a screen reader hears when something happens.
 *
 * The interesting parts — what a status looks like, how an event reads aloud —
 * are pure functions of the state, so they can be tested without a DOM. The
 * only stateful bit is the writer, which remembers what it last wrote so a
 * 60Hz render loop does not rewrite identical text sixty times a second.
 */

import { VISIBLE_HEIGHT, type GameEvent, type GameState } from '../engine';
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
 *
 * The bar is deliberately high. A live region that speaks on every lock, hold
 * and spawn is a live region players turn their screen reader off to escape,
 * so only three things get through: a line clear (with the count), a level up,
 * and the end of the run. Everything else is background chatter and is read on
 * demand from the playfield's own description instead.
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
    case 'gameOver':
      return `Game over. Final score ${formatNumber(event.score)}, ${formatNumber(event.lines)} lines.`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The playfield in words
// ---------------------------------------------------------------------------

/** How tall the stack is, in rows of the visible well. */
export function stackHeight(state: GameState): number {
  const { board } = state;
  const hidden = Math.max(0, board.height - VISIBLE_HEIGHT);
  for (let y = hidden; y < board.height; y += 1) {
    for (let x = 0; x < board.width; x += 1) {
      if (board.cells[y * board.width + x] != null) {
        return board.height - y;
      }
    }
  }
  return 0;
}

/** `['I', 'O']` → `'I, then O'`; an empty queue reads as "nothing queued". */
function listPieces(kinds: readonly string[]): string {
  if (kinds.length === 0) {
    return 'nothing queued';
  }
  return kinds.join(', then ');
}

/** The next-queue thumbnail canvas, in words. */
export function describeQueue(state: GameState, previewCount = 3): string {
  return `Next: ${listPieces(state.next.slice(0, previewCount))}.`;
}

/** The hold slot, in words — including whether it is spent for this piece. */
export function describeHold(state: GameState): string {
  if (state.hold === null) {
    return 'Hold is empty.';
  }
  return state.holdLocked
    ? `Holding ${state.hold}. Already used this piece.`
    : `Holding ${state.hold}.`;
}

/**
 * The canvas, as a sentence a screen reader can actually use.
 *
 * This is the playfield's text alternative — the thing that stops the well
 * being an opaque box. It is a *summary*, not a running commentary: the height
 * of the stack, the numbers, what is falling, what is coming and what is held.
 * Deliberately silent about the active piece's row and column, because a
 * description that changed on every gravity tick would be unusable — and the
 * HUD would be announcing it.
 */
export function describePlayfield(state: GameState, previewCount = 3): string {
  const height = stackHeight(state);
  const stack =
    height === 0
      ? 'The well is empty.'
      : `The stack is ${height} ${height === 1 ? 'row' : 'rows'} high, of ${VISIBLE_HEIGHT}.`;

  const falling =
    state.active === null ? 'No piece is falling.' : `Falling piece: ${state.active.kind}.`;
  const next = describeQueue(state, previewCount);
  const hold = describeHold(state);

  const status =
    state.status === 'over'
      ? 'Game over.'
      : state.status === 'paused'
        ? 'Paused.'
        : state.status === 'ready'
          ? 'Ready to play.'
          : '';

  return [
    `Playfield, ${state.board.width} columns wide.`,
    stack,
    `Score ${formatNumber(state.score)}, level ${formatNumber(state.level)}, ${formatNumber(state.lines)} lines cleared.`,
    falling,
    next,
    hold,
    status,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/** The things the HUD cannot read off the snapshot. */
export interface HudView {
  /** Whether the player is on a touch device, which changes the help copy. */
  readonly touch?: boolean;
  /**
   * The number to put in the score box. The effects layer walks this up to the
   * engine's score over a few hundred milliseconds; leave it out to show the
   * real one.
   */
  readonly score?: number;
  /** The 3-2-1 digit to show over the well, or `null` when nothing counts. */
  readonly countdown?: number | null;
  /**
   * Keep the overlay down even though the status calls for it — a modal dialog
   * is covering the well and owns the conversation.
   */
  readonly suppressOverlay?: boolean;
}

export interface Hud {
  /** Push the state into the DOM. Cheap to call every frame. */
  render(state: GameState, view?: HudView): void;
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

  /**
   * The playfield description is rebuilt only when something it mentions has
   * changed — not sixty times a second, and pointedly not when the only thing
   * that moved was the falling piece. `aria-labelledby` is not a live region,
   * so this is cheap rather than loud, but rebuilding a string per frame is
   * still waste in a loop that otherwise allocates nothing.
   */
  let summarySignature = '';

  function refreshSummary(state: GameState): void {
    const signature = [
      state.status,
      state.score,
      state.level,
      state.lines,
      state.hold ?? '-',
      state.holdLocked ? 'x' : '-',
      state.active?.kind ?? '-',
      state.next.slice(0, 3).join(''),
    ].join('|');
    if (signature === summarySignature) {
      return;
    }
    summarySignature = signature;
    setText(shell.boardSummary, describePlayfield(state));
    setText(shell.nextText, describeQueue(state));
    setText(shell.holdText, describeHold(state));
  }

  return {
    render(state: GameState, view: HudView = {}): void {
      const shown = view.score ?? state.score;
      setText(shell.score, formatNumber(shown));
      // Lit while the counter is still catching up — the readout's own little
      // "something just happened", and free of any animation of its own.
      shell.score.classList.toggle('score--counting', shown !== state.score);
      setText(shell.level, formatNumber(state.level));
      setText(shell.lines, formatNumber(state.lines));
      setText(shell.playButton, playButtonLabel(state));
      refreshSummary(state);

      // The 3-2-1 after a pause. `aria-hidden`, because the live region has
      // already said "Paused" and will say "Resumed" — counting out loud on
      // top of that is noise.
      const digit = view.countdown ?? null;
      if (digit === null) {
        shell.countdown.hidden = true;
      } else {
        setText(shell.countdown, String(digit));
        shell.countdown.hidden = false;
      }

      const overlay =
        view.suppressOverlay === true || digit !== null
          ? null
          : overlayContent(state, view.touch ?? false);
      if (overlay === null) {
        shell.overlay.hidden = true;
      } else {
        setText(shell.overlayTitle, overlay.title);
        setText(shell.overlayHint, overlay.hint);
        setText(shell.overlayButton, overlay.button);
        // The stylesheet fades the game-over panel in behind the field sweep;
        // the status is how it knows which panel this is.
        shell.overlay.dataset['state'] = state.status;
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
