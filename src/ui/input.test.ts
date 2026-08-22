import { describe, expect, it } from 'vitest';

import {
  ARR_INTERVAL_MS,
  DAS_DELAY_MS,
  FRESH_REPEAT,
  KEY_BINDINGS,
  SOFT_DROP_INTERVAL_MS,
  createAutoRepeat,
  describeBinding,
  findBinding,
  formatKeyLabel,
  normalizeKey,
  stepRepeat,
  type ActionId,
} from './input';

describe('key bindings', () => {
  it('binds every action exactly once', () => {
    const actions = KEY_BINDINGS.map((binding) => binding.action);
    const expected: ActionId[] = [
      'moveLeft',
      'moveRight',
      'softDrop',
      'hardDrop',
      'rotateCW',
      'rotateCCW',
      'hold',
      'togglePause',
      'restart',
    ];

    expect([...actions].sort()).toEqual([...expected].sort());
  });

  it('never gives one key two meanings', () => {
    const keys = KEY_BINDINGS.flatMap((binding) => binding.keys);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('stores keys in their normalised form', () => {
    for (const binding of KEY_BINDINGS) {
      for (const key of binding.keys) {
        expect(normalizeKey(key)).toBe(key);
      }
    }
  });

  it('resolves the documented defaults', () => {
    expect(findBinding('ArrowLeft')?.action).toBe('moveLeft');
    expect(findBinding('ArrowRight')?.action).toBe('moveRight');
    expect(findBinding('ArrowDown')?.action).toBe('softDrop');
    expect(findBinding('ArrowUp')?.action).toBe('rotateCW');
    expect(findBinding(' ')?.action).toBe('hardDrop');
    expect(findBinding('z')?.action).toBe('rotateCCW');
    expect(findBinding('Control')?.action).toBe('rotateCCW');
    expect(findBinding('c')?.action).toBe('hold');
    expect(findBinding('Shift')?.action).toBe('hold');
    expect(findBinding('Escape')?.action).toBe('togglePause');
    expect(findBinding('r')?.action).toBe('restart');
  });

  it('matches letters whatever the shift state', () => {
    expect(findBinding('a')).toBe(findBinding('A'));
    expect(findBinding('d')?.action).toBe('moveRight');
  });

  it('leaves unbound keys alone', () => {
    expect(findBinding('Tab')).toBeUndefined();
    expect(findBinding('Enter')).toBeUndefined();
    expect(findBinding('q')).toBeUndefined();
  });

  it('describes itself in words a help panel can print', () => {
    expect(formatKeyLabel('ArrowLeft')).toBe('←');
    expect(formatKeyLabel(' ')).toBe('Space');
    expect(formatKeyLabel('Escape')).toBe('Esc');
    expect(formatKeyLabel('X')).toBe('X');

    const left = KEY_BINDINGS.find((binding) => binding.action === 'moveLeft');
    expect(left && describeBinding(left)).toBe('← / A');
  });
});

describe('auto-repeat timing', () => {
  const das = (state = FRESH_REPEAT, deltaMs = 0) =>
    stepRepeat(state, deltaMs, DAS_DELAY_MS, ARR_INTERVAL_MS);

  it('stays silent through the initial delay', () => {
    const first = das(FRESH_REPEAT, 100);
    expect(first.repeats).toBe(0);
    expect(first.state.charged).toBe(false);

    const second = das(first.state, 60);
    expect(second.repeats).toBe(0);
    expect(second.state.elapsedMs).toBe(160);
  });

  it('fires once the moment the delay is met', () => {
    const charged = das(FRESH_REPEAT, DAS_DELAY_MS);

    expect(charged.repeats).toBe(1);
    expect(charged.state.charged).toBe(true);
    expect(charged.state.elapsedMs).toBe(0);
  });

  it('then repeats at the auto-repeat rate', () => {
    let state = das(FRESH_REPEAT, DAS_DELAY_MS).state;

    // Two 16ms frames are under one interval; the third crosses it.
    for (const expected of [0, 0, 1]) {
      const stepped = das(state, 16);
      state = stepped.state;
      expect(stepped.repeats).toBe(expected);
    }
  });

  it('carries leftover time forward instead of drifting', () => {
    let state = das(FRESH_REPEAT, DAS_DELAY_MS).state;
    let total = 0;

    // A second of held input at 60Hz should be within one repeat of exact.
    for (let frame = 0; frame < 60; frame += 1) {
      const stepped = das(state, 1000 / 60);
      state = stepped.state;
      total += stepped.repeats;
    }

    const ideal = 1000 / ARR_INTERVAL_MS;
    expect(Math.abs(total - ideal)).toBeLessThanOrEqual(1);
  });

  it('emits several repeats for one long frame, but not a flood', () => {
    const charged = das(FRESH_REPEAT, DAS_DELAY_MS).state;
    const hitch = das(charged, 200);
    expect(hitch.repeats).toBe(5);

    const stall = das(charged, 10_000);
    expect(stall.repeats).toBe(8);
    expect(stall.state.elapsedMs).toBe(0);
  });

  it('gives soft drop no initial delay beyond its own interval', () => {
    const stepped = stepRepeat(FRESH_REPEAT, 35, 35, 35);

    expect(stepped.repeats).toBe(1);
  });

  it('ignores non-positive time', () => {
    expect(das(FRESH_REPEAT, 0).repeats).toBe(0);
    expect(das(FRESH_REPEAT, -50).state).toBe(FRESH_REPEAT);
    expect(das(FRESH_REPEAT, Number.NaN).state).toBe(FRESH_REPEAT);
  });
});

/**
 * The keyboard and the on-screen pad both drive this object, which is the point
 * of it: a held ◀ button has to behave exactly like a held arrow key, and the
 * only way to guarantee that is for there to be one implementation of "held".
 */
describe('the shared auto-repeat clock', () => {
  function recorder() {
    const emitted: ActionId[] = [];
    return { emitted, repeat: createAutoRepeat((action) => emitted.push(action)) };
  }

  it('fires once on press and refuses to double-count a held control', () => {
    const { emitted, repeat } = recorder();

    expect(repeat.press('moveLeft')).toBe(true);
    expect(repeat.press('moveLeft')).toBe(false);
    expect(emitted).toEqual(['moveLeft']);
    expect(repeat.isHeld('moveLeft')).toBe(true);
  });

  it('charges DAS before it streams', () => {
    const { emitted, repeat } = recorder();
    repeat.press('moveRight');

    repeat.update(DAS_DELAY_MS - 1);
    expect(emitted).toEqual(['moveRight']);

    repeat.update(1 + ARR_INTERVAL_MS * 2);
    expect(emitted).toEqual(['moveRight', 'moveRight', 'moveRight', 'moveRight']);
  });

  it('stops the moment the control is released', () => {
    const { emitted, repeat } = recorder();
    repeat.press('moveLeft');
    repeat.release('moveLeft');
    repeat.update(DAS_DELAY_MS + ARR_INTERVAL_MS * 10);

    expect(emitted).toEqual(['moveLeft']);
  });

  it('hands over to the other direction with a fresh charge', () => {
    const { emitted, repeat } = recorder();
    repeat.press('moveLeft');
    repeat.press('moveRight');
    repeat.update(DAS_DELAY_MS);
    expect(emitted).toEqual(['moveLeft', 'moveRight', 'moveRight']);

    // Letting go of right falls back to left, which has to charge again rather
    // than inheriting right's momentum and warping across the well.
    repeat.release('moveRight');
    repeat.update(DAS_DELAY_MS - 1);
    expect(emitted).toHaveLength(3);
    repeat.update(1);
    expect(emitted[emitted.length - 1]).toBe('moveLeft');
  });

  it('repeats soft drop on its own steadier rate', () => {
    const { emitted, repeat } = recorder();
    repeat.press('softDrop');
    repeat.update(SOFT_DROP_INTERVAL_MS * 3);

    expect(emitted).toEqual(['softDrop', 'softDrop', 'softDrop', 'softDrop']);
  });

  it('leaves one-shot actions alone however long they are held', () => {
    const { emitted, repeat } = recorder();
    repeat.press('hardDrop');
    repeat.press('rotateCW');
    repeat.update(2000);

    expect(emitted).toEqual(['hardDrop', 'rotateCW']);
  });

  it('forgets everything when the game looks away', () => {
    const { emitted, repeat } = recorder();
    repeat.press('moveLeft');
    repeat.press('softDrop');
    repeat.releaseAll();
    repeat.update(1000);

    expect(emitted).toEqual(['moveLeft', 'softDrop']);
    expect(repeat.isHeld('moveLeft')).toBe(false);
  });
});
