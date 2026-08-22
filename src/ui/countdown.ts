/**
 * The three seconds between closing the pause menu and playing again.
 *
 * Coming back from a pause straight into a falling piece is how a player loses
 * a run to a menu. Three, two, one gives the hands somewhere to be while the
 * eyes find the well again — the same courtesy an arcade cabinet extends after
 * a coin drop.
 *
 * The clock is driven by the game loop's real delta rather than a timer, so it
 * pauses with the tab and cannot drift away from the frame it is drawn on.
 * `countdownNumber` is pure, which is where the off-by-one lives: at exactly
 * 2000 ms left the player should see **2**, not 3.
 */

/** How long the countdown runs. Three digits, one second each. */
export const COUNTDOWN_MS = 3000;

/**
 * The digit to show with `remainingMs` left, clamped to 1..3.
 *
 * `ceil` is what makes 3000 ms read as "3" and 2999 ms still read as "3": the
 * digit names the second you are *in*, not the second you have finished.
 */
export function countdownNumber(remainingMs: number, durationMs = COUNTDOWN_MS): number {
  const total = Math.max(1, Math.ceil(durationMs / 1000));
  const digit = Math.ceil(remainingMs / 1000);
  return Math.max(1, Math.min(total, digit));
}

export interface Countdown {
  /** Restart the count. Calling it while one is running starts it over. */
  start(): void;
  /** Stop without firing `onFinish` — a restart mid-count, say. */
  cancel(): void;
  /** Advance by one frame. Fires `onFinish` on the frame it reaches zero. */
  update(deltaMs: number): void;
  active(): boolean;
  remaining(): number;
  /** The digit to paint, or `null` when nothing is counting. */
  digit(): number | null;
}

export interface CountdownOptions {
  readonly durationMs?: number;
  readonly onFinish: () => void;
  /** Called when the digit changes, for anything that wants to react to it. */
  readonly onTick?: (digit: number) => void;
}

export function createCountdown(options: CountdownOptions): Countdown {
  const duration = options.durationMs ?? COUNTDOWN_MS;
  let remaining = 0;

  return {
    start(): void {
      remaining = duration;
      options.onTick?.(countdownNumber(remaining, duration));
    },

    cancel(): void {
      remaining = 0;
    },

    update(deltaMs: number): void {
      if (remaining <= 0 || !(deltaMs > 0)) {
        return;
      }
      const before = countdownNumber(remaining, duration);
      remaining -= deltaMs;
      if (remaining <= 0) {
        remaining = 0;
        options.onFinish();
        return;
      }
      const after = countdownNumber(remaining, duration);
      if (after !== before) {
        options.onTick?.(after);
      }
    },

    active: () => remaining > 0,
    remaining: () => remaining,
    digit: () => (remaining > 0 ? countdownNumber(remaining, duration) : null),
  };
}
