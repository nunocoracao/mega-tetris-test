import { describe, expect, it } from 'vitest';

import { HARD_DROP_POINTS, LINE_CLEAR_POINTS, SOFT_DROP_POINTS } from '../engine';
import {
  MECHANIC_NOTES,
  TOUCH_GESTURES,
  escapeHtml,
  helpBodyMarkup,
  keyboardRows,
  scoringRows,
} from './help';
import { KEY_BINDINGS, describeBinding } from './input';

describe('keyboardRows', () => {
  it('is the binding table, not a copy of it', () => {
    // The whole reason this function exists: a help panel that can drift out of
    // date is worse than no help panel. Rebinding a key must move this list.
    expect(keyboardRows()).toEqual(
      KEY_BINDINGS.map((binding) => ({ term: describeBinding(binding), detail: binding.label })),
    );
  });

  it('covers every binding, in the order the table lists them', () => {
    expect(keyboardRows()).toHaveLength(KEY_BINDINGS.length);
    expect(keyboardRows()[0]?.detail).toBe(KEY_BINDINGS[0]?.label);
  });
});

describe('scoringRows', () => {
  it('takes its numbers from the engine', () => {
    const rows = scoringRows();

    for (const count of [1, 2, 3, 4] as const) {
      const row = rows.find((candidate) => candidate.term.includes(`${count} line`));
      expect(row?.detail).toBe(`${LINE_CLEAR_POINTS[count]} × level`);
    }
    expect(rows.find((row) => row.term === 'Soft drop')?.detail).toBe(
      `${SOFT_DROP_POINTS} per row`,
    );
    expect(rows.find((row) => row.term === 'Hard drop')?.detail).toBe(
      `${HARD_DROP_POINTS} per row`,
    );
  });
});

describe('escapeHtml', () => {
  it('neutralises the four characters that matter', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });

  it('leaves ordinary copy alone', () => {
    expect(escapeHtml('Rotate right')).toBe('Rotate right');
  });
});

describe('helpBodyMarkup', () => {
  const markup = helpBodyMarkup();

  it('lists every key from the binding table', () => {
    for (const binding of KEY_BINDINGS) {
      expect(markup).toContain(escapeHtml(describeBinding(binding)));
      expect(markup).toContain(escapeHtml(binding.label));
    }
  });

  it('covers the gestures, the scoring and the two mechanics', () => {
    for (const row of [...TOUCH_GESTURES, ...scoringRows(), ...MECHANIC_NOTES]) {
      expect(markup).toContain(escapeHtml(row.term));
    }
  });

  it('uses headings one level below the dialog title', () => {
    // The dialog is labelled by an <h2>, so its sections are <h3>s: the outline
    // has to keep going down one step at a time.
    expect(markup).toContain('<h3');
    expect(markup).not.toContain('<h1');
    expect(markup).not.toContain('<h2');
  });

  it('stays short enough to scan', () => {
    // A guard rail, not a rule: the help panel is meant to be a page, not a
    // manual. If this trips, the extra prose probably belongs in the README.
    const words = markup.replace(/<[^>]+>/g, ' ').trim().split(/\s+/);

    expect(words.length).toBeLessThan(320);
  });
});
