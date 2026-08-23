/**
 * A bot that can actually play.
 *
 * It is an *opponent*, not a simulation of one: it looks at a `GameState`,
 * decides where the falling piece should go, and then gets it there by pressing
 * the same buttons a person would. There is no back door. Every move it makes
 * goes through `applyInput`, which means a bot game obeys exactly the rules a
 * human game obeys, records into exactly the same replay log, and cannot cheat
 * even by accident — if the bot could reach a placement the rules forbid, that
 * would be a bug in the rules.
 *
 * ## Pure and seeded, like everything else here
 *
 * The bot's own randomness — which is only ever used to decide whether to play
 * a deliberately worse move — is a `randomStep` state carried in `BotState`,
 * the way the piece bag is carried in `GameState`. Same state, same difficulty,
 * same seed, same moves, on any machine and any day. `bot.test.ts` runs two
 * identical simulations and compares the final snapshots field for field.
 *
 * ## How a placement is chosen
 *
 * 1. **Enumerate.** Every distinct rotation of the falling piece, at every
 *    column it can occupy, dropped straight down. Rotations whose cells are the
 *    same shape are collapsed — an `O` has one, an `I` two, a `T` four — so no
 *    work is done twice.
 * 2. **Score.** Lock the piece into a copy of the board, clear whatever
 *    completed, and read five numbers off the result: aggregate height, holes,
 *    bumpiness, lines cleared, and how deep the deepest unfillable well is.
 *    `BOT_WEIGHTS` turns those into one number. The weights are named constants
 *    and nothing else in this file writes a number into that sum.
 * 3. **Look ahead**, on the harder settings only: take the best few boards and
 *    ask what the *next* piece would score on each, then add a discounted share
 *    of that. This is the single biggest difference between a bot that survives
 *    a minute and one that survives twenty.
 * 4. **Choose**, usually the best — but an easier bot rolls its generator and,
 *    some of the time, takes something from further down the list instead.
 * 5. **Reach it.** Drive `applyInput` from where the piece actually is: hold if
 *    the plan called for it, turn it the short way round, walk it sideways one
 *    press at a time, and slam. Every one of those presses is checked against
 *    the engine as it is generated, so a plan that cannot be executed is never
 *    returned in the first place.
 *
 * ## Difficulty is thinking and speed, never a handicap
 *
 * An easier bot waits longer between presses, looks one piece less far ahead,
 * leaves the hold slot alone, and misplays more often. What it never gets is a
 * different rule book: no extra garbage, no slower gravity, no forgiving
 * top-out. A player can feel a rigged game within about a minute, and being
 * beaten by a machine that had to cheat to do it is worth nothing.
 */

import { clearRows, findFullRows, isValidPosition, lockPiece, type Board } from './board';
import {
  applyInput,
  dropDistance,
  type GameInput,
  type GameState,
} from './game';
import { getCells, spawnPosition } from './pieces';
import { randomStep } from './random';
import type { ActivePiece, PieceKind, Rotation } from './types';

// ---------------------------------------------------------------------------
// The heuristic
// ---------------------------------------------------------------------------

/**
 * What the bot measures about a board. Five numbers, all of them things a
 * player would say out loud: how tall it is, how many cells are buried, how
 * jagged the surface is, how much came out, and whether there is a hole in the
 * skyline nothing can ever fill.
 */
export interface BoardMetrics {
  /** Sum of the column heights. The stack's total mass. */
  readonly aggregateHeight: number;
  /** Empty cells with at least one filled cell somewhere above them. */
  readonly holes: number;
  /** Sum of the height differences between neighbouring columns. */
  readonly bumpiness: number;
  /** The tallest column. */
  readonly maxHeight: number;
  /**
   * How far the wells run past what a piece could fill. A column four rows
   * below both its neighbours is a tetris well and costs nothing; a column
   * seven rows below them is three rows of damage nothing can reach.
   */
  readonly wellDepth: number;
}

/**
 * How deep a well may be before it counts against the board: four, the length
 * of the longest piece. Anything up to that is a slot; anything past it is a
 * hole with the lid off.
 */
export const WELL_TOLERANCE = 4;

/**
 * What each measurement is worth.
 *
 * Positive is good, negative is bad, and the relative sizes are the whole
 * personality of the bot: burying a cell costs about two thirds of a row of
 * height, and clearing a row pays a little more than the height it removes,
 * which is why it will happily take a single to keep the stack low but will not
 * dig a hole to do it. The four classic terms carry the familiar weights from
 * the published genetic-algorithm work on this heuristic; the well term is this
 * project's own, and exists because the other four are perfectly happy to build
 * a chasm they can never fill.
 */
export interface BotWeights {
  readonly aggregateHeight: number;
  readonly holes: number;
  readonly bumpiness: number;
  readonly linesCleared: number;
  readonly wellDepth: number;
}

export const BOT_WEIGHTS: BotWeights = {
  aggregateHeight: -0.510066,
  holes: -0.35663,
  bumpiness: -0.184483,
  linesCleared: 0.760666,
  wellDepth: -0.4,
};

/**
 * How much of the next piece's best score counts toward this piece's decision.
 *
 * Less than one on purpose: the next piece's placement is a guess about a board
 * that has not happened yet, and a bot that trusts its own forecast as much as
 * the thing in front of it plays worse, not better.
 */
export const LOOKAHEAD_DISCOUNT = 0.6;

/** How many of the best placements are worth looking a piece past. */
export const LOOKAHEAD_BRANCHES = 5;

/** The height of every column, left to right. Zero for an empty column. */
export function columnHeights(board: Board): number[] {
  const heights: number[] = [];
  for (let x = 0; x < board.width; x += 1) {
    let height = 0;
    for (let y = 0; y < board.height; y += 1) {
      if (board.cells[y * board.width + x] != null) {
        height = board.height - y;
        break;
      }
    }
    heights.push(height);
  }
  return heights;
}

/** Read the five numbers off a board. */
export function boardMetrics(board: Board): BoardMetrics {
  const heights = columnHeights(board);

  let aggregateHeight = 0;
  let maxHeight = 0;
  for (const height of heights) {
    aggregateHeight += height;
    if (height > maxHeight) {
      maxHeight = height;
    }
  }

  let bumpiness = 0;
  for (let x = 0; x + 1 < heights.length; x += 1) {
    bumpiness += Math.abs((heights[x] ?? 0) - (heights[x + 1] ?? 0));
  }

  let holes = 0;
  for (let x = 0; x < board.width; x += 1) {
    const top = board.height - (heights[x] ?? 0);
    for (let y = top + 1; y < board.height; y += 1) {
      if (board.cells[y * board.width + x] == null) {
        holes += 1;
      }
    }
  }

  // A well is a column sunk below its neighbours. At the edges there is only
  // one neighbour to be sunk below; the wall is not a taller column, it is the
  // end of the board.
  let wellDepth = 0;
  for (let x = 0; x < heights.length; x += 1) {
    const here = heights[x] ?? 0;
    const left = x > 0 ? (heights[x - 1] ?? 0) : Number.POSITIVE_INFINITY;
    const right = x + 1 < heights.length ? (heights[x + 1] ?? 0) : Number.POSITIVE_INFINITY;
    const rim = Math.min(left, right);
    if (Number.isFinite(rim)) {
      wellDepth += Math.max(0, rim - here - WELL_TOLERANCE);
    }
  }

  return { aggregateHeight, holes, bumpiness, maxHeight, wellDepth };
}

/** The heuristic proper: one number for a board and the rows it just cleared. */
export function scoreBoard(board: Board, linesCleared: number): number {
  const metrics = boardMetrics(board);
  return (
    BOT_WEIGHTS.aggregateHeight * metrics.aggregateHeight +
    BOT_WEIGHTS.holes * metrics.holes +
    BOT_WEIGHTS.bumpiness * metrics.bumpiness +
    BOT_WEIGHTS.linesCleared * linesCleared +
    BOT_WEIGHTS.wellDepth * metrics.wellDepth
  );
}

// ---------------------------------------------------------------------------
// Difficulties
// ---------------------------------------------------------------------------

export type BotDifficulty = 'easy' | 'medium' | 'hard';

/** Every difficulty, easiest first. */
export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'medium', 'hard'];

/** Anything at all, read as a difficulty. Unrecognised values are `medium`. */
export function parseBotDifficulty(value: unknown): BotDifficulty {
  return BOT_DIFFICULTIES.includes(value as BotDifficulty) ? (value as BotDifficulty) : 'medium';
}

/**
 * How one difficulty thinks and how fast it moves. Four dials, and not one of
 * them touches the rules.
 */
export interface BotProfile {
  /** Pause before the first press of a placement — the bot working it out. */
  readonly thinkMs: number;
  /** Pause between presses within a placement. */
  readonly moveIntervalMs: number;
  /** 1 looks at the falling piece only; 2 also weighs the piece after it. */
  readonly lookahead: number;
  /** Whether the hold slot is part of its vocabulary. */
  readonly useHold: boolean;
  /** How often it takes something other than the best placement, 0 to 1. */
  readonly mistakeChance: number;
  /** How far down the ranked list a mistake may reach. */
  readonly mistakeDepth: number;
}

export const BOT_PROFILES: Readonly<Record<BotDifficulty, BotProfile>> = {
  /** Slow hands, no plan past the piece in front of it, and a third of its
   *  placements are not the one it should have made. Beatable, and — this is
   *  the point — beatable in a way that looks like a person having a bad game
   *  rather than a machine being switched off. */
  easy: {
    thinkMs: 380,
    moveIntervalMs: 85,
    lookahead: 1,
    useHold: false,
    mistakeChance: 0.32,
    mistakeDepth: 6,
  },
  /** Quicker, uses hold, and misplays about one piece in eight. */
  medium: {
    thinkMs: 200,
    moveIntervalMs: 50,
    lookahead: 1,
    useHold: true,
    mistakeChance: 0.12,
    mistakeDepth: 3,
  },
  /** Fast, looks a piece ahead, holds, and never throws one away. */
  hard: {
    thinkMs: 80,
    moveIntervalMs: 22,
    lookahead: 2,
    useHold: true,
    mistakeChance: 0,
    mistakeDepth: 1,
  },
};

// ---------------------------------------------------------------------------
// Enumerating placements
// ---------------------------------------------------------------------------

/** One place the piece could end up, and what the board would look like after. */
interface Candidate {
  readonly rotation: Rotation;
  readonly x: number;
  readonly useHold: boolean;
  /** The board after locking and clearing. */
  readonly board: Board;
  readonly lines: number;
  /** Heuristic score, lookahead included when the profile asks for it. */
  score: number;
}

/** The shape of a rotation, normalised so equal shapes compare equal. */
function shapeKey(kind: PieceKind, rotation: Rotation): string {
  const cells = getCells(kind, rotation);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const { x, y } of cells) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  return cells.map(({ x, y }) => `${x - minX},${y - minY}`).join(' ');
}

/** The rotations of a kind whose shapes actually differ, lowest state first. */
export function distinctRotations(kind: PieceKind): readonly Rotation[] {
  const seen = new Set<string>();
  const rotations: Rotation[] = [];
  for (const rotation of [0, 1, 2, 3] as const) {
    const key = shapeKey(kind, rotation);
    if (!seen.has(key)) {
      seen.add(key);
      rotations.push(rotation);
    }
  }
  return rotations;
}

/** Lock a piece where it would land and clear whatever completed. */
function settle(board: Board, piece: ActivePiece): { board: Board; lines: number } {
  const landed: ActivePiece = { ...piece, y: piece.y + dropDistance(board, piece) };
  const locked = lockPiece(board, landed);
  const full = findFullRows(locked);
  if (full.length === 0) {
    return { board: locked, lines: 0 };
  }
  return { board: clearRows(locked, full).board, lines: full.length };
}

/**
 * Every distinct place `kind` could be dropped into `board` from row `startY`.
 *
 * Straight drops only: no tucking a piece sideways under an overhang at the
 * last moment. That is a real limitation and a deliberate one — it is the class
 * of move the input driver below can reliably reach, and a bot that plans moves
 * it cannot execute is worse than one that plans fewer.
 */
function enumerate(board: Board, kind: PieceKind, startY: number, useHold: boolean): Candidate[] {
  const candidates: Candidate[] = [];
  for (const rotation of distinctRotations(kind)) {
    for (let x = -3; x < board.width; x += 1) {
      const piece: ActivePiece = { kind, rotation, x, y: startY };
      if (!isValidPosition(board, piece)) {
        continue;
      }
      const settled = settle(board, piece);
      candidates.push({
        rotation,
        x,
        useHold,
        board: settled.board,
        lines: settled.lines,
        score: scoreBoard(settled.board, settled.lines),
      });
    }
  }
  return candidates;
}

/** The best a kind can do on a board, dropped from its spawn row. */
function bestReply(board: Board, kind: PieceKind): number {
  const spawn = spawnPosition(kind, board.width);
  let best = Number.NEGATIVE_INFINITY;
  for (const candidate of enumerate(board, kind, spawn.y, false)) {
    if (candidate.score > best) {
      best = candidate.score;
    }
  }
  return Number.isFinite(best) ? best : 0;
}

// ---------------------------------------------------------------------------
// Reaching a placement
// ---------------------------------------------------------------------------

/** A placement the bot wants, and the presses that get the piece there. */
export interface BotPlan {
  readonly kind: PieceKind;
  readonly rotation: Rotation;
  /** The piece origin's target column. */
  readonly x: number;
  /** The plan opens by parking the falling piece in the hold slot. */
  readonly useHold: boolean;
  /** The heuristic score of the resulting board. */
  readonly score: number;
  /** Rows the placement completes. */
  readonly lines: number;
  /** This was not the best placement available; the bot chose it anyway. */
  readonly mistake: boolean;
  /** The presses, in order, ending in a hard drop. */
  readonly inputs: readonly GameInput[];
}

const ROTATE_CW: GameInput = { type: 'rotateCW' };
const ROTATE_CCW: GameInput = { type: 'rotateCCW' };
const MOVE_LEFT: GameInput = { type: 'moveLeft' };
const MOVE_RIGHT: GameInput = { type: 'moveRight' };
const HARD_DROP: GameInput = { type: 'hardDrop' };
const HOLD: GameInput = { type: 'hold' };

/** Did applying an input actually move the game? */
function inputLanded(before: GameState, after: GameState): boolean {
  if (before.status !== after.status || before.board !== after.board) {
    return true;
  }
  if (before.score !== after.score || before.hold !== after.hold) {
    return true;
  }
  if (before.holdLocked !== after.holdLocked) {
    return true;
  }
  const a = before.active;
  const b = after.active;
  if (a === null || b === null) {
    return a !== b;
  }
  return a.kind !== b.kind || a.rotation !== b.rotation || a.x !== b.x || a.y !== b.y;
}

/**
 * Build the press list that takes the falling piece to `(rotation, x)`.
 *
 * Every press is applied to a throwaway copy of the state as it is generated
 * and kept only if the engine accepted it, so the list this returns is a list
 * the engine has already agreed to. A placement walled off behind the stack
 * simply comes back `null` and the caller moves on to its next choice.
 */
function pressesTo(
  state: GameState,
  target: { rotation: Rotation; x: number; useHold: boolean },
): readonly GameInput[] | null {
  const inputs: GameInput[] = [];
  let current = state;

  if (target.useHold) {
    const held = applyInput(current, HOLD);
    if (!inputLanded(current, held) || held.active === null) {
      return null;
    }
    inputs.push(HOLD);
    current = held;
  }

  const piece = current.active;
  if (piece === null) {
    return null;
  }

  // Turn the short way round: three clockwise presses and one anticlockwise
  // press arrive at the same place, and the shorter list is also the one less
  // likely to be interrupted.
  const clockwise = (target.rotation - piece.rotation + 4) % 4;
  const anticlockwise = (piece.rotation - target.rotation + 4) % 4;
  const turns = clockwise <= anticlockwise ? clockwise : anticlockwise;
  const turn = clockwise <= anticlockwise ? ROTATE_CW : ROTATE_CCW;
  for (let i = 0; i < turns; i += 1) {
    const turned = applyInput(current, turn);
    if (!inputLanded(current, turned) || turned.active === null) {
      return null;
    }
    inputs.push(turn);
    current = turned;
  }
  if (current.active?.rotation !== target.rotation) {
    return null;
  }

  // Then sideways, one press at a time, until the origin is on target. A kick
  // during the rotation may have moved it, which is exactly why the walk starts
  // from where the piece actually is rather than from where it was.
  let guard = 0;
  while (current.active !== null && current.active.x !== target.x) {
    guard += 1;
    if (guard > state.board.width * 2) {
      return null;
    }
    const step = current.active.x < target.x ? MOVE_RIGHT : MOVE_LEFT;
    const moved = applyInput(current, step);
    if (!inputLanded(current, moved) || moved.active === null) {
      return null;
    }
    inputs.push(step);
    current = moved;
  }

  inputs.push(HARD_DROP);
  return inputs;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Which kind the bot will be holding the piece *after* this one. */
function lookaheadKind(state: GameState, useHold: boolean): PieceKind | undefined {
  if (useHold && state.hold === null) {
    // The first hold of a run takes the head of the queue with it.
    return state.next[1];
  }
  return state.next[0];
}

/**
 * Decide where the falling piece goes and how to get it there.
 *
 * Returns the advanced generator alongside the plan: the bot's randomness is
 * data, like everything else, and a caller that throws the new state away gets
 * the same decision again.
 */
export function planPlacement(
  state: GameState,
  difficulty: BotDifficulty,
  random: number,
): { plan: BotPlan | null; random: number } {
  const profile = BOT_PROFILES[difficulty];
  const piece = state.active;
  if (state.status !== 'playing' || piece === null) {
    return { plan: null, random };
  }

  const branches: { state: GameState; kind: PieceKind; useHold: boolean }[] = [
    { state, kind: piece.kind, useHold: false },
  ];
  if (profile.useHold && !state.holdLocked) {
    const held = applyInput(state, HOLD);
    if (held.active !== null && held.active.kind !== piece.kind) {
      branches.push({ state: held, kind: held.active.kind, useHold: true });
    }
  }

  const candidates: Candidate[] = [];
  for (const branch of branches) {
    const from = branch.state.active;
    if (from === null) {
      continue;
    }
    candidates.push(...enumerate(branch.state.board, branch.kind, from.y, branch.useHold));
  }
  if (candidates.length === 0) {
    return { plan: null, random };
  }

  candidates.sort((a, b) => b.score - a.score);

  let ranked = candidates;
  if (profile.lookahead > 1) {
    // Only the shortlist is worth the cost of a second piece. The two halves
    // are then ranked on different scales — a looked-ahead score and a plain
    // one — so they are never compared: the shortlist is re-sorted among
    // itself and the tail is left underneath it, in its own order, as the
    // fallback it always was. Mixing the two is what a first draft of this did,
    // and a bot that compares a discounted score against an undiscounted one
    // reliably picks the worst move on the board.
    const shortlist = candidates.slice(0, LOOKAHEAD_BRANCHES);
    for (const candidate of shortlist) {
      const kind = lookaheadKind(state, candidate.useHold);
      if (kind !== undefined) {
        candidate.score += LOOKAHEAD_DISCOUNT * bestReply(candidate.board, kind);
      }
    }
    shortlist.sort((a, b) => b.score - a.score);
    ranked = [...shortlist, ...candidates.slice(LOOKAHEAD_BRANCHES)];
  }

  // One roll decides whether to misplay, a second decides how badly. Rolled
  // whatever the difficulty, so that the generator advances at the same rate
  // for all three and a difficulty is not secretly a different seed.
  const rollChance = randomStep(random);
  const rollDepth = randomStep(rollChance.state);
  let chosen = 0;
  if (profile.mistakeChance > 0 && rollChance.value < profile.mistakeChance) {
    const depth = Math.max(1, Math.floor(profile.mistakeDepth));
    chosen = Math.min(ranked.length - 1, 1 + Math.floor(rollDepth.value * depth));
  }

  // Walk down from the choice until one of them can actually be reached. Only
  // the choice itself counts as a mistake: falling past a placement the stack
  // has walled off is the bot doing its best, not throwing a piece away.
  for (let index = chosen; index < ranked.length; index += 1) {
    const candidate = ranked[index];
    if (candidate === undefined) {
      continue;
    }
    const source = candidate.useHold ? branches[1]?.state : state;
    if (source === undefined) {
      continue;
    }
    const inputs = pressesTo(state, {
      rotation: candidate.rotation,
      x: candidate.x,
      useHold: candidate.useHold,
    });
    if (inputs === null) {
      continue;
    }
    const kind = source.active?.kind ?? piece.kind;
    return {
      plan: {
        kind,
        rotation: candidate.rotation,
        x: candidate.x,
        useHold: candidate.useHold,
        score: candidate.score,
        lines: candidate.lines,
        mistake: index === chosen && chosen > 0,
        inputs,
      },
      random: rollDepth.state,
    };
  }

  return { plan: null, random: rollDepth.state };
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

/**
 * The bot, as plain data.
 *
 * `waitMs` counts down to the next press exactly the way gravity counts down to
 * the next row, and `plan`/`step` are how far through the current placement it
 * has got. All of it is a value: two bots with equal fields play identically
 * from here on.
 */
export interface BotState {
  readonly difficulty: BotDifficulty;
  /** The bot's own generator, advanced once per decision. */
  readonly random: number;
  /** Milliseconds until the next press. */
  readonly waitMs: number;
  /** The placement being executed, or `null` between placements. */
  readonly plan: BotPlan | null;
  /** How many of `plan.inputs` have been pressed. */
  readonly step: number;
  /** Placements decided on so far. */
  readonly placements: number;
  /** How many of those were deliberately not the best available. */
  readonly mistakes: number;
}

/** What the bot did with one slice of time. */
export interface BotStep {
  readonly bot: BotState;
  /** The game after its presses. Hand this back to `update`. */
  readonly state: GameState;
  /** The presses it made, in order — a recorder can log these verbatim. */
  readonly inputs: readonly GameInput[];
}

/** How much of a long frame the bot will try to catch up on in one call. */
const MAX_BOT_DEBT_MS = 250;

/** Presses per `stepBot` call. A backstop, not a rule the bot ever reaches. */
const MAX_INPUTS_PER_STEP = 24;

/** Re-plans per `stepBot` call, in case a plan is stale the moment it is made. */
const MAX_REPLANS_PER_STEP = 3;

/**
 * A bot at the start of a run.
 *
 * `waitMs` is zero rather than a think time: the first thing it does is decide
 * on a placement, and *that* is what costs `thinkMs`. Starting the clock here as
 * well would charge the opening piece twice.
 */
export function createBot(difficulty: BotDifficulty, seed: number): BotState {
  return {
    difficulty,
    random: seed >>> 0,
    waitMs: 0,
    plan: null,
    step: 0,
    placements: 0,
    mistakes: 0,
  };
}

/**
 * Give the bot `deltaMs` of thinking time and let it press whatever is due.
 *
 * It never advances the game clock — that is the caller's `update` — and it
 * only ever changes the game through `applyInput`. A press that the engine
 * turns out not to accept (the piece fell a row while the bot was walking it
 * sideways, and the path closed) is not forced through: the plan is thrown away
 * and a new one made against the board as it now stands.
 */
export function stepBot(bot: BotState, state: GameState, deltaMs: number): BotStep {
  const profile = BOT_PROFILES[bot.difficulty];
  const inputs: GameInput[] = [];

  let current = state;
  let waitMs = Math.max(bot.waitMs - Math.max(0, deltaMs), -MAX_BOT_DEBT_MS);
  let plan = bot.plan;
  let step = bot.step;
  let random = bot.random;
  let placements = bot.placements;
  let mistakes = bot.mistakes;
  let replans = 0;

  while (waitMs <= 0 && inputs.length < MAX_INPUTS_PER_STEP) {
    if (current.status !== 'playing' || current.active === null) {
      // Topped out, paused, or between pieces while a clear plays out. Either
      // way there is nothing to press; the wait is held where it is so the bot
      // is ready the moment a piece arrives.
      plan = null;
      step = 0;
      break;
    }

    if (plan === null || step >= plan.inputs.length) {
      if (replans >= MAX_REPLANS_PER_STEP) {
        break;
      }
      replans += 1;
      const planned = planPlacement(current, bot.difficulty, random);
      random = planned.random;
      plan = planned.plan;
      step = 0;
      if (plan === null) {
        break;
      }
      placements += 1;
      if (plan.mistake) {
        mistakes += 1;
      }
      waitMs += profile.thinkMs;
      continue;
    }

    const input = plan.inputs[step];
    const next = input === undefined ? current : applyInput(current, input);
    if (input === undefined || !inputLanded(current, next)) {
      // The board moved out from under the plan — the piece fell a row while
      // the bot was walking it sideways and the path closed. The press is *not*
      // forced through; the plan goes in the bin and a new one is made against
      // the well as it now stands.
      plan = null;
      step = 0;
      continue;
    }

    current = next;
    inputs.push(input);
    step += 1;
    waitMs += profile.moveIntervalMs;
  }

  return {
    bot: { difficulty: bot.difficulty, random, waitMs, plan, step, placements, mistakes },
    state: current,
    inputs,
  };
}
