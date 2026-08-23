import { describe, expect, it } from 'vitest';

import { boardFromStrings, createBoard, BOARD_HEIGHT, BOARD_WIDTH } from './board';
import {
  boardMetrics,
  columnHeights,
  createBot,
  distinctRotations,
  parseBotDifficulty,
  planPlacement,
  scoreBoard,
  stepBot,
  BOT_DIFFICULTIES,
  BOT_PROFILES,
  BOT_WEIGHTS,
  WELL_TOLERANCE,
  type BotDifficulty,
  type BotState,
} from './bot';
import { applyInput, createGame, update, type GameInput, type GameState } from './game';
import { PIECE_KINDS } from './pieces';
import { createRecorder, replay } from './replay';

/**
 * The bot's tests are about *behaviour*: does it survive, does it beat its
 * easier self, does it press only buttons the engine accepts, and does it do
 * the same thing twice. None of them reach inside the search, because the
 * search is the part that should be free to get better.
 */

/** One frame of a bot game: the bot presses, then the clock moves. */
const FRAME_MS = 16;

interface RunResult {
  readonly state: GameState;
  readonly bot: BotState;
  readonly inputs: readonly GameInput[];
  readonly frames: number;
}

/**
 * Play a bot game for `durationMs` of run time, or until it tops out.
 *
 * Deliberately written the way a UI would write it — press, then advance the
 * clock — so what the tests measure is what a player would watch.
 */
function runBot(
  difficulty: BotDifficulty,
  seed: number,
  durationMs: number,
  options: { readonly check?: (before: GameState, inputs: readonly GameInput[], after: GameState) => void } = {},
): RunResult {
  let state = applyInput(createGame({ seed }), { type: 'resume' });
  let bot = createBot(difficulty, seed);
  const inputs: GameInput[] = [];
  let frames = 0;

  while (state.elapsedMs < durationMs && state.status === 'playing') {
    const before = state;
    const stepped = stepBot(bot, state, FRAME_MS);
    options.check?.(before, stepped.inputs, stepped.state);
    bot = stepped.bot;
    inputs.push(...stepped.inputs);
    state = update(stepped.state, FRAME_MS);
    frames += 1;
  }

  return { state, bot, inputs, frames };
}

/** Everything about a snapshot two identical runs must agree on. */
function signature(state: GameState): Record<string, unknown> {
  return {
    status: state.status,
    outcome: state.outcome,
    score: state.score,
    lines: state.lines,
    level: state.level,
    elapsedMs: state.elapsedMs,
    board: state.board.cells.join(''),
    hold: state.hold,
    next: [...state.next],
  };
}

// ---------------------------------------------------------------------------
// The heuristic's own arithmetic
// ---------------------------------------------------------------------------

describe('columnHeights', () => {
  it('is zero everywhere on an empty board', () => {
    expect(columnHeights(createBoard(4, 4))).toEqual([0, 0, 0, 0]);
  });

  it('measures from the highest filled cell, holes included', () => {
    expect(columnHeights(boardFromStrings(['.I..', '.I..', 'OI.T', 'O..T']))).toEqual([2, 4, 0, 2]);
  });
});

describe('boardMetrics', () => {
  it('counts buried cells as holes', () => {
    expect(boardMetrics(boardFromStrings(['....', 'II.I', '.I.I'])).holes).toBe(1);
  });

  it('adds up the steps between neighbouring columns', () => {
    // Heights 3, 1, 2, 1 — so two steps down, one up, one down.
    expect(boardMetrics(boardFromStrings(['I...', 'I.T.', 'IOTO'])).bumpiness).toBe(2 + 1 + 1);
  });

  it('forgives a well a piece could fill and punishes one it could not', () => {
    /** A middle column sunk `depth` rows below both its neighbours. */
    const well = (depth: number): string[] =>
      Array.from({ length: depth + 1 }, (_, y) => (y < depth ? 'I.I' : 'III'));
    expect(boardMetrics(boardFromStrings(well(WELL_TOLERANCE))).wellDepth).toBe(0);
    expect(boardMetrics(boardFromStrings(well(WELL_TOLERANCE + 2))).wellDepth).toBe(2);
  });

  it('counts a chasm against the wall, which has only one rim', () => {
    // The wall is not a taller column, it is the end of the board — so the
    // depth of an edge well is measured against its one neighbour.
    const board = boardFromStrings(['.III', '.III', '.III', '.III', '.III', '.III']);
    expect(boardMetrics(board).wellDepth).toBe(6 - WELL_TOLERANCE);
    // And a shallow notch at the edge is still just a notch.
    expect(boardMetrics(boardFromStrings(['.III', 'IIII'])).wellDepth).toBe(0);
  });

  it('finds the tallest column', () => {
    expect(boardMetrics(boardFromStrings(['..I.', '.OI.', 'JOIT'])).maxHeight).toBe(3);
  });
});

describe('scoreBoard', () => {
  it('prefers a low stack to a tall one', () => {
    const low = boardFromStrings(['....', '....', 'IIII']);
    const tall = boardFromStrings(['IIII', 'IIII', 'IIII']);
    expect(scoreBoard(low, 0)).toBeGreaterThan(scoreBoard(tall, 0));
  });

  it('prefers a flat surface to a jagged one', () => {
    const flat = boardFromStrings(['....', 'IIII']);
    const jagged = boardFromStrings(['I.I.', 'IIII']);
    expect(scoreBoard(flat, 0)).toBeGreaterThan(scoreBoard(jagged, 0));
  });

  it('hates a buried cell more than a row of height', () => {
    expect(Math.abs(BOT_WEIGHTS.holes)).toBeGreaterThan(Math.abs(BOT_WEIGHTS.aggregateHeight) / 2);
  });

  it('pays for the rows a placement cleared', () => {
    const board = boardFromStrings(['....', '....']);
    expect(scoreBoard(board, 4) - scoreBoard(board, 0)).toBeCloseTo(BOT_WEIGHTS.linesCleared * 4);
  });
});

describe('distinctRotations', () => {
  it('collapses the rotations that are the same shape', () => {
    expect(distinctRotations('O')).toEqual([0]);
    expect(distinctRotations('I')).toEqual([0, 1]);
    expect(distinctRotations('S')).toEqual([0, 1]);
    expect(distinctRotations('Z')).toEqual([0, 1]);
    expect(distinctRotations('T')).toEqual([0, 1, 2, 3]);
    expect(distinctRotations('J')).toEqual([0, 1, 2, 3]);
    expect(distinctRotations('L')).toEqual([0, 1, 2, 3]);
  });

  it('always keeps the spawn rotation, which costs no presses', () => {
    for (const kind of PIECE_KINDS) {
      expect(distinctRotations(kind)[0]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Difficulties
// ---------------------------------------------------------------------------

describe('the difficulties', () => {
  it('get faster, deeper and steadier, in that order', () => {
    let previous = BOT_PROFILES.easy;
    for (const difficulty of BOT_DIFFICULTIES.slice(1)) {
      const profile = BOT_PROFILES[difficulty];
      expect(profile.thinkMs).toBeLessThan(previous.thinkMs);
      expect(profile.moveIntervalMs).toBeLessThan(previous.moveIntervalMs);
      expect(profile.lookahead).toBeGreaterThanOrEqual(previous.lookahead);
      expect(profile.mistakeChance).toBeLessThan(previous.mistakeChance);
      previous = profile;
    }
  });

  it('differ only in thinking and speed — never in the rules', () => {
    // The profile is the whole of a difficulty, and there is nothing in it that
    // could bend a rule: no gravity, no garbage, no scoring, no top-out.
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(Object.keys(BOT_PROFILES[difficulty]).sort()).toEqual([
        'lookahead',
        'mistakeChance',
        'mistakeDepth',
        'moveIntervalMs',
        'thinkMs',
        'useHold',
      ]);
    }
  });

  it('reads an unknown difficulty as the middle one', () => {
    expect(parseBotDifficulty('nightmare')).toBe('medium');
    expect(parseBotDifficulty(undefined)).toBe('medium');
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(parseBotDifficulty(difficulty)).toBe(difficulty);
    }
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe('planPlacement', () => {
  const game = (): GameState => applyInput(createGame({ seed: 5 }), { type: 'resume' });

  it('returns the same plan for the same state, difficulty and generator', () => {
    const state = game();
    const first = planPlacement(state, 'hard', 1234);
    const again = planPlacement(state, 'hard', 1234);
    expect(again).toEqual(first);
  });

  it('ends every plan with a hard drop', () => {
    for (const difficulty of BOT_DIFFICULTIES) {
      const plan = planPlacement(game(), difficulty, 99).plan;
      expect(plan).not.toBeNull();
      expect(plan?.inputs.at(-1)).toEqual({ type: 'hardDrop' });
    }
  });

  it('produces presses the engine accepts, and lands the piece where it said', () => {
    const state = game();
    const plan = planPlacement(state, 'hard', 7).plan;
    expect(plan).not.toBeNull();

    let current = state;
    for (const input of plan?.inputs ?? []) {
      const next = applyInput(current, input);
      expect(next).not.toBe(current);
      current = next;
    }
    // The piece is on the stack and the board changed, which is the only proof
    // that matters: the plan was executable from start to finish.
    expect(current.board).not.toBe(state.board);
  });

  it('never opens with a hold on a difficulty that does not use one', () => {
    for (let random = 1; random < 60; random += 7) {
      const plan = planPlacement(game(), 'easy', random).plan;
      expect(plan?.useHold).toBe(false);
    }
  });

  it('has nothing to say when there is no piece on the field', () => {
    const paused: GameState = { ...game(), active: null };
    expect(planPlacement(paused, 'hard', 3).plan).toBeNull();
    expect(planPlacement({ ...game(), status: 'over' }, 'hard', 3).plan).toBeNull();
  });

  it('finds the row-clearing placement when there is one under its nose', () => {
    // Nine columns full to a depth of one, and a vertical `I` falling: the only
    // placement that clears anything is the tenth column.
    const almost = Array.from({ length: BOARD_WIDTH }, (_, x) => (x === 8 ? '.' : 'J')).join('');
    const board = boardFromStrings(
      Array.from({ length: BOARD_HEIGHT }, (_, y) => (y === BOARD_HEIGHT - 1 ? almost : '.'.repeat(BOARD_WIDTH))),
    );
    const state: GameState = { ...game(), board, active: { kind: 'I', rotation: 0, x: 3, y: 0 } };
    const plan = planPlacement(state, 'hard', 1).plan;
    expect(plan?.lines).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Playing, which is the part that matters
// ---------------------------------------------------------------------------

describe('a bot game', () => {
  it('presses only buttons the engine accepts', () => {
    // Every input the bot hands back is re-applied here, one at a time, to the
    // state it was handed — and every one of them has to move the game.
    runBot('hard', 3, 30_000, {
      check(before, inputs, after) {
        let current = before;
        for (const input of inputs) {
          const next = applyInput(current, input);
          expect(next).not.toEqual(current);
          current = next;
        }
        expect(current).toEqual(after);
      },
    });
  });

  it('is identical across two runs of the same seed and difficulty', () => {
    for (const difficulty of BOT_DIFFICULTIES) {
      const first = runBot(difficulty, 17, 20_000);
      const again = runBot(difficulty, 17, 20_000);
      expect(signature(again.state)).toEqual(signature(first.state));
      expect(again.inputs).toEqual(first.inputs);
      expect(again.bot).toEqual(first.bot);
    }
  });

  it('replays from its own inputs, exactly like a human one', () => {
    const seed = 23;
    const recorder = createRecorder();

    let state = createGame({ seed });
    recorder.record(state.elapsedMs, 'resume');
    state = applyInput(state, { type: 'resume' });
    let bot = createBot('medium', seed);

    while (state.elapsedMs < 20_000 && state.status === 'playing') {
      const at = state.elapsedMs;
      const stepped = stepBot(bot, state, FRAME_MS);
      for (const input of stepped.inputs) {
        recorder.record(at, input.type);
      }
      bot = stepped.bot;
      state = update(stepped.state, FRAME_MS);
      recorder.mark(state.elapsedMs);
    }

    expect(recorder.size()).toBeGreaterThan(50);
    expect(signature(replay(seed, {}, recorder.log()))).toEqual(signature(state));
  });

  it('lets a hard bot survive two minutes and clear a hundred rows', () => {
    const run = runBot('hard', 1, 120_000);
    expect(run.state.status).toBe('playing');
    expect(run.state.elapsedMs).toBeGreaterThanOrEqual(120_000);
    expect(run.state.lines).toBeGreaterThanOrEqual(100);
    expect(run.bot.mistakes).toBe(0);
  });

  it('leaves a hard bot with a well it could still play out of', () => {
    const run = runBot('hard', 4, 60_000);
    expect(boardMetrics(run.state.board).maxHeight).toBeLessThan(BOARD_HEIGHT);
  });

  it('has the harder settings beat the easier ones on every seed', () => {
    const seeds = [1, 2, 3, 4, 5];
    const lines: Record<BotDifficulty, number[]> = { easy: [], medium: [], hard: [] };
    for (const seed of seeds) {
      for (const difficulty of BOT_DIFFICULTIES) {
        lines[difficulty].push(runBot(difficulty, seed, 60_000).state.lines);
      }
    }

    for (let index = 0; index < seeds.length; index += 1) {
      const easy = lines.easy[index] ?? 0;
      const medium = lines.medium[index] ?? 0;
      const hard = lines.hard[index] ?? 0;
      expect([easy, medium, hard]).toEqual([...new Set([easy, medium, hard])].sort((a, b) => a - b));
    }
  }, 60_000);

  it('has an easy bot that really does throw pieces away', () => {
    const run = runBot('easy', 8, 60_000);
    expect(run.bot.placements).toBeGreaterThan(20);
    expect(run.bot.mistakes / run.bot.placements).toBeGreaterThan(0.15);
  });
});

describe('stepBot', () => {
  it('does nothing at all while the game is not running', () => {
    const ready = createGame({ seed: 2 });
    const bot = createBot('hard', 2);
    const stepped = stepBot(bot, ready, 5000);
    expect(stepped.inputs).toEqual([]);
    expect(stepped.state).toBe(ready);
  });

  /** How long a difficulty takes, in frames, to press its first button. */
  function firstPressMs(difficulty: BotDifficulty): number {
    let state = applyInput(createGame({ seed: 2 }), { type: 'resume' });
    let bot = createBot(difficulty, 2);
    for (let elapsed = FRAME_MS; elapsed <= 5000; elapsed += FRAME_MS) {
      const stepped = stepBot(bot, state, FRAME_MS);
      bot = stepped.bot;
      state = stepped.state;
      if (stepped.inputs.length > 0) {
        return elapsed;
      }
    }
    return Number.POSITIVE_INFINITY;
  }

  it('waits out its thinking time before the first press', () => {
    for (const difficulty of BOT_DIFFICULTIES) {
      const thinkMs = BOT_PROFILES[difficulty].thinkMs;
      const pressed = firstPressMs(difficulty);
      expect(pressed).toBeGreaterThanOrEqual(thinkMs);
      expect(pressed).toBeLessThan(thinkMs + 3 * FRAME_MS);
    }
  });

  it('has the harder settings press sooner', () => {
    expect(firstPressMs('hard')).toBeLessThan(firstPressMs('medium'));
    expect(firstPressMs('medium')).toBeLessThan(firstPressMs('easy'));
  });

  it('throws away a plan the board has moved out from under, rather than forcing it', () => {
    // A piece hard against the left wall, and a plan that opens by walking it
    // further left. The engine would simply refuse that press; the bot must
    // notice and think again instead of counting it as done.
    const base = applyInput(createGame({ seed: 2 }), { type: 'resume' });
    const state: GameState = { ...base, active: { kind: 'O', rotation: 0, x: 0, y: 4 } };
    const stale: BotState = {
      difficulty: 'hard',
      random: 5,
      waitMs: 0,
      plan: {
        kind: 'O',
        rotation: 0,
        x: 0,
        useHold: false,
        score: 0,
        lines: 0,
        mistake: false,
        inputs: [{ type: 'moveLeft' }, { type: 'hardDrop' }],
      },
      step: 0,
      placements: 0,
      mistakes: 0,
    };

    const stepped = stepBot(stale, state, 1);
    expect(stepped.inputs).toEqual([]);
    expect(stepped.state).toBe(state);
    // It planned again rather than sitting on the dead plan.
    expect(stepped.bot.placements).toBe(1);
    expect(stepped.bot.plan).not.toEqual(stale.plan);
  });

  it('does not run away with a very long frame', () => {
    const state = applyInput(createGame({ seed: 2 }), { type: 'resume' });
    const stepped = stepBot(createBot('hard', 2), state, 60_000);
    expect(stepped.inputs.length).toBeLessThanOrEqual(24);
  });
});
