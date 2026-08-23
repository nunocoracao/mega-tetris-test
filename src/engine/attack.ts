/**
 * The attack table: how much garbage a clear sends.
 *
 * Versus is a conversation, and this file is its vocabulary. Everything it
 * reads is a signal the scoring code already produces when a piece locks — how
 * many rows came out, whether the piece was spun into its slot, how long the
 * combo is, whether the back-to-back chain paid — so there is exactly one place
 * that decides what a clear *was*, and this is only the place that decides what
 * it is *worth to the other player*.
 *
 * The whole thing is plain exported data. The README quotes it, the versus HUD
 * will draw it, and the tests assert against the constants rather than against
 * copies of the numbers.
 *
 * ## The shape of the table
 *
 * A single sends nothing. That is the rule the rest of it hangs off: clearing
 * one row at a time is how you survive, not how you attack, and a game where it
 * pays would have no reason for anything else to exist.
 *
 *   single 0   double 1   triple 2   quad 4
 *
 * A spin sends roughly double what the same number of rows sends flat, and a
 * spin that clears nothing still sends nothing — a clever setup is not an
 * attack until it is cashed in. Kicked spins pay half of a clean spin, exactly
 * as they do in the score table: turning a piece into a hole it already fits is
 * the harder trick.
 *
 * Combos add a slowly growing tail, and the back-to-back chain adds a flat
 * line on top of every difficult clear after the first. Neither can turn a
 * single into a big attack on its own, which keeps the table's first rule true.
 */

import type { SpinKind } from './game';

/**
 * Garbage sent by a plain clear, indexed by the number of rows it took out.
 * A single sends nothing; a quad sends four.
 */
export const ATTACK_LINES: Readonly<Record<number, number>> = {
  0: 0,
  1: 0,
  2: 1,
  3: 2,
  4: 4,
};

/**
 * Garbage sent by a clear that was **spun** into place — the piece turned into
 * its slot and was boxed in when it locked. Around double the flat table, and
 * the reason a well-built stack with holes in it is still worth playing.
 */
export const SPIN_ATTACK_LINES: Readonly<Record<number, number>> = {
  0: 0,
  1: 2,
  2: 4,
  3: 6,
  4: 8,
};

/**
 * The same for a **kicked** spin — one that only fitted because a wall kick
 * shoved it sideways or upwards on the way round. Half of a clean spin, rounded
 * the way the score table rounds it, and still ahead of the flat clear.
 */
export const KICKED_SPIN_ATTACK_LINES: Readonly<Record<number, number>> = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
};

/**
 * Extra garbage per step of a combo, indexed by the combo counter as the engine
 * reports it (1 on the first clear of a chain, 2 on the second, and so on).
 *
 * The first two clears add nothing: a combo has to *be* a combo before it pays.
 * After that it climbs one line every two steps and settles at five, so a long
 * chain of doubles is a real threat without ever eclipsing a quad on its own.
 * A combo longer than the table is worth the last entry.
 */
export const COMBO_ATTACK_LINES: readonly number[] = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];

/**
 * Added to any difficult clear that takes the back-to-back bonus — a quad or a
 * spin clear following another one. Flat, and only one line: back-to-back is a
 * habit, not a jackpot.
 */
export const BACK_TO_BACK_ATTACK_BONUS = 1;

/**
 * Everything the attack table reads, and nothing else.
 *
 * These are the fields of the engine's own `rowsCleared` event, named the same
 * way on purpose: a caller passes the event straight in, and nothing about a
 * clear has to be worked out twice.
 */
export interface ClearSignals {
  /** Rows the lock took out. Zero is not an attack, whatever else happened. */
  readonly count: number;
  /** Whether the piece was spun into place, and whether it needed a kick. */
  readonly spin: SpinKind;
  /** Consecutive clearing locks including this one; 1 on the first. */
  readonly combo: number;
  /** This clear took the back-to-back bonus. */
  readonly backToBack: boolean;
}

/** Which of the three row tables a clear of this kind is paid from. */
export function attackTable(spin: SpinKind): Readonly<Record<number, number>> {
  switch (spin) {
    case 'none':
      return ATTACK_LINES;
    case 'full':
      return SPIN_ATTACK_LINES;
    case 'kick':
      return KICKED_SPIN_ATTACK_LINES;
  }
}

/** The combo tail for a combo counter, clamped to the end of the table. */
export function comboAttackLines(combo: number): number {
  if (!(combo > 1)) {
    return 0;
  }
  const index = Math.min(Math.floor(combo), COMBO_ATTACK_LINES.length - 1);
  return COMBO_ATTACK_LINES[index] ?? 0;
}

/**
 * How many rows of garbage a clear sends.
 *
 * Pure arithmetic over the table: rows, plus the combo tail, plus the flat
 * back-to-back line. A lock that cleared nothing sends nothing, however clever
 * it was.
 */
export function attackLines(signals: ClearSignals): number {
  const count = Math.max(0, Math.floor(signals.count));
  if (count === 0) {
    return 0;
  }
  const rows = attackTable(signals.spin)[count] ?? 0;
  const combo = comboAttackLines(signals.combo);
  const chain = signals.backToBack ? BACK_TO_BACK_ATTACK_BONUS : 0;
  return rows + combo + chain;
}
