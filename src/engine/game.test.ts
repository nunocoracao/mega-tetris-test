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
  update,
  GRAVITY_BASE_MS,
  GRAVITY_FLOOR_MS,
  HARD_DROP_POINTS,
  LINE_CLEAR_DELAY_MS,
  LINE_CLEAR_POINTS,
  LINES_PER_LEVEL,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  NEXT_QUEUE_SIZE,
  SOFT_DROP_POINTS,
  type GameEvent,
  type GameInput,
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
    expect(eventsOfType(held, 'gameOver')).toHaveLength(1);
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
    expect(eventsOfType(over, 'gameOver')[0]).toEqual({
      type: 'gameOver',
      score: over.score,
      lines: over.lines,
      level: over.level,
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
      // or the snapshot carrying the `gameOver` event is thrown away.
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
    const ended = eventsOfType(over, 'gameOver')[0];
    expect(ended).toEqual({
      type: 'gameOver',
      score: over.score,
      lines: over.lines,
      level: over.level,
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
