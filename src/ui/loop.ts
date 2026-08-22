/**
 * The frame loop.
 *
 * `requestAnimationFrame` gives us timestamps; the engine wants elapsed
 * milliseconds. Turning one into the other is almost trivial, except for the
 * case that actually matters: the tab was in the background for two minutes.
 * Feed the engine that delta raw and the player comes back to a piece already
 * buried at the bottom of the well.
 *
 * So the loop does two things about it. Deltas are clamped to `MAX_DELTA_MS`,
 * and while the document is hidden the loop stops entirely and restarts from a
 * fresh timestamp — the clamp is the backstop, the stop is the fix.
 */

/**
 * The largest delta ever handed to `update`, in milliseconds.
 *
 * Six frames at 60Hz. Long enough that a hitching frame still advances gravity
 * honestly, short enough that a stall can never cost more than a fraction of a
 * gravity step at low levels.
 */
export const MAX_DELTA_MS = 100;

/**
 * A frame delta the engine can be trusted with: never negative, never `NaN`,
 * never larger than `maxMs`.
 */
export function clampDelta(deltaMs: number, maxMs: number = MAX_DELTA_MS): number {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return 0;
  }
  return Math.min(deltaMs, maxMs);
}

export interface LoopOptions {
  /** Called once per animation frame with the clamped elapsed milliseconds. */
  readonly onFrame: (deltaMs: number) => void;
  /** Override the delta ceiling. Mostly here for tests. */
  readonly maxDeltaMs?: number;
}

export interface Loop {
  start(): void;
  stop(): void;
  readonly running: boolean;
  destroy(): void;
}

/**
 * Start/stop wrapper around `requestAnimationFrame` that suspends itself while
 * the document is hidden and resumes without a time debt when it comes back.
 */
export function createLoop(options: LoopOptions): Loop {
  const maxDeltaMs = options.maxDeltaMs ?? MAX_DELTA_MS;

  let frameHandle: number | null = null;
  /** The caller wants the loop running; it may still be suspended by hiding. */
  let wanted = false;
  let lastTimestamp: number | null = null;

  function tick(timestamp: number): void {
    frameHandle = requestAnimationFrame(tick);
    // The first frame after a start or a resume has no predecessor to measure
    // against, so it advances the clock by nothing at all.
    const delta = lastTimestamp === null ? 0 : clampDelta(timestamp - lastTimestamp, maxDeltaMs);
    lastTimestamp = timestamp;
    options.onFrame(delta);
  }

  function schedule(): void {
    if (frameHandle === null) {
      lastTimestamp = null;
      frameHandle = requestAnimationFrame(tick);
    }
  }

  function cancel(): void {
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    lastTimestamp = null;
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      cancel();
    } else if (wanted) {
      schedule();
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    start(): void {
      wanted = true;
      if (!document.hidden) {
        schedule();
      }
    },
    stop(): void {
      wanted = false;
      cancel();
    },
    get running(): boolean {
      return frameHandle !== null;
    },
    destroy(): void {
      wanted = false;
      cancel();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
