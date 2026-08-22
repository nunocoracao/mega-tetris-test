/**
 * The in-game help panel's content.
 *
 * Every row in it is *derived*, not retyped. The keyboard list comes from
 * `KEY_BINDINGS`, the scoring table from `LINE_CLEAR_POINTS` and the two drop
 * bonuses, so rebinding a key or retuning a score updates the help by itself.
 * A help panel that can drift out of date is worse than no help panel, and the
 * only reliable way to stop it drifting is to have no second copy of the facts.
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

import { HARD_DROP_POINTS, LINE_CLEAR_POINTS, SOFT_DROP_POINTS } from '../engine';
import { KEY_BINDINGS, describeBinding } from './input';

/** One line of the help: what you do on the left, what happens on the right. */
export interface HelpRow {
  /** The keys, the gesture, or the thing you cleared. */
  readonly term: string;
  readonly detail: string;
}

/** The keyboard controls, straight off the binding table. */
export function keyboardRows(): readonly HelpRow[] {
  return KEY_BINDINGS.map((binding) => ({
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

/** The scoring table, generated from the engine's own numbers. */
export function scoringRows(): readonly HelpRow[] {
  const names: Readonly<Record<1 | 2 | 3 | 4, string>> = {
    1: 'Single',
    2: 'Double',
    3: 'Triple',
    4: 'Quad',
  };
  const clears: readonly HelpRow[] = ([1, 2, 3, 4] as const).map((count) => ({
    term: `${names[count]} — ${count} ${count === 1 ? 'line' : 'lines'}`,
    detail: `${LINE_CLEAR_POINTS[count]} × level`,
  }));
  return [
    ...clears,
    { term: 'Soft drop', detail: `${SOFT_DROP_POINTS} per row` },
    { term: 'Hard drop', detail: `${HARD_DROP_POINTS} per row` },
  ];
}

/** The two mechanics that need a sentence rather than a table row. */
export const MECHANIC_NOTES: readonly HelpRow[] = [
  {
    term: 'Hold',
    detail:
      'Parks the falling piece for later and brings back whatever was already parked. One hold per piece — the slot dims until you lock something.',
  },
  {
    term: 'Ghost',
    detail: 'The hollow outline under the piece is where a hard drop would land it.',
  },
];

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
 * Short on purpose: a few sentences and three lists. Anyone who wants a manual
 * has the README; anyone who is mid-game wants to find one key and get out.
 */
export function helpBodyMarkup(): string {
  return `
    <p class="help__lede">
      Stack the falling pieces so they fill a whole row — full rows clear and
      score. The game speeds up every ten lines.
    </p>
    ${section('help-keys', 'Keyboard', keyboardRows(), 'help__keys')}
    ${section('help-touch', 'Touch', TOUCH_GESTURES, 'help__term')}
    ${section('help-scoring', 'Scoring', scoringRows(), 'help__term')}
    ${section('help-mechanics', 'Hold and ghost', MECHANIC_NOTES, 'help__term')}
  `;
}
