/**
 * Watching a run back.
 *
 * A replay is just a `GameState` being painted, which is the whole reason the
 * renderer was written as a pure painter: nothing in `ui/renderer.ts` had to
 * learn what a replay is, and nothing here paints. This module owns the
 * *machine* — which run is loaded, whether it is playing, how fast, how far
 * through — and the words that go on the bar. `src/main.ts` puts them in the
 * DOM, exactly as it does for the live game.
 *
 * No game rules live here either. Stepping the run is `advanceReplay` in the
 * engine; all this does is decide how many milliseconds to hand it.
 */

import {
  advanceReplay,
  replay,
  restartReplay,
  startReplay,
  type GameEvent,
  type GameMode,
  type GameState,
  type ReplayLog,
  type ReplayPlayer,
  type RunOutcome,
} from '../engine';
import type { Board } from '../engine';
import { MODE_LABELS, formatDuration, formatNumber, outcomeTitle } from './hud';

/** The speeds the viewer offers. One is real time; the others are for scrubbing. */
export const REPLAY_SPEEDS = [1, 2, 4] as const;

export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** `2` → `'2×'`. The one place the multiplication sign is written. */
export function replaySpeedLabel(speed: ReplaySpeed): string {
  return `${speed}×`;
}

/**
 * Where the run came from, which is the only thing that changes the copy.
 *
 * A player watching their own last game already knows what they did; someone
 * who has just clicked a friend's link does not, and the bar is the only place
 * that can tell them.
 */
export type ReplayOrigin = 'own' | 'link';

/** A run to watch: everything `replay` needs, plus where it came from. */
export interface ReplayRequest {
  readonly seed: number;
  readonly startLevel: number;
  readonly mode: GameMode;
  readonly log: ReplayLog;
  readonly origin: ReplayOrigin;
}

/**
 * How the run turned out — worked out once, when the replay is opened, by
 * running it to the end.
 *
 * That is cheap (a few thousand pure calls, single-digit milliseconds) and it
 * is what lets the bar say "3,450 points" before a single frame has been
 * painted. A link that promises a score should show the score straight away,
 * not make its reader sit through two minutes to find out.
 */
export interface ReplayResult {
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  readonly outcome: RunOutcome;
  readonly durationMs: number;
}

export function replayResult(request: ReplayRequest): ReplayResult {
  const final = replay(
    request.seed,
    { startLevel: request.startLevel, mode: request.mode },
    request.log,
  );
  return {
    score: final.score,
    lines: final.lines,
    level: final.level,
    outcome: final.outcome,
    durationMs: final.elapsedMs,
  };
}

/** Everything the bar over the well says, as plain strings. */
export interface ReplayCaption {
  /** The badge on the field. Short, and never mistakable for a live game. */
  readonly badge: string;
  readonly title: string;
  /** Mode, level and the numbers the run ended on. */
  readonly detail: string;
  /** `"0:42 / 2:10"`. */
  readonly progress: string;
  /** How far through, 0 to 1, for the bar's own fill. */
  readonly fraction: number;
  /** What the play/pause button says now. */
  readonly playLabel: string;
  /** The sentence for the live region when the replay opens. */
  readonly announcement: string;
}

export interface ReplayCaptionView {
  readonly request: ReplayRequest;
  readonly result: ReplayResult;
  readonly clockMs: number;
  readonly durationMs: number;
  readonly playing: boolean;
  readonly done: boolean;
}

/**
 * The whole of the replay's copy, as a pure function. Tested without a DOM,
 * like every other piece of wording in this game.
 */
export function replayCaption(view: ReplayCaptionView): ReplayCaption {
  const { request, result } = view;
  const shared = request.origin === 'link';
  const level =
    request.startLevel > 1 ? `, from level ${formatNumber(request.startLevel)}` : '';
  const detail = `${MODE_LABELS[request.mode]}${level} — ${outcomeTitle({
    mode: request.mode,
    // A replay of a run that never finished is still a replay; reading an
    // unfinished run as a top-out is the same safe guess the overlay makes.
    outcome: result.outcome === 'none' ? 'toppedOut' : result.outcome,
    score: result.score,
    lines: result.lines,
    level: result.level,
    durationMs: result.durationMs,
  })}`;

  return {
    badge: 'Replay',
    title: shared ? 'Watching a shared run' : 'Watching your last run',
    detail,
    progress: `${formatDuration(view.clockMs)} / ${formatDuration(view.durationMs)}`,
    fraction: view.durationMs > 0 ? Math.min(1, Math.max(0, view.clockMs / view.durationMs)) : 1,
    playLabel: view.done ? 'Watch again' : view.playing ? 'Pause' : 'Play',
    announcement: shared
      ? `Replay of a shared run. ${detail}. ${formatNumber(result.score)} points. Press Escape to leave.`
      : `Replay. ${detail}. Press Escape to leave.`,
  };
}

export interface ReplayViewer {
  /** Load a run and start it playing. */
  open(request: ReplayRequest): void;
  /** Leave the replay. Safe to call when nothing is loaded. */
  close(): void;
  active(): boolean;
  /** The snapshot to paint. `null` when no replay is loaded. */
  state(): GameState | null;
  /** The board as it stood before the last step, for the effects layer. */
  previousBoard(): Board | null;
  /** Events produced by the last `update`, for the effects layer. */
  events(): readonly GameEvent[];
  /** Advance by one frame of real time. Speed is applied here. */
  update(deltaMs: number): void;
  playing(): boolean;
  done(): boolean;
  /** Play, pause, or — at the end — start over. */
  togglePlay(): void;
  setSpeed(speed: ReplaySpeed): void;
  speed(): ReplaySpeed;
  /** Back to the first piece, playing. */
  restart(): void;
  caption(): ReplayCaption | null;
  result(): ReplayResult | null;
  origin(): ReplayOrigin | null;
}

export interface ReplayViewerOptions {
  /** Called whenever anything the UI shows has changed. */
  readonly onChange?: () => void;
}

const NO_EVENTS: readonly GameEvent[] = Object.freeze([]);

export function createReplayViewer(options: ReplayViewerOptions = {}): ReplayViewer {
  let request: ReplayRequest | null = null;
  let result: ReplayResult | null = null;
  let player: ReplayPlayer | null = null;
  let previousBoard: Board | null = null;
  let playing = false;
  let speed: ReplaySpeed = 1;

  const changed = (): void => options.onChange?.();

  const load = (next: ReplayRequest): void => {
    request = next;
    result = replayResult(next);
    player = startReplay(next.seed, { startLevel: next.startLevel, mode: next.mode }, next.log);
    previousBoard = player.state.board;
    playing = true;
  };

  return {
    open(next: ReplayRequest): void {
      load(next);
      speed = 1;
      changed();
    },

    close(): void {
      if (request === null) {
        return;
      }
      request = null;
      result = null;
      player = null;
      previousBoard = null;
      playing = false;
      changed();
    },

    active(): boolean {
      return player !== null;
    },

    state(): GameState | null {
      return player?.state ?? null;
    },

    previousBoard(): Board | null {
      return previousBoard;
    },

    events(): readonly GameEvent[] {
      return player?.events ?? NO_EVENTS;
    },

    update(deltaMs: number): void {
      if (player === null || !playing || player.done || !(deltaMs > 0)) {
        return;
      }
      previousBoard = player.state.board;
      // Speed is the *only* thing a faster replay changes: the engine is handed
      // a bigger delta and behaves exactly as it would have if the player had
      // been on a slower machine. There is no second code path for 4×.
      player = advanceReplay(player, deltaMs * speed);
      if (player.done) {
        playing = false;
      }
      changed();
    },

    playing(): boolean {
      return playing;
    },

    done(): boolean {
      return player?.done ?? false;
    },

    togglePlay(): void {
      if (player === null) {
        return;
      }
      if (player.done) {
        // At the end, the play button means "again" — there is nothing else it
        // could usefully mean, and a dead button at the end of a replay is a
        // small betrayal.
        player = restartReplay(player);
        previousBoard = player.state.board;
        playing = true;
      } else {
        playing = !playing;
      }
      changed();
    },

    setSpeed(next: ReplaySpeed): void {
      if (speed === next) {
        return;
      }
      speed = next;
      changed();
    },

    speed(): ReplaySpeed {
      return speed;
    },

    restart(): void {
      if (player === null) {
        return;
      }
      player = restartReplay(player);
      previousBoard = player.state.board;
      playing = true;
      changed();
    },

    caption(): ReplayCaption | null {
      if (request === null || result === null || player === null) {
        return null;
      }
      return replayCaption({
        request,
        result,
        clockMs: player.clockMs,
        durationMs: player.durationMs,
        playing,
        done: player.done,
      });
    },

    result(): ReplayResult | null {
      return result;
    },

    origin(): ReplayOrigin | null {
      return request?.origin ?? null;
    },
  };
}
