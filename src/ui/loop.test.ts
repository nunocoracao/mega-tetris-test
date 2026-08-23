import { describe, expect, it } from 'vitest';

import { clampDelta, splitWholeMs, MAX_DELTA_MS } from './loop';

describe('clampDelta', () => {
  it('passes ordinary frame times straight through', () => {
    expect(clampDelta(16.7)).toBeCloseTo(16.7);
    expect(clampDelta(MAX_DELTA_MS)).toBe(MAX_DELTA_MS);
  });

  it('caps the delta after a backgrounded tab', () => {
    // Two minutes away must not become 150 gravity steps on return.
    expect(clampDelta(120_000)).toBe(MAX_DELTA_MS);
  });

  it('refuses time that did not pass', () => {
    expect(clampDelta(0)).toBe(0);
    expect(clampDelta(-5)).toBe(0);
    expect(clampDelta(Number.NaN)).toBe(0);
    expect(clampDelta(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('honours a caller-supplied ceiling', () => {
    expect(clampDelta(500, 33)).toBe(33);
  });
});

describe('splitWholeMs', () => {
  it('hands out whole milliseconds and keeps the fraction', () => {
    const first = splitWholeMs(16.7, 0);
    expect(first.wholeMs).toBe(16);
    expect(first.carryMs).toBeCloseTo(0.7);
  });

  it('spends the carry rather than dropping it', () => {
    // The property that matters: sixty frames of 16.666 are a second, not 960
    // milliseconds. A game that ran 4% slow so replays could be written down
    // would be a bad trade.
    let carry = 0;
    let total = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      const split = splitWholeMs(1000 / 60, carry);
      carry = split.carryMs;
      total += split.wholeMs;
    }
    // Ten seconds of frames, to within the single millisecond still in hand.
    expect(total + carry).toBeCloseTo(10_000, 6);
    expect(Math.abs(total - 10_000)).toBeLessThanOrEqual(1);
  });

  it('only ever emits integers', () => {
    let carry = 0;
    for (const delta of [0.4, 0.4, 0.4, 16.666, 33.3333, 8.125, 99.999]) {
      const split = splitWholeMs(delta, carry);
      carry = split.carryMs;
      expect(Number.isInteger(split.wholeMs)).toBe(true);
      expect(split.wholeMs).toBeGreaterThanOrEqual(0);
      expect(carry).toBeGreaterThanOrEqual(0);
      expect(carry).toBeLessThan(1);
    }
  });

  it('treats time that did not pass as no time at all', () => {
    expect(splitWholeMs(0, 0)).toEqual({ wholeMs: 0, carryMs: 0 });
    expect(splitWholeMs(-5, 0).wholeMs).toBe(0);
    expect(splitWholeMs(Number.NaN, 0).wholeMs).toBe(0);
    // A carry survives a dead frame rather than being thrown away with it.
    expect(splitWholeMs(0, 0.75).carryMs).toBeCloseTo(0.75);
  });
});
