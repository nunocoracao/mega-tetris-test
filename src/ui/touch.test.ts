import { describe, expect, it } from 'vitest';

import {
  CCW_ZONE_FRACTION,
  HARD_DROP_MIN_CELLS,
  HOLD_SWIPE_CELLS,
  MOVE_STEP_CELLS,
  PAD_PREFERENCES,
  SOFT_DROP_STEP_CELLS,
  TAP_MAX_MS,
  TOUCH_ACTIONS,
  TOUCH_PAD_BUTTONS,
  createGestureRecognizer,
  isPadVisible,
  nextPadPreference,
  padPreferenceLabel,
  parsePadPreference,
  type GesturePointer,
  type GestureRecognizer,
  type TouchAction,
} from './touch';

/**
 * A synthetic finger. The recogniser reads four fields off a pointer event and
 * nothing else, so a plain object is a complete stand-in for one — which is the
 * whole reason the recogniser is kept free of the DOM.
 */
const CELL = 20;
const WIDTH = CELL * 10;

/** Threshold distances in pixels, derived the way the recogniser derives them. */
const MOVE = MOVE_STEP_CELLS * CELL;
const SOFT = SOFT_DROP_STEP_CELLS * CELL;

interface Finger {
  readonly id: number;
  x: number;
  y: number;
  t: number;
}

function finger(x: number, y: number, options: { id?: number; t?: number } = {}): Finger {
  return { id: options.id ?? 1, x, y, t: options.t ?? 0 };
}

function at(f: Finger): GesturePointer {
  return { pointerId: f.id, x: f.x, y: f.y, timeMs: f.t };
}

/** Move a finger to a new place at a new time and feed the move through. */
function dragTo(
  recognizer: GestureRecognizer,
  f: Finger,
  x: number,
  y: number,
  elapsedMs: number,
): readonly TouchAction[] {
  f.x = x;
  f.y = y;
  f.t += elapsedMs;
  return recognizer.move(at(f));
}

function makeRecognizer(cellSize = CELL, width = WIDTH): GestureRecognizer {
  return createGestureRecognizer({ cellSize, width });
}

describe('touch action vocabulary', () => {
  it('gives every pad button a known action', () => {
    for (const button of TOUCH_PAD_BUTTONS) {
      expect(TOUCH_ACTIONS).toContain(button.action);
    }
  });

  it('offers each action exactly once on the pad, with a name to announce', () => {
    const actions = TOUCH_PAD_BUTTONS.map((button) => button.action);

    expect([...actions].sort()).toEqual([...TOUCH_ACTIONS].sort());
    expect(new Set(TOUCH_PAD_BUTTONS.map((button) => button.slot)).size).toBe(
      TOUCH_PAD_BUTTONS.length,
    );
    for (const button of TOUCH_PAD_BUTTONS) {
      expect(button.label.length).toBeGreaterThan(3);
    }
  });
});

describe('horizontal drag', () => {
  it('moves one column per threshold, continuously through one gesture', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 300);
    recognizer.down(at(f));

    expect(dragTo(recognizer, f, 100 + MOVE, 300, 16)).toEqual(['moveRight']);
    expect(dragTo(recognizer, f, 100 + MOVE * 2, 300, 16)).toEqual(['moveRight']);
    // Still inside the third threshold: nothing yet.
    expect(dragTo(recognizer, f, 100 + MOVE * 2.5, 300, 16)).toEqual([]);
    expect(dragTo(recognizer, f, 100 + MOVE * 3, 300, 16)).toEqual(['moveRight']);
  });

  it('emits several moves when one event carries a big jump', () => {
    const recognizer = makeRecognizer();
    const f = finger(20, 300);
    recognizer.down(at(f));

    expect(dragTo(recognizer, f, 20 + MOVE * 3, 300, 60)).toEqual([
      'moveRight',
      'moveRight',
      'moveRight',
    ]);
  });

  it('follows a reversal back the other way', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 300);
    recognizer.down(at(f));

    expect(dragTo(recognizer, f, 100 + MOVE * 2, 300, 32)).toHaveLength(2);
    expect(dragTo(recognizer, f, 100 + MOVE, 300, 16)).toEqual(['moveLeft']);
    expect(dragTo(recognizer, f, 100 - MOVE, 300, 16)).toEqual(['moveLeft', 'moveLeft']);
  });

  it('scales the threshold with the rendered cell size', () => {
    const small = makeRecognizer(10);
    const large = makeRecognizer(40);
    const a = finger(100, 300);
    const b = finger(100, 300);
    small.down(at(a));
    large.down(at(b));

    // The same pixel distance is three columns on a small board and not even
    // one on a large one; measured in cells, both are the same drag.
    const distance = MOVE_STEP_CELLS * 10 * 3;
    expect(dragTo(small, a, 100 + distance, 300, 40)).toHaveLength(3);
    expect(dragTo(large, b, 100 + distance, 300, 40)).toHaveLength(0);
  });

  it('stays on its axis once locked, so a curving drag never drops the piece', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 300);
    recognizer.down(at(f));

    expect(dragTo(recognizer, f, 100 + MOVE, 300, 16)).toEqual(['moveRight']);
    // Now sweep downwards a long way: the gesture is horizontal and stays so.
    expect(dragTo(recognizer, f, 100 + MOVE, 300 + SOFT * 4, 120)).toEqual([]);
  });
});

describe('vertical drag', () => {
  it('soft drops one row per threshold on a deliberate drag', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 100);
    recognizer.down(at(f));

    // Slow: 60ms per row is far below the flick speed.
    expect(dragTo(recognizer, f, 100, 100 + SOFT, 60)).toEqual(['softDrop']);
    expect(dragTo(recognizer, f, 100, 100 + SOFT * 2, 60)).toEqual(['softDrop']);
    expect(dragTo(recognizer, f, 100, 100 + SOFT * 4, 120)).toEqual(['softDrop', 'softDrop']);
  });

  it('never mistakes a long slow drag for a slam', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 40);
    recognizer.down(at(f));

    const emitted: TouchAction[] = [];
    for (let step = 1; step <= 10; step += 1) {
      emitted.push(...dragTo(recognizer, f, 100, 40 + SOFT * step, 80));
    }

    expect(emitted).not.toContain('hardDrop');
    expect(emitted).toHaveLength(10);
  });

  it('hard drops on a fast flick, the moment it qualifies', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 40);
    recognizer.down(at(f));

    // Three cells in 24ms — about 2.5 cells per millisecond of board, well past
    // anything a deliberate soft drop reaches.
    const actions = dragTo(recognizer, f, 100, 40 + CELL * (HARD_DROP_MIN_CELLS + 1), 24);

    expect(actions).toEqual(['hardDrop']);
  });

  it('spends the gesture on the slam, so the rest of the flick is silent', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 40);
    recognizer.down(at(f));

    dragTo(recognizer, f, 100, 40 + CELL * (HARD_DROP_MIN_CELLS + 1), 24);

    expect(dragTo(recognizer, f, 100, 300, 16)).toEqual([]);
    expect(recognizer.up(at(f))).toEqual([]);
  });

  it('catches a flick that ends before a move event reports it', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 40);
    recognizer.down(at(f));

    // One small move to lock the axis downwards, then the finger leaves the
    // glass a long way further down, all inside the velocity window.
    dragTo(recognizer, f, 100, 40 + CELL * 0.6, 8);
    f.x = 100;
    f.y = 40 + CELL * (HARD_DROP_MIN_CELLS + 2);
    f.t += 20;

    expect(recognizer.up(at(f))).toEqual(['hardDrop']);
  });

  it('does not slam when the finger stops before lifting', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 40);
    recognizer.down(at(f));

    dragTo(recognizer, f, 100, 40 + CELL * (HARD_DROP_MIN_CELLS + 2), 400);
    f.t += 300; // A pause with the finger resting on the glass.

    expect(recognizer.up(at(f))).toEqual([]);
  });

  it('holds on a swipe up, once', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 400);
    recognizer.down(at(f));

    expect(dragTo(recognizer, f, 100, 400 - CELL * (HOLD_SWIPE_CELLS + 0.5), 90)).toEqual(['hold']);
    expect(dragTo(recognizer, f, 100, 100, 90)).toEqual([]);
    expect(recognizer.up(at(f))).toEqual([]);
  });

  it('ignores a short upward nudge', () => {
    const recognizer = makeRecognizer();
    const f = finger(100, 400);
    recognizer.down(at(f));

    expect(dragTo(recognizer, f, 100, 400 - CELL * (HOLD_SWIPE_CELLS - 0.4), 90)).toEqual([]);
  });
});

describe('taps', () => {
  it('rotates clockwise', () => {
    const recognizer = makeRecognizer();
    const f = finger(WIDTH * 0.6, 300);
    recognizer.down(at(f));
    f.t += 60;

    expect(recognizer.up(at(f))).toEqual(['rotateCW']);
  });

  it('rotates counter-clockwise in the dedicated zone at the left edge', () => {
    const recognizer = makeRecognizer();
    const f = finger(WIDTH * CCW_ZONE_FRACTION * 0.5, 300);
    recognizer.down(at(f));
    f.t += 60;

    expect(recognizer.up(at(f))).toEqual(['rotateCCW']);
  });

  it('rotates counter-clockwise on a two-finger tap anywhere', () => {
    const recognizer = makeRecognizer();
    const first = finger(WIDTH * 0.7, 300, { id: 1 });
    const second = finger(WIDTH * 0.8, 320, { id: 2, t: 20 });

    expect(recognizer.down(at(first))).toEqual([]);
    expect(recognizer.down(at(second))).toEqual([]);

    second.t = 60;
    expect(recognizer.up(at(second))).toEqual([]);

    first.t = 80;
    expect(recognizer.up(at(first))).toEqual(['rotateCCW']);
  });

  it('tolerates a little jitter but not a real move', () => {
    const jittery = makeRecognizer();
    const a = finger(WIDTH * 0.6, 300);
    jittery.down(at(a));
    expect(dragTo(jittery, a, WIDTH * 0.6 + 3, 302, 30)).toEqual([]);
    a.t += 20;
    expect(jittery.up(at(a))).toEqual(['rotateCW']);

    const moved = makeRecognizer();
    const b = finger(WIDTH * 0.6, 300);
    moved.down(at(b));
    dragTo(moved, b, WIDTH * 0.6 + MOVE, 300, 30);
    b.t += 20;
    expect(moved.up(at(b))).toEqual([]);
  });

  it('treats a resting finger as a rest, not a tap', () => {
    const recognizer = makeRecognizer();
    const f = finger(WIDTH * 0.6, 300);
    recognizer.down(at(f));
    f.t += TAP_MAX_MS + 50;

    expect(recognizer.up(at(f))).toEqual([]);
  });
});

describe('multi-touch and cancellation', () => {
  it('lets one pointer steer while a second finger comes and goes', () => {
    const recognizer = makeRecognizer();
    const primary = finger(100, 300, { id: 1 });
    const other = finger(300, 300, { id: 2, t: 10 });
    recognizer.down(at(primary));
    recognizer.down(at(other));

    // The second finger cannot move the piece...
    expect(recognizer.move({ pointerId: 2, x: 300 + MOVE * 3, y: 300, timeMs: 30 })).toEqual([]);
    // ...and the first is entirely unaffected by its presence.
    expect(dragTo(recognizer, primary, 100 + MOVE, 300, 30)).toEqual(['moveRight']);

    other.t = 40;
    expect(recognizer.up(at(other))).toEqual([]);
    expect(recognizer.isTracking()).toBe(true);
  });

  it('forgets a cancelled gesture without emitting anything', () => {
    const recognizer = makeRecognizer();
    const f = finger(WIDTH * 0.6, 300);
    recognizer.down(at(f));
    f.t += 40;

    expect(recognizer.cancel(at(f))).toEqual([]);
    expect(recognizer.isTracking()).toBe(false);
    // The tap is gone with it: a later up for the same pointer says nothing.
    expect(recognizer.up(at(f))).toEqual([]);
  });

  it('re-measures when the board is resized under it', () => {
    const recognizer = makeRecognizer(10, 100);
    recognizer.setSurface({ cellSize: 40, width: 400 });

    const f = finger(200, 300);
    recognizer.down(at(f));

    expect(dragTo(recognizer, f, 200 + MOVE_STEP_CELLS * 40, 300, 30)).toEqual(['moveRight']);
  });

  it('survives a nonsensical surface rather than dividing by zero', () => {
    const recognizer = makeRecognizer(0, 0);
    const f = finger(0, 0);
    recognizer.down(at(f));
    f.t += 40;

    expect(recognizer.up(at(f))).toEqual(['rotateCCW']);
  });
});

describe('the pad visibility preference', () => {
  it('falls back to auto for anything it does not recognise', () => {
    expect(parsePadPreference(null)).toBe('auto');
    expect(parsePadPreference(undefined)).toBe('auto');
    expect(parsePadPreference('')).toBe('auto');
    expect(parsePadPreference('sideways')).toBe('auto');
    expect(parsePadPreference('on')).toBe('on');
    expect(parsePadPreference('off')).toBe('off');
  });

  it('cycles through every setting and back', () => {
    let preference = parsePadPreference('auto');
    const seen = PAD_PREFERENCES.map(() => {
      const current = preference;
      preference = nextPadPreference(preference);
      return current;
    });

    expect(seen).toEqual(['auto', 'on', 'off']);
    expect(preference).toBe('auto');
  });

  it('follows the device only while it is set to auto', () => {
    expect(isPadVisible('auto', true)).toBe(true);
    expect(isPadVisible('auto', false)).toBe(false);
    expect(isPadVisible('on', false)).toBe(true);
    expect(isPadVisible('off', true)).toBe(false);
  });

  it('labels every setting for the toggle', () => {
    for (const preference of PAD_PREFERENCES) {
      expect(padPreferenceLabel(preference)).toMatch(/^[A-Z]/);
    }
  });
});
