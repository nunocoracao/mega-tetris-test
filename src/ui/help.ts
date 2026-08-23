/**
 * The in-game help panel's content.
 *
 * Every row in it is *derived*, not retyped. The keyboard list comes from the
 * `BindingTable` in force — so a rebound key moves this panel with it, and the
 * panel is rebuilt when it does; the scoring table from `LINE_CLEAR_POINTS`, the two spin
 * tables, the combo step, the back-to-back multiplier and the two drop bonuses.
 * Rebinding a key or retuning a score therefore updates the help by itself. A
 * help panel that can drift out of date is worse than no help panel, and the
 * only reliable way to stop it drifting is to have no second copy of the facts.
 * The *words* for a clear come from `ui/hud.ts`, which is where copy lives.
 *
 * The gestures are the exception, and named as one: the recogniser in
 * `ui/touch.ts` codes the *thresholds*, not the sentences, so the sentences
 * live here beside the rest of the copy.
 *
 * The whole file is a pure function of the tables it reads, which is how
 * `help.test.ts` can assert the no-drift property directly. Whether a player has
 * seen the panel before is a stored *setting*, and lives with the rest of them
 * in `ui/storage.ts`.
 */

import {
  BACK_TO_BACK_MULTIPLIER,
  COMBO_POINTS,
  GAME_MODES,
  HARD_DROP_POINTS,
  KICKED_SPIN_POINTS,
  LINE_CLEAR_POINTS,
  SOFT_DROP_POINTS,
  SPIN_POINTS,
} from '../engine';
import { CLEAR_NAMES, CLEAR_SIZES, MODE_BLURBS, MODE_LABELS } from './hud';
import { DEFAULT_BINDINGS, describeBinding, type BindingTable } from './input';

/** One line of the help: what you do on the left, what happens on the right. */
export interface HelpRow {
  /** The keys, the gesture, or the thing you cleared. */
  readonly term: string;
  readonly detail: string;
}

/**
 * The keyboard controls, straight off whichever binding table is in force —
 * so a rebound key changes what this panel says, with no second copy to update.
 */
export function keyboardRows(bindings: BindingTable = DEFAULT_BINDINGS): readonly HelpRow[] {
  return bindings.list.map((binding) => ({
    term: describeBinding(binding),
    detail: binding.label,
  }));
}

/**
 * The gestures over the well. Order matches the pad: the continuous ones
 * first, then the one-shots.
 */
export const TOUCH_GESTURES: readonly HelpRow[] = [
  { term: 'Drag sideways', detail: 'Move, one column per step' },
  { term: 'Drag down', detail: 'Soft drop, one row per step' },
  { term: 'Flick down', detail: 'Hard drop' },
  { term: 'Tap', detail: 'Rotate right' },
  { term: 'Tap the left edge', detail: 'Rotate left' },
  { term: 'Swipe up', detail: 'Hold' },
];

/**
 * The three modes, generated from the engine's own list and the HUD's own copy
 * — so a mode added to `GAME_MODES` appears here without anyone remembering to
 * add it, and its blurb cannot say one thing on the start screen and another in
 * the help panel.
 */
export function modeRows(): readonly HelpRow[] {
  return GAME_MODES.map((mode) => ({ term: MODE_LABELS[mode], detail: MODE_BLURBS[mode] }));
}

/** `'single'` → `'Single'`. The names themselves live in `ui/hud.ts`. */
function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The scoring table, generated from the engine's own numbers.
 *
 * Every figure here — the four clear tiers, both spin tables, the combo step
 * and the back-to-back multiplier — is read out of `src/engine`, so retuning
 * the scoring retunes this panel and there is no second copy to fall out of
 * date. The only thing this file decides is the wording.
 */
export function scoringRows(): readonly HelpRow[] {
  const clears: readonly HelpRow[] = CLEAR_SIZES.map((count) => ({
    term: `${titleCase(CLEAR_NAMES[count])} — ${count} ${count === 1 ? 'line' : 'lines'}`,
    detail: `${LINE_CLEAR_POINTS[count]} × level`,
  }));
  // Every size but the quad: a four-row spin is a shape nothing can make.
  const spins: readonly HelpRow[] = CLEAR_SIZES.filter((count) => count < 4).map((count) => ({
    term: `Spin ${CLEAR_NAMES[count]}`,
    detail: `${SPIN_POINTS[count]} × level, or ${KICKED_SPIN_POINTS[count]} if the turn needed a kick`,
  }));
  return [
    ...clears,
    ...spins,
    {
      term: 'Spin, no lines',
      detail: `${SPIN_POINTS[0]} × level, or ${KICKED_SPIN_POINTS[0]} if the turn needed a kick`,
    },
    {
      term: 'Combo',
      detail: `${COMBO_POINTS} × combo × level, from the second clear of a run onwards`,
    },
    {
      term: 'Back to back',
      detail: `A quad or a spin clear straight after another one scores ${BACK_TO_BACK_MULTIPLIER}×`,
    },
    { term: 'Soft drop', detail: `${SOFT_DROP_POINTS} per row` },
    { term: 'Hard drop', detail: `${HARD_DROP_POINTS} per row` },
  ];
}

/** The mechanics that need a sentence rather than a table row. */
export const MECHANIC_NOTES: readonly HelpRow[] = [
  {
    term: 'Hold',
    detail:
      'Parks the falling piece and brings back whatever was parked. One per piece — the slot dims until you lock.',
  },
  {
    term: 'Ghost',
    detail: 'The hollow outline is where a hard drop lands the piece.',
  },
  {
    term: 'Spin',
    detail:
      'Rotate into a gap you could not slide into, with nowhere left to move. Any piece can, and it scores even with no clear.',
  },
  {
    term: 'Versus',
    detail:
      'Clears send garbage at the other well; yours cancel what is queued against you. The meter shows what is coming. First to top out loses.',
  },
];

/**
 * Watching a run back, and handing one to somebody.
 *
 * The keys named here are the game's own bindings doing a second job while a
 * replay is on the well, so they are read out of `KEY_BINDINGS` rather than
 * retyped — rebind "pause" and this panel follows.
 */
export function replayRows(bindings: BindingTable = DEFAULT_BINDINGS): readonly HelpRow[] {
  const keys = (action: string): string => {
    const binding = bindings.list.find((candidate) => candidate.action === action);
    return binding === undefined ? '' : describeBinding(binding);
  };
  return [
    {
      term: 'Watch replay',
      detail: 'Plays your last run back, exactly as it happened.',
    },
    { term: keys('hardDrop'), detail: 'Play or pause the replay' },
    { term: '1× / 2× / 4×', detail: 'How fast it plays back' },
    { term: keys('restart'), detail: 'Watch it again from the first piece' },
    { term: keys('togglePause'), detail: 'Leave the replay' },
    {
      term: 'Copy replay link',
      detail:
        'A link a friend can watch. Nothing is uploaded; too long, or a match, and it says so.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

/** Our copy is our own, but generated markup should still be safe by default. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One section of the panel: a heading and a description list.
 *
 * A `<dl>` rather than a `<table>` on purpose — these are term/definition
 * pairs, not tabular data with meaningful columns, and a description list
 * survives being reflowed into a narrow phone layout.
 */
function section(id: string, title: string, rows: readonly HelpRow[], termClass: string): string {
  const items = rows
    .map(
      (row) =>
        `<div class="help__row">
           <dt class="${termClass}">${escapeHtml(row.term)}</dt>
           <dd class="help__detail">${escapeHtml(row.detail)}</dd>
         </div>`,
    )
    .join('');
  return `
    <section class="help__section" aria-labelledby="${id}">
      <h3 class="help__heading" id="${id}">${escapeHtml(title)}</h3>
      <dl class="help">${items}</dl>
    </section>
  `;
}

/**
 * The body of the help dialog.
 *
 * Short on purpose: a few sentences and four lists. Anyone who wants a manual
 * has the README; anyone who is mid-game wants to find one key and get out.
 */
export function helpBodyMarkup(bindings: BindingTable = DEFAULT_BINDINGS): string {
  return `
    <p class="help__lede">
      Fill a whole row and it clears and scores. The game speeds up every ten
      lines. Settings remaps every key below and tunes how held ones repeat.
    </p>
    ${section('help-modes', 'Modes', modeRows(), 'help__term')}
    ${section('help-keys', 'Keyboard', keyboardRows(bindings), 'help__keys')}
    ${section('help-touch', 'Touch', TOUCH_GESTURES, 'help__term')}
    ${section('help-scoring', 'Scoring', scoringRows(), 'help__term')}
    ${section('help-mechanics', 'Hold, ghost and spins', MECHANIC_NOTES, 'help__term')}
    ${section('help-replays', 'Replays and sharing', replayRows(bindings), 'help__term')}
  `;
}
