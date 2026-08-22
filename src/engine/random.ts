/**
 * Deterministic randomness.
 *
 * The game must be reproducible: the same seed has to yield the same run,
 * every time and on every machine. `Math.random` gives us neither seeding nor
 * a promise of stability, so we carry a tiny PRNG of our own — mulberry32,
 * a well-known handful of lines with a 2^32 period, which is far more than a
 * puzzle game needs.
 */

import { PIECE_KINDS } from './pieces';
import type { PieceKind } from './types';

/** A pure-ish generator returning the next float in `[0, 1)`. */
export type RandomFn = () => number;

/**
 * mulberry32: advance a 32-bit state, then avalanche it into a float.
 * All the arithmetic is forced back into 32 bits with `| 0` / `>>> 0` so the
 * sequence is identical wherever it runs.
 */
export function createRandom(seed: number): RandomFn {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates, driven by `random`. Returns a new array; the input is
 * untouched.
 */
export function shuffle<T>(items: readonly T[], random: RandomFn): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** A stream of pieces. */
export interface Bag {
  /** The next kind to play. */
  next(): PieceKind;
  /**
   * Peek at the next `count` kinds without consuming them — for the
   * next-piece preview.
   */
  preview(count: number): PieceKind[];
}

/**
 * The 7-bag generator: shuffle all seven kinds, deal them out one at a time,
 * then shuffle a fresh bag. Every group of seven contains each kind exactly
 * once, so droughts are bounded and the game stays fair while still feeling
 * random.
 */
export function createBag(seed: number): Bag {
  const random = createRandom(seed);
  let queue: PieceKind[] = [];

  const refillTo = (count: number): void => {
    while (queue.length < count) {
      queue.push(...shuffle(PIECE_KINDS, random));
    }
  };

  return {
    next(): PieceKind {
      refillTo(1);
      return queue.shift() as PieceKind;
    },
    preview(count: number): PieceKind[] {
      if (count <= 0) {
        return [];
      }
      refillTo(count);
      return queue.slice(0, count);
    },
  };
}
