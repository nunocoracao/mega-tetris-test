import { describe, expect, it } from 'vitest';

import { nextFocusIndex } from './dialog';

describe('nextFocusIndex', () => {
  it('stays out of the way in the middle of a dialog', () => {
    // Moving between two elements that are both inside the dialog needs no
    // help, and intercepting it would only break whatever the browser does.
    expect(nextFocusIndex(4, 1, false)).toBeNull();
    expect(nextFocusIndex(4, 2, true)).toBeNull();
  });

  it('wraps forward off the last element', () => {
    expect(nextFocusIndex(4, 3, false)).toBe(0);
  });

  it('wraps backward off the first element', () => {
    expect(nextFocusIndex(4, 0, true)).toBe(3);
  });

  it('pulls focus back in when it is somewhere unexpected', () => {
    expect(nextFocusIndex(4, -1, false)).toBe(0);
    expect(nextFocusIndex(4, -1, true)).toBe(3);
  });

  it('handles a dialog with exactly one focusable thing', () => {
    // Both ends are the same element, so Tab has to stay put rather than
    // escaping — a one-button dialog is the easiest trap to get wrong.
    expect(nextFocusIndex(1, 0, false)).toBe(0);
    expect(nextFocusIndex(1, 0, true)).toBe(0);
  });

  it('has nothing to say about an empty dialog', () => {
    expect(nextFocusIndex(0, -1, false)).toBeNull();
    expect(nextFocusIndex(0, 0, true)).toBeNull();
  });
});
