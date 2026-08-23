/**
 * The DOM shell: every element the game needs, built once.
 *
 * Real markup, not divs pretending to be markup. The page has the three
 * landmarks a page should have — a `<header>` with the one `<h1>`, a `<main>`
 * holding the well and its readouts, and a `<footer>` of actions — and every
 * heading below the title is an `<h2>`, so the outline reads in order. Readouts
 * are description lists, panels are sections with headings, and every control
 * is a real `<button>` with an accessible name.
 *
 * The canvases carry no meaning of their own, so none of them is left as an
 * opaque box: the well is labelled by a running text description of the state
 * (`#playfield-summary`, written by `ui/hud.ts`), and the two thumbnails have
 * a visually hidden sentence beside them saying what they are showing. Only
 * genuinely meaningful moments — a clear, a level up, a pause, the end of a run
 * — go through the polite live region.
 *
 * The pause menu and the help panel are built here as modal dialogs;
 * `ui/dialog.ts` supplies the behaviour that makes them real ones.
 *
 * Nothing here knows the game rules; it builds the furniture and hands back
 * references to it.
 */

import { GAME_MODES } from '../engine';
import { DAILY_HISTORY_DAYS } from './daily';
import { helpBodyMarkup } from './help';
import {
  MENU_STATS,
  MODE_BLURBS,
  MODE_LABELS,
  OVERLAY_ROW_KEYS,
  OVERLAY_ROW_LABELS,
  READOUT_ROW_KEYS,
} from './hud';
import { KEY_BINDINGS, describeBinding } from './input';
import { START_LEVELS } from './stats';
import { TOUCH_PAD_BUTTONS } from './touch';

export interface Shell {
  /** Focusable wrapper around the playfield — the game's keyboard home. */
  readonly playfield: HTMLElement;
  readonly boardCanvas: HTMLCanvasElement;
  readonly nextCanvas: HTMLCanvasElement;
  readonly holdCanvas: HTMLCanvasElement;
  /** The well in words — the canvas's text alternative. */
  readonly boardSummary: HTMLElement;
  /** What the next queue is showing, for anyone who cannot see it. */
  readonly nextText: HTMLElement;
  /** What the hold slot is holding, likewise. */
  readonly holdText: HTMLElement;
  /** The readout panel's heading: "Score", "Time", "Time left". */
  readonly readoutTitle: HTMLElement;
  /** The big number under it, whatever the mode has made that. */
  readonly score: HTMLElement;
  /** The three labelled rows beneath. `ui/hud.ts` writes both halves of each. */
  readonly readoutRows: HTMLElement;
  readonly overlay: HTMLElement;
  /** The small line above the title: the game's name, or a record broken. */
  readonly overlayEyebrow: HTMLElement;
  readonly overlayTitle: HTMLElement;
  readonly overlayHint: HTMLElement;
  /** The run-against-best table on the game-over panel. */
  readonly overlayRows: HTMLElement;
  /** A footnote under the panel: the personal best, or which ladder applied. */
  readonly overlayNote: HTMLElement;
  /** The daily challenge block: date, streak, thirty-day strip, its buttons. */
  readonly daily: HTMLElement;
  readonly dailyStatus: HTMLElement;
  readonly dailyStreak: HTMLElement;
  /** The thirty cells of the strip, oldest first. Filled by `src/main.ts`. */
  readonly dailyCells: readonly HTMLElement[];
  /** Starts today's daily, or a practice run once the attempt is spent. */
  readonly dailyPlay: HTMLButtonElement;
  readonly dailyCopy: HTMLButtonElement;
  /** Shown only when the clipboard is unavailable or says no. */
  readonly dailyFallback: HTMLElement;
  readonly dailyShare: HTMLTextAreaElement;
  /** The start screen's mode and level pickers. */
  readonly overlayStart: HTMLElement;
  readonly startLevel: HTMLSelectElement;
  /** The three mode buttons, in the order the engine lists them. */
  readonly modeButtons: readonly HTMLButtonElement[];
  /** Opens the help panel from the start screen. */
  readonly overlayHelp: HTMLButtonElement;
  readonly overlayButton: HTMLButtonElement;
  /** The 3-2-1 shown over the well on the way back from a pause. */
  readonly countdown: HTMLElement;
  readonly playButton: HTMLButtonElement;
  readonly restartButton: HTMLButtonElement;
  readonly helpButton: HTMLButtonElement;
  /**
   * Offers to install the cabinet. Hidden unless the browser has actually said
   * there is an installation to offer — see `ui/pwa.ts`.
   */
  readonly installButton: HTMLButtonElement;
  /**
   * "A new version is ready." A row under the actions rather than a banner over
   * the well: a player mid-run should be able to ignore it, and nothing that
   * covers the field can be ignored.
   */
  readonly updateBar: HTMLElement;
  readonly updateReload: HTMLButtonElement;
  readonly updateDismiss: HTMLButtonElement;
  /** The on-screen control pad. Hidden or shown by `ui/touch.ts`. */
  readonly touchPad: HTMLElement;
  /** Cycles the pad between auto, forced on and forced off. */
  readonly padToggle: HTMLButtonElement;
  /** Mutes and unmutes the synthesised cues. */
  readonly soundToggle: HTMLButtonElement;
  /** Cycles effects between following the system, full and reduced. */
  readonly motionToggle: HTMLButtonElement;
  /** Cycles contrast between following the system, high and standard. */
  readonly contrastToggle: HTMLButtonElement;
  /** `aria-live="polite"` region for clears, level ups, pause and game over. */
  readonly status: HTMLElement;

  // -- dialogs --------------------------------------------------------------

  readonly pauseDialog: HTMLElement;
  readonly pauseResume: HTMLButtonElement;
  readonly pauseRestart: HTMLButtonElement;
  readonly pauseHelp: HTMLButtonElement;
  readonly pauseClose: HTMLButtonElement;
  /** The personal-bests readout inside the pause menu. */
  readonly menuStats: HTMLElement;
  /** Asks for the reset; the confirmation below is what actually does it. */
  readonly statsReset: HTMLButtonElement;
  readonly statsConfirm: HTMLElement;
  readonly statsConfirmYes: HTMLButtonElement;
  readonly statsConfirmNo: HTMLButtonElement;
  readonly helpDialog: HTMLElement;
  /**
   * The scrolling panel inside the help dialog. Focus lands here rather than on
   * a button, so the panel opens at the top with the title read out — focusing
   * "Got it" would scroll a phone straight past the controls to the last line.
   */
  readonly helpPanel: HTMLElement;
  readonly helpClose: HTMLButtonElement;
  readonly helpDone: HTMLButtonElement;
  /**
   * Everything that is not a dialog. Made `inert` while one is open, so the
   * game behind cannot be tabbed into, clicked, or read out from under it.
   */
  readonly background: readonly HTMLElement[];
}

/** Query a required element, failing loudly rather than silently doing nothing. */
function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) {
    throw new Error(`Shell is missing its "${selector}" element.`);
  }
  return found;
}

/** The controls list, generated from the binding table so it cannot drift. */
function controlsMarkup(): string {
  return KEY_BINDINGS.map(
    (binding) =>
      `<div class="controls__row">
         <dt class="controls__keys">${describeBinding(binding)}</dt>
         <dd class="controls__label">${binding.label}</dd>
       </div>`,
  ).join('');
}

/**
 * The touch pad, generated from `TOUCH_PAD_BUTTONS`.
 *
 * Real buttons with real accessible names: the glyph on the cap is hidden from
 * assistive technology and the `aria-label` carries the meaning, so "Rotate
 * left" is what gets announced rather than an arrow nobody can pronounce. The
 * `--slot` modifier is the only thing the stylesheet needs to place them.
 */
function padMarkup(): string {
  return TOUCH_PAD_BUTTONS.map(
    (button) =>
      `<button
         type="button"
         class="pad__button pad__button--${button.slot}"
         data-pad-action="${button.action}"
         aria-label="${button.label}"
       ><span class="pad__glyph" aria-hidden="true">${button.glyph}</span></button>`,
  ).join('');
}

/**
 * The game-over panel's "this run against your best" table.
 *
 * Built empty-but-valid rather than generated on demand: the values are written
 * into these `<dd>`s by `ui/hud.ts`, so the panel never rebuilds its own DOM
 * while it is fading in, and the shell that the accessibility audit sees is the
 * same shell the player gets.
 */
function runStatsMarkup(): string {
  return OVERLAY_ROW_KEYS.map(
    (key) =>
      `<div class="runstats__row" data-run-row="${key}">
         <dt class="runstats__label">${OVERLAY_ROW_LABELS[key]}</dt>
         <dd class="runstats__value" data-run-value="${key}">—</dd>
       </div>`,
  ).join('');
}

/**
 * The pause menu's personal-bests list.
 *
 * Static rows with placeholder values, filled by `src/main.ts` whenever the
 * menu opens — the same trick the game-over table uses, and for the same
 * reason: a `<dl>` the audit can see, and no DOM built at the moment a dialog
 * is animating in.
 */
function menuStatsMarkup(): string {
  return MENU_STATS.map(
    (row) =>
      `<div class="stats__row" data-stat-row="${row.key}">
         <dt class="stats__label">${row.label}</dt>
         <dd class="stats__value" data-stat="${row.key}">0</dd>
       </div>`,
  ).join('');
}

/** The start screen's level picker, straight off the engine's supported range. */
function levelOptionsMarkup(): string {
  return START_LEVELS.map((level) => `<option value="${level}">${level}</option>`).join('');
}

/**
 * The readout beside the well: a heading, a big number, three labelled rows.
 *
 * Every one of the seven strings in it is written by `ui/hud.ts` from the
 * mode's own readout, so this is only the furniture — three rows with no
 * meaning of their own, which is exactly what stops there being three HUDs.
 */
function readoutRowsMarkup(): string {
  return READOUT_ROW_KEYS.map(
    (key) =>
      `<div class="stats__row" data-readout-row="${key}">
         <dt class="stats__label" data-readout-label="${key}"></dt>
         <dd class="stats__value" data-readout-value="${key}">—</dd>
       </div>`,
  ).join('');
}

/**
 * The mode picker.
 *
 * Three real buttons in a labelled group, each carrying `aria-pressed` — so the
 * current choice is announced rather than merely coloured in, `Tab` reaches all
 * three, and Enter and Space work because they are buttons and nothing has been
 * done to stop them. The blurb under each name is part of the button's own
 * accessible name, which is what makes "Sprint, clear 40 lines as fast as you
 * can" one thing to hear instead of two.
 */
function modesMarkup(): string {
  return GAME_MODES.map(
    (mode) =>
      `<button
         type="button"
         class="mode"
         data-mode="${mode}"
         aria-pressed="false"
       ><span class="mode__name">${MODE_LABELS[mode]}</span>
        <span class="mode__blurb">${MODE_BLURBS[mode]}</span></button>`,
  ).join('');
}

/**
 * The daily challenge's block on the overlay.
 *
 * Built once and empty, like every other list on this panel: `src/main.ts`
 * fills the two lines and the thirty cells whenever the record changes, which
 * is a handful of times a session rather than sixty times a second.
 *
 * The strip is a real `<ol>` of real `<li>`s — thirty days in order is a list,
 * and saying so costs nothing. Each cell carries **two** descriptions of itself:
 * a `title` for a mouse, and a visually hidden sentence for a screen reader,
 * because a `title` alone is not reliably announced and is invisible to a
 * thumb. The tint is never the only difference between a played day and a
 * missed one — the stylesheet gives them different shapes as well.
 */
function dailyStripMarkup(): string {
  return Array.from(
    { length: DAILY_HISTORY_DAYS },
    (_, index) =>
      `<li class="daily__cell" data-daily-cell="${index}">
         <span class="visually-hidden" data-daily-cell-text></span>
       </li>`,
  ).join('');
}

function dailyMarkup(): string {
  return `
    <section class="daily" aria-labelledby="daily-title" data-daily hidden>
      <h2 class="daily__title" id="daily-title">Daily challenge</h2>
      <p class="daily__status" data-daily-status></p>
      <ol class="daily__strip" aria-label="Your last ${DAILY_HISTORY_DAYS} days" data-daily-strip>
        ${dailyStripMarkup()}
      </ol>
      <p class="daily__streak" data-daily-streak></p>
      <div class="daily__actions">
        <button type="button" class="button button--quiet" data-daily-play>
          Play today’s daily
        </button>
        <button type="button" class="button button--quiet" data-daily-copy hidden>
          Copy result
        </button>
      </div>
      <!--
        The clipboard is a permission, not a guarantee: it is absent over plain
        HTTP, refused in some embedded browsers, and rejected outright if the
        click did not look like a gesture. When it fails the text appears here
        instead, selected and ready to copy by hand — which is a fallback rather
        than an apology.
      -->
      <div class="daily__fallback" data-daily-fallback hidden>
        <label class="daily__fallback-label" for="daily-share">Copy this</label>
        <!-- A textarea rather than a text input: the shareable line is three
             lines, and an input strips the newlines out of its own value. -->
        <textarea
          class="daily__share"
          id="daily-share"
          data-daily-share
          rows="3"
          readonly
        ></textarea>
      </div>
    </section>
  `;
}

/**
 * The one panel that covers the well: attract screen, paused veil, scoreboard.
 *
 * All three states share this markup and `ui/hud.ts` decides which parts of it
 * are showing, which is what makes "play again" instant — there is nothing to
 * build, only text to change.
 */
function overlayMarkup(): string {
  return `
    <div class="overlay" data-overlay hidden>
      <p class="overlay__eyebrow" data-overlay-eyebrow hidden></p>
      <!-- Seeded with the copy the start screen uses, so the panel has words
           and the button has a name from the first parse rather than the first
           paint. -->
      <p class="overlay__title" data-overlay-title>One more game.</p>
      <p class="overlay__hint" data-overlay-hint></p>
      <dl class="runstats" data-overlay-rows hidden>${runStatsMarkup()}</dl>
      <p class="overlay__note" data-overlay-note hidden></p>
      ${dailyMarkup()}
      <div class="overlay__start" data-overlay-start hidden>
        <div class="modes" role="group" aria-label="Game mode">${modesMarkup()}</div>
        <label class="level" for="start-level">
          <span class="level__label">Start level</span>
          <select class="level__select" id="start-level" data-start-level>
            ${levelOptionsMarkup()}
          </select>
        </label>
      </div>
      <button type="button" class="button button--primary" data-overlay-button>Play</button>
      <button type="button" class="button button--quiet" data-overlay-help hidden>
        How to play
      </button>
    </div>
  `;
}

/** The little round × in the corner of a dialog. */
function closeButtonMarkup(attribute: string, label: string): string {
  return `<button type="button" class="modal__close" ${attribute} aria-label="${label}">
            <span aria-hidden="true">×</span>
          </button>`;
}

/**
 * The pause menu.
 *
 * Everything a paused player might want, in the order they are likely to want
 * it: carry on, start over, look something up, change a setting. The four
 * settings live here rather than under the well because that is where a player
 * goes looking for them, and because it keeps the actions row to three buttons
 * on a phone.
 */
function pauseDialogMarkup(): string {
  return `
    <div class="modal" data-pause-dialog hidden>
      <div
        class="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pause-title"
        tabindex="-1"
        data-pause-panel
      >
        ${closeButtonMarkup('data-pause-close', 'Close the pause menu and resume')}
        <h2 class="modal__title" id="pause-title">Paused</h2>
        <div class="modal__actions">
          <button type="button" class="button button--primary" data-pause-resume>Resume</button>
          <button type="button" class="button" data-pause-restart>Restart</button>
          <button type="button" class="button" data-pause-help>Help</button>
        </div>
        <section class="modal__section" aria-labelledby="pause-settings-title">
          <h3 class="modal__heading" id="pause-settings-title">Settings</h3>
          <div class="settings">
            <button type="button" class="button button--quiet" data-sound-toggle>Sound: On</button>
            <button type="button" class="button button--quiet" data-motion-toggle>Effects: Auto</button>
            <button type="button" class="button button--quiet" data-contrast-toggle>Contrast: Auto</button>
            <button type="button" class="button button--quiet" data-pad-toggle>Touchpad: Auto</button>
          </div>
        </section>
        <section class="modal__section" aria-labelledby="pause-bests-title">
          <h3 class="modal__heading" id="pause-bests-title">Personal bests</h3>
          <dl class="stats" data-menu-stats>${menuStatsMarkup()}</dl>
          <div class="settings">
            <button type="button" class="button button--quiet" data-stats-reset>
              Reset stats…
            </button>
          </div>
          <!--
            Two steps on purpose. Erasing a personal best is the one destructive
            thing in the game, and a single mis-tap in a menu is not consent —
            so the button asks, and a second, differently-worded control agrees.
          -->
          <div class="confirm" data-stats-confirm hidden>
            <p class="confirm__text">
              Erase every personal best, total and daily result? This cannot be
              undone.
            </p>
            <div class="modal__actions">
              <button type="button" class="button button--primary" data-stats-keep>
                Keep them
              </button>
              <button type="button" class="button" data-stats-erase>Erase everything</button>
            </div>
          </div>
        </section>
        <p class="modal__foot">Closing the menu counts you back in: three, two, one.</p>
      </div>
    </div>
  `;
}

/** The help panel. Its content is generated in `ui/help.ts`. */
function helpDialogMarkup(): string {
  return `
    <div class="modal" data-help-dialog hidden>
      <div
        class="modal__panel modal__panel--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        tabindex="-1"
        data-help-panel
      >
        ${closeButtonMarkup('data-help-close', 'Close help')}
        <h2 class="modal__title" id="help-title">How to play</h2>
        <div class="modal__body">${helpBodyMarkup()}</div>
        <div class="modal__actions">
          <button type="button" class="button button--primary" data-help-done>Got it</button>
        </div>
      </div>
    </div>
  `;
}

/** Build the shell inside `root`, replacing whatever was there. */
export function createShell(root: HTMLElement): Shell {
  root.innerHTML = `
    <div class="game">
      <header class="game__header">
        <h1 class="game__title">Mega Tetris</h1>
      </header>

      <main class="game__body" aria-label="Mega Tetris playfield and readouts">
        <div class="rail rail--start">
          <section class="panel panel--score" aria-labelledby="readout-title">
            <h2 class="panel__title" id="readout-title" data-readout-title>Score</h2>
            <p class="score" data-score>0</p>
            <dl class="stats" data-readout-rows>${readoutRowsMarkup()}</dl>
          </section>

          <section class="panel panel--hold">
            <h2 class="panel__title">Hold</h2>
            <canvas class="panel__canvas panel__canvas--hold" data-hold aria-hidden="true"></canvas>
            <p class="visually-hidden" data-hold-text>Hold is empty.</p>
          </section>
        </div>

        <div
          class="playfield"
          tabindex="0"
          role="application"
          aria-label="Playfield"
          aria-describedby="playfield-summary"
          data-playfield
        >
          <canvas
            class="playfield__canvas"
            data-board
            role="img"
            aria-labelledby="playfield-summary"
          ></canvas>
          <p class="countdown" data-countdown aria-hidden="true" hidden></p>
          ${overlayMarkup()}
        </div>

        <div class="rail rail--end">
          <section class="panel panel--next">
            <h2 class="panel__title">Next</h2>
            <canvas class="panel__canvas panel__canvas--next" data-next aria-hidden="true"></canvas>
            <p class="visually-hidden" data-next-text>Next pieces unknown.</p>
          </section>

          <section class="panel panel--controls">
            <h2 class="panel__title">Controls</h2>
            <dl class="controls">${controlsMarkup()}</dl>
          </section>
        </div>

        <!--
          The well in words: the canvas's text alternative, and the playfield's
          description. It lives inside the main landmark, because all page
          content should, and the visually-hidden class takes it out of flow —
          so it costs the layout nothing.
        -->
        <p class="visually-hidden" id="playfield-summary" data-board-summary>
          Playfield. The well is empty and the game is ready to start.
        </p>
      </main>

      <footer class="game__actions">
        <button type="button" class="button button--primary" data-play>Play</button>
        <button type="button" class="button" data-restart>Restart</button>
        <button type="button" class="button" data-help-open>Help</button>
        <!--
          Beside the other actions, in the tab order, and hidden until the
          browser offers an installation. No banner, no modal, nothing over
          the well.
        -->
        <button type="button" class="button button--quiet" data-install hidden>Install</button>
      </footer>

      <!--
        The update offer. A row of its own between the actions and the pad, so
        it can appear mid-game without covering anything or moving the well —
        the field is sized by max-height, and gives way by a few pixels.
        Deliberately *not* a live region: the game has exactly one, and the
        announcement goes through it like every other one.
      -->
      <section class="update" aria-label="New version" data-update hidden>
        <p class="update__text">A new version is ready.</p>
        <div class="update__actions">
          <button type="button" class="button button--primary" data-update-reload>Reload</button>
          <button type="button" class="button button--quiet" data-update-dismiss>Not now</button>
        </div>
      </section>

      <section class="pad" aria-label="On-screen controls" data-pad hidden>
        ${padMarkup()}
      </section>

      <p class="visually-hidden" role="status" aria-live="polite" data-status></p>

      ${pauseDialogMarkup()}
      ${helpDialogMarkup()}
    </div>
  `;

  const header = must<HTMLElement>(root, '.game__header');
  const body = must<HTMLElement>(root, '.game__body');
  const actions = must<HTMLElement>(root, '.game__actions');
  const pad = must<HTMLElement>(root, '[data-pad]');
  const update = must<HTMLElement>(root, '[data-update]');

  return {
    playfield: must<HTMLElement>(root, '[data-playfield]'),
    boardCanvas: must<HTMLCanvasElement>(root, '[data-board]'),
    nextCanvas: must<HTMLCanvasElement>(root, '[data-next]'),
    holdCanvas: must<HTMLCanvasElement>(root, '[data-hold]'),
    boardSummary: must<HTMLElement>(root, '[data-board-summary]'),
    nextText: must<HTMLElement>(root, '[data-next-text]'),
    holdText: must<HTMLElement>(root, '[data-hold-text]'),
    readoutTitle: must<HTMLElement>(root, '[data-readout-title]'),
    score: must<HTMLElement>(root, '[data-score]'),
    readoutRows: must<HTMLElement>(root, '[data-readout-rows]'),
    overlay: must<HTMLElement>(root, '[data-overlay]'),
    overlayEyebrow: must<HTMLElement>(root, '[data-overlay-eyebrow]'),
    overlayTitle: must<HTMLElement>(root, '[data-overlay-title]'),
    overlayHint: must<HTMLElement>(root, '[data-overlay-hint]'),
    overlayRows: must<HTMLElement>(root, '[data-overlay-rows]'),
    overlayNote: must<HTMLElement>(root, '[data-overlay-note]'),
    daily: must<HTMLElement>(root, '[data-daily]'),
    dailyStatus: must<HTMLElement>(root, '[data-daily-status]'),
    dailyStreak: must<HTMLElement>(root, '[data-daily-streak]'),
    dailyCells: Array.from(
      { length: DAILY_HISTORY_DAYS },
      (_, index) => must<HTMLElement>(root, `[data-daily-cell="${index}"]`),
    ),
    dailyPlay: must<HTMLButtonElement>(root, '[data-daily-play]'),
    dailyCopy: must<HTMLButtonElement>(root, '[data-daily-copy]'),
    dailyFallback: must<HTMLElement>(root, '[data-daily-fallback]'),
    dailyShare: must<HTMLTextAreaElement>(root, '[data-daily-share]'),
    overlayStart: must<HTMLElement>(root, '[data-overlay-start]'),
    startLevel: must<HTMLSelectElement>(root, '[data-start-level]'),
    modeButtons: GAME_MODES.map((mode) => must<HTMLButtonElement>(root, `[data-mode="${mode}"]`)),
    overlayHelp: must<HTMLButtonElement>(root, '[data-overlay-help]'),
    overlayButton: must<HTMLButtonElement>(root, '[data-overlay-button]'),
    countdown: must<HTMLElement>(root, '[data-countdown]'),
    playButton: must<HTMLButtonElement>(root, '[data-play]'),
    restartButton: must<HTMLButtonElement>(root, '[data-restart]'),
    helpButton: must<HTMLButtonElement>(root, '[data-help-open]'),
    installButton: must<HTMLButtonElement>(root, '[data-install]'),
    updateBar: update,
    updateReload: must<HTMLButtonElement>(root, '[data-update-reload]'),
    updateDismiss: must<HTMLButtonElement>(root, '[data-update-dismiss]'),
    touchPad: pad,
    padToggle: must<HTMLButtonElement>(root, '[data-pad-toggle]'),
    soundToggle: must<HTMLButtonElement>(root, '[data-sound-toggle]'),
    motionToggle: must<HTMLButtonElement>(root, '[data-motion-toggle]'),
    contrastToggle: must<HTMLButtonElement>(root, '[data-contrast-toggle]'),
    status: must<HTMLElement>(root, '[data-status]'),

    pauseDialog: must<HTMLElement>(root, '[data-pause-dialog]'),
    pauseResume: must<HTMLButtonElement>(root, '[data-pause-resume]'),
    pauseRestart: must<HTMLButtonElement>(root, '[data-pause-restart]'),
    pauseHelp: must<HTMLButtonElement>(root, '[data-pause-help]'),
    pauseClose: must<HTMLButtonElement>(root, '[data-pause-close]'),
    menuStats: must<HTMLElement>(root, '[data-menu-stats]'),
    statsReset: must<HTMLButtonElement>(root, '[data-stats-reset]'),
    statsConfirm: must<HTMLElement>(root, '[data-stats-confirm]'),
    statsConfirmYes: must<HTMLButtonElement>(root, '[data-stats-erase]'),
    statsConfirmNo: must<HTMLButtonElement>(root, '[data-stats-keep]'),
    helpDialog: must<HTMLElement>(root, '[data-help-dialog]'),
    helpPanel: must<HTMLElement>(root, '[data-help-panel]'),
    helpClose: must<HTMLButtonElement>(root, '[data-help-close]'),
    helpDone: must<HTMLButtonElement>(root, '[data-help-done]'),
    // The live region is deliberately *not* here: an announcement must still
    // reach the player while a dialog has the rest of the page inert.
    background: [header, body, actions, update, pad],
  };
}
