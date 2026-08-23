/**
 * The daily challenge's seed.
 *
 * The whole daily challenge rests on one fact this file establishes: a calendar
 * date is enough to know the piece sequence. Everybody who opens the page on
 * the same UTC day plays the same run, and nothing had to be uploaded, fetched
 * or agreed on for that to be true — the engine was already `(seed, ordered
 * list of calls) → state`, so all that was missing was a seed two strangers
 * could both derive.
 *
 * The date arrives as a **string**, and that is the deliberate part. The engine
 * may not read the clock (see `purity.test.ts`), so "what day is it" is a
 * question `src/main.ts` answers and hands down. That also makes every date a
 * test can name: `dailySeed('2026-08-23')` is a value, not a moment.
 *
 * The hash is FNV-1a, 32 bits. It is chosen for being small, well known and
 * completely specified — not for any cryptographic property, of which it has
 * none and needs none. What matters here is only that it is *stable*: the
 * sequence a date produces must be the same in every build, on every machine,
 * forever, because a player comparing scores with a friend is comparing runs on
 * two different computers. `daily.test.ts` pins a handful of dates to their
 * seeds so a well-meaning refactor cannot quietly move them.
 */

/** How `YYYY-MM-DD` is written, everywhere the daily challenge names a day. */
export const DATE_STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this a `YYYY-MM-DD` date stamp?
 *
 * Structural only: it checks the shape and the obvious ranges, not whether the
 * day exists in that month. Anything reading a *stored* date wants the stricter
 * calendar round-trip in `ui/daily.ts`; this is the cheap guard for the seed.
 */
export function isDateStamp(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_STAMP_PATTERN.test(value)) {
    return false;
  }
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** FNV-1a's starting state and multiplier, both 32-bit. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * The seed for a given `YYYY-MM-DD` day.
 *
 * Pure, total and stable: one string in, one 32-bit unsigned integer out, with
 * no clock, no locale and no table anywhere in it. Every step is forced back
 * into 32 bits (`Math.imul`, `>>> 0`) so the arithmetic cannot drift into
 * doubles and produce a different answer on a different engine.
 *
 * A date the game did not write is hashed exactly like one it did — the caller
 * decides what counts as today, and this only turns that answer into a run.
 */
export function dailySeed(date: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < date.length; index += 1) {
    hash ^= date.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}
