import { describe, expect, it, vi } from 'vitest';

import { COUNTDOWN_MS, countdownNumber, createCountdown } from './countdown';

describe('countdownNumber', () => {
  it('names the second you are in, not the one you finished', () => {
    expect(countdownNumber(3000)).toBe(3);
    expect(countdownNumber(2999)).toBe(3);
    expect(countdownNumber(2001)).toBe(3);
    expect(countdownNumber(2000)).toBe(2);
    expect(countdownNumber(1000)).toBe(1);
    expect(countdownNumber(1)).toBe(1);
  });

  it('clamps rather than showing a 0 or a 4', () => {
    expect(countdownNumber(0)).toBe(1);
    expect(countdownNumber(-500)).toBe(1);
    expect(countdownNumber(9999)).toBe(3);
  });

  it('scales to a different duration', () => {
    expect(countdownNumber(5000, 5000)).toBe(5);
    expect(countdownNumber(4500, 5000)).toBe(5);
  });
});

describe('createCountdown', () => {
  it('does nothing until it is started', () => {
    const onFinish = vi.fn();
    const countdown = createCountdown({ onFinish });

    countdown.update(1000);

    expect(onFinish).not.toHaveBeenCalled();
    expect(countdown.active()).toBe(false);
    expect(countdown.digit()).toBeNull();
  });

  it('counts down across frames and fires once at the end', () => {
    const onFinish = vi.fn();
    const countdown = createCountdown({ onFinish });

    countdown.start();
    expect(countdown.digit()).toBe(3);

    // Sixty frames of a real loop, not one big jump.
    for (let i = 0; i < 180; i += 1) {
      countdown.update(16.7);
    }

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(countdown.active()).toBe(false);
    expect(countdown.digit()).toBeNull();

    // And it stays finished: no second call from the frames after zero.
    countdown.update(16.7);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('reports each digit exactly once on the way down', () => {
    const seen: number[] = [];
    const countdown = createCountdown({ onFinish: () => {}, onTick: (d) => seen.push(d) });

    countdown.start();
    for (let i = 0; i < 200; i += 1) {
      countdown.update(16.7);
    }

    expect(seen).toEqual([3, 2, 1]);
  });

  it('can be cancelled without resuming anything', () => {
    const onFinish = vi.fn();
    const countdown = createCountdown({ onFinish });

    countdown.start();
    countdown.update(1000);
    countdown.cancel();
    countdown.update(COUNTDOWN_MS);

    expect(onFinish).not.toHaveBeenCalled();
    expect(countdown.active()).toBe(false);
  });

  it('starting again restarts the count', () => {
    const countdown = createCountdown({ onFinish: () => {} });

    countdown.start();
    countdown.update(2500);
    expect(countdown.digit()).toBe(1);

    countdown.start();
    expect(countdown.digit()).toBe(3);
    expect(countdown.remaining()).toBe(COUNTDOWN_MS);
  });

  it('ignores a frame that did not advance', () => {
    const countdown = createCountdown({ onFinish: () => {} });

    countdown.start();
    countdown.update(0);
    countdown.update(-100);

    expect(countdown.remaining()).toBe(COUNTDOWN_MS);
  });
});
