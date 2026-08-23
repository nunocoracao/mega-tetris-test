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
import type { PieceKind, SpinKind } from '../engine';
import { bestFor, type Best, type RunSummary, type Stats, type StatsUpdate } from './stats';
import type { Shell } from './shell';

/** Thousands separators, without dragging in locale differences. */
export function formatNumber(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A run's length, as a clock. Minutes and seconds, with an hour on the front
 * only for the runs that earn one — a leading `0:` on every game would be
 * noise on the panel that shows it.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * The run in one line — "12 lines, level 3, 4,200 points".
 *
 * The whole point of it is that the loop closes on a small sense of progress
 * rather than on the word "over", so it leads with the thing the player did
 * rather than with the thing that happened to them.
 */
export function summaryLine(run: RunSummary): string {
  const lines = run.lines === 1 ? '1 line' : `${formatNumber(run.lines)} lines`;
  return `${lines}, level ${formatNumber(run.level)}, ${formatNumber(run.score)} points`;
}

/** A personal best in one line, for the start screen. */
export function bestLine(best: Best): string {
  return `${formatNumber(best.score)} points, level ${formatNumber(best.level)}, ${formatNumber(best.lines)} lines`;
}

/** One "this run against your best" row on the game-over panel. */
export type OverlayRowKey = 'score' | 'lines' | 'level' | 'time';

export const OVERLAY_ROW_KEYS: readonly OverlayRowKey[] = ['score', 'lines', 'level', 'time'];

/** The row headings. `ui/shell.ts` builds the markup from these; nothing else
 *  writes them, so the panel's labels have exactly one home. */
export const OVERLAY_ROW_LABELS: Readonly<Record<OverlayRowKey, string>> = {
  score: 'Score',
  lines: 'Lines',
  level: 'Level',
  time: 'Time',
};

export interface OverlayRow {
  readonly key: OverlayRowKey;
  readonly label: string;
  readonly value: string;
  /** The same number from the personal best, or `null` if there is not one. */
  readonly best: string | null;
  /** This run pushed the best past where it was. */
  readonly record: boolean;
}

// ---------------------------------------------------------------------------
// The pause menu's readout
// ---------------------------------------------------------------------------

/** The rows of the "Personal bests" list in the pause menu. */
export type MenuStatKey =
  | 'highScore'
  | 'highestLevel'
  | 'mostLines'
  | 'headStart'
  | 'gamesPlayed'
  | 'totalLines';

export const MENU_STATS: readonly { readonly key: MenuStatKey; readonly label: string }[] = [
  { key: 'highScore', label: 'High score' },
  { key: 'highestLevel', label: 'Highest level' },
  { key: 'mostLines', label: 'Most lines in a run' },
  { key: 'headStart', label: 'Best head start' },
  { key: 'gamesPlayed', label: 'Games played' },
  { key: 'totalLines', label: 'Lines all-time' },
];

/**
 * Every row of the pause menu's list, as text. `null` means "do not show this
 * row at all" — which only the head-start best ever is, because a player who
 * has never used the level picker should not be told they have no record on a
 * ladder they have never heard of.
 */
export function menuStatValues(stats: Stats): Readonly<Record<MenuStatKey, string | null>> {
  return {
    highScore: formatNumber(stats.best.score),
    highestLevel: formatNumber(stats.best.level),
    mostLines: formatNumber(stats.best.lines),
    headStart: stats.headStart.score > 0 ? formatNumber(stats.headStart.score) : null,
    gamesPlayed: formatNumber(stats.gamesPlayed),
    totalLines: formatNumber(stats.totalLines),
  };
}

/** What the overlay says over the well, or `null` while the game is live. */
export interface OverlayContent {
  /** Which panel this is, for the stylesheet and for the tests. */
  readonly kind: 'start' | 'paused' | 'over';
  /** The small line above the title: the game's name, or a record being broken. */
  readonly eyebrow: string | null;
  readonly title: string;
  readonly hint: string;
  readonly button: string;
  /** The run-against-best table. Empty except on the game-over panel. */
  readonly rows: readonly OverlayRow[];
  /** A footnote: the personal best on the start screen, or which ladder a
   *  head-start run was measured on. */
  readonly note: string | null;
  readonly showLevelSelect: boolean;
  readonly showHelp: boolean;
}

/** The things the overlay copy cannot read off the game snapshot. */
export interface OverlayView {
  /** Whether the player is on a touch device, which changes the help copy. */
  readonly touch?: boolean;
  /** Personal bests and totals, for the start screen's teaser. */
  readonly stats?: Stats;
  /** The run that just ended, and what it did to the stats. */
  readonly result?: StatsUpdate | null;
  /** The level the start screen's picker is currently set to. */
  readonly startLevel?: number;
}

/** `'—'` rather than a zero, for a best that does not exist yet. */
function bestValue(value: number): string | null {
  return value > 0 ? formatNumber(value) : null;
}

/** The four rows of the game-over panel: what you did, against what you had. */
function resultRows(run: RunSummary, previous: Best | null, records: ReadonlySet<string>): readonly OverlayRow[] {
  const best = previous ?? { score: 0, level: 0, lines: 0, durationMs: 0 };
  const label = (key: OverlayRowKey): string => OVERLAY_ROW_LABELS[key];
  return [
    {
      key: 'score',
      label: label('score'),
      value: formatNumber(run.score),
      best: bestValue(best.score),
      record: records.has('score'),
    },
    {
      key: 'lines',
      label: label('lines'),
      value: formatNumber(run.lines),
      best: bestValue(best.lines),
      record: records.has('lines'),
    },
    {
      key: 'level',
      label: label('level'),
      value: formatNumber(run.level),
      best: bestValue(best.level),
      record: records.has('level'),
    },
    {
      // Time is shown, never raced: a long run is not a better run, so this row
      // reports the clock and never claims a record.
      key: 'time',
      label: label('time'),
      value: formatDuration(run.durationMs),
      best: best.durationMs > 0 ? formatDuration(best.durationMs) : null,
      record: false,
    },
  ];
}

/**
 * The overlay is the cabinet's screen between runs: the attract mode before the
 * first game, the paused veil, and the scoreboard at the end.
 *
 * It is also the game's shortest help panel, so it says what to *do* — and on a
 * phone that is a different sentence. Everything else it reads off the snapshot
 * and the stats it is handed, so the whole thing stays a pure function.
 */
export function overlayContent(state: GameState, view: OverlayView = {}): OverlayContent | null {
  const touch = view.touch ?? false;
  const controls = touch
    ? 'Drag to slide, tap to spin, flick down to drop, swipe up to hold.'
    : 'Arrows to move and rotate, space to drop.';

  switch (state.status) {
    case 'ready': {
      const best =
        view.stats === undefined ? null : bestFor(view.stats, view.startLevel ?? state.startLevel);
      return {
        kind: 'start',
        eyebrow: 'Mega Tetris',
        title: 'One more game.',
        hint: controls,
        button: 'Play',
        rows: [],
        note: best !== null && best.score > 0 ? `Your best: ${bestLine(best)}.` : null,
        showLevelSelect: true,
        showHelp: true,
      };
    }
    case 'paused':
      return {
        kind: 'paused',
        eyebrow: null,
        title: 'Paused',
        hint: touch
          ? 'Tap Resume to pick up where you left off.'
          : 'Press P or Esc to pick up where you left off.',
        button: 'Resume',
        rows: [],
        note: null,
        showLevelSelect: false,
        showHelp: false,
      };
    case 'over': {
      const result = view.result ?? null;
      // The result is the authority when there is one; the snapshot is the
      // fallback, so the panel is still right if the run was never recorded.
      const run: RunSummary = result?.run ?? {
        score: state.score,
        lines: state.lines,
        level: state.level,
        startLevel: state.startLevel,
        durationMs: state.elapsedMs,
      };
      const records = new Set<string>(result?.records ?? []);
      const eyebrow =
        result === null || records.size === 0
          ? null
          : result.isHighScore
            ? 'New high score!'
            : 'New personal best!';
      return {
        kind: 'over',
        eyebrow,
        title: 'Game over',
        hint: summaryLine(run),
        button: 'Play again',
        rows: resultRows(run, result?.previousBest ?? null, records),
        note:
          result?.headStart === true
            ? `Started on level ${formatNumber(run.startLevel)}, so it is measured against your head-start runs.`
            : null,
        showLevelSelect: false,
        showHelp: false,
      };
    }
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

// ---------------------------------------------------------------------------
// Naming a clear
// ---------------------------------------------------------------------------

/**
 * What each size of clear is called. Index 0 is unused — a clear of no rows is
 * not a clear — and the array is the single home of these four words: the
 * popups, the live region and the help panel all read them from here.
 */
export const CLEAR_NAMES = ['', 'single', 'double', 'triple', 'quad'] as const;

/** The sizes of clear that have a name — every clear there can be. */
export type ClearSize = 1 | 2 | 3 | 4;

export const CLEAR_SIZES: readonly ClearSize[] = [1, 2, 3, 4];

/** The words for a clear that this run of the game is up to. */
export interface ClearNaming {
  readonly kind: PieceKind;
  readonly count: number;
  readonly spin: SpinKind;
  readonly backToBack: boolean;
}

/**
 * A clear in the game's own words: `"triple"`, `"T-spin double"`,
 * `"back-to-back quad"`, `"S-spin single"`.
 *
 * The engine deliberately does not name anything — it reports a count, a spin
 * kind and a flag, and this is where those become English. Naming the spin
 * after the piece that did it is the one place the piece kind matters to the
 * copy, which is why `rowsCleared` carries it.
 */
export function clearName(event: ClearNaming): string {
  // Clamped rather than guarded: there is no fifth size to fall through to, and
  // a nonsense count should still come out as words rather than as a blank.
  const size = CLEAR_NAMES[Math.min(Math.max(event.count, 1), 4) as ClearSize];
  const spun = event.spin === 'none' ? size : `${event.kind}-spin ${size}`;
  return event.backToBack ? `back-to-back ${spun}` : spun;
}

/** A spin that cleared nothing, named: `"T-spin"`. */
export function spinName(kind: PieceKind): string {
  return `${kind}-spin`;
}

/** `4` → `"combo ×4"`. Only ever shown from the second clear of a chain. */
export function comboName(combo: number): string {
  return `combo ×${formatNumber(combo)}`;
}

/**
 * Combo steps worth interrupting a screen reader for.
 *
 * A live region that says "combo ×2, combo ×3, combo ×4" is a live region
 * nobody survives, so only every fifth step gets through. The rest of the
 * chain is visible on the well and audible in the rising cue, which is where a
 * running count belongs.
 */
export const COMBO_ANNOUNCE_STEP = 5;

/** Is this combo step one the live region should mention? */
export function announcesCombo(combo: number): boolean {
  return combo >= COMBO_ANNOUNCE_STEP && combo % COMBO_ANNOUNCE_STEP === 0;
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
    case 'spin':
      // A spin that cleared rows is about to be announced as the clear it was;
      // saying "T-spin" and then "T-spin double" is the same news twice.
      return event.cleared > 0
        ? null
        : `${spinName(event.kind)}, ${formatNumber(event.points)} points.`;
    case 'rowsCleared': {
      const lines = event.count === 1 ? '1 line' : `${event.count} lines`;
      const spun = event.spin === 'none' ? '' : `${spinName(event.kind)}, `;
      const bonus = event.backToBack ? ', back to back' : '';
      // Combos are counted out loud only at milestones — see `announcesCombo`.
      const combo = announcesCombo(event.combo) ? `, ${comboName(event.combo)}` : '';
      return `${spun}${lines} cleared${bonus}${combo}, ${formatNumber(event.points)} points.`;
    }
    case 'levelUp':
      return `Level ${formatNumber(event.level)}.`;
    case 'gameOver':
      return `Game over. Final score ${formatNumber(event.score)}, ${formatNumber(event.lines)} lines.`;
    default:
      return null;
  }
}

/**
 * The end of a run, out loud.
 *
 * `describeEvent` cannot say this one: what makes a game over worth hearing is
 * not the event, it is what the event did to the player's bests. Celebrating a
 * record is exactly as important in the live region as it is on the panel.
 */
export function describeRunEnd(update: StatsUpdate): string {
  const { run } = update;
  const base = `Game over. Final score ${formatNumber(run.score)}, ${formatNumber(run.lines)} lines.`;
  if (update.isHighScore) {
    return `${base} A new high score!`;
  }
  if (update.records.length > 0) {
    return `${base} A new personal best.`;
  }
  if (update.previousBest.score > 0) {
    return `${base} Your best is ${formatNumber(update.previousBest.score)}.`;
  }
  return base;
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
  /** Personal bests and totals, for the readout and the panels. */
  readonly stats?: Stats;
  /** The run that just ended, and what it did to the bests. */
  readonly result?: StatsUpdate | null;
  /** The level the start screen's picker is set to. */
  readonly startLevel?: number;
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

/** Show or hide an element, without touching it when it is already right. */
function setHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden !== hidden) {
    element.hidden = hidden;
  }
}

export function createHud(shell: Shell): Hud {
  let lastStatus: GameState['status'] | null = null;

  /**
   * The overlay's rows are static markup filled in place, so the panel never
   * rebuilds its own DOM mid-animation. The lookups are cached once rather than
   * re-queried per frame.
   */
  const rowNodes = new Map<OverlayRowKey, { row: HTMLElement; value: HTMLElement }>();
  for (const key of OVERLAY_ROW_KEYS) {
    const row = shell.overlayRows.querySelector<HTMLElement>(`[data-run-row="${key}"]`);
    const value = shell.overlayRows.querySelector<HTMLElement>(`[data-run-value="${key}"]`);
    if (row !== null && value !== null) {
      rowNodes.set(key, { row, value });
    }
  }

  /**
   * What the overlay last said, so identical copy is not rewritten per frame.
   *
   * A `JSON.stringify` per frame would be waste in the game loop; it is not one
   * here, because the overlay is only ever up while the game is *not* live —
   * the start screen, a pause and the scoreboard. Nothing is falling behind it.
   */
  let overlaySignature = '';

  function renderOverlay(content: OverlayContent): void {
    const signature = JSON.stringify(content);
    if (signature === overlaySignature) {
      return;
    }
    overlaySignature = signature;

    setText(shell.overlayTitle, content.title);
    setText(shell.overlayHint, content.hint);
    setText(shell.overlayButton, content.button);

    setText(shell.overlayEyebrow, content.eyebrow ?? '');
    setHidden(shell.overlayEyebrow, content.eyebrow === null);
    shell.overlayEyebrow.classList.toggle('overlay__eyebrow--record', content.kind === 'over');

    setText(shell.overlayNote, content.note ?? '');
    setHidden(shell.overlayNote, content.note === null);

    setHidden(shell.overlayRows, content.rows.length === 0);
    for (const row of content.rows) {
      const nodes = rowNodes.get(row.key);
      if (nodes === undefined) {
        continue;
      }
      setText(nodes.value, row.best === null ? row.value : `${row.value} (best ${row.best})`);
      nodes.row.classList.toggle('runstats__row--record', row.record);
    }

    setHidden(shell.overlayStart, !content.showLevelSelect);
    setHidden(shell.overlayHelp, !content.showHelp);
  }

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

      // The best on this run's own ladder, and a quiet flag while the run in
      // progress is already past it. A record you are *setting* is worth more
      // encouragement than one you set last week.
      const best = view.stats === undefined ? 0 : bestFor(view.stats, state.startLevel).score;
      setText(shell.best, best > 0 ? formatNumber(best) : '—');
      shell.bestRow.classList.toggle(
        'stats__row--record',
        state.status === 'playing' && state.score > best,
      );

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
          : overlayContent(state, {
              touch: view.touch ?? false,
              stats: view.stats,
              result: view.result ?? null,
              startLevel: view.startLevel,
            });
      if (overlay === null) {
        setHidden(shell.overlay, true);
      } else {
        renderOverlay(overlay);
        // The stylesheet fades the game-over panel in behind the field sweep;
        // the status is how it knows which panel this is.
        shell.overlay.dataset['state'] = state.status;
        setHidden(shell.overlay, false);
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
