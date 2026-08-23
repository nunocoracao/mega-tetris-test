import { describe, expect, it } from 'vitest';

import {
  boardFromStrings,
  boardToStrings,
  createBoard,
  isBoardEmpty,
  pieceCells,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BUFFER_ROWS,
  type Board,
} from './board';
import {
  applyInput,
  createGame,
  dropDistance,
  ghostPiece,
  gravityIntervalMs,
  isResting,
  levelForLines,
  parseGameMode,
  spinKind,
  spinTable,
  update,
  GAME_MODES,
  MODE_RULES,
  SPRINT_GOAL_LINES,
  ULTRA_TIME_LIMIT_MS,
  BACK_TO_BACK_MULTIPLIER,
  COMBO_POINTS,
  GRAVITY_BASE_MS,
  GRAVITY_FLOOR_MS,
  HARD_DROP_POINTS,
  LINE_CLEAR_DELAY_MS,
  LINE_CLEAR_POINTS,
  LINES_PER_LEVEL,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  KICKED_SPIN_POINTS,
  NEXT_QUEUE_SIZE,
  SOFT_DROP_POINTS,
  SPIN_POINTS,
  type GameEvent,
  type GameInput,
  type GameMode,
  type GameState,
} from './game';
import type { ActivePiece, PieceKind } from './types';

/** Start a game: `createGame` hands back a `ready` state, `resume` runs it. */
function start(state: GameState): GameState {
  return applyInput(state, { type: 'resume' });
}

/** A fresh, running game. */
function playing(options: { seed?: number; startLevel?: number } = {}): GameState {
  return start(createGame({ seed: options.seed ?? 7, startLevel: options.startLevel ?? 1 }));
}

function eventsOfType<T extends GameEvent['type']>(
  state: GameState,
  type: T,
): Extract<GameEvent, { type: T }>[] {
  return state.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

/**
 * A board whose bottom `rows` are full except for one gap column — drop a
 * vertical `I` into the gap and exactly `rows` lines complete at once.
 */
const GAP_COLUMN = 3;

function boardWithFloor(rows: number): Board {
  const empty = '.'.repeat(BOARD_WIDTH);
  const almost = Array.from({ length: BOARD_WIDTH }, (_, x) => (x === GAP_COLUMN ? '.' : 'J')).join('');
  return boardFromStrings(
    Array.from({ length: BOARD_HEIGHT }, (_, y) => (y >= BOARD_HEIGHT - rows ? almost : empty)),
  );
}

/**
 * A vertical `I` sitting in the gap, already resting on the floor. Rotation 1
 * puts the four cells in box column 2, so the origin is two columns left of
 * the gap and four rows up from the bottom.
 */
function pendingClear(rows: number, options: { startLevel?: number; lines?: number } = {}): GameState {
  const base = playing({ startLevel: options.startLevel ?? 1 });
  return {
    ...base,
    board: boardWithFloor(rows),
    active: { kind: 'I', rotation: 1, x: GAP_COLUMN - 2, y: BOARD_HEIGHT - 4 },
    lines: options.lines ?? 0,
  };
}

/** A game with the active piece parked flat on the floor, board otherwise empty. */
function restingOnFloor(): GameState {
  return { ...playing(), active: { kind: 'T', rotation: 0, x: 3, y: BOARD_HEIGHT - 2 } };
}

describe('gravityIntervalMs', () => {
  it('is comfortable at level 1', () => {
    expect(gravityIntervalMs(1)).toBe(GRAVITY_BASE_MS);
    expect(gravityIntervalMs(1)).toBe(800);
  });

  it('gets strictly faster with every level until it hits the floor', () => {
    let previous = gravityIntervalMs(1);
    for (let level = 2; level <= 18; level += 1) {
      const interval = gravityIntervalMs(level);
      expect(interval).toBeLessThan(previous);
      previous = interval;
    }
    expect(previous).toBe(GRAVITY_FLOOR_MS);
  });

  it('follows the documented curve', () => {
    expect(gravityIntervalMs(2)).toBe(680);
    expect(gravityIntervalMs(5)).toBe(418);
    expect(gravityIntervalMs(10)).toBe(185);
    expect(gravityIntervalMs(15)).toBe(82);
  });

  it('never falls below the floor, however high the level', () => {
    for (const level of [18, 19, 50, 1000]) {
      expect(gravityIntervalMs(level)).toBe(GRAVITY_FLOOR_MS);
    }
  });

  it('treats nonsense levels as level 1', () => {
    expect(gravityIntervalMs(0)).toBe(gravityIntervalMs(1));
    expect(gravityIntervalMs(-4)).toBe(gravityIntervalMs(1));
  });

  it('returns whole milliseconds', () => {
    for (let level = 1; level <= 25; level += 1) {
      expect(Number.isInteger(gravityIntervalMs(level))).toBe(true);
    }
  });
});

describe('createGame', () => {
  it('starts ready, with a piece on the field and a full preview queue', () => {
    const game = createGame({ seed: 42 });
    expect(game.status).toBe('ready');
    expect(game.active).not.toBeNull();
    expect(game.next).toHaveLength(NEXT_QUEUE_SIZE);
    expect(game.hold).toBeNull();
    expect(game.holdLocked).toBe(false);
    expect(game.score).toBe(0);
    expect(game.lines).toBe(0);
    expect(game.level).toBe(1);
    expect(game.events).toEqual([]);
    expect(isBoardEmpty(game.board)).toBe(true);
  });

  it('honours a starting level', () => {
    expect(createGame({ startLevel: 6 }).level).toBe(6);
    expect(createGame({ startLevel: 0 }).level).toBe(1);
  });

  it('produces the same opening for the same seed and a different one otherwise', () => {
    expect(createGame({ seed: 3 })).toEqual(createGame({ seed: 3 }));
    expect(createGame({ seed: 3 }).next).not.toEqual(createGame({ seed: 4 }).next);
  });

  it('ignores gameplay input and time until it is started', () => {
    const ready = createGame({ seed: 5 });
    expect(update(ready, 10_000).active).toEqual(ready.active);
    expect(applyInput(ready, { type: 'moveLeft' }).active).toEqual(ready.active);
    expect(start(ready).status).toBe('playing');
  });
});

describe('gravity', () => {
  it('moves the piece down after exactly the level interval, not before', () => {
    const game = playing();
    const startY = game.active?.y ?? 0;

    const almost = update(game, gravityIntervalMs(1) - 1);
    expect(almost.active?.y).toBe(startY);

    const stepped = update(almost, 1);
    expect(stepped.active?.y).toBe(startY + 1);
  });

  it('carries the remainder over instead of losing it', () => {
    const game = playing();
    const startY = game.active?.y ?? 0;
    // Three quarters of an interval twice: one step, half an interval banked.
    const first = update(game, 600);
    const second = update(first, 600);
    expect(second.active?.y).toBe(startY + 1);
    expect(second.gravityMs).toBe(400);
  });

  it('takes as many steps from one big delta as from many small ones', () => {
    const game = playing();
    const oneBigStep = update(game, gravityIntervalMs(1) * 5);

    let framed = game;
    for (let i = 0; i < 100; i += 1) {
      framed = update(framed, gravityIntervalMs(1) / 20);
    }
    expect(oneBigStep.active?.y).toBe(framed.active?.y);
  });

  it('falls faster once the level goes up', () => {
    const slow = playing({ startLevel: 1 });
    const fast = playing({ startLevel: 8 });
    const dropped = update(fast, gravityIntervalMs(1));
    const crawled = update(slow, gravityIntervalMs(1));
    expect(dropped.active?.y).toBeGreaterThan(crawled.active?.y ?? 0);
  });
});

describe('lock delay', () => {
  it('locks a resting piece only after the full delay', () => {
    const game = restingOnFloor();

    const waiting = update(game, LOCK_DELAY_MS - 1);
    expect(waiting.active?.kind).toBe('T');
    expect(isBoardEmpty(waiting.board)).toBe(true);

    const locked = update(waiting, 1);
    expect(isBoardEmpty(locked.board)).toBe(false);
    expect(eventsOfType(locked, 'lock')).toHaveLength(1);
    expect(eventsOfType(locked, 'spawn')).toHaveLength(1);
  });

  it('is refreshed by a move inside the delay', () => {
    const game = restingOnFloor();

    const waited = update(game, 400);
    expect(waited.lockMs).toBe(400);

    const nudged = applyInput(waited, { type: 'moveLeft' });
    expect(nudged.lockMs).toBe(0);
    expect(nudged.lockResets).toBe(1);

    // 800 ms have now passed in total and the piece is still falling.
    const stillFalling = update(nudged, 400);
    expect(isBoardEmpty(stillFalling.board)).toBe(true);

    const locked = update(stillFalling, 100);
    expect(isBoardEmpty(locked.board)).toBe(false);
  });

  it('is refreshed by a rotation inside the delay', () => {
    const waited = update(restingOnFloor(), 400);
    const turned = applyInput(waited, { type: 'rotateCW' });
    expect(turned.active?.rotation).toBe(1);
    expect(turned.lockMs).toBe(0);
  });

  it('is not refreshed by a move that the board refuses', () => {
    const game: GameState = { ...restingOnFloor(), active: { kind: 'T', rotation: 0, x: 0, y: BOARD_HEIGHT - 2 } };
    const waited = update(game, 400);
    const blocked = applyInput(waited, { type: 'moveLeft' });
    expect(blocked.active).toEqual(waited.active);
    expect(blocked.lockMs).toBe(400);
  });

  it('stops refreshing once the reset cap is reached, so a piece cannot stall forever', () => {
    let game = restingOnFloor();
    for (let i = 0; i < MAX_LOCK_RESETS; i += 1) {
      game = update(game, 100);
      game = applyInput(game, { type: i % 2 === 0 ? 'moveLeft' : 'moveRight' });
      expect(game.lockMs).toBe(0);
    }
    expect(game.lockResets).toBe(MAX_LOCK_RESETS);
    expect(isBoardEmpty(game.board)).toBe(true);

    // The cap is spent: the piece still moves, but the clock keeps running.
    const waited = update(game, 400);
    const ignored = applyInput(waited, { type: 'moveLeft' });
    expect(ignored.active?.x).toBe((waited.active?.x ?? 0) - 1);
    expect(ignored.lockMs).toBe(400);

    expect(isBoardEmpty(update(ignored, 100).board)).toBe(false);
  });

  it('does not run the lock timer while the piece is in the air', () => {
    const airborne = update(playing(), 100);
    expect(airborne.lockMs).toBe(0);
    expect(airborne.active).not.toBeNull();
  });
});

describe('soft drop', () => {
  it('moves one row and scores one point per row', () => {
    let game = playing();
    const startY = game.active?.y ?? 0;

    for (let i = 1; i <= 3; i += 1) {
      game = applyInput(game, { type: 'softDrop' });
      expect(game.active?.y).toBe(startY + i);
      expect(game.score).toBe(i * SOFT_DROP_POINTS);
    }
  });

  it('resets the gravity timer so the piece does not double-step', () => {
    const banked = update(playing(), 700);
    const dropped = applyInput(banked, { type: 'softDrop' });
    expect(dropped.gravityMs).toBe(0);
  });

  it('does nothing and scores nothing once the piece is resting', () => {
    const resting = restingOnFloor();
    const dropped = applyInput(resting, { type: 'softDrop' });
    expect(dropped.active).toEqual(resting.active);
    expect(dropped.score).toBe(0);
  });
});

describe('hard drop', () => {
  it('lands the piece flush on the floor and locks it immediately', () => {
    const game: GameState = { ...playing(), active: { kind: 'T', rotation: 0, x: 3, y: 0 } };
    const distance = dropDistance(game.board, game.active!);

    const dropped = applyInput(game, { type: 'hardDrop' });
    const rows = boardToStrings(dropped.board);

    expect(rows[BOARD_HEIGHT - 2]).toBe('....T.....');
    expect(rows[BOARD_HEIGHT - 1]).toBe('...TTT....');
    expect(dropped.score).toBe(distance * HARD_DROP_POINTS);
    expect(dropped.score).toBe(40);
    expect(eventsOfType(dropped, 'hardDrop')[0]).toEqual({ type: 'hardDrop', kind: 'T', distance });
    expect(eventsOfType(dropped, 'lock')).toHaveLength(1);
    // A new piece is already falling.
    expect(dropped.active).not.toBeNull();
    expect(dropped.active?.kind).toBe(game.next[0]);
  });

  it('lands flush on the stack, not on the floor', () => {
    const game: GameState = {
      ...playing(),
      board: boardWithFloor(2),
      active: { kind: 'O', rotation: 0, x: 0, y: 0 },
    };
    const dropped = applyInput(game, { type: 'hardDrop' });
    const rows = boardToStrings(dropped.board);

    // The O comes to rest on top of the two-row floor, not inside it.
    expect(rows[BOARD_HEIGHT - 3]).toBe('OO........');
    expect(rows[BOARD_HEIGHT - 4]).toBe('OO........');
    expect(eventsOfType(dropped, 'hardDrop')[0]?.distance).toBe(BOARD_HEIGHT - 4);
  });

  it('scores nothing extra when the piece is already resting', () => {
    const resting = restingOnFloor();
    const dropped = applyInput(resting, { type: 'hardDrop' });
    expect(eventsOfType(dropped, 'hardDrop')[0]?.distance).toBe(0);
    expect(dropped.score).toBe(0);
    expect(isBoardEmpty(dropped.board)).toBe(false);
  });
});

describe('line clears and scoring', () => {
  const TIERS: readonly { count: number; base: number }[] = [
    { count: 1, base: 100 },
    { count: 2, base: 300 },
    { count: 3, base: 500 },
    { count: 4, base: 800 },
  ];

  for (const { count, base } of TIERS) {
    it(`scores ${count} line(s) as ${base} at level 1`, () => {
      const cleared = update(pendingClear(count), LOCK_DELAY_MS);
      const event = eventsOfType(cleared, 'rowsCleared')[0];

      expect(event?.count).toBe(count);
      expect(event?.rows).toHaveLength(count);
      expect(event?.points).toBe(base);
      expect(cleared.score).toBe(base);
      expect(cleared.lines).toBe(count);
      expect(LINE_CLEAR_POINTS[count]).toBe(base);
    });

    it(`multiplies ${count} line(s) by the level`, () => {
      const cleared = update(pendingClear(count, { startLevel: 7 }), LOCK_DELAY_MS);
      expect(cleared.score).toBe(base * 7);
      expect(eventsOfType(cleared, 'rowsCleared')[0]?.points).toBe(base * 7);
    });
  }

  it('reports the cleared row indices, top to bottom', () => {
    const cleared = update(pendingClear(3), LOCK_DELAY_MS);
    expect(eventsOfType(cleared, 'rowsCleared')[0]?.rows).toEqual([
      BOARD_HEIGHT - 3,
      BOARD_HEIGHT - 2,
      BOARD_HEIGHT - 1,
    ]);
  });

  it('collapses the stack and leaves the board otherwise clean', () => {
    const cleared = update(pendingClear(4), LOCK_DELAY_MS);
    expect(isBoardEmpty(cleared.board)).toBe(true);
  });

  it('flags a quad, and a back-to-back quad only on the second one', () => {
    const first = update(pendingClear(4), LOCK_DELAY_MS);
    const firstEvent = eventsOfType(first, 'rowsCleared')[0];
    expect(firstEvent?.quad).toBe(true);
    expect(firstEvent?.backToBack).toBe(false);
    expect(first.backToBack).toBe(true);

    const again = update({ ...pendingClear(4), backToBack: true }, LOCK_DELAY_MS);
    const againEvent = eventsOfType(again, 'rowsCleared')[0];
    expect(againEvent?.quad).toBe(true);
    expect(againEvent?.backToBack).toBe(true);
  });

  it('breaks the back-to-back streak on a smaller clear', () => {
    const single = update({ ...pendingClear(1), backToBack: true }, LOCK_DELAY_MS);
    const event = eventsOfType(single, 'rowsCleared')[0];
    expect(event?.quad).toBe(false);
    expect(event?.backToBack).toBe(false);
    expect(single.backToBack).toBe(false);
  });

  it('pauses briefly before the next piece so the clear can be animated', () => {
    const cleared = update(pendingClear(2), LOCK_DELAY_MS);
    expect(cleared.active).toBeNull();
    expect(cleared.clearDelayMs).toBe(LINE_CLEAR_DELAY_MS);
    expect(eventsOfType(cleared, 'spawn')).toHaveLength(0);

    const resumed = update(cleared, LINE_CLEAR_DELAY_MS);
    expect(resumed.active).not.toBeNull();
    expect(eventsOfType(resumed, 'spawn')).toHaveLength(1);
  });

  it('spawns immediately when nothing was cleared', () => {
    const locked = update(restingOnFloor(), LOCK_DELAY_MS);
    expect(locked.active).not.toBeNull();
    expect(locked.clearDelayMs).toBe(0);
  });
});

describe('levels', () => {
  it('counts a level for every ten lines', () => {
    expect(levelForLines(1, 0)).toBe(1);
    expect(levelForLines(1, 9)).toBe(1);
    expect(levelForLines(1, 10)).toBe(2);
    expect(levelForLines(1, 29)).toBe(3);
    expect(levelForLines(4, 20)).toBe(6);
    expect(LINES_PER_LEVEL).toBe(10);
  });

  it('levels up on the tenth line and announces it', () => {
    const nearly = pendingClear(1, { lines: LINES_PER_LEVEL - 1 });
    const cleared = update(nearly, LOCK_DELAY_MS);

    expect(cleared.lines).toBe(LINES_PER_LEVEL);
    expect(cleared.level).toBe(2);
    expect(eventsOfType(cleared, 'levelUp')[0]).toEqual({
      type: 'levelUp',
      level: 2,
      previousLevel: 1,
    });
  });

  it('does not announce a level up on the ninth line', () => {
    const cleared = update(pendingClear(1, { lines: LINES_PER_LEVEL - 2 }), LOCK_DELAY_MS);
    expect(cleared.level).toBe(1);
    expect(eventsOfType(cleared, 'levelUp')).toHaveLength(0);
  });

  it('skips a level when a quad crosses two thresholds', () => {
    const cleared = update(pendingClear(4, { lines: 2 * LINES_PER_LEVEL - 2 }), LOCK_DELAY_MS);
    expect(cleared.lines).toBe(2 * LINES_PER_LEVEL + 2);
    expect(cleared.level).toBe(3);
    expect(eventsOfType(cleared, 'levelUp')[0]?.previousLevel).toBe(1);
  });

  it('makes gravity faster after levelling up', () => {
    const cleared = update(pendingClear(1, { lines: LINES_PER_LEVEL - 1 }), LOCK_DELAY_MS);
    expect(gravityIntervalMs(cleared.level)).toBeLessThan(gravityIntervalMs(1));
  });
});

describe('hold', () => {
  it('takes the next piece the first time and parks the active one', () => {
    const game = playing();
    const active = game.active?.kind as PieceKind;
    const upcoming = game.next[0] as PieceKind;

    const held = applyInput(game, { type: 'hold' });

    expect(held.hold).toBe(active);
    expect(held.active?.kind).toBe(upcoming);
    expect(held.holdLocked).toBe(true);
    expect(held.next).toHaveLength(NEXT_QUEUE_SIZE);
    expect(held.next[0]).toBe(game.next[1]);
    expect(eventsOfType(held, 'hold')[0]).toEqual({ type: 'hold', held: active, active: upcoming });
  });

  it('cannot be used twice for the same piece', () => {
    const once = applyInput(playing(), { type: 'hold' });
    const twice = applyInput(once, { type: 'hold' });

    expect(twice.active).toEqual(once.active);
    expect(twice.hold).toBe(once.hold);
    expect(twice.events).toEqual([]);
  });

  it('unlocks again once the next piece locks', () => {
    const held = applyInput(playing(), { type: 'hold' });
    expect(held.holdLocked).toBe(true);

    const dropped = applyInput(held, { type: 'hardDrop' });
    expect(dropped.holdLocked).toBe(false);
    expect(applyInput(dropped, { type: 'hold' }).active?.kind).toBe(held.hold);
  });

  it('swaps back and resets rotation and position', () => {
    const game = playing();
    const first = game.active?.kind as PieceKind;

    const turned = applyInput(game, { type: 'rotateCW' });
    expect(turned.active?.rotation).toBe(1);

    const held = applyInput(turned, { type: 'hold' });
    expect(held.active?.rotation).toBe(0);
    expect(held.active?.y).toBe(0);

    // Lock the swapped-in piece so hold frees up, then turn and swap back.
    const dropped = applyInput(held, { type: 'hardDrop' });
    const turnedAgain = applyInput(applyInput(dropped, { type: 'rotateCW' }), { type: 'rotateCW' });
    expect(turnedAgain.active?.rotation).toBe(2);

    const swappedBack = applyInput(turnedAgain, { type: 'hold' });
    expect(swappedBack.active?.kind).toBe(first);
    expect(swappedBack.active?.rotation).toBe(0);
    expect(swappedBack.hold).toBe(turnedAgain.active?.kind);
  });

  it('resets the gravity and lock timers for the incoming piece', () => {
    const banked = update(playing(), 700);
    const held = applyInput(banked, { type: 'hold' });
    expect(held.gravityMs).toBe(0);
    expect(held.lockMs).toBe(0);
    expect(held.lockResets).toBe(0);
  });

  it('ends the run when the swapped-in piece has nowhere to go', () => {
    const blocked: GameState = { ...playing(), board: blockedSpawnBoard() };
    const held = applyInput(blocked, { type: 'hold' });
    expect(held.status).toBe('over');
    expect(eventsOfType(held, 'runEnd')).toHaveLength(1);
    expect(held.outcome).toBe('toppedOut');
  });
});

/** Rows 0-3 filled except the last column: nothing can spawn, nothing is full. */
function blockedSpawnBoard(): Board {
  const empty = '.'.repeat(BOARD_WIDTH);
  const wall = `${'Z'.repeat(BOARD_WIDTH - 1)}.`;
  return boardFromStrings(Array.from({ length: BOARD_HEIGHT }, (_, y) => (y < 4 ? wall : empty)));
}

describe('game over', () => {
  it('fires when a newly spawned piece has no valid position', () => {
    const doomed: GameState = {
      ...playing(),
      board: blockedSpawnBoard(),
      active: { kind: 'T', rotation: 0, x: 3, y: BOARD_HEIGHT - 2 },
    };

    const over = applyInput(doomed, { type: 'hardDrop' });

    expect(over.status).toBe('over');
    expect(over.active).toBeNull();
    expect(over.outcome).toBe('toppedOut');
    expect(eventsOfType(over, 'runEnd')[0]).toEqual({
      type: 'runEnd',
      mode: 'marathon',
      outcome: 'toppedOut',
      score: over.score,
      lines: over.lines,
      level: over.level,
      durationMs: over.elapsedMs,
    });
    expect(eventsOfType(over, 'spawn')).toHaveLength(0);
  });

  it('ignores every gameplay input and all further time once it is over', () => {
    const doomed: GameState = {
      ...playing(),
      board: blockedSpawnBoard(),
      active: { kind: 'T', rotation: 0, x: 3, y: BOARD_HEIGHT - 2 },
    };
    const over = applyInput(doomed, { type: 'hardDrop' });
    const settled: GameState = { ...over, events: [] };

    const inputs: GameInput[] = [
      { type: 'moveLeft' },
      { type: 'moveRight' },
      { type: 'softDrop' },
      { type: 'hardDrop' },
      { type: 'rotateCW' },
      { type: 'rotateCCW' },
      { type: 'hold' },
      { type: 'pause' },
      { type: 'resume' },
    ];
    for (const input of inputs) {
      expect(applyInput(settled, input)).toEqual(settled);
    }
    expect(update(settled, 60_000)).toEqual(settled);
  });

  it('restarts into a fresh, playable game on the same seed', () => {
    const doomed: GameState = {
      ...playing({ seed: 11 }),
      board: blockedSpawnBoard(),
      active: { kind: 'T', rotation: 0, x: 3, y: BOARD_HEIGHT - 2 },
    };
    const over = applyInput(doomed, { type: 'hardDrop' });
    const restarted = applyInput(over, { type: 'restart' });

    expect(restarted.status).toBe('playing');
    expect(restarted.score).toBe(0);
    expect(restarted.lines).toBe(0);
    expect(restarted.hold).toBeNull();
    expect(isBoardEmpty(restarted.board)).toBe(true);
    expect(restarted).toEqual({ ...playing({ seed: 11 }), events: restarted.events });
  });
});

describe('pause', () => {
  it('freezes gravity and ignores movement', () => {
    const game = playing();
    const paused = applyInput(game, { type: 'pause' });
    expect(paused.status).toBe('paused');

    const waited = update(paused, 10_000);
    expect(waited.active).toEqual(game.active);
    expect(applyInput(paused, { type: 'moveLeft' }).active).toEqual(game.active);
    expect(applyInput(paused, { type: 'hardDrop' }).board).toEqual(game.board);

    const resumed = applyInput(waited, { type: 'resume' });
    expect(resumed.status).toBe('playing');
    expect(update(resumed, gravityIntervalMs(1)).active?.y).toBe((game.active?.y ?? 0) + 1);
  });

  it('does nothing when the game is not running', () => {
    const over: GameState = { ...playing(), status: 'over' };
    expect(applyInput(over, { type: 'pause' }).status).toBe('over');
  });
});

describe('events', () => {
  it('belong to the update that produced them and never accumulate', () => {
    const dropped = applyInput(playing(), { type: 'hardDrop' });
    expect(dropped.events.length).toBeGreaterThan(0);

    const later = update(dropped, 1);
    expect(later.events).toEqual([]);

    const laterStill = applyInput(later, { type: 'moveLeft' });
    expect(laterStill.events).toEqual([]);
  });

  it('come out in the order they happened', () => {
    const cleared = update(pendingClear(4, { lines: LINES_PER_LEVEL - 1 }), LOCK_DELAY_MS);
    expect(cleared.events.map((event) => event.type)).toEqual(['lock', 'rowsCleared', 'levelUp']);
  });
});

describe('immutability', () => {
  it('never mutates the state it is given', () => {
    const game = playing();
    const before = structuredClone(game);

    update(game, 5_000);
    applyInput(game, { type: 'hardDrop' });
    applyInput(game, { type: 'hold' });
    applyInput(game, { type: 'rotateCW' });

    expect(game).toEqual(before);
  });
});

describe('determinism', () => {
  /** A fixed script: the same calls, in the same order, every run. */
  function replay(seed: number): GameState {
    const script: (GameInput | number)[] = [
      { type: 'resume' },
      300,
      { type: 'moveLeft' },
      { type: 'rotateCW' },
      500,
      { type: 'softDrop' },
      { type: 'hold' },
      120,
      { type: 'moveRight' },
      { type: 'hardDrop' },
      900,
      { type: 'rotateCCW' },
      { type: 'moveRight' },
      { type: 'hardDrop' },
      { type: 'hold' },
      2_000,
      { type: 'pause' },
      1_000,
      { type: 'resume' },
      { type: 'hardDrop' },
      { type: 'softDrop' },
      5_000,
      { type: 'moveLeft' },
      { type: 'hardDrop' },
      750,
    ];

    let state = createGame({ seed });
    for (const step of script) {
      state = typeof step === 'number' ? update(state, step) : applyInput(state, step);
    }
    return state;
  }

  it('produces an identical final state for the same seed and script', () => {
    const first = replay(2026);
    const second = replay(2026);
    expect(second).toEqual(first);
    expect(second.board.cells).toEqual(first.board.cells);
    expect(second.bag).toEqual(first.bag);
    expect(second.score).toEqual(first.score);
  });

  it('produces a different game for a different seed', () => {
    expect(replay(2026).next).not.toEqual(replay(2027).next);
  });

  it('actually played: the replay locked pieces and scored', () => {
    const played = replay(2026);
    expect(played.score).toBeGreaterThan(0);
    expect(isBoardEmpty(played.board)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The ghost, and the edges a playtest actually finds
// ---------------------------------------------------------------------------

describe('ghostPiece', () => {
  it('is null when there is no piece on the field', () => {
    const between = { ...playing(), active: null };
    expect(ghostPiece(between)).toBeNull();
    expect(ghostPiece(applyInput(playing(), { type: 'pause' }))).not.toBeNull();
  });

  it('sits flush on the floor of an empty board', () => {
    const state = playing();
    const ghost = ghostPiece(state);
    expect(ghost).not.toBeNull();
    const lowest = Math.max(...pieceCells(ghost as ActivePiece).map((cell) => cell.y));
    expect(lowest).toBe(BOARD_HEIGHT - 1);
  });

  it('keeps the active piece’s kind and rotation, and only moves it down', () => {
    const state = applyInput(playing(), { type: 'rotateCW' });
    const active = state.active as ActivePiece;
    const ghost = ghostPiece(state) as ActivePiece;
    expect(ghost.kind).toBe(active.kind);
    expect(ghost.rotation).toBe(active.rotation);
    expect(ghost.x).toBe(active.x);
    expect(ghost.y).toBeGreaterThanOrEqual(active.y);
  });

  it('rests on the stack rather than passing through it', () => {
    const state = pendingClear(2);
    // The I is already resting in the gap, so its ghost is exactly where it is.
    expect(ghostPiece(state)).toEqual(state.active);
  });

  it('is where a hard drop would put the piece', () => {
    const state = playing();
    const ghost = ghostPiece(state) as ActivePiece;
    const dropped = applyInput(state, { type: 'hardDrop' });
    // The piece locks on impact, so the proof is in the cells it left behind.
    const locked = eventsOfType(dropped, 'lock')[0];
    expect(locked?.cells).toEqual(pieceCells(ghost));
  });

  it('agrees with `dropDistance` and `isResting`', () => {
    const state = playing();
    const active = state.active as ActivePiece;
    const ghost = ghostPiece(state) as ActivePiece;
    expect(ghost.y - active.y).toBe(dropDistance(state.board, active));
    expect(isResting(state.board, ghost)).toBe(true);
    expect(isResting(state.board, active)).toBe(false);
  });
});

describe('rotation the board refuses', () => {
  /**
   * A one-cell-wide well running the whole height of the field, with an `I`
   * standing in it. A horizontal `I` needs four columns and there is exactly
   * one, so no kick in the table can place it — which is the case a shallow
   * well does *not* test: there, a kick simply lifts the piece out of the hole.
   */
  function inATightWell(): GameState {
    const wall = Array.from({ length: BOARD_WIDTH }, (_, x) => (x === GAP_COLUMN ? '.' : 'J')).join('');
    const empty = '.'.repeat(BOARD_WIDTH);
    const board = boardFromStrings(
      Array.from({ length: BOARD_HEIGHT }, (_, y) => (y >= BUFFER_ROWS ? wall : empty)),
    );
    return {
      ...playing(),
      board,
      active: { kind: 'I', rotation: 1, x: GAP_COLUMN - 2, y: BOARD_HEIGHT - 4 },
    };
  }

  it('leaves the piece exactly where it was', () => {
    const state = inATightWell();
    const turned = applyInput(state, { type: 'rotateCW' });
    expect(turned.active).toEqual(state.active);
    expect(applyInput(state, { type: 'rotateCCW' }).active).toEqual(state.active);
  });

  it('does not spend a lock reset on a rotation that never happened', () => {
    const state = inATightWell();
    let current = state;
    for (let i = 0; i < 30; i += 1) {
      current = applyInput(current, { type: 'rotateCW' });
    }
    expect(current.lockResets).toBe(0);
    expect(current.active).toEqual(state.active);
  });

  it('still locks on time however hard the player spins', () => {
    let current = inATightWell();
    for (let i = 0; i < 20; i += 1) {
      current = applyInput(current, { type: 'rotateCW' });
      current = update(current, 10);
    }
    // 200ms of the 500ms delay has gone and no reset was earned, so the piece
    // is still on the field but on its way down.
    expect(current.active).not.toBeNull();
    expect(update(current, LOCK_DELAY_MS).events.some((e) => e.type === 'lock')).toBe(true);
  });
});

describe('holding a direction into a wall', () => {
  it('never walks the piece off the left edge, however long it is held', () => {
    let current = playing();
    for (let i = 0; i < 200; i += 1) {
      current = applyInput(current, { type: 'moveLeft' });
    }
    const cells = pieceCells(current.active as ActivePiece);
    expect(Math.min(...cells.map((cell) => cell.x))).toBe(0);
    expect(current.score).toBe(0);
  });

  it('never walks it off the right edge either', () => {
    let current = playing();
    for (let i = 0; i < 200; i += 1) {
      current = applyInput(current, { type: 'moveRight' });
    }
    const cells = pieceCells(current.active as ActivePiece);
    expect(Math.max(...cells.map((cell) => cell.x))).toBe(BOARD_WIDTH - 1);
    expect(current.score).toBe(0);
  });

  it('emits nothing at all for the refused moves', () => {
    let current = playing();
    for (let i = 0; i < 20; i += 1) {
      current = applyInput(current, { type: 'moveLeft' });
      expect(current.events).toEqual([]);
    }
  });
});

describe('hold, hammered', () => {
  it('swaps once and then ignores every further press', () => {
    const state = playing();
    let current = applyInput(state, { type: 'hold' });
    const afterFirst = current;
    for (let i = 0; i < 40; i += 1) {
      current = applyInput(current, { type: 'hold' });
    }
    expect(current.hold).toBe(afterFirst.hold);
    expect(current.active).toEqual(afterFirst.active);
    expect(current.next).toEqual(afterFirst.next);
    expect(current.bag).toEqual(afterFirst.bag);
    expect(current.score).toBe(0);
  });

  it('keeps the preview queue exactly full through repeated swaps', () => {
    let current = playing();
    for (let i = 0; i < 12; i += 1) {
      current = applyInput(current, { type: 'hold' });
      current = applyInput(current, { type: 'hardDrop' });
      current = update(current, LINE_CLEAR_DELAY_MS + 1);
      expect(current.next).toHaveLength(NEXT_QUEUE_SIZE);
    }
  });
});

describe('input during the line-clear pause', () => {
  /** A state that has just cleared a row and is waiting to spawn. */
  function pausing(): GameState {
    const cleared = applyInput(pendingClear(1), { type: 'hardDrop' });
    expect(cleared.active).toBeNull();
    expect(cleared.clearDelayMs).toBe(LINE_CLEAR_DELAY_MS);
    return cleared;
  }

  const GAMEPLAY: readonly GameInput[] = [
    { type: 'moveLeft' },
    { type: 'moveRight' },
    { type: 'softDrop' },
    { type: 'hardDrop' },
    { type: 'rotateCW' },
    { type: 'rotateCCW' },
    { type: 'hold' },
  ];

  it.each(GAMEPLAY.map((input) => [input.type, input] as const))(
    'ignores %s while the board is settling',
    (_type, input) => {
      const paused = pausing();
      const after = applyInput(paused, input);
      expect(after.active).toBeNull();
      expect(after.score).toBe(paused.score);
      expect(after.board).toEqual(paused.board);
      expect(after.events).toEqual([]);
    },
  );

  it('still spawns on time after a storm of ignored input', () => {
    let current = pausing();
    for (let i = 0; i < 100; i += 1) {
      current = applyInput(current, GAMEPLAY[i % GAMEPLAY.length] as GameInput);
    }
    expect(current.clearDelayMs).toBe(LINE_CLEAR_DELAY_MS);
    const spawned = update(current, LINE_CLEAR_DELAY_MS);
    expect(spawned.active).not.toBeNull();
    expect(eventsOfType(spawned, 'spawn')).toHaveLength(1);
  });

  it('lets pause and restart through, because they are not gameplay', () => {
    const paused = applyInput(pausing(), { type: 'pause' });
    expect(paused.status).toBe('paused');
    const restarted = applyInput(pausing(), { type: 'restart' });
    expect(restarted.status).toBe('playing');
    expect(restarted.active).not.toBeNull();
    expect(restarted.score).toBe(0);
  });
});

describe('a head start', () => {
  it('starts on the chosen level and counts up from there', () => {
    expect(levelForLines(7, 0)).toBe(7);
    expect(levelForLines(7, 9)).toBe(7);
    expect(levelForLines(7, 10)).toBe(8);
    expect(levelForLines(10, 95)).toBe(19);
  });

  it('scores the first clear at the head-start level, not at level 1', () => {
    const state = applyInput(pendingClear(1, { startLevel: 7 }), { type: 'hardDrop' });
    const cleared = eventsOfType(state, 'rowsCleared')[0];
    expect(cleared?.points).toBe((LINE_CLEAR_POINTS[1] ?? 0) * 7);
  });

  it('levels up from the head start after ten lines, and says so', () => {
    const state = applyInput(pendingClear(1, { startLevel: 7, lines: 9 }), { type: 'hardDrop' });
    expect(state.level).toBe(8);
    expect(eventsOfType(state, 'levelUp')[0]).toEqual({ type: 'levelUp', level: 8, previousLevel: 7 });
  });

  it('runs at the head start’s gravity from the very first piece', () => {
    expect(playing({ startLevel: 9 }).level).toBe(9);
    expect(gravityIntervalMs(9)).toBeLessThan(gravityIntervalMs(1));
  });

  it('clamps a nonsense start level to a playable one', () => {
    expect(createGame({ startLevel: 0 }).level).toBe(1);
    expect(createGame({ startLevel: -4 }).level).toBe(1);
    expect(createGame({ startLevel: 3.9 }).level).toBe(3);
  });
});

describe('fast gravity', () => {
  it('never falls more than one row per interval, however small the interval', () => {
    // Level 18 and up sits on the floor of the curve. A frame that spans three
    // intervals must move three rows, not skip to the bottom.
    let current = { ...playing({ startLevel: 18 }), board: createBoard() };
    const startY = (current.active as ActivePiece).y;
    current = update(current, GRAVITY_FLOOR_MS * 3);
    expect((current.active as ActivePiece).y).toBe(startY + 3);
  });

  it('behaves the same at level 60 as at the floor level', () => {
    expect(gravityIntervalMs(60)).toBe(GRAVITY_FLOOR_MS);
    const slow = update(playing({ startLevel: 18 }), GRAVITY_FLOOR_MS);
    const fast = update(playing({ startLevel: 60 }), GRAVITY_FLOOR_MS);
    expect((fast.active as ActivePiece).y).toBe((slow.active as ActivePiece).y);
  });

  it('one long frame lands a piece exactly where many short ones do', () => {
    const seed = 4242;
    let stepped = playing({ seed, startLevel: 14 });
    for (let i = 0; i < 400; i += 1) {
      stepped = update(stepped, 8);
    }
    const oneGo = update(playing({ seed, startLevel: 14 }), 3200);
    expect(oneGo.board.cells).toEqual(stepped.board.cells);
    expect(oneGo.score).toBe(stepped.score);
    expect(oneGo.lines).toBe(stepped.lines);
    expect(oneGo.active).toEqual(stepped.active);
  });
});

describe('a run that is played to the end', () => {
  /** Drop pieces straight down until the stack reaches the ceiling. */
  function stackToTheTop(seed: number): GameState {
    let current = playing({ seed });
    for (let i = 0; i < 500; i += 1) {
      current = applyInput(current, { type: 'hardDrop' });
      if (current.status !== 'playing') {
        break;
      }
      // Sit out the clear pause, if there was one — but never past the top-out,
      // or the snapshot carrying the `runEnd` event is thrown away.
      const settled = update(current, LINE_CLEAR_DELAY_MS + 1);
      if (settled.status !== 'playing') {
        return settled;
      }
      current = settled;
    }
    return current;
  }

  it('ends, and reports the numbers it ended on', () => {
    const over = stackToTheTop(11);
    expect(over.status).toBe('over');
    expect(over.active).toBeNull();
    const ended = eventsOfType(over, 'runEnd')[0];
    expect(ended).toEqual({
      type: 'runEnd',
      mode: 'marathon',
      outcome: 'toppedOut',
      score: over.score,
      lines: over.lines,
      level: over.level,
      durationMs: over.elapsedMs,
    });
  });

  it('leaves nothing counting down behind it', () => {
    const over = stackToTheTop(11);
    expect(over.clearDelayMs).toBe(0);
    expect(over.lockMs).toBe(0);
    expect(over.gravityMs).toBe(0);
  });

  it('is deterministic all the way to the top-out', () => {
    expect(stackToTheTop(11)).toEqual(stackToTheTop(11));
  });
});

// ---------------------------------------------------------------------------
// Spins, combos and the back-to-back chain
// ---------------------------------------------------------------------------

/** A board whose bottom rows are these strings, everything above them empty. */
function boardWithRows(...bottom: readonly string[]): Board {
  const empty = '.'.repeat(BOARD_WIDTH);
  return boardFromStrings([
    ...Array.from({ length: BOARD_HEIGHT - bottom.length }, () => empty),
    ...bottom,
  ]);
}

/**
 * The T-spin bench.
 *
 * The two rows given are the bottom two of the board. In every version of them
 * the second-to-last row has a three-wide mouth at columns 3–5 with filled
 * shoulders either side, and the last row has a one-cell gap at column 4 — so a
 * vertical `T` at column 3 that is turned clockwise drops its nub into that gap
 * and is then walled in left and right by the stack and floored below by the
 * board. Rotating is the only way in; sliding one over would not fit.
 */
function tSpinBench(row20: string, row21: string): GameState {
  return {
    ...playing(),
    board: boardWithRows(row20, row21),
    active: { kind: 'T', rotation: 1, x: 3, y: BOARD_HEIGHT - 3 },
  };
}

/** Mouth open, and the row below it has a second gap the `T` cannot reach. */
const SPIN_NO_CLEAR = ['JJJ...JJJ.', 'JJJJ.JJJ.J'] as const;
/** The bottom row completes; the one above it is a column short. */
const SPIN_SINGLE = ['JJJ...JJJ.', 'JJJJ.JJJJJ'] as const;
/** Both rows complete. */
const SPIN_DOUBLE = ['JJJ...JJJJ', 'JJJJ.JJJJJ'] as const;

/** Turn the piece into the slot and let the lock delay run out on it. */
function spinAndLock(state: GameState, direction: 'cw' | 'ccw' = 'cw'): GameState {
  const turned = applyInput(state, { type: direction === 'cw' ? 'rotateCW' : 'rotateCCW' });
  return update(turned, LOCK_DELAY_MS);
}

/**
 * A spin against the *wall*: a `T` turned anticlockwise into the right-hand
 * column, held up by a block under its nose and stopped on the left by the one
 * beside it. Nothing near it is close to a full row, so it clears nothing.
 */
function wallSpinBench(): GameState {
  return {
    ...playing(),
    board: boardWithRows('.......J.J', '..........', '..........'),
    active: { kind: 'T', rotation: 2, x: 7, y: BOARD_HEIGHT - 5 },
  };
}

/**
 * A spin that only fitted because it was kicked.
 *
 * The `T` is turned clockwise out of column 5. Turning in place and the
 * leftward kick both hit the stack; the rightward kick fits, which is the
 * definition of a kicked spin and is scored from the cheaper table.
 */
function kickedSpinBench(row20: string): GameState {
  return {
    ...playing(),
    board: boardWithRows(row20, 'JJJJJ..JJJ'),
    active: { kind: 'T', rotation: 1, x: 4, y: BOARD_HEIGHT - 3 },
  };
}

const KICKED_NO_CLEAR = 'JJJJJ...J.';
const KICKED_SINGLE = 'JJJJJ...JJ';

describe('spins', () => {
  it('is not a spin when the piece can still move', () => {
    const bench = tSpinBench(...SPIN_SINGLE);
    // One row higher, where the mouth is wide open on both sides.
    const loose = { ...bench, active: { ...bench.active!, y: BOARD_HEIGHT - 4 } };
    const turned = applyInput(loose, { type: 'rotateCW' });
    expect(turned.lastAction).toBe('rotate');
    expect(spinKind(turned.board, turned.active!, turned.lastAction)).toBe('none');
  });

  it('is a spin when a rotation leaves the piece walled in on the floor', () => {
    const turned = applyInput(tSpinBench(...SPIN_NO_CLEAR), { type: 'rotateCW' });
    expect(turned.lastAction).toBe('rotate');
    expect(spinKind(turned.board, turned.active!, turned.lastAction)).toBe('full');
  });

  it('scores a flat bonus for a spin that clears nothing', () => {
    const locked = spinAndLock(tSpinBench(...SPIN_NO_CLEAR));
    const spin = eventsOfType(locked, 'spin')[0];

    expect(spin?.spin).toBe('full');
    expect(spin?.kind).toBe('T');
    expect(spin?.cleared).toBe(0);
    expect(spin?.points).toBe(SPIN_POINTS[0]);
    expect(locked.score).toBe(SPIN_POINTS[0]);
    expect(eventsOfType(locked, 'rowsCleared')).toHaveLength(0);
    // A spin that cleared nothing is still not a clearing lock: the combo goes.
    expect(locked.combo).toBe(0);
  });

  it('scores a spin that clears rows from the spin table, not the plain one', () => {
    const locked = spinAndLock(tSpinBench(...SPIN_SINGLE));
    const cleared = eventsOfType(locked, 'rowsCleared')[0];

    expect(cleared?.count).toBe(1);
    expect(cleared?.spin).toBe('full');
    expect(cleared?.kind).toBe('T');
    expect(cleared?.points).toBe(SPIN_POINTS[1]);
    expect(SPIN_POINTS[1]).toBeGreaterThan(LINE_CLEAR_POINTS[1] ?? 0);
    // The spin event still fires, but the points are on the clear.
    expect(eventsOfType(locked, 'spin')[0]?.points).toBe(0);
    expect(eventsOfType(locked, 'spin')[0]?.cleared).toBe(1);
    expect(locked.score).toBe(SPIN_POINTS[1]);
  });

  it('scores a two-row spin from the spin table too', () => {
    const locked = spinAndLock(tSpinBench(...SPIN_DOUBLE));
    expect(eventsOfType(locked, 'rowsCleared')[0]?.count).toBe(2);
    expect(locked.score).toBe(SPIN_POINTS[2]);
    expect(locked.lines).toBe(2);
  });

  it('counts a spin against the wall, with the board edge doing the walling', () => {
    const locked = spinAndLock(wallSpinBench(), 'ccw');
    const spin = eventsOfType(locked, 'spin')[0];

    expect(spin?.spin).toBe('full');
    expect(spin?.cleared).toBe(0);
    // Hard against the right-hand column: it is the wall, not a block, that
    // stops it moving over.
    expect(spin?.cells.some((cell) => cell.x === BOARD_WIDTH - 1)).toBe(true);
    expect(locked.score).toBe(SPIN_POINTS[0]);
  });

  it('detects a spin for a piece that is not a T', () => {
    // The same slot, entered by an S turned into it. Nothing in the rule set
    // names a piece kind, and this is the test that keeps it that way.
    const board = boardWithRows('JJJ..JJJJJ', 'JJJJ.JJJJJ');
    const bench: GameState = {
      ...playing(),
      board,
      active: { kind: 'S', rotation: 0, x: 3, y: BOARD_HEIGHT - 3 },
    };
    const turned = applyInput(bench, { type: 'rotateCW' });
    expect(turned.active?.rotation).toBe(1);
    expect(spinKind(turned.board, turned.active!, turned.lastAction)).not.toBe('none');
  });

  it('pays a kicked spin from the cheaper table', () => {
    const locked = spinAndLock(kickedSpinBench(KICKED_NO_CLEAR));
    const spin = eventsOfType(locked, 'spin')[0];

    expect(spin?.spin).toBe('kick');
    expect(spin?.points).toBe(KICKED_SPIN_POINTS[0]);
    expect(locked.score).toBe(KICKED_SPIN_POINTS[0]);
  });

  it('pays a kicked spin clear from the cheaper table, and still beats a plain clear', () => {
    const locked = spinAndLock(kickedSpinBench(KICKED_SINGLE));
    const cleared = eventsOfType(locked, 'rowsCleared')[0];

    expect(cleared?.spin).toBe('kick');
    expect(cleared?.count).toBe(1);
    expect(cleared?.points).toBe(KICKED_SPIN_POINTS[1]);
    expect(KICKED_SPIN_POINTS[1]).toBeGreaterThan(LINE_CLEAR_POINTS[1] ?? 0);
    expect(SPIN_POINTS[1]).toBeGreaterThan(KICKED_SPIN_POINTS[1] ?? 0);
  });

  it('multiplies the spin bonus by the level', () => {
    const bench = { ...tSpinBench(...SPIN_NO_CLEAR), level: 4, startLevel: 4 };
    expect(spinAndLock(bench).score).toBe((SPIN_POINTS[0] ?? 0) * 4);
  });

  it('every spin tier out-scores the plain clear of the same size', () => {
    for (const count of [1, 2, 3, 4] as const) {
      expect(SPIN_POINTS[count]).toBeGreaterThan(LINE_CLEAR_POINTS[count] ?? 0);
      expect(KICKED_SPIN_POINTS[count]).toBeGreaterThan(LINE_CLEAR_POINTS[count] ?? 0);
    }
  });

  it('picks the table a spin is paid from', () => {
    expect(spinTable('full')).toBe(SPIN_POINTS);
    expect(spinTable('kick')).toBe(KICKED_SPIN_POINTS);
  });
});

describe('the last action a piece took', () => {
  it('starts clean on a fresh piece and after a hold', () => {
    const fresh = playing();
    expect(fresh.lastAction).toBe('none');
    const turned = applyInput(fresh, { type: 'rotateCW' });
    expect(turned.lastAction).toBe('rotate');
    expect(applyInput(turned, { type: 'hold' }).lastAction).toBe('none');
  });

  it('records a move, a rotation, a soft drop and gravity', () => {
    const base = playing();
    expect(applyInput(base, { type: 'moveLeft' }).lastAction).toBe('move');
    expect(applyInput(base, { type: 'rotateCW' }).lastAction).toBe('rotate');
    expect(applyInput(base, { type: 'softDrop' }).lastAction).toBe('drop');
    expect(update(base, gravityIntervalMs(base.level)).lastAction).toBe('drop');
  });

  it('is left alone by a move the board refuses', () => {
    const turned = applyInput(tSpinBench(...SPIN_SINGLE), { type: 'rotateCW' });
    // Walled in on both sides: neither move can land, so the rotation stands.
    expect(applyInput(turned, { type: 'moveLeft' }).lastAction).toBe('rotate');
    expect(applyInput(turned, { type: 'moveRight' }).lastAction).toBe('rotate');
  });

  it('is not disturbed by a hard drop that falls no rows', () => {
    const turned = applyInput(tSpinBench(...SPIN_SINGLE), { type: 'rotateCW' });
    const slammed = applyInput(turned, { type: 'hardDrop' });
    expect(eventsOfType(slammed, 'hardDrop')[0]?.distance).toBe(0);
    // Turning into the slot and slamming to confirm still counts as a spin.
    expect(eventsOfType(slammed, 'spin')[0]?.spin).toBe('full');
  });

  it('is cleared by a hard drop that actually falls', () => {
    const dropped = applyInput(playing(), { type: 'rotateCW' });
    expect(applyInput(dropped, { type: 'hardDrop' }).lastAction).toBe('none');
  });
});

describe('a piece that moved after it turned', () => {
  /**
   * The one shape this rule cannot be tested in is "rotate, slide sideways,
   * lock walled in" — and it cannot be tested because it cannot happen. A piece
   * that cannot move left is a piece that cannot have arrived from the left, so
   * a lock that is walled in on both sides was never slid into. Every real
   * "moved after turning" case therefore ends in a downward step, which is what
   * these two cover.
   */
  it('does not count as a spin when it soft-dropped into the slot', () => {
    const bench = tSpinBench(...SPIN_SINGLE);
    const above = { ...bench, active: { ...bench.active!, y: BOARD_HEIGHT - 4 } };
    const turned = applyInput(above, { type: 'rotateCW' });
    const dropped = applyInput(turned, { type: 'softDrop' });

    expect(dropped.lastAction).toBe('drop');
    const locked = update(dropped, LOCK_DELAY_MS);
    expect(eventsOfType(locked, 'spin')).toHaveLength(0);
    // The rows still go — as a plain single, at the plain price.
    expect(eventsOfType(locked, 'rowsCleared')[0]?.spin).toBe('none');
    expect(eventsOfType(locked, 'rowsCleared')[0]?.points).toBe(LINE_CLEAR_POINTS[1]);
  });

  it('does not count as a spin when it was slid sideways and then dropped in', () => {
    const bench = tSpinBench(...SPIN_SINGLE);
    const above = { ...bench, active: { ...bench.active!, y: BOARD_HEIGHT - 4 } };
    const turned = applyInput(above, { type: 'rotateCW' });
    const slid = applyInput(applyInput(turned, { type: 'moveLeft' }), { type: 'moveRight' });
    expect(slid.lastAction).toBe('move');
    expect(slid.active).toEqual(turned.active);

    const locked = update(applyInput(slid, { type: 'softDrop' }), LOCK_DELAY_MS);
    expect(eventsOfType(locked, 'spin')).toHaveLength(0);
  });

  it('does not count as a spin when gravity carried it the last row', () => {
    const bench = tSpinBench(...SPIN_SINGLE);
    const above = { ...bench, active: { ...bench.active!, y: BOARD_HEIGHT - 4 } };
    const turned = applyInput(above, { type: 'rotateCW' });
    const fallen = update(turned, gravityIntervalMs(turned.level));
    expect(fallen.active?.y).toBe(BOARD_HEIGHT - 3);

    const locked = update(fallen, LOCK_DELAY_MS);
    expect(eventsOfType(locked, 'spin')).toHaveLength(0);
    expect(eventsOfType(locked, 'rowsCleared')[0]?.spin).toBe('none');
  });
});

describe('combos', () => {
  it('starts at nothing and counts the first clear as one', () => {
    expect(playing().combo).toBe(0);
    const cleared = update(pendingClear(1), LOCK_DELAY_MS);
    expect(cleared.combo).toBe(1);
    // The first clear of a chain earns no combo bonus.
    expect(cleared.score).toBe(LINE_CLEAR_POINTS[1]);
    expect(eventsOfType(cleared, 'rowsCleared')[0]?.combo).toBe(1);
  });

  it('pays fifty a step, by level, from the second clear onwards', () => {
    const second = update({ ...pendingClear(1), combo: 1 }, LOCK_DELAY_MS);
    expect(second.combo).toBe(2);
    expect(second.score).toBe((LINE_CLEAR_POINTS[1] ?? 0) + COMBO_POINTS);

    const fourthAtLevelThree = update(
      { ...pendingClear(1, { startLevel: 3 }), combo: 3 },
      LOCK_DELAY_MS,
    );
    expect(fourthAtLevelThree.combo).toBe(4);
    expect(fourthAtLevelThree.score).toBe((LINE_CLEAR_POINTS[1] ?? 0) * 3 + COMBO_POINTS * 3 * 3);
  });

  it('builds across consecutive clearing locks', () => {
    const first = update(pendingClear(1), LOCK_DELAY_MS);
    // Deal the same setup again, keeping the counter the first clear left.
    const second = update({ ...pendingClear(1), combo: first.combo }, LOCK_DELAY_MS);
    const third = update({ ...pendingClear(1), combo: second.combo }, LOCK_DELAY_MS);
    expect([first.combo, second.combo, third.combo]).toEqual([1, 2, 3]);
  });

  it('breaks on a lock that clears nothing', () => {
    const broken = update({ ...restingOnFloor(), combo: 5 }, LOCK_DELAY_MS);
    expect(eventsOfType(broken, 'rowsCleared')).toHaveLength(0);
    expect(broken.combo).toBe(0);
  });

  it('survives a hold, a pause and a resume', () => {
    const mid = { ...playing(), combo: 4 };
    expect(applyInput(mid, { type: 'hold' }).combo).toBe(4);
    const paused = applyInput(mid, { type: 'pause' });
    expect(paused.combo).toBe(4);
    expect(applyInput(paused, { type: 'resume' }).combo).toBe(4);
    // Nothing about a resize reaches the engine at all, but time passing does.
    expect(update(mid, 16).combo).toBe(4);
  });

  it('is wiped by a restart', () => {
    const restarted = applyInput({ ...playing(), combo: 7, backToBackChain: 3 }, { type: 'restart' });
    expect(restarted.combo).toBe(0);
    expect(restarted.backToBack).toBe(false);
    expect(restarted.backToBackChain).toBe(0);
    expect(restarted.lastAction).toBe('none');
  });
});

describe('the back-to-back chain', () => {
  it('is started by a quad and continued by the next one', () => {
    const first = update(pendingClear(4), LOCK_DELAY_MS);
    expect(first.backToBack).toBe(true);
    expect(first.backToBackChain).toBe(1);
    expect(eventsOfType(first, 'rowsCleared')[0]?.backToBack).toBe(false);

    const second = update({ ...pendingClear(4), backToBack: true, backToBackChain: 1 }, LOCK_DELAY_MS);
    const event = eventsOfType(second, 'rowsCleared')[0];
    expect(event?.backToBack).toBe(true);
    expect(event?.backToBackChain).toBe(2);
    expect(second.backToBackChain).toBe(2);
  });

  it('is continued by a spin clear, not only by a quad', () => {
    const bench = { ...tSpinBench(...SPIN_SINGLE), backToBack: true, backToBackChain: 1 };
    const locked = spinAndLock(bench);
    const event = eventsOfType(locked, 'rowsCleared')[0];

    expect(event?.spin).toBe('full');
    expect(event?.backToBack).toBe(true);
    expect(event?.backToBackChain).toBe(2);
    expect(locked.backToBack).toBe(true);
  });

  it('is started by a spin clear on its own', () => {
    const locked = spinAndLock(tSpinBench(...SPIN_SINGLE));
    expect(locked.backToBack).toBe(true);
    expect(locked.backToBackChain).toBe(1);
    expect(eventsOfType(locked, 'rowsCleared')[0]?.backToBack).toBe(false);
  });

  it('is broken by a plain triple', () => {
    const broken = update(
      { ...pendingClear(3), backToBack: true, backToBackChain: 4 },
      LOCK_DELAY_MS,
    );
    const event = eventsOfType(broken, 'rowsCleared')[0];

    expect(event?.spin).toBe('none');
    expect(event?.backToBack).toBe(false);
    expect(event?.backToBackChain).toBe(0);
    expect(broken.backToBack).toBe(false);
    expect(broken.backToBackChain).toBe(0);
    // And it is paid at the plain price, with no multiplier.
    expect(broken.score).toBe(LINE_CLEAR_POINTS[3]);
  });

  it('is left alone by a lock that clears nothing', () => {
    const quiet = update(
      { ...restingOnFloor(), backToBack: true, backToBackChain: 2 },
      LOCK_DELAY_MS,
    );
    expect(quiet.backToBack).toBe(true);
    expect(quiet.backToBackChain).toBe(2);
  });

  it('multiplies the base by one and a half, rounded down', () => {
    // 500 x 1.5 is 750 exactly; 300 x 1.5 x level 1 would be 450. The rounding
    // only shows up on an odd base, so the spin tables are where it is checked.
    const spun = spinAndLock({
      ...tSpinBench(...SPIN_SINGLE),
      backToBack: true,
      backToBackChain: 1,
    });
    expect(spun.score).toBe(Math.floor((SPIN_POINTS[1] ?? 0) * BACK_TO_BACK_MULTIPLIER));

    const quad = update({ ...pendingClear(4), backToBack: true }, LOCK_DELAY_MS);
    expect(quad.score).toBe(Math.floor((LINE_CLEAR_POINTS[4] ?? 0) * BACK_TO_BACK_MULTIPLIER));
  });
});

describe('the exact arithmetic', () => {
  const CASES: readonly {
    readonly name: string;
    readonly state: () => GameState;
    readonly points: number;
  }[] = [
    {
      name: 'a plain single at level 1',
      state: () => pendingClear(1),
      points: 100,
    },
    {
      name: 'a plain quad at level 3',
      state: () => pendingClear(4, { startLevel: 3 }),
      points: 2400,
    },
    {
      name: 'a back-to-back quad at level 2',
      state: () => ({ ...pendingClear(4, { startLevel: 2 }), backToBack: true }),
      points: 2400,
    },
    {
      name: 'a plain double on the fourth clear of a combo at level 1',
      state: () => ({ ...pendingClear(2), combo: 3 }),
      points: 300 + 50 * 3,
    },
    {
      name: 'a plain triple on the sixth clear of a combo at level 2',
      state: () => ({ ...pendingClear(3, { startLevel: 2 }), combo: 5 }),
      points: 500 * 2 + 50 * 5 * 2,
    },
    {
      name: 'a back-to-back quad on the third clear of a combo at level 1',
      state: () => ({ ...pendingClear(4), combo: 2, backToBack: true }),
      points: 1200 + 50 * 2,
    },
  ];

  for (const { name, state, points } of CASES) {
    it(`scores ${name} as ${points}`, () => {
      const locked = update(state(), LOCK_DELAY_MS);
      expect(eventsOfType(locked, 'rowsCleared')[0]?.points).toBe(points);
      expect(locked.score).toBe(points);
    });
  }

  const SPIN_CASES: readonly {
    readonly name: string;
    readonly state: () => GameState;
    readonly points: number;
  }[] = [
    {
      name: 'a full spin single at level 1',
      state: () => tSpinBench(...SPIN_SINGLE),
      points: 400,
    },
    {
      name: 'a full spin double at level 2',
      state: () => ({ ...tSpinBench(...SPIN_DOUBLE), level: 2, startLevel: 2 }),
      points: 1600,
    },
    {
      name: 'a back-to-back full spin single on the second clear of a combo',
      state: () => ({ ...tSpinBench(...SPIN_SINGLE), backToBack: true, combo: 1 }),
      points: 600 + 50,
    },
    {
      name: 'a full spin that clears nothing at level 5',
      state: () => ({ ...tSpinBench(...SPIN_NO_CLEAR), level: 5, startLevel: 5 }),
      points: 500,
    },
    {
      name: 'a kicked spin that clears nothing at level 2',
      state: () => ({ ...kickedSpinBench(KICKED_NO_CLEAR), level: 2, startLevel: 2 }),
      points: 100,
    },
    {
      name: 'a kicked spin single at level 3',
      state: () => ({ ...kickedSpinBench(KICKED_SINGLE), level: 3, startLevel: 3 }),
      points: 600,
    },
  ];

  for (const { name, state, points } of SPIN_CASES) {
    it(`scores ${name} as ${points}`, () => {
      expect(spinAndLock(state()).score).toBe(points);
    });
  }
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/** A fresh, running game in `mode`. */
function playingIn(mode: GameMode, options: { seed?: number; startLevel?: number } = {}): GameState {
  return start(
    createGame({ seed: options.seed ?? 7, startLevel: options.startLevel ?? 1, mode }),
  );
}

/**
 * A Sprint with `lines` already cleared and a vertical `I` resting in the gap,
 * so one hard drop completes exactly `rows` more.
 */
function sprintPending(rows: number, lines: number): GameState {
  return {
    ...playingIn('sprint'),
    board: boardWithFloor(rows),
    active: { kind: 'I', rotation: 1, x: GAP_COLUMN - 2, y: BOARD_HEIGHT - 4 },
    lines,
  };
}

describe('modes', () => {
  it('plays Marathon unless told otherwise, and Marathon has no finish line', () => {
    const game = createGame({ seed: 7 });

    expect(game.mode).toBe('marathon');
    expect(game.goalLines).toBe(0);
    expect(game.timeLimitMs).toBe(0);
    expect(game.outcome).toBe('none');
  });

  it('takes each mode’s goals from one table', () => {
    for (const mode of GAME_MODES) {
      const game = createGame({ seed: 7, mode });
      expect(game.mode).toBe(mode);
      expect(game.goalLines).toBe(MODE_RULES[mode].goalLines);
      expect(game.timeLimitMs).toBe(MODE_RULES[mode].timeLimitMs);
    }
    expect(MODE_RULES.sprint.goalLines).toBe(SPRINT_GOAL_LINES);
    expect(MODE_RULES.ultra.timeLimitMs).toBe(ULTRA_TIME_LIMIT_MS);
  });

  it('reads an unrecognised mode as Marathon rather than throwing', () => {
    expect(parseGameMode('sprint')).toBe('sprint');
    expect(parseGameMode('blitz')).toBe('marathon');
    expect(parseGameMode(undefined)).toBe('marathon');
  });

  it('keeps the mode across a restart — changing it is a new game', () => {
    const again = applyInput(playingIn('ultra'), { type: 'restart' });

    expect(again.mode).toBe('ultra');
    expect(again.timeLimitMs).toBe(ULTRA_TIME_LIMIT_MS);
    expect(again.status).toBe('playing');
    expect(again.elapsedMs).toBe(0);
  });

  it('is the same game in all three: identical gravity, scoring and levels', () => {
    // The only thing a mode changes is when the run stops, so up to the point
    // where a finish line could bite, every snapshot must agree.
    const script = 12_000;
    const [marathon, sprint, ultra] = GAME_MODES.map((mode) =>
      update(playingIn(mode, { seed: 21 }), script),
    ) as [GameState, GameState, GameState];

    for (const other of [sprint, ultra]) {
      expect(other.board.cells).toEqual(marathon.board.cells);
      expect(other.score).toBe(marathon.score);
      expect(other.lines).toBe(marathon.lines);
      expect(other.level).toBe(marathon.level);
      expect(other.active).toEqual(marathon.active);
      expect(other.status).toBe('playing');
    }
  });

  it('gains levels the usual way in a timed mode', () => {
    expect(levelForLines(1, 10)).toBe(2);
    const climbing: GameState = { ...sprintPending(1, LINES_PER_LEVEL - 1) };
    const cleared = applyInput(climbing, { type: 'hardDrop' });

    expect(cleared.lines).toBe(LINES_PER_LEVEL);
    expect(cleared.level).toBe(2);
    expect(eventsOfType(cleared, 'levelUp')).toHaveLength(1);
  });
});

/**
 * An Ultra whose clock has already been wound forward.
 *
 * Two minutes of gravity with nobody playing tops the well out at about 106
 * seconds, so a deadline test that started from zero would be testing the
 * top-out instead. Winding the clock on is the honest way to reach the last few
 * seconds of a run that is still going.
 */
function ultraAt(elapsedMs: number): GameState {
  return { ...playingIn('ultra'), elapsedMs };
}

describe('an Ultra run against the clock', () => {
  it('ends at exactly the limit, however long the frame that got there', () => {
    // The whole point of slicing at the deadline: one enormous delta produces a
    // run that stopped on 120000ms, not one that overshot and then noticed.
    const done = update(ultraAt(ULTRA_TIME_LIMIT_MS - 5_000), 60_000);

    expect(done.elapsedMs).toBe(ULTRA_TIME_LIMIT_MS);
    expect(done.status).toBe('over');
    expect(done.outcome).toBe('timeUp');
  });

  it('does not overshoot on a 100ms frame that straddles the deadline', () => {
    const nearly = update(ultraAt(ULTRA_TIME_LIMIT_MS - 5_050), 5_000);
    expect(nearly.status).toBe('playing');
    expect(nearly.elapsedMs).toBe(ULTRA_TIME_LIMIT_MS - 50);

    const done = update(nearly, 100);

    expect(done.elapsedMs).toBe(ULTRA_TIME_LIMIT_MS);
    expect(done.outcome).toBe('timeUp');
  });

  it('ends on a frame that lands exactly on the deadline with nothing to spare', () => {
    const done = update(ultraAt(ULTRA_TIME_LIMIT_MS - 100), 100);

    expect(done.elapsedMs).toBe(ULTRA_TIME_LIMIT_MS);
    expect(done.outcome).toBe('timeUp');
  });

  it('reports the run with the numbers Ultra is scored on', () => {
    const done = update(ultraAt(ULTRA_TIME_LIMIT_MS - 1_000), 5_000);
    const ended = eventsOfType(done, 'runEnd')[0];

    expect(ended).toEqual({
      type: 'runEnd',
      mode: 'ultra',
      outcome: 'timeUp',
      score: done.score,
      lines: done.lines,
      level: done.level,
      durationMs: ULTRA_TIME_LIMIT_MS,
    });
  });

  it('ends early, and says so, when the well tops out first', () => {
    // Nobody is playing, so the stack reaches the ceiling well inside the two
    // minutes — and that is a top-out, not a finished run.
    const over = update(playingIn('ultra'), ULTRA_TIME_LIMIT_MS + 5_000);

    expect(over.status).toBe('over');
    expect(over.outcome).toBe('toppedOut');
    expect(over.elapsedMs).toBeLessThan(ULTRA_TIME_LIMIT_MS);
  });

  it('leaves a mode without a clock running as long as you like', () => {
    const marathon = update({ ...playing(), elapsedMs: ULTRA_TIME_LIMIT_MS }, 5_000);

    expect(marathon.elapsedMs).toBe(ULTRA_TIME_LIMIT_MS + 5_000);
    expect(marathon.status).toBe('playing');
  });
});

describe('a Sprint run against the line goal', () => {
  it('ends on the fortieth line', () => {
    const done = applyInput(sprintPending(1, SPRINT_GOAL_LINES - 1), { type: 'hardDrop' });

    expect(done.lines).toBe(SPRINT_GOAL_LINES);
    expect(done.status).toBe('over');
    expect(done.outcome).toBe('goalReached');
    expect(done.active).toBeNull();
  });

  it('does not wait for the forty-first', () => {
    const still = applyInput(sprintPending(1, SPRINT_GOAL_LINES - 2), { type: 'hardDrop' });

    expect(still.lines).toBe(SPRINT_GOAL_LINES - 1);
    expect(still.status).toBe('playing');
    expect(still.outcome).toBe('none');
    expect(eventsOfType(still, 'runEnd')).toHaveLength(0);
  });

  it('ends on the clear that crosses the line, not only on an exact landing', () => {
    const done = applyInput(sprintPending(4, SPRINT_GOAL_LINES - 3), { type: 'hardDrop' });

    expect(done.lines).toBe(SPRINT_GOAL_LINES + 1);
    expect(done.outcome).toBe('goalReached');
  });

  it('stops the clock on the clear rather than after the clear pause', () => {
    const at39 = update(sprintPending(1, SPRINT_GOAL_LINES - 1), 40);
    const done = applyInput(at39, { type: 'hardDrop' });
    const ended = eventsOfType(done, 'runEnd')[0];

    expect(done.clearDelayMs).toBe(0);
    expect(ended?.durationMs).toBe(done.elapsedMs);
    expect(ended?.durationMs).toBe(40);
  });

  it('records a top-out before the goal as a top-out, not as a slow time', () => {
    const doomed: GameState = {
      ...playingIn('sprint'),
      board: blockedSpawnBoard(),
      active: { kind: 'T', rotation: 0, x: 3, y: BOARD_HEIGHT - 2 },
      lines: 23,
    };

    const over = applyInput(doomed, { type: 'hardDrop' });

    expect(over.status).toBe('over');
    expect(over.outcome).toBe('toppedOut');
    expect(over.lines).toBeLessThan(SPRINT_GOAL_LINES);
    expect(eventsOfType(over, 'runEnd')[0]?.outcome).toBe('toppedOut');
  });

  it('has no clock of its own to run out', () => {
    const long = update({ ...playingIn('sprint'), elapsedMs: ULTRA_TIME_LIMIT_MS }, 1_000);

    expect(long.status).toBe('playing');
    expect(long.elapsedMs).toBe(ULTRA_TIME_LIMIT_MS + 1_000);
  });
});
