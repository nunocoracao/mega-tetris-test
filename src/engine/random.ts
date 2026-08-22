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
 * One step of mulberry32: advance a 32-bit state, then avalanche it into a
 * float. All the arithmetic is forced back into 32 bits with `| 0` / `>>> 0`
 * so the sequence is identical wherever it runs.
 *
 * This is the pure form — state in, state and value out — so a generator can
 * live inside an immutable snapshot instead of a closure.
 */
export function randomStep(state: number): { state: number; value: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/** A stateful generator over `randomStep`, for code that just wants numbers. */
export function createRandom(seed: number): RandomFn {
  let state = seed >>> 0;
  return () => {
    const stepped = randomStep(state);
    state = stepped.state;
    return stepped.value;
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

/** Fisher-Yates over an explicit PRNG state; returns the shuffle and the state. */
export function shuffleWithState<T>(items: readonly T[], state: number): { items: T[]; state: number } {
  let current = state;
  const shuffled = shuffle(items, () => {
    const stepped = randomStep(current);
    current = stepped.state;
    return stepped.value;
  });
  return { items: shuffled, state: current };
}

/**
 * A 7-bag generator as **plain data**: the PRNG state plus the kinds already
 * dealt out of the current bag but not yet taken.
 *
 * The game state is an immutable snapshot that has to compare deeply equal
 * across identical replays, so the piece stream cannot hide in a closure —
 * it has to be a value we can copy around like everything else.
 */
export interface BagState {
  /** mulberry32 state, advanced once per shuffle. */
  readonly random: number;
  /** Kinds dealt but not yet drawn, oldest first. */
  readonly queue: readonly PieceKind[];
}

/** A fresh, empty bag. The first draw shuffles a full set of seven. */
export function createBagState(seed: number): BagState {
  return { random: seed >>> 0, queue: [] };
}

/** Top the queue up to at least `count` kinds by shuffling in whole bags. */
function refill(bag: BagState, count: number): BagState {
  if (bag.queue.length >= count) {
    return bag;
  }
  let random = bag.random;
  const queue = [...bag.queue];
  while (queue.length < count) {
    const shuffled = shuffleWithState(PIECE_KINDS, random);
    queue.push(...shuffled.items);
    random = shuffled.state;
  }
  return { random, queue };
}

/** Take the next kind, returning it alongside the advanced bag. */
export function drawPiece(bag: BagState): { bag: BagState; kind: PieceKind } {
  const filled = refill(bag, 1);
  return {
    bag: { random: filled.random, queue: filled.queue.slice(1) },
    kind: filled.queue[0] as PieceKind,
  };
}

/** Take the next `count` kinds in order, returning them and the advanced bag. */
export function drawPieces(bag: BagState, count: number): { bag: BagState; kinds: PieceKind[] } {
  if (count <= 0) {
    return { bag, kinds: [] };
  }
  const filled = refill(bag, count);
  return {
    bag: { random: filled.random, queue: filled.queue.slice(count) },
    kinds: filled.queue.slice(0, count),
  };
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
  let bag = createBagState(seed);

  return {
    next(): PieceKind {
      const drawn = drawPiece(bag);
      bag = drawn.bag;
      return drawn.kind;
    },
    preview(count: number): PieceKind[] {
      if (count <= 0) {
        return [];
      }
      // Peek without consuming: keep the refilled bag, hand back a copy.
      bag = refill(bag, count);
      return bag.queue.slice(0, count);
    },
  };
}
