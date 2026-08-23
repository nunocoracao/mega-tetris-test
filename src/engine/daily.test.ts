import { describe, expect, it } from 'vitest';

import { createGame, update } from './game';
import { dailySeed, isDateStamp } from './daily';

/**
 * The pinned seeds.
 *
 * These are not "whatever the function happens to return today" — they are the
 * contract. Two players comparing a daily score are comparing runs produced by
 * two different downloads of this file, so the day → seed mapping has to be
 * fixed for good. If a change to `dailySeed` turns this list red, the change is
 * wrong however tidy it looks: every stored history and every shared score in
 * the world was set under the old numbers.
 */
const PINNED: readonly (readonly [string, number])[] = [
  ['1970-01-01', 1_421_751_008],
  ['2000-02-29', 4_125_131_930],
  ['2026-01-01', 2_049_302_883],
  ['2026-08-23', 3_523_671_066],
  ['2026-08-24', 3_439_782_971],
  ['2026-12-31', 1_294_366_724],
];

describe('dailySeed', () => {
  it.each(PINNED)('hashes %s to the seed it has always hashed to', (date, seed) => {
    expect(dailySeed(date)).toBe(seed);
  });

  it('is a pure function of the string it is given', () => {
    expect(dailySeed('2026-08-23')).toBe(dailySeed('2026-08-23'));
  });

  it('gives neighbouring days completely unrelated seeds', () => {
    // One character apart in, nothing recognisably apart out — which is the
    // only property of the hash the game actually depends on.
    const a = dailySeed('2026-08-23');
    const b = dailySeed('2026-08-24');

    expect(a).not.toBe(b);
    expect(Math.abs(a - b)).toBeGreaterThan(1000);
  });

  it('returns a 32-bit unsigned integer for every day of a year', () => {
    for (let day = 0; day < 366; day += 1) {
      const stamp = `2026-${String(1 + (day % 12)).padStart(2, '0')}-${String(1 + (day % 28)).padStart(2, '0')}`;
      const seed = dailySeed(stamp);

      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('gives every day of a year its own seed', () => {
    const seeds = new Set<number>();
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= 28; day += 1) {
        seeds.add(
          dailySeed(`2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`),
        );
      }
    }

    expect(seeds.size).toBe(12 * 28);
  });
});

describe('the run a day deals', () => {
  it('is identical for two players on the same date', () => {
    const date = '2026-08-23';

    const one = createGame({ seed: dailySeed(date) });
    const two = createGame({ seed: dailySeed(date) });

    expect(one.next).toEqual(two.next);
    expect(update(one, 5_000)).toEqual(update(two, 5_000));
  });

  it('is a different sequence the next day', () => {
    const today = createGame({ seed: dailySeed('2026-08-23') });
    const tomorrow = createGame({ seed: dailySeed('2026-08-24') });

    // Two seven-bags can open with the same piece by chance; five in a row from
    // unrelated seeds would be a coincidence worth investigating.
    expect(today.next.join('')).not.toBe(tomorrow.next.join(''));
  });
});

describe('isDateStamp', () => {
  it.each(['1970-01-01', '2026-08-23', '2026-12-31'])('accepts %s', (value) => {
    expect(isDateStamp(value)).toBe(true);
  });

  it.each([
    '2026-8-23',
    '2026-08-23T00:00:00Z',
    '26-08-23',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026-01-32',
    'today',
    '',
  ])('rejects %s', (value) => {
    expect(isDateStamp(value)).toBe(false);
  });

  it('rejects anything that is not a string', () => {
    for (const value of [null, undefined, 20_260_823, {}, [], new Map()]) {
      expect(isDateStamp(value)).toBe(false);
    }
  });
});
