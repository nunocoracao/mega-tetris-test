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

import { BOT_DIFFICULTIES, GAME_MODES } from '../engine';
import { CONTRAST_SETTINGS, contrastSettingLabel } from './contrast';
import { DAILY_HISTORY_DAYS } from './daily';
import { escapeHtml, helpBodyMarkup } from './help';
import {
  MENU_STATS,
  MODE_BLURBS,
  MODE_LABELS,
  OVERLAY_ROW_KEYS,
  OVERLAY_ROW_LABELS,
  READOUT_ROW_KEYS,
  opponentBlurb,
  opponentLabel,
} from './hud';
import {
  ACTION_IDS,
  DEFAULT_BINDINGS,
  DEFAULT_HANDLING,
  HANDLING_BOUNDS,
  actionLabel,
  describeBinding,
  type BindingTable,
} from './input';
import { MOTION_SETTINGS, motionSettingLabel } from './motion';
import { REPLAY_SPEEDS, replaySpeedLabel } from './replay';
import { TRY_COLUMNS, formatMs, type SettingsElements } from './settings';
import { START_LEVELS } from './stats';
import { THEMES, themeLabel, type ThemeId } from './theme';
import { PAD_PREFERENCES, TOUCH_PAD_BUTTONS, padPreferenceLabel } from './touch';
import { METER_SEGMENTS } from './versus';

export interface Shell {
  /**
   * The row the wells live in: the incoming meter, the player's field, and —
   * in Versus — the opponent's.
   *
   * `display: contents` unless a match is on, so in every other mode the
   * playfield is a direct child of `.game__body` exactly as it always was and
   * the layout is untouched to the pixel.
   */
  readonly wells: HTMLElement;
  /** Focusable wrapper around the playfield — the game's keyboard home. */
  readonly playfield: HTMLElement;
  readonly boardCanvas: HTMLCanvasElement;
  /** The charging meter beside the well: what is queued, and how close it is. */
  readonly garbage: HTMLElement;
  readonly garbageCount: HTMLElement;
  /** The meter's blocks, soonest first. Shape *and* colour, never colour alone. */
  readonly garbageSegments: readonly HTMLElement[];
  /** How close the soonest batch is to landing, as a bar. */
  readonly garbageFill: HTMLElement;
  /** The meter in words — the only part of it assistive technology reads. */
  readonly garbageLabel: HTMLElement;
  /** The opponent's well. Decorative: nothing here is a control. */
  readonly opponent: HTMLElement;
  readonly opponentCanvas: HTMLCanvasElement;
  /** One concise sentence, rewritten only at meaningful moments. */
  readonly opponentSummary: HTMLElement;
  /** The name over that well — "Steady", "Quick", "Relentless". */
  readonly opponentTag: HTMLElement;
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
  /** The match's exchange line: how many rows crossed the screen each way. */
  readonly overlayVersus: HTMLElement;
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
  /** The mode buttons, in the order the engine lists them. */
  readonly modeButtons: readonly HTMLButtonElement[];
  /** The opponent picker. Inside the start block, and shown only in Versus. */
  readonly overlayOpponent: HTMLElement;
  /** The three difficulty buttons, easiest first. */
  readonly opponentButtons: readonly HTMLButtonElement[];
  /** The start screen's two quiet buttons: help, and settings. */
  readonly overlayMinor: HTMLElement;
  /** Opens the help panel from the start screen. */
  readonly overlayHelp: HTMLButtonElement;
  /** Opens the settings dialog from the start screen. */
  readonly overlaySettings: HTMLButtonElement;
  readonly overlayButton: HTMLButtonElement;
  /** The 3-2-1 shown over the well on the way back from a pause. */
  readonly countdown: HTMLElement;
  /** "Watch replay" and "Copy replay link", on the run-summary panel. */
  readonly overlayActions: HTMLElement;
  readonly overlayReplay: HTMLButtonElement;
  readonly overlayShare: HTMLButtonElement;
  /** Shown only when the clipboard refuses the replay link. */
  readonly shareFallback: HTMLElement;
  readonly shareText: HTMLTextAreaElement;
  /** The "Replay" stamp over the well. */
  readonly replayBadge: HTMLElement;
  /** The replay bar: what is playing, how far through, and the controls. */
  readonly replayBar: HTMLElement;
  readonly replayTitle: HTMLElement;
  readonly replayDetail: HTMLElement;
  readonly replayFill: HTMLElement;
  readonly replayProgress: HTMLElement;
  readonly replayPlay: HTMLButtonElement;
  /** The 1x / 2x / 4x buttons, in the order `REPLAY_SPEEDS` lists them. */
  readonly replaySpeeds: readonly HTMLButtonElement[];
  readonly replayRestart: HTMLButtonElement;
  readonly replayExit: HTMLButtonElement;
  readonly playButton: HTMLButtonElement;
  readonly restartButton: HTMLButtonElement;
  readonly helpButton: HTMLButtonElement;
  /** Opens the settings dialog from the footer. */
  readonly settingsButton: HTMLButtonElement;
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
  /** The pad's seven buttons, so `applyBindings` can retitle them. */
  readonly padButtons: readonly HTMLButtonElement[];
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
  /** Steps sideways from the pause menu into the settings dialog. */
  readonly pauseSettings: HTMLButtonElement;
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
  /** The help panel's generated body, rewritten when a key is rebound. */
  readonly helpBody: HTMLElement;
  /** The controls card beside the well, likewise. */
  readonly controlsList: HTMLElement;
  readonly settingsDialog: HTMLElement;
  /** Everything inside the settings dialog, for `ui/settings.ts`. */
  readonly settings: SettingsElements;
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
function controlsMarkup(bindings: BindingTable): string {
  return bindings.list
    .map(
      (binding) =>
        `<div class="controls__row">
         <dt class="controls__keys">${escapeHtml(describeBinding(binding))}</dt>
         <dd class="controls__label">${escapeHtml(binding.label)}</dd>
       </div>`,
    )
    .join('');
}

/**
 * Republish the bindings into every place that shows them.
 *
 * Three views, one table: the controls card beside the well, the help panel's
 * keyboard list, and the tooltip on each pad button. None of them keeps a copy,
 * so rebinding a key is one call and cannot half-apply. `src/main.ts` subscribes
 * this to `LiveBindings`.
 */
export function applyBindings(shell: Shell, bindings: BindingTable): void {
  shell.controlsList.innerHTML = controlsMarkup(bindings);
  shell.helpBody.innerHTML = helpBodyMarkup(bindings);
  for (const button of shell.padButtons) {
    const action = button.dataset['padAction'] ?? '';
    const binding = bindings.list.find((candidate) => candidate.action === action);
    if (binding === undefined) {
      continue;
    }
    button.setAttribute('aria-label', binding.label);
    button.title =
      binding.keys.length === 0
        ? binding.label
        : `${binding.label} — ${describeBinding(binding)}`;
  }
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
 * The opponent picker.
 *
 * The mode picker's markup, with a different vocabulary: three real buttons in
 * a labelled group, each carrying `aria-pressed`, each with the machine's own
 * name and a sentence saying what actually changes. The sentence is generated
 * from `BOT_PROFILES` — see `opponentBlurb` — because "hard" tells a player how
 * they are expected to feel and "presses every 22 ms" tells them what they are
 * up against.
 */
function opponentsMarkup(): string {
  return BOT_DIFFICULTIES.map(
    (difficulty) =>
      `<button
         type="button"
         class="mode mode--opponent"
         data-opponent-choice="${difficulty}"
         aria-pressed="false"
       ><span class="mode__name">${escapeHtml(opponentLabel(difficulty))}</span>
        <span class="mode__blurb">${escapeHtml(opponentBlurb(difficulty))}</span></button>`,
  ).join('');
}

/**
 * The incoming meter: what is queued against this well, and how close it is.
 *
 * Three ways of saying one thing, because colour on its own says it to nobody
 * in particular: a **numeral**, a stack of blocks whose **shape** changes as a
 * batch charges up, and a sentence only assistive technology reads. It sits
 * beside the well and never over it — a player who cannot see the field cannot
 * play, and that includes a player whose field is covered by a warning about
 * the field.
 */
function garbageMeterMarkup(): string {
  const segments = Array.from(
    { length: METER_SEGMENTS },
    (_, index) => `<li class="meter__cell" data-garbage-cell="${index}" data-state="empty"></li>`,
  ).join('');
  return `
    <div class="meter" data-garbage hidden>
      <p class="meter__tag" aria-hidden="true">In</p>
      <ol class="meter__stack" aria-hidden="true" data-garbage-stack>${segments}</ol>
      <div class="meter__charge" aria-hidden="true">
        <div class="meter__charge-fill" data-garbage-fill></div>
      </div>
      <p class="meter__count" aria-hidden="true" data-garbage-count>0</p>
      <p class="visually-hidden" data-garbage-label>Nothing incoming.</p>
    </div>
  `;
}

/**
 * The opponent's well.
 *
 * A canvas and two lines of text, and not one control: the player cannot act on
 * this well, so nothing in it is focusable and nothing in it is announced as it
 * happens. The name above it is for eyes only; the sentence below is the
 * canvas's text alternative, and `src/main.ts` rewrites it at the four moments
 * that are worth knowing about rather than sixty times a second.
 */
function opponentMarkup(): string {
  return `
    <div class="opponent" data-opponent hidden>
      <p class="opponent__tag" aria-hidden="true" data-opponent-tag>Opponent</p>
      <canvas
        class="opponent__canvas"
        data-opponent-board
        role="img"
        aria-labelledby="opponent-summary"
      ></canvas>
      <p class="visually-hidden" id="opponent-summary" data-opponent-summary>
        Opponent well. The match has not started.
      </p>
    </div>
  `;
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
      <!-- The match's exchange, on the result screen only: how many rows went
           each way. Hidden in every other mode and on every other panel. -->
      <p class="overlay__versus" data-overlay-versus hidden></p>
      <dl class="runstats" data-overlay-rows hidden>${runStatsMarkup()}</dl>
      <p class="overlay__note" data-overlay-note hidden></p>
      ${dailyMarkup()}
      <div class="overlay__start" data-overlay-start hidden>
        <div class="modes" role="group" aria-label="Game mode">${modesMarkup()}</div>
        <div
          class="modes modes--opponent"
          role="group"
          aria-label="Opponent"
          data-overlay-opponent
          hidden
        >${opponentsMarkup()}</div>
        <label class="level" for="start-level">
          <span class="level__label">Start level</span>
          <select class="level__select" id="start-level" data-start-level>
            ${levelOptionsMarkup()}
          </select>
        </label>
      </div>
      <button type="button" class="button button--primary" data-overlay-button>Play</button>
      <!--
        The two things you can do with a finished run besides playing another
        one: watch it, and hand it to somebody. Both are hidden until there is
        a run to watch, and the share button turns into an honest sentence when
        the run is too long to fit in a link.
      -->
      <div class="overlay__actions" data-overlay-actions hidden>
        <button type="button" class="button button--quiet" data-overlay-replay>
          Watch replay
        </button>
        <button type="button" class="button button--quiet" data-overlay-share>
          Copy replay link
        </button>
      </div>
      <div class="overlay__minor" data-overlay-minor hidden>
        <button type="button" class="button button--quiet" data-overlay-help>
          How to play
        </button>
        <button type="button" class="button button--quiet" data-overlay-settings>
          Settings
        </button>
      </div>
      <!--
        The clipboard's fallback, the same arrangement the daily block uses and
        for the same reason: the clipboard is a permission, not a guarantee.
        A textarea rather than an input, because a URL this long deserves more
        than one line to be selected in.

        (No backticks in this comment, and none in any other markup comment
        here: a backtick inside an HTML comment inside a template literal ends
        the template.)
      -->
      <div class="share" data-share-fallback hidden>
        <label class="share__label" for="share-link">Copy this link</label>
        <textarea class="share__text" id="share-link" data-share-text rows="3" readonly></textarea>
      </div>
    </div>
  `;
}

/**
 * The replay bar.
 *
 * A row of its own under the actions, never a floating panel over the well: the
 * whole point of a replay is watching the field, and a control strip that
 * covered any of it would be self-defeating. It follows the update notice's
 * pattern — a real `<section>` with a label, so its contents are inside a
 * landmark rather than orphaned, and `hidden` when there is nothing to watch.
 *
 * Every control is a real button. The speed picker carries `aria-pressed` the
 * way the mode picker does, so "currently 2×" is a fact rather than a colour.
 */
function replayBarMarkup(): string {
  const speeds = REPLAY_SPEEDS.map(
    (speed) =>
      `<button
         type="button"
         class="button button--quiet replay__speed"
         data-replay-speed="${speed}"
         aria-pressed="${speed === 1}"
       >${replaySpeedLabel(speed)}</button>`,
  ).join('');

  return `
    <section class="replay" aria-label="Replay" data-replay hidden>
      <p class="replay__heading">
        <span class="replay__badge">Replay</span>
        <span class="replay__title" data-replay-title></span>
      </p>
      <p class="replay__detail" data-replay-detail></p>
      <div class="replay__track" data-replay-track aria-hidden="true">
        <div class="replay__fill" data-replay-fill></div>
      </div>
      <p class="replay__time" data-replay-progress></p>
      <div class="replay__actions">
        <button type="button" class="button button--primary" data-replay-play>Pause</button>
        <div class="replay__speeds" role="group" aria-label="Playback speed">${speeds}</div>
        <button type="button" class="button button--quiet" data-replay-restart>
          Start over
        </button>
        <button type="button" class="button" data-replay-exit>Leave replay</button>
      </div>
    </section>
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
        <!--
          The four quick toggles stay here even though the settings dialog has
          the same four in labelled groups. Mid-run, "turn the sound off" should
          be one tap from the pause menu, not two dialogs deep — and neither
          copy holds any state: both write through the same accessor.
        -->
        <section class="modal__section" aria-labelledby="pause-settings-title">
          <h3 class="modal__heading" id="pause-settings-title">Settings</h3>
          <div class="settings">
            <button type="button" class="button button--quiet" data-sound-toggle>Sound: On</button>
            <button type="button" class="button button--quiet" data-motion-toggle>Effects: Auto</button>
            <button type="button" class="button button--quiet" data-contrast-toggle>Contrast: Auto</button>
            <button type="button" class="button button--quiet" data-pad-toggle>Touchpad: Auto</button>
            <button type="button" class="button button--quiet" data-pause-settings>
              Keys and handling…
            </button>
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

/**
 * One three-way preference, as a radio group.
 *
 * Radios rather than the footer's cycling button: a dialog has room to show all
 * three answers at once, and "which of these is chosen" is a thing a radio group
 * says out loud without anybody having to press it to find out. The labels come
 * from the module that owns each vocabulary, so there is no second copy of the
 * word "Reduced" anywhere.
 */
function choiceMarkup(
  name: string,
  legend: string,
  hint: string,
  values: readonly string[],
  label: (value: string) => string,
  /** Extra markup between the radio and its name — the theme picker's swatch. */
  decorate: (value: string) => string = () => '',
): string {
  const options = values
    .map(
      (value) =>
        `<label class="choice__option">
           <input type="radio" name="settings-${name}" value="${escapeHtml(value)}" data-choice="${name}">
           ${decorate(value)}
           <span class="choice__name">${escapeHtml(label(value))}</span>
         </label>`,
    )
    .join('');
  return `
    <fieldset class="choice">
      <legend class="choice__legend">${escapeHtml(legend)}</legend>
      <div class="choice__options">${options}</div>
      <p class="choice__hint">${escapeHtml(hint)}</p>
    </fieldset>
  `;
}

/**
 * A skin in miniature: the well it is played in, and four of its seven faces.
 *
 * The chip carries the skin's own `data-theme`, and `src/style.css` declares
 * every skin against `.swatch[data-theme='…']` as well as against `:root` — so
 * the swatch is painted by the very declarations the cabinet would use, and
 * cannot drift from the thing it is advertising.
 *
 * `aria-hidden`, deliberately: the name beside it is the accessible label, and
 * four coloured squares are decoration to anyone who has to be told about them.
 */
function swatchMarkup(theme: ThemeId): string {
  const chips = ['i', 'o', 't', 'z']
    .map((kind) => `<span class="swatch__chip swatch__chip--${kind}"></span>`)
    .join('');
  return `<span class="swatch" data-theme="${escapeHtml(theme)}" aria-hidden="true">${chips}</span>`;
}

/** One handling slider, its units and its explanation. */
function sliderMarkup(): string {
  return HANDLING_BOUNDS.map((bound) => {
    const id = `handling-${bound.key}`;
    return `
      <div class="slider">
        <label class="slider__label" for="${id}">${escapeHtml(bound.label)}</label>
        <!-- The number sits beside the name rather than under the track, so
             the value can be read without following the thumb. -->
        <output class="slider__value" for="${id}" data-handling-value="${bound.key}">${escapeHtml(
          formatMs(DEFAULT_HANDLING[bound.key]),
        )}</output>
        <input
          class="slider__input"
          type="range"
          id="${id}"
          data-handling="${bound.key}"
          min="${bound.min}"
          max="${bound.max}"
          step="${bound.step}"
          value="${DEFAULT_HANDLING[bound.key]}"
          aria-describedby="${id}-hint"
        >
        <p class="slider__hint" id="${id}-hint">${escapeHtml(bound.hint)}</p>
      </div>
    `;
  }).join('');
}

/**
 * The try-it strip: the sliders' output, in a form you can feel.
 *
 * A number in milliseconds means nothing until a block moves at it. The strip
 * borrows the game's own repeat clock and the player's own move keys, so what
 * happens here is exactly what will happen to a piece — and the two buttons
 * beside it make that true on a phone as well, where there is no key to hold.
 */
function tryMarkup(): string {
  const cells = Array.from(
    { length: TRY_COLUMNS },
    () => '<span class="try__cell"></span>',
  ).join('');
  return `
    <div class="try">
      <p class="try__hint" id="try-hint">
        Hold your move keys here — or the arrows beside it — to feel the numbers above.
      </p>
      <div class="try__row">
        <button
          type="button"
          class="button button--quiet try__button"
          data-try-button="moveLeft"
          aria-label="Try moving left"
        ><span aria-hidden="true">◀</span></button>
        <div
          class="try__field"
          tabindex="0"
          role="application"
          aria-label="Handling tryout"
          aria-describedby="try-hint"
          data-try-field
        >
          <span class="try__track" aria-hidden="true">${cells}</span>
          <span class="try__block" aria-hidden="true" data-try-block></span>
        </div>
        <button
          type="button"
          class="button button--quiet try__button"
          data-try-button="moveRight"
          aria-label="Try moving right"
        ><span aria-hidden="true">▶</span></button>
      </div>
    </div>
  `;
}

/**
 * One row of the key remapper: what it does, what it answers to, and the two
 * buttons that change it. The keys themselves are written in by
 * `ui/settings.ts` — they move, and the row does not.
 */
function keymapMarkup(): string {
  return ACTION_IDS.map((action) => {
    const label = actionLabel(action);
    return `
      <li class="keyrow" data-key-row="${action}">
        <span class="keyrow__action">${escapeHtml(label)}</span>
        <span class="keyrow__keys" data-key-keys="${action}"></span>
        <span class="keyrow__buttons">
          <button
            type="button"
            class="button button--quiet keyrow__button"
            data-key-bind="${action}"
            aria-pressed="false"
            aria-label="Add a key for ${escapeHtml(label)}"
          >Add key</button>
          <button
            type="button"
            class="button button--quiet keyrow__button"
            data-key-reset="${action}"
            aria-label="Reset ${escapeHtml(label)} to its default keys"
          >Default</button>
        </span>
      </li>
    `;
  }).join('');
}

/**
 * The settings dialog.
 *
 * A dialog rather than a screen: the game underneath is untouched, which is
 * what lets a player open it mid-run, move DAS by ten milliseconds and carry on
 * with the same piece still where they left it.
 *
 * The four quick toggles stay in the pause menu as well as living here. That is
 * a deliberate duplication of *controls* and not of state — both write through
 * the same accessor — because a player who paused to turn the sound off should
 * not have to open a second dialog to do it.
 */
function settingsDialogMarkup(): string {
  return `
    <div class="modal" data-settings-dialog hidden>
      <div
        class="modal__panel modal__panel--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabindex="-1"
        data-settings-panel
      >
        ${closeButtonMarkup('data-settings-close', 'Close settings')}
        <h2 class="modal__title" id="settings-title">Settings</h2>

        <section class="modal__section" aria-labelledby="settings-cabinet-title">
          <h3 class="modal__heading" id="settings-cabinet-title">Cabinet</h3>
          <label class="switch">
            <input type="checkbox" data-settings-sound checked>
            <span class="switch__name">Sound effects</span>
          </label>
          ${choiceMarkup(
            'motion',
            'Effects',
            'Auto follows your system’s reduced-motion setting.',
            MOTION_SETTINGS,
            (value) => motionSettingLabel(value as (typeof MOTION_SETTINGS)[number]),
          )}
          ${choiceMarkup(
            'contrast',
            'Contrast',
            'Auto follows your system. High thickens every block outline and marks each piece.',
            CONTRAST_SETTINGS,
            (value) => contrastSettingLabel(value as (typeof CONTRAST_SETTINGS)[number]),
          )}
          ${choiceMarkup(
            'theme',
            'Cabinet skin',
            'Colour only — the rules never change. Every skin passes the same contrast checks, in both contrast modes.',
            THEMES.map((theme) => theme.id),
            (value) => themeLabel(value as ThemeId),
            (value) => swatchMarkup(value as ThemeId),
          )}
          ${choiceMarkup(
            'pad',
            'On-screen pad',
            'Auto shows the pad on touch or narrow screens.',
            PAD_PREFERENCES,
            (value) => padPreferenceLabel(value as (typeof PAD_PREFERENCES)[number]),
          )}
        </section>

        <section class="modal__section" aria-labelledby="settings-handling-title">
          <h3 class="modal__heading" id="settings-handling-title">Handling</h3>
          ${sliderMarkup()}
          ${tryMarkup()}
          <div class="settings">
            <button type="button" class="button button--quiet" data-handling-reset>
              Reset handling
            </button>
          </div>
        </section>

        <section class="modal__section" aria-labelledby="settings-keys-title">
          <h3 class="modal__heading" id="settings-keys-title">Keys</h3>
          <p class="modal__foot">
            Add a key, then press the one you want. A key already in use is
            refused rather than stolen — clear it from the other row first.
          </p>
          <!--
            The one line that explains what just happened: a conflict, a
            reserved key, a capture waiting. Deliberately not a live region —
            the game has exactly one, and every sentence written here goes
            through it as well.
          -->
          <p class="settings__message" data-settings-message></p>
          <ul class="keymap" data-keymap>${keymapMarkup()}</ul>
          <div class="settings">
            <button type="button" class="button button--quiet" data-keys-reset>
              Reset every key
            </button>
          </div>
        </section>

        <section class="modal__section" aria-labelledby="settings-reset-title">
          <h3 class="modal__heading" id="settings-reset-title">Start over</h3>
          <div class="settings">
            <button type="button" class="button button--quiet" data-settings-reset>
              Reset all settings…
            </button>
          </div>
          <!-- Two steps, exactly as the record book's reset has. -->
          <div class="confirm" data-settings-confirm hidden>
            <p class="confirm__text">
              Put every setting — keys, handling, sound, effects, contrast and
              pad — back to the way it shipped? Your personal bests are not
              touched.
            </p>
            <div class="modal__actions">
              <button type="button" class="button button--primary" data-settings-keep>
                Keep mine
              </button>
              <button type="button" class="button" data-settings-erase>Reset everything</button>
            </div>
          </div>
        </section>

        <div class="modal__actions">
          <button type="button" class="button button--primary" data-settings-done>Done</button>
        </div>
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
        <div class="modal__body" data-help-body>${helpBodyMarkup()}</div>
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

        <!--
          The wells, and what passes between them. This wrapper is
          display: contents in every mode but Versus, so the playfield is a
          direct child of the body grid exactly as it has always been and no
          other layout moves by a pixel. In a match it becomes a real row: the
          incoming meter, the player's field at full size, and the opponent's
          beside it at a fraction of it.
        -->
        <div class="wells" data-wells>
          ${garbageMeterMarkup()}
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
            <!--
              A replay must never be mistaken for a live game. This is the
              visible half of saying so — the other halves are the tinted field
              frame that the root data-replay attribute turns on, the bar under
              the well, and the playfield's own label and description. The badge
              itself is hidden from assistive technology: the bar below already
              says "Replay" out loud, and twice would be twice.
            -->
            <p class="field-badge" data-replay-badge aria-hidden="true" hidden>Replay</p>
            ${overlayMarkup()}
          </div>
          ${opponentMarkup()}
        </div>

        <div class="rail rail--end">
          <section class="panel panel--next">
            <h2 class="panel__title">Next</h2>
            <canvas class="panel__canvas panel__canvas--next" data-next aria-hidden="true"></canvas>
            <p class="visually-hidden" data-next-text>Next pieces unknown.</p>
          </section>

          <section class="panel panel--controls">
            <h2 class="panel__title">Controls</h2>
            <dl class="controls" data-controls-list>${controlsMarkup(DEFAULT_BINDINGS)}</dl>
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
        <button type="button" class="button" data-settings-open>Settings</button>
        <!--
          Beside the other actions, in the tab order, and hidden until the
          browser offers an installation. No banner, no modal, nothing over
          the well.
        -->
        <button type="button" class="button button--quiet" data-install hidden>Install</button>
      </footer>

      ${replayBarMarkup()}

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
      ${settingsDialogMarkup()}
    </div>
  `;

  const header = must<HTMLElement>(root, '.game__header');
  const body = must<HTMLElement>(root, '.game__body');
  const actions = must<HTMLElement>(root, '.game__actions');
  const pad = must<HTMLElement>(root, '[data-pad]');
  const update = must<HTMLElement>(root, '[data-update]');
  const replay = must<HTMLElement>(root, '[data-replay]');

  return {
    wells: must<HTMLElement>(root, '[data-wells]'),
    playfield: must<HTMLElement>(root, '[data-playfield]'),
    boardCanvas: must<HTMLCanvasElement>(root, '[data-board]'),
    garbage: must<HTMLElement>(root, '[data-garbage]'),
    garbageCount: must<HTMLElement>(root, '[data-garbage-count]'),
    garbageSegments: Array.from({ length: METER_SEGMENTS }, (_, index) =>
      must<HTMLElement>(root, `[data-garbage-cell="${index}"]`),
    ),
    garbageFill: must<HTMLElement>(root, '[data-garbage-fill]'),
    garbageLabel: must<HTMLElement>(root, '[data-garbage-label]'),
    opponent: must<HTMLElement>(root, '[data-opponent]'),
    opponentCanvas: must<HTMLCanvasElement>(root, '[data-opponent-board]'),
    opponentSummary: must<HTMLElement>(root, '[data-opponent-summary]'),
    opponentTag: must<HTMLElement>(root, '[data-opponent-tag]'),
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
    overlayVersus: must<HTMLElement>(root, '[data-overlay-versus]'),
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
    overlayOpponent: must<HTMLElement>(root, '[data-overlay-opponent]'),
    opponentButtons: BOT_DIFFICULTIES.map((difficulty) =>
      must<HTMLButtonElement>(root, `[data-opponent-choice="${difficulty}"]`),
    ),
    overlayMinor: must<HTMLElement>(root, '[data-overlay-minor]'),
    overlayHelp: must<HTMLButtonElement>(root, '[data-overlay-help]'),
    overlaySettings: must<HTMLButtonElement>(root, '[data-overlay-settings]'),
    overlayButton: must<HTMLButtonElement>(root, '[data-overlay-button]'),
    countdown: must<HTMLElement>(root, '[data-countdown]'),
    overlayActions: must<HTMLElement>(root, '[data-overlay-actions]'),
    overlayReplay: must<HTMLButtonElement>(root, '[data-overlay-replay]'),
    overlayShare: must<HTMLButtonElement>(root, '[data-overlay-share]'),
    shareFallback: must<HTMLElement>(root, '[data-share-fallback]'),
    shareText: must<HTMLTextAreaElement>(root, '[data-share-text]'),
    replayBadge: must<HTMLElement>(root, '[data-replay-badge]'),
    replayBar: replay,
    replayTitle: must<HTMLElement>(root, '[data-replay-title]'),
    replayDetail: must<HTMLElement>(root, '[data-replay-detail]'),
    replayFill: must<HTMLElement>(root, '[data-replay-fill]'),
    replayProgress: must<HTMLElement>(root, '[data-replay-progress]'),
    replayPlay: must<HTMLButtonElement>(root, '[data-replay-play]'),
    replaySpeeds: REPLAY_SPEEDS.map((speed) =>
      must<HTMLButtonElement>(root, `[data-replay-speed="${speed}"]`),
    ),
    replayRestart: must<HTMLButtonElement>(root, '[data-replay-restart]'),
    replayExit: must<HTMLButtonElement>(root, '[data-replay-exit]'),
    playButton: must<HTMLButtonElement>(root, '[data-play]'),
    restartButton: must<HTMLButtonElement>(root, '[data-restart]'),
    helpButton: must<HTMLButtonElement>(root, '[data-help-open]'),
    settingsButton: must<HTMLButtonElement>(root, '[data-settings-open]'),
    installButton: must<HTMLButtonElement>(root, '[data-install]'),
    updateBar: update,
    updateReload: must<HTMLButtonElement>(root, '[data-update-reload]'),
    updateDismiss: must<HTMLButtonElement>(root, '[data-update-dismiss]'),
    touchPad: pad,
    padButtons: [...pad.querySelectorAll<HTMLButtonElement>('[data-pad-action]')],
    padToggle: must<HTMLButtonElement>(root, '[data-pad-toggle]'),
    soundToggle: must<HTMLButtonElement>(root, '[data-sound-toggle]'),
    motionToggle: must<HTMLButtonElement>(root, '[data-motion-toggle]'),
    contrastToggle: must<HTMLButtonElement>(root, '[data-contrast-toggle]'),
    status: must<HTMLElement>(root, '[data-status]'),

    pauseDialog: must<HTMLElement>(root, '[data-pause-dialog]'),
    pauseResume: must<HTMLButtonElement>(root, '[data-pause-resume]'),
    pauseRestart: must<HTMLButtonElement>(root, '[data-pause-restart]'),
    pauseHelp: must<HTMLButtonElement>(root, '[data-pause-help]'),
    pauseSettings: must<HTMLButtonElement>(root, '[data-pause-settings]'),
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
    helpBody: must<HTMLElement>(root, '[data-help-body]'),
    controlsList: must<HTMLElement>(root, '[data-controls-list]'),
    settingsDialog: must<HTMLElement>(root, '[data-settings-dialog]'),
    settings: {
      dialog: must<HTMLElement>(root, '[data-settings-dialog]'),
      panel: must<HTMLElement>(root, '[data-settings-panel]'),
      close: must<HTMLButtonElement>(root, '[data-settings-close]'),
      done: must<HTMLButtonElement>(root, '[data-settings-done]'),
      message: must<HTMLElement>(root, '[data-settings-message]'),
      soundInput: must<HTMLInputElement>(root, '[data-settings-sound]'),
      motionInputs: [...root.querySelectorAll<HTMLInputElement>('[data-choice="motion"]')],
      contrastInputs: [...root.querySelectorAll<HTMLInputElement>('[data-choice="contrast"]')],
      themeInputs: [...root.querySelectorAll<HTMLInputElement>('[data-choice="theme"]')],
      padInputs: [...root.querySelectorAll<HTMLInputElement>('[data-choice="pad"]')],
      handlingInputs: HANDLING_BOUNDS.map((bound) =>
        must<HTMLInputElement>(root, `[data-handling="${bound.key}"]`),
      ),
      handlingValues: HANDLING_BOUNDS.map((bound) =>
        must<HTMLElement>(root, `[data-handling-value="${bound.key}"]`),
      ),
      handlingReset: must<HTMLButtonElement>(root, '[data-handling-reset]'),
      tryField: must<HTMLElement>(root, '[data-try-field]'),
      tryBlock: must<HTMLElement>(root, '[data-try-block]'),
      tryButtons: [...root.querySelectorAll<HTMLButtonElement>('[data-try-button]')],
      keymap: must<HTMLElement>(root, '[data-keymap]'),
      keysReset: must<HTMLButtonElement>(root, '[data-keys-reset]'),
      resetAsk: must<HTMLButtonElement>(root, '[data-settings-reset]'),
      resetConfirm: must<HTMLElement>(root, '[data-settings-confirm]'),
      resetYes: must<HTMLButtonElement>(root, '[data-settings-erase]'),
      resetNo: must<HTMLButtonElement>(root, '[data-settings-keep]'),
    },
    // The live region is deliberately *not* here: an announcement must still
    // reach the player while a dialog has the rest of the page inert.
    background: [header, body, actions, replay, update, pad],
  };
}
