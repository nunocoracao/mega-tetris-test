/**
 * The DOM shell: every element the game needs, built once.
 *
 * Real markup, not divs pretending to be markup — the readouts are a
 * description list, the panels are sections with headings, the controls are
 * buttons, and status changes are announced through a polite live region. The
 * canvases are decorative in the accessibility tree only in the sense that
 * their meaning is carried by the readouts and announcements beside them.
 *
 * Nothing here knows the game rules; it builds the furniture and hands back
 * references to it.
 */

import { KEY_BINDINGS, describeBinding } from './input';
import { TOUCH_PAD_BUTTONS } from './touch';

export interface Shell {
  /** Focusable wrapper around the playfield — the game's keyboard home. */
  readonly playfield: HTMLElement;
  readonly boardCanvas: HTMLCanvasElement;
  readonly nextCanvas: HTMLCanvasElement;
  readonly holdCanvas: HTMLCanvasElement;
  readonly score: HTMLElement;
  readonly level: HTMLElement;
  readonly lines: HTMLElement;
  readonly overlay: HTMLElement;
  readonly overlayTitle: HTMLElement;
  readonly overlayHint: HTMLElement;
  readonly overlayButton: HTMLButtonElement;
  readonly playButton: HTMLButtonElement;
  readonly restartButton: HTMLButtonElement;
  /** The on-screen control pad. Hidden or shown by `ui/touch.ts`. */
  readonly touchPad: HTMLElement;
  /** Cycles the pad between auto, forced on and forced off. */
  readonly padToggle: HTMLButtonElement;
  /** `aria-live="polite"` region for pauses, level ups and game over. */
  readonly status: HTMLElement;
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

/** Build the shell inside `root`, replacing whatever was there. */
export function createShell(root: HTMLElement): Shell {
  root.innerHTML = `
    <div class="game">
      <header class="game__header">
        <h1 class="game__title">Mega Tetris</h1>
      </header>

      <div class="game__body">
        <aside class="rail rail--start">
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
            <canvas class="panel__canvas panel__canvas--hold" data-hold></canvas>
          </section>
        </aside>

        <div class="playfield" tabindex="0" role="application" aria-label="Playfield. Use the arrow keys, or drag and tap, to move and rotate." data-playfield>
          <canvas class="playfield__canvas" data-board aria-hidden="true"></canvas>
          <div class="overlay" data-overlay hidden>
            <p class="overlay__title" data-overlay-title></p>
            <p class="overlay__hint" data-overlay-hint></p>
            <button type="button" class="button button--primary" data-overlay-button></button>
          </div>
        </div>

        <aside class="rail rail--end">
          <section class="panel panel--next">
            <h2 class="panel__title">Next</h2>
            <canvas class="panel__canvas panel__canvas--next" data-next></canvas>
          </section>

          <section class="panel panel--controls">
            <h2 class="panel__title">Controls</h2>
            <dl class="controls">${controlsMarkup()}</dl>
          </section>
        </aside>
      </div>

      <div class="game__actions">
        <button type="button" class="button button--primary" data-play>Play</button>
        <button type="button" class="button" data-restart>Restart</button>
        <button type="button" class="button button--quiet" data-pad-toggle>Touchpad: Auto</button>
      </div>

      <section class="pad" aria-label="On-screen controls" data-pad hidden>
        ${padMarkup()}
      </section>

      <p class="visually-hidden" role="status" aria-live="polite" data-status></p>
    </div>
  `;

  return {
    playfield: must<HTMLElement>(root, '[data-playfield]'),
    boardCanvas: must<HTMLCanvasElement>(root, '[data-board]'),
    nextCanvas: must<HTMLCanvasElement>(root, '[data-next]'),
    holdCanvas: must<HTMLCanvasElement>(root, '[data-hold]'),
    score: must<HTMLElement>(root, '[data-score]'),
    level: must<HTMLElement>(root, '[data-level]'),
    lines: must<HTMLElement>(root, '[data-lines]'),
    overlay: must<HTMLElement>(root, '[data-overlay]'),
    overlayTitle: must<HTMLElement>(root, '[data-overlay-title]'),
    overlayHint: must<HTMLElement>(root, '[data-overlay-hint]'),
    overlayButton: must<HTMLButtonElement>(root, '[data-overlay-button]'),
    playButton: must<HTMLButtonElement>(root, '[data-play]'),
    restartButton: must<HTMLButtonElement>(root, '[data-restart]'),
    touchPad: must<HTMLElement>(root, '[data-pad]'),
    padToggle: must<HTMLButtonElement>(root, '[data-pad-toggle]'),
    status: must<HTMLElement>(root, '[data-status]'),
  };
}
