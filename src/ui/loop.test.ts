import { describe, expect, it } from 'vitest';

import { clampDelta, MAX_DELTA_MS } from './loop';

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
