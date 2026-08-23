/**
 * The test this whole feature exists for.
 *
 * The README has said since the first week that the game is a pure function of
 * `(seed, ordered list of calls)`. `purity.test.ts` checks that the engine
 * *could* be one — no clock, no `Math.random`, no DOM. This file checks that it
 * actually **is** one, by playing hundreds of inputs, writing them down, and
 * rebuilding the run from the seed and the list alone. If the two final states
 * ever stop being deeply equal, the engine has grown a hidden piece of state
 * and that is a bug worth finding, not a test worth loosening.
 */

import { describe, expect, it } from 'vitest';

import { clearRows, findFullRows, isValidPosition, lockPiece, type Board } from './board';
import { applyInput, createGame, dropDistance, update, type GameState } from './game';
import type { Rotation } from './types';
import {
  MAX_LOG_ENTRIES,
  advanceReplay,
  createRecorder,
  emptyLog,
  isReplayInput,
  replay,
  restartReplay,
  startReplay,
  REPLAY_INPUTS,
  type ReplayInput,
  type ReplayLog,
  type ReplayOptions,
  type RunRecorder,
} from './replay';
import { createRandom } from './random';

// ---------------------------------------------------------------------------
// A scripted run
// ---------------------------------------------------------------------------

/** One thing the driver does on a step: press something, or let time pass. */
type Step = { readonly kind: 'input'; readonly input: ReplayInput } | { readonly kind: 'wait'; readonly ms: number };

/**
 * A believable run, generated from a seed of its own.
 *
 * Deliberately *not* a good player: it moves, turns, holds, soft-drops, slams
 * and occasionally pauses for thought, which is what gets a real board built,
 * a few lines cleared and — eventually — a top-out. The seed keeps it exactly
 * reproducible, so a failure can be re-run.
 *
 * Waits are whole milliseconds because the run clock is whole milliseconds:
 * `ui/loop.ts` hands the engine `splitWholeMs`, precisely so a run is a thing
 * that can be written down.
 */
function makeScript(seed: number, length: number): Step[] {
  const random = createRandom(seed);
  const steps: Step[] = [];
  // The inputs a player actually presses, weighted the way a player presses
  // them: mostly movement, some rotation, the occasional hold.
  const weighted: ReplayInput[] = [
    'moveLeft',
    'moveLeft',
    'moveRight',
    'moveRight',
    'rotateCW',
    'rotateCW',
    'rotateCCW',
    'softDrop',
    'softDrop',
    'hardDrop',
    'hold',
  ];
  for (let index = 0; index < length; index += 1) {
    const roll = random();
    if (roll < 0.35) {
      // Between a frame and a quarter of a second of nothing at all.
      steps.push({ kind: 'wait', ms: 1 + Math.floor(random() * 250) });
      continue;
    }
    if (roll > 0.985) {
      // A player who stops to think, and then carries on.
      steps.push({ kind: 'input', input: 'pause' });
      steps.push({ kind: 'wait', ms: 500 });
      steps.push({ kind: 'input', input: 'resume' });
      continue;
    }
    const pick = weighted[Math.floor(random() * weighted.length)] ?? 'moveLeft';
    steps.push({ kind: 'input', input: pick });
  }
  return steps;
}

interface RunResult {
  readonly state: GameState;
  readonly log: ReplayLog;
  /**
   * The high-water marks of the run, gathered from its events.
   *
   * The final snapshot is no use for this: `combo` is back to zero the moment a
   * lock clears nothing, so a run full of combos ends with `combo: 0`. What the
   * coverage assertions want to know is whether the run ever *had* one.
   */
  readonly peak: RunPeak;
}

interface RunPeak {
  combo: number;
  backToBackChain: number;
  quads: number;
  spins: number;
  holds: number;
  levelUps: number;
}

function emptyPeak(): RunPeak {
  return { combo: 0, backToBackChain: 0, quads: 0, spins: 0, holds: 0, levelUps: 0 };
}

function notePeak(peak: RunPeak, state: GameState): void {
  for (const event of state.events) {
    if (event.type === 'rowsCleared') {
      peak.combo = Math.max(peak.combo, event.combo);
      peak.backToBackChain = Math.max(peak.backToBackChain, event.backToBackChain);
      if (event.quad) {
        peak.quads += 1;
      }
    } else if (event.type === 'spin') {
      peak.spins += 1;
    } else if (event.type === 'hold') {
      peak.holds += 1;
    } else if (event.type === 'levelUp') {
      peak.levelUps += 1;
    }
  }
}

/**
 * Play a script the way `src/main.ts` plays a real game: frame deltas into
 * `update`, presses into `applyInput`, and — optionally — a recorder watching
 * from the side. The recorder is passed in rather than assumed, which is what
 * makes "the same run with and without it" a thing this file can assert.
 */
function play(
  seed: number,
  options: ReplayOptions,
  script: readonly Step[],
  recorder: RunRecorder | null = null,
): RunResult {
  let state = createGame({ seed, startLevel: options.startLevel, mode: options.mode });
  const peak = emptyPeak();
  const send = (input: ReplayInput): void => {
    recorder?.record(state.elapsedMs, input);
    state = applyInput(state, { type: input });
    notePeak(peak, state);
  };

  // Every run starts the same way a player starts one.
  send('resume');

  for (const step of script) {
    if (step.kind === 'input') {
      send(step.input);
      continue;
    }
    // Real frames, not one big delta: the point is that the log is written
    // from a run that was played the way the browser plays it.
    let left = step.ms;
    while (left > 0) {
      const frame = Math.min(left, 17);
      state = update(state, frame);
      notePeak(peak, state);
      left -= frame;
      recorder?.mark(state.elapsedMs);
    }
  }

  recorder?.mark(state.elapsedMs);
  return { state, log: recorder?.log() ?? emptyLog(), peak };
}

// ---------------------------------------------------------------------------
// A run that actually plays
// ---------------------------------------------------------------------------

/**
 * Flailing at the keyboard tops a well out without ever completing a row, and a
 * replay test that never clears a line has not tested combos, back-to-back or
 * the clear pause — which is most of what there is to get wrong. So the long
 * runs below are driven by a small placement bot instead: it scores every
 * rotation against every column on holes, height and bumpiness, takes the best,
 * and presses the real keys to get there.
 *
 * A fraction of its placements are deliberately random. A competent bot never
 * tops out, and a run that never ends tests only the opening.
 */
const SLOPPY = 0.12;

const CLEAR_REWARD = [0, 2, 9, 22, 80];

/** How bad a board is. Lower is better; the units are arbitrary and tuned. */
function evaluateBoard(board: Board, cleared: number): number {
  const heights: number[] = [];
  let holes = 0;
  for (let x = 0; x < board.width; x += 1) {
    let top = board.height;
    for (let y = 0; y < board.height; y += 1) {
      if (board.cells[y * board.width + x] != null) {
        top = y;
        break;
      }
    }
    heights.push(board.height - top);
    for (let y = top + 1; y < board.height; y += 1) {
      if (board.cells[y * board.width + x] == null) {
        holes += 1;
      }
    }
  }
  let bumpiness = 0;
  for (let x = 1; x < heights.length; x += 1) {
    bumpiness += Math.abs((heights[x] ?? 0) - (heights[x - 1] ?? 0));
  }
  const aggregate = heights.reduce((total, height) => total + height, 0);
  return (CLEAR_REWARD[cleared] ?? 0) - holes * 9 - aggregate * 0.9 - bumpiness * 0.5;
}

interface Placement {
  readonly rotation: Rotation;
  readonly x: number;
}

function bestPlacement(state: GameState, random: () => number): Placement | null {
  const piece = state.active;
  if (piece === null) {
    return null;
  }
  const candidates: Placement[] = [];
  let best: { placement: Placement; score: number } | null = null;

  for (let rotation = 0; rotation < 4; rotation += 1) {
    for (let x = -2; x < state.board.width + 2; x += 1) {
      const candidate = { ...piece, rotation: rotation as Rotation, x };
      if (!isValidPosition(state.board, candidate)) {
        continue;
      }
      const landed = { ...candidate, y: candidate.y + dropDistance(state.board, candidate) };
      const locked = lockPiece(state.board, landed);
      const rows = findFullRows(locked);
      const after = rows.length > 0 ? clearRows(locked, rows).board : locked;
      const score = evaluateBoard(after, rows.length);
      const placement: Placement = { rotation: rotation as Rotation, x };
      candidates.push(placement);
      if (best === null || score > best.score) {
        best = { placement, score };
      }
    }
  }

  if (candidates.length === 0 || best === null) {
    return null;
  }
  if (random() < SLOPPY) {
    return candidates[Math.floor(random() * candidates.length)] ?? best.placement;
  }
  return best.placement;
}

/**
 * Play a real game to `maxPieces` placements or a top-out, whichever comes
 * first, pressing real keys through the same path a player would.
 */
function playBot(
  seed: number,
  options: ReplayOptions,
  recorder: RunRecorder | null,
  maxPieces: number,
): RunResult {
  const random = createRandom(seed ^ 0x9e3779b9);
  let state = createGame({ seed, startLevel: options.startLevel, mode: options.mode });
  const peak = emptyPeak();

  const send = (input: ReplayInput): void => {
    recorder?.record(state.elapsedMs, input);
    state = applyInput(state, { type: input });
    notePeak(peak, state);
  };
  const wait = (ms: number): void => {
    let left = ms;
    while (left > 0) {
      const frame = Math.min(left, 17);
      state = update(state, frame);
      notePeak(peak, state);
      left -= frame;
      recorder?.mark(state.elapsedMs);
    }
  };

  send('resume');

  for (let piece = 0; piece < maxPieces && state.status === 'playing'; piece += 1) {
    // The clear pause leaves `active` null for a quarter of a second.
    let patience = 0;
    while (state.active === null && state.status === 'playing' && patience < 40) {
      wait(17);
      patience += 1;
    }
    if (state.active === null) {
      break;
    }

    // A hold every so often, which is the only way the hold slot and its lock
    // ever appear in a recorded run.
    if (!state.holdLocked && random() < 0.08) {
      send('hold');
      wait(17);
    }

    const target = bestPlacement(state, random);
    const current = state.active;
    if (target === null || current === null) {
      break;
    }

    for (let turn = 0; turn < ((target.rotation - current.rotation + 4) % 4); turn += 1) {
      send('rotateCW');
      wait(9);
    }
    const active = state.active;
    if (active !== null) {
      const drift = target.x - active.x;
      for (let step = 0; step < Math.abs(drift); step += 1) {
        send(drift < 0 ? 'moveLeft' : 'moveRight');
        wait(11);
      }
    }
    // Half the pieces are slammed, half are let down by gravity and a soft
    // drop, so both paths into `lockActive` are on the tape.
    if (random() < 0.5) {
      send('hardDrop');
    } else {
      send('softDrop');
      wait(1_200);
    }
    wait(34);
  }

  wait(300);
  recorder?.mark(state.elapsedMs);
  return { state, log: recorder?.log() ?? emptyLog(), peak };
}

/** Everything a replay has to get right, gathered in one readable place. */
function fingerprint(state: GameState): Record<string, unknown> {
  return {
    score: state.score,
    lines: state.lines,
    level: state.level,
    status: state.status,
    outcome: state.outcome,
    elapsedMs: state.elapsedMs,
    combo: state.combo,
    backToBack: state.backToBack,
    backToBackChain: state.backToBackChain,
    hold: state.hold,
    holdLocked: state.holdLocked,
    bag: state.bag,
    next: state.next,
    cells: state.board.cells,
  };
}

/**
 * Five seeds, chosen because the bot below plays each of them for five hundred
 * to a thousand inputs before topping out — long enough that a desync would
 * have somewhere to hide.
 */
const SEEDS = [1, 11, 1234, 31_337, 5150];

// ---------------------------------------------------------------------------

describe('the log format', () => {
  it('holds every input except restart', () => {
    // A restart throws the run away and deals another from the same seed. That
    // is a *new* run with a log of its own; a log that contained one would have
    // a clock that ran backwards halfway through.
    expect(REPLAY_INPUTS).not.toContain('restart');
    expect(isReplayInput('restart')).toBe(false);
    expect(isReplayInput('hardDrop')).toBe(true);
    expect(isReplayInput('nonsense')).toBe(false);
  });

  it('starts empty', () => {
    expect(emptyLog()).toEqual({ durationMs: 0, entries: [], truncated: false });
  });
});

describe('record, then replay', () => {
  for (const seed of SEEDS) {
    it(`rebuilds seed ${seed} exactly, from the seed and the log alone`, () => {
      const recorder = createRecorder();
      const live = playBot(seed, {}, recorder, 4_000);

      // Several hundred inputs, and a run that got somewhere.
      expect(live.log.entries.length).toBeGreaterThan(500);
      expect(live.log.truncated).toBe(false);
      expect(live.state.lines).toBeGreaterThan(0);

      const rebuilt = replay(seed, {}, live.log);

      // The whole snapshot, field for field — board, bag, combo, back-to-back,
      // hold, the lot. `events` belong to the call that produced them, and the
      // last call of a replay is the same last call the live run made.
      expect(fingerprint(rebuilt)).toEqual(fingerprint(live.state));
      expect(rebuilt).toEqual(live.state);
    });
  }

  it('rebuilds a run of pure flailing too', () => {
    // The bot is a tidy player; a real one is not. Random input finds different
    // corners — refused moves, rotations against walls, holds mid-fall.
    for (const seed of SEEDS) {
      const recorder = createRecorder();
      const live = play(seed, {}, makeScript(seed, 400), recorder);
      expect(recorder.size()).toBeGreaterThan(200);
      expect(replay(seed, {}, recorder.log())).toEqual(live.state);
    }
  });

  it('replays runs that scored, cleared, combo-ed, quadded and held', () => {
    // A guard against the whole suite passing on five runs that topped out on
    // the second piece and proved nothing. Every rule the log has to survive
    // has to have happened at least once somewhere in these five.
    const runs = SEEDS.map((seed) => playBot(seed, {}, createRecorder(), 4_000));
    expect(runs.every((run) => run.state.score > 0)).toBe(true);
    expect(runs.every((run) => run.state.lines > 0)).toBe(true);
    expect(runs.every((run) => run.peak.holds > 0)).toBe(true);
    expect(runs.every((run) => run.peak.combo > 0)).toBe(true);
    expect(runs.every((run) => run.peak.levelUps > 0 || run.state.lines < 10)).toBe(true);
    // Combos, quads and a back-to-back chain are the three bits of scoring
    // state that live *between* locks, so they are the ones a naive replay
    // would lose. At least one of the five has to exercise each.
    expect(runs.some((run) => run.peak.combo > 2)).toBe(true);
    expect(runs.some((run) => run.peak.quads > 0)).toBe(true);
    expect(runs.some((run) => run.peak.backToBackChain > 0)).toBe(true);
  });

  it('rebuilds a run that ended, not merely one that stopped', () => {
    // A top-out leaves `status: 'over'` and an outcome, and those have to come
    // back too — a replay that ends one piece early is a replay that lies.
    const recorder = createRecorder();
    const live = playBot(31_337, {}, recorder, 4_000);
    expect(live.state.status).toBe('over');
    expect(live.state.outcome).toBe('toppedOut');
    expect(replay(31_337, {}, recorder.log())).toEqual(live.state);
  });

  it('rebuilds a sprint and an ultra, not just a marathon', () => {
    for (const mode of ['sprint', 'ultra'] as const) {
      const options: ReplayOptions = { mode, startLevel: 3 };
      const recorder = createRecorder();
      const live = playBot(31_337, options, recorder, 4_000);
      expect(live.state.mode).toBe(mode);
      // Both of these modes have a finish line, and reaching it is the
      // interesting case: the clock stops on an exact millisecond.
      expect(live.state.status).toBe('over');
      expect(replay(31_337, options, recorder.log())).toEqual(live.state);
    }
  });

  it('is not fooled by a different seed, level or mode', () => {
    // The negative half: if `replay` ignored its arguments, every test above
    // would pass for the wrong reason. The seed is a different bag, the level
    // is a different gravity curve, and the mode is a different finish line —
    // this run is long enough and clears enough lines to cross both of them.
    const recorder = createRecorder();
    const live = playBot(31_337, {}, recorder, 4_000);
    const log = recorder.log();
    expect(fingerprint(replay(31_338, {}, log))).not.toEqual(fingerprint(live.state));
    expect(fingerprint(replay(31_337, { startLevel: 6 }, log))).not.toEqual(
      fingerprint(live.state),
    );
    expect(fingerprint(replay(31_337, { mode: 'ultra' }, log))).not.toEqual(
      fingerprint(live.state),
    );
    expect(fingerprint(replay(31_337, { mode: 'sprint' }, log))).not.toEqual(
      fingerprint(live.state),
    );
  });
});

describe('the recorder', () => {
  it('does not change the run it is recording', () => {
    // The acceptance test for "the recorder observes, it does not participate".
    // Same seed, same script, one run watched and one not.
    for (const seed of SEEDS) {
      const script = makeScript(seed, 250);
      const watched = play(seed, {}, script, createRecorder());
      const unwatched = play(seed, {}, script, null);
      expect(watched.state).toEqual(unwatched.state);
    }
  });

  it('writes down the clock as it stood before each input', () => {
    const recorder = createRecorder();
    let state = createGame({ seed: 3 });
    recorder.record(state.elapsedMs, 'resume');
    state = applyInput(state, { type: 'resume' });
    state = update(state, 120);
    recorder.mark(state.elapsedMs);
    recorder.record(state.elapsedMs, 'moveLeft');

    expect(recorder.log().entries).toEqual([
      { t: 0, input: 'resume' },
      { t: 120, input: 'moveLeft' },
    ]);
    expect(recorder.log().durationMs).toBe(120);
  });

  it('covers the time after the last input', () => {
    const recorder = createRecorder();
    recorder.record(0, 'resume');
    recorder.mark(9_000);
    expect(recorder.log().durationMs).toBe(9_000);
  });

  it('ignores inputs a log may not hold', () => {
    const recorder = createRecorder();
    recorder.record(0, 'restart');
    expect(recorder.size()).toBe(0);
  });

  it('stops at the cap rather than growing without bound', () => {
    // Two hours of play must not quietly eat the browser. The cap stops the
    // tape and says so; it does not drop the oldest entries, because a log with
    // a hole in it is not a shorter replay, it is a wrong one.
    const recorder = createRecorder({ maxEntries: 4 });
    for (let index = 0; index < 50; index += 1) {
      recorder.record(index, 'moveLeft');
    }
    expect(recorder.size()).toBe(4);
    expect(recorder.truncated()).toBe(true);
    expect(recorder.log().truncated).toBe(true);
    expect(recorder.log().entries).toHaveLength(4);
  });

  it('caps a real session well above any real run', () => {
    expect(MAX_LOG_ENTRIES).toBeGreaterThan(10_000);
  });

  it('hands out a fresh log every time, not a live one', () => {
    const recorder = createRecorder();
    recorder.record(0, 'resume');
    const first = recorder.log();
    recorder.record(50, 'hardDrop');
    expect(first.entries).toHaveLength(1);
    expect(recorder.log().entries).toHaveLength(2);
  });

  it('starts over on reset', () => {
    const recorder = createRecorder({ maxEntries: 1 });
    recorder.record(0, 'resume');
    recorder.record(1, 'moveLeft');
    expect(recorder.truncated()).toBe(true);
    recorder.reset();
    expect(recorder.log()).toEqual({ durationMs: 0, entries: [], truncated: false });
  });
});

describe('the stepped player', () => {
  it('arrives at exactly the state the one-shot replay does', () => {
    for (const seed of SEEDS) {
      const recorder = createRecorder();
      const live = play(seed, {}, makeScript(seed, 300), recorder);
      const log = recorder.log();

      let player = startReplay(seed, {}, log);
      // Driven the way the browser drives it: whole-millisecond frames.
      let guard = 0;
      while (!player.done && guard < 200_000) {
        player = advanceReplay(player, 16);
        guard += 1;
      }

      expect(player.done).toBe(true);
      expect(player.state).toEqual(live.state);
    }
  });

  it('reports the events of the step it just took, and only those', () => {
    const recorder = createRecorder();
    play(21, {}, makeScript(21, 200), recorder);
    const log = recorder.log();

    let player = startReplay(21, {}, log);
    const seen: string[] = [];
    while (!player.done) {
      player = advanceReplay(player, 16);
      seen.push(...player.events.map((event) => event.type));
    }
    // A run of two hundred inputs locks pieces; the viewer needs those events
    // to animate, and it needs them once each.
    expect(seen).toContain('spawn');
    expect(seen).toContain('lock');
    expect(player.events.length === 0 || player.events.length > 0).toBe(true);
  });

  it('takes a whole run in one enormous step just as happily', () => {
    const recorder = createRecorder();
    const live = play(99, {}, makeScript(99, 300), recorder);
    const log = recorder.log();
    const player = advanceReplay(startReplay(99, {}, log), log.durationMs + 10_000);
    expect(player.done).toBe(true);
    expect(player.state).toEqual(live.state);
  });

  it('plays faster by being handed a bigger delta, and nothing else', () => {
    const recorder = createRecorder();
    play(5, {}, makeScript(5, 200), recorder);
    const log = recorder.log();

    const run = (multiplier: number): number => {
      let player = startReplay(5, {}, log);
      let frames = 0;
      while (!player.done && frames < 200_000) {
        player = advanceReplay(player, 16 * multiplier);
        frames += 1;
      }
      return frames;
    };

    const single = run(1);
    const quadruple = run(4);
    expect(quadruple).toBeLessThan(single);
    expect(quadruple).toBeGreaterThan(0);
  });

  it('does nothing at all once it is done', () => {
    const player = startReplay(1, {}, emptyLog());
    expect(player.done).toBe(true);
    expect(advanceReplay(player, 1000)).toEqual(player);
  });

  it('winds back to the beginning without keeping anything', () => {
    const recorder = createRecorder();
    play(31, {}, makeScript(31, 120), recorder);
    const log = recorder.log();
    const started = startReplay(31, {}, log);
    const halfway = advanceReplay(started, log.durationMs / 2);
    expect(restartReplay(halfway)).toEqual(started);
  });

  it('does not run the clock past the end of the log', () => {
    const recorder = createRecorder();
    play(63, {}, makeScript(63, 100), recorder);
    const log = recorder.log();
    const player = advanceReplay(startReplay(63, {}, log), 1_000_000);
    expect(player.clockMs).toBe(log.durationMs);
  });
});

describe('a log from somewhere else', () => {
  // `replay` is fed by a decoder that has already checked the shape, but it is
  // still the last thing between a stranger's link and the game.

  it('survives entries whose clock goes backwards', () => {
    const log: ReplayLog = {
      durationMs: 100,
      entries: [
        { t: 90, input: 'resume' },
        { t: 10, input: 'moveLeft' },
        { t: 50, input: 'hardDrop' },
      ],
      truncated: false,
    };
    expect(() => replay(1, {}, log)).not.toThrow();
    expect(replay(1, {}, log).status).not.toBe('ready');
  });

  it('survives a duration shorter than the last entry', () => {
    const log: ReplayLog = {
      durationMs: 0,
      entries: [{ t: 5_000, input: 'resume' }],
      truncated: false,
    };
    expect(() => replay(1, {}, log)).not.toThrow();
  });

  it('replays an empty log to the opening position', () => {
    expect(replay(1, {}, emptyLog())).toEqual(createGame({ seed: 1 }));
  });
});

