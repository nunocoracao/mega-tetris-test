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

import { helpBodyMarkup } from './help';
import { KEY_BINDINGS, describeBinding } from './input';
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
  readonly score: HTMLElement;
  readonly level: HTMLElement;
  readonly lines: HTMLElement;
  readonly overlay: HTMLElement;
  readonly overlayTitle: HTMLElement;
  readonly overlayHint: HTMLElement;
  readonly overlayButton: HTMLButtonElement;
  /** The 3-2-1 shown over the well on the way back from a pause. */
  readonly countdown: HTMLElement;
  readonly playButton: HTMLButtonElement;
  readonly restartButton: HTMLButtonElement;
  readonly helpButton: HTMLButtonElement;
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
          <section class="panel panel--score">
            <h2 class="panel__title">Score</h2>
            <p class="score" data-score>0</p>
            <dl class="stats">
              <div class="stats__row">
                <dt class="stats__label">Level</dt>
                <dd class="stats__value" data-level>1</dd>
              </div>
              <div class="stats__row">
                <dt class="stats__label">Lines</dt>
                <dd class="stats__value" data-lines>0</dd>
              </div>
            </dl>
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
          <div class="overlay" data-overlay hidden>
            <p class="overlay__title" data-overlay-title></p>
            <p class="overlay__hint" data-overlay-hint></p>
            <!-- Seeded with the copy the 'ready' state uses, so the control has
                 a name from the first parse rather than from the first paint. -->
            <button type="button" class="button button--primary" data-overlay-button>Play</button>
          </div>
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
      </footer>

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

  return {
    playfield: must<HTMLElement>(root, '[data-playfield]'),
    boardCanvas: must<HTMLCanvasElement>(root, '[data-board]'),
    nextCanvas: must<HTMLCanvasElement>(root, '[data-next]'),
    holdCanvas: must<HTMLCanvasElement>(root, '[data-hold]'),
    boardSummary: must<HTMLElement>(root, '[data-board-summary]'),
    nextText: must<HTMLElement>(root, '[data-next-text]'),
    holdText: must<HTMLElement>(root, '[data-hold-text]'),
    score: must<HTMLElement>(root, '[data-score]'),
    level: must<HTMLElement>(root, '[data-level]'),
    lines: must<HTMLElement>(root, '[data-lines]'),
    overlay: must<HTMLElement>(root, '[data-overlay]'),
    overlayTitle: must<HTMLElement>(root, '[data-overlay-title]'),
    overlayHint: must<HTMLElement>(root, '[data-overlay-hint]'),
    overlayButton: must<HTMLButtonElement>(root, '[data-overlay-button]'),
    countdown: must<HTMLElement>(root, '[data-countdown]'),
    playButton: must<HTMLButtonElement>(root, '[data-play]'),
    restartButton: must<HTMLButtonElement>(root, '[data-restart]'),
    helpButton: must<HTMLButtonElement>(root, '[data-help-open]'),
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
    helpDialog: must<HTMLElement>(root, '[data-help-dialog]'),
    helpPanel: must<HTMLElement>(root, '[data-help-panel]'),
    helpClose: must<HTMLButtonElement>(root, '[data-help-close]'),
    helpDone: must<HTMLButtonElement>(root, '[data-help-done]'),
    // The live region is deliberately *not* here: an announcement must still
    // reach the player while a dialog has the rest of the page inert.
    background: [header, body, actions, pad],
  };
}
