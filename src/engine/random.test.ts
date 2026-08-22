import { describe, expect, it } from 'vitest';

import { PIECE_KINDS } from './pieces';
import { createBag, createRandom, shuffle } from './random';
import type { PieceKind } from './types';

function take(seed: number, count: number): PieceKind[] {
  const bag = createBag(seed);
  return Array.from({ length: count }, () => bag.next());
}

describe('createRandom', () => {
  it('only produces numbers in [0, 1)', () => {
    const random = createRandom(12345);
    for (let i = 0; i < 1000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('repeats exactly for the same seed', () => {
    const a = createRandom(2026);
    const b = createRandom(2026);
    for (let i = 0; i < 50; i += 1) {
      expect(a()).toBe(b());
    }
  });

  it('diverges for different seeds', () => {
    const a = Array.from({ length: 20 }, createRandom(1));
    const b = Array.from({ length: 20 }, createRandom(2));
    expect(a).not.toEqual(b);
  });

  it('does not get stuck on one value', () => {
    const random = createRandom(7);
    const values = new Set(Array.from({ length: 200 }, () => random()));
    expect(values.size).toBeGreaterThan(150);
  });

  it('spreads roughly evenly across the unit interval', () => {
    const random = createRandom(99);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 10_000; i += 1) {
      const bucket = Math.floor(random() * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1300);
    }
  });
});

describe('shuffle', () => {
  it('returns a permutation without touching the input', () => {
    const input = [...PIECE_KINDS];
    const shuffled = shuffle(input, createRandom(4));

    expect(input).toEqual([...PIECE_KINDS]);
    expect(shuffled).not.toBe(input);
    expect([...shuffled].sort()).toEqual([...PIECE_KINDS].sort());
  });

  it('is deterministic for a given seed', () => {
    expect(shuffle(PIECE_KINDS, createRandom(88))).toEqual(shuffle(PIECE_KINDS, createRandom(88)));
  });

  it('actually reorders things for at least some seeds', () => {
    const orders = new Set(
      Array.from({ length: 20 }, (_, seed) => shuffle(PIECE_KINDS, createRandom(seed)).join('')),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('createBag', () => {
  it('emits all seven kinds in each group of seven, with no repeats inside a bag', () => {
    const sequence = take(31337, 70);

    for (let start = 0; start < sequence.length; start += 7) {
      const group = sequence.slice(start, start + 7);
      expect(new Set(group).size).toBe(7);
      expect([...group].sort()).toEqual([...PIECE_KINDS].sort());
    }
  });

  it('reproduces the same sequence from the same seed', () => {
    expect(take(2024, 35)).toEqual(take(2024, 35));
  });

  it('produces different sequences for different seeds', () => {
    const sequences = new Set(Array.from({ length: 12 }, (_, seed) => take(seed, 14).join('')));
    expect(sequences.size).toBeGreaterThan(1);
  });

  it('does not always deal the bag in the canonical order', () => {
    const firstBags = new Set(Array.from({ length: 12 }, (_, seed) => take(seed, 7).join('')));
    expect(firstBags.size).toBeGreaterThan(1);
    expect(firstBags.has([...PIECE_KINDS].join(''))).toBe(false);
  });

  it('previews upcoming pieces without consuming them', () => {
    const bag = createBag(5);
    const preview = bag.preview(5);

    expect(preview).toHaveLength(5);
    expect(bag.preview(5)).toEqual(preview);
    expect(Array.from({ length: 5 }, () => bag.next())).toEqual(preview);
  });

  it('can preview across a bag boundary', () => {
    const bag = createBag(6);
    const preview = bag.preview(10);
    expect(preview).toHaveLength(10);
    expect(Array.from({ length: 10 }, () => bag.next())).toEqual(preview);
  });

  it('previews nothing for a non-positive count', () => {
    const bag = createBag(6);
    expect(bag.preview(0)).toEqual([]);
    expect(bag.preview(-3)).toEqual([]);
  });

  it('agrees between preview and next for the same seed', () => {
    expect(createBag(77).preview(20)).toEqual(take(77, 20));
  });
});
