import { describe, expect, it } from 'vitest';

import { attackLines, ATTACK_LINES } from './attack';
import {
  boardFromStrings,
  boardToStrings,
  createBoard,
  pushRowsUp,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  type Board,
} from './board';
import {
  applyInput,
  createGame,
  receiveGarbage,
  update,
  LINE_CLEAR_DELAY_MS,
  type GameEvent,
  type GameState,
} from './game';
import {
  cancelGarbage,
  createGarbageRandom,
  garbageDeadlineMs,
  garbageRow,
  nextHoleColumn,
  pendingGarbage,
  queueGarbage,
  riseGarbage,
  tickGarbage,
  GARBAGE_DELAY_MS,
  MAX_GARBAGE_BATCH_ROWS,
  MAX_GARBAGE_QUEUE,
  type GarbageBatch,
} from './garbage';
import { GARBAGE_CELL, type ActivePiece } from './types';

/** A running solo game — no garbage rules at all. */
function solo(seed = 7): GameState {
  return applyInput(createGame({ seed }), { type: 'resume' });
}

/** A running game with versus rules switched on. */
function versus(options: { seed?: number; delayMs?: number } = {}): GameState {
  const garbage = options.delayMs === undefined ? {} : { delayMs: options.delayMs };
  return applyInput(createGame({ seed: options.seed ?? 7, garbage }), { type: 'resume' });
}

function eventsOfType<T extends GameEvent['type']>(
  state: GameState,
  type: T,
): Extract<GameEvent, { type: T }>[] {
  return state.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

/** The rows of a board that hold at least one cell, as strings. */
function filledRows(board: Board): string[] {
  return boardToStrings(board).filter((row) => row.includes(GARBAGE_CELL) || /[IOTSZJL]/.test(row));
}

const GAP_COLUMN = 3;

/** A board whose bottom `rows` are full but for one gap column. */
function boardWithFloor(rows: number): Board {
  const empty = '.'.repeat(BOARD_WIDTH);
  const almost = Array.from({ length: BOARD_WIDTH }, (_, x) => (x === GAP_COLUMN ? '.' : 'J')).join('');
  return boardFromStrings(
    Array.from({ length: BOARD_HEIGHT }, (_, y) => (y >= BOARD_HEIGHT - rows ? almost : empty)),
  );
}

/** A vertical `I` in the gap, resting on that floor: hard drop clears `rows`. */
function pendingClear(base: GameState, rows: number): GameState {
  return {
    ...base,
    board: boardWithFloor(rows),
    active: { kind: 'I', rotation: 1, x: GAP_COLUMN - 2, y: BOARD_HEIGHT - 4 },
  };
}

// ---------------------------------------------------------------------------
// The pieces of the mechanism
// ---------------------------------------------------------------------------

describe('pushRowsUp', () => {
  it('shifts the board up and drops what no longer fits', () => {
    const board = boardFromStrings(['I...', 'OO..', '..TT']);
    const pushed = pushRowsUp(board, [['G', 'G', null, 'G']]);
    expect(boardToStrings(pushed.board)).toEqual(['OO..', '..TT', 'GG.G']);
    expect(pushed.overflow).toEqual([['I', null, null, null]]);
  });

  it('is a no-op for no rows at all', () => {
    const board = boardFromStrings(['....', 'OO..']);
    expect(pushRowsUp(board, []).board).toBe(board);
  });

  it('refuses a row that is not the width of the board', () => {
    expect(() => pushRowsUp(createBoard(4, 3), [[null, null]])).toThrow(/expected 4/);
  });

  it('keeps the last rows when more arrive than the board is tall', () => {
    const board = boardFromStrings(['..', '..']);
    const pushed = pushRowsUp(board, [
      ['I', null],
      ['O', null],
      ['T', null],
    ]);
    expect(boardToStrings(pushed.board)).toEqual(['O.', 'T.']);
  });
});

describe('garbageRow', () => {
  it('is solid but for the hole', () => {
    expect(garbageRow(5, 2)).toEqual([GARBAGE_CELL, GARBAGE_CELL, null, GARBAGE_CELL, GARBAGE_CELL]);
  });
});

describe('nextHoleColumn', () => {
  it('is a function of the generator state and nothing else', () => {
    const first = nextHoleColumn(1234, BOARD_WIDTH);
    const again = nextHoleColumn(1234, BOARD_WIDTH);
    expect(again).toEqual(first);
  });

  it('advances the generator, so a second draw is a fresh column', () => {
    const first = nextHoleColumn(1234, BOARD_WIDTH);
    expect(nextHoleColumn(first.random, BOARD_WIDTH).random).not.toBe(first.random);
  });

  it('stays inside the board, over a long run of draws', () => {
    let random = createGarbageRandom(99);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const drawn = nextHoleColumn(random, BOARD_WIDTH);
      random = drawn.random;
      expect(drawn.column).toBeGreaterThanOrEqual(0);
      expect(drawn.column).toBeLessThan(BOARD_WIDTH);
      seen.add(drawn.column);
    }
    // And it really does use the whole width rather than favouring a corner.
    expect(seen.size).toBe(BOARD_WIDTH);
  });
});

describe('queueGarbage', () => {
  const base = { queue: [] as readonly GarbageBatch[], delayMs: 900, width: BOARD_WIDTH, nextId: 1 };

  it('puts a small attack in one batch with one hole', () => {
    const queued = queueGarbage({ ...base, rows: 3, random: createGarbageRandom(5) });
    expect(queued.added).toHaveLength(1);
    expect(queued.added[0]?.rows).toBe(3);
    expect(pendingGarbage(queued.queue)).toBe(3);
  });

  it('splits an attack bigger than a batch, and each half gets its own hole', () => {
    const seed = createGarbageRandom(5);
    const queued = queueGarbage({ ...base, rows: 9, random: seed });
    expect(queued.added.map((batch) => batch.rows)).toEqual([MAX_GARBAGE_BATCH_ROWS, MAX_GARBAGE_BATCH_ROWS, 1]);

    // Three successive draws from the one generator: independent columns, free
    // to coincide but never shared by construction.
    const first = nextHoleColumn(seed, BOARD_WIDTH);
    const second = nextHoleColumn(first.random, BOARD_WIDTH);
    const third = nextHoleColumn(second.random, BOARD_WIDTH);
    expect(queued.added.map((batch) => batch.holeColumn)).toEqual([
      first.column,
      second.column,
      third.column,
    ]);
    expect(queued.random).toBe(third.random);
  });

  it('hands out ids in order', () => {
    const queued = queueGarbage({ ...base, rows: 6, random: 1, nextId: 4 });
    expect(queued.added.map((batch) => batch.id)).toEqual([4, 5]);
    expect(queued.nextId).toBe(6);
  });

  it('stops growing at the queue cap', () => {
    let queue: readonly GarbageBatch[] = [];
    let random = createGarbageRandom(1);
    let nextId = 1;
    for (let i = 0; i < MAX_GARBAGE_QUEUE + 10; i += 1) {
      const queued = queueGarbage({ ...base, queue, rows: 1, random, nextId });
      queue = queued.queue;
      random = queued.random;
      nextId = queued.nextId;
    }
    expect(queue).toHaveLength(MAX_GARBAGE_QUEUE);
  });
});

describe('cancelGarbage', () => {
  const queue: readonly GarbageBatch[] = [
    { rows: 2, holeColumn: 1, delayMs: 100, id: 1 },
    { rows: 3, holeColumn: 4, delayMs: 400, id: 2 },
  ];

  it('eats the soonest batch first', () => {
    const cancelled = cancelGarbage(queue, 2);
    expect(cancelled.cancelled).toBe(2);
    expect(cancelled.queue.map((batch) => batch.id)).toEqual([2]);
  });

  it('takes a bite out of a batch it cannot finish', () => {
    const cancelled = cancelGarbage(queue, 4);
    expect(cancelled.cancelled).toBe(4);
    expect(cancelled.queue).toEqual([{ rows: 1, holeColumn: 4, delayMs: 400, id: 2 }]);
  });

  it('never eats more than there is', () => {
    const cancelled = cancelGarbage(queue, 99);
    expect(cancelled.cancelled).toBe(5);
    expect(cancelled.queue).toEqual([]);
  });

  it('leaves the queue alone when there is no attack to spend', () => {
    expect(cancelGarbage(queue, 0).queue).toBe(queue);
  });
});

describe('tickGarbage', () => {
  it('runs every batch down together', () => {
    const queue: readonly GarbageBatch[] = [
      { rows: 1, holeColumn: 0, delayMs: 100, id: 1 },
      { rows: 1, holeColumn: 0, delayMs: 400, id: 2 },
    ];
    expect(tickGarbage(queue, 150).map((batch) => batch.delayMs)).toEqual([0, 250]);
  });

  it('reports the soonest deadline, and infinity for an empty queue', () => {
    expect(garbageDeadlineMs([])).toBe(Number.POSITIVE_INFINITY);
    expect(
      garbageDeadlineMs([
        { rows: 1, holeColumn: 0, delayMs: 400, id: 1 },
        { rows: 1, holeColumn: 0, delayMs: 120, id: 2 },
      ]),
    ).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Rising
// ---------------------------------------------------------------------------

describe('riseGarbage', () => {
  it('pushes solid rows in at the bottom, all sharing one hole', () => {
    const board = boardFromStrings(['....', '....', '....', 'OO..']);
    const risen = riseGarbage(board, null, 2, 1);
    expect(boardToStrings(risen.board)).toEqual(['....', 'OO..', 'G.GG', 'G.GG']);
    expect(risen.toppedOut).toBe(false);
  });

  it('does nothing at all for zero rows', () => {
    const board = boardFromStrings(['....', 'OO..']);
    expect(riseGarbage(board, null, 0, 1).board).toBe(board);
  });

  it('lifts the falling piece out of the way, by as little as it takes', () => {
    // A `T` flat on the floor of a 10-wide board, and two rows arriving under it.
    const board = createBoard();
    const active: ActivePiece = { kind: 'T', rotation: 0, x: 3, y: BOARD_HEIGHT - 2 };
    const risen = riseGarbage(board, active, 2, 0);
    expect(risen.nudged).toBe(2);
    expect(risen.active).toEqual({ ...active, y: BOARD_HEIGHT - 4 });
    expect(risen.toppedOut).toBe(false);
  });

  it('leaves a piece where it is when the rise happens below it', () => {
    const board = createBoard();
    const active: ActivePiece = { kind: 'T', rotation: 0, x: 3, y: 4 };
    const risen = riseGarbage(board, active, 1, 0);
    expect(risen.nudged).toBe(0);
    expect(risen.active).toEqual(active);
  });

  it('tops out when a row with blocks in it is pushed off the top', () => {
    const board = boardFromStrings(['I...', '....', '....', '....']);
    const risen = riseGarbage(board, null, 1, 2);
    expect(risen.toppedOut).toBe(true);
    // And it still returns the risen board: the run is over, not undefined.
    expect(boardToStrings(risen.board)).toEqual(['....', '....', '....', 'GG.G']);
  });

  it('tops out when the falling piece has nowhere left to be lifted to', () => {
    // The piece is already against the ceiling — its top cell is on row 0 — and
    // the cells under it are full, so there is no legal place for it to go.
    const board = boardFromStrings(['....', 'JJJJ', 'JJJJ', 'JJJ.']);
    const active: ActivePiece = { kind: 'O', rotation: 0, x: 0, y: -1 };
    const risen = riseGarbage(board, active, 1, 3);
    expect(risen.toppedOut).toBe(true);
  });

  it('lets a piece that was already poking out of the well stay where it is', () => {
    // `I` at rotation 0 fills box row 1, so this one's four cells sit on board
    // row −1: entirely above the array, which is legal. Nothing is in its way,
    // and a rise underneath it must not kill it for a position it was already
    // in before the garbage arrived.
    const board = boardFromStrings(['....', '....', '....', '....']);
    const active: ActivePiece = { kind: 'I', rotation: 0, x: 0, y: -2 };
    const risen = riseGarbage(board, active, 1, 2);
    expect(risen.toppedOut).toBe(false);
    expect(risen.nudged).toBe(0);
    expect(risen.active).toEqual(active);
  });
});

// ---------------------------------------------------------------------------
// The queue inside a running game
// ---------------------------------------------------------------------------

describe('a solo run', () => {
  it('has garbage switched off, an empty queue, and no way to turn it on', () => {
    const state = solo();
    expect(state.garbageEnabled).toBe(false);
    expect(state.garbageQueue).toEqual([]);

    const offered = receiveGarbage(state, 4);
    expect(offered.garbageQueue).toEqual([]);
    expect(offered.events).toEqual([]);
    expect(offered.garbageRandom).toBe(state.garbageRandom);
  });

  it('never emits an attack event, however good the clear', () => {
    const cleared = applyInput(pendingClear(solo(), 4), { type: 'hardDrop' });
    expect(cleared.lines).toBe(4);
    expect(eventsOfType(cleared, 'attack')).toEqual([]);
    expect(cleared.garbageSent).toBe(0);
  });

  it('is untouched by a hundred seconds of play with the queue empty', () => {
    let state = solo(11);
    for (let i = 0; i < 100; i += 1) {
      state = update(state, 1000);
    }
    expect(state.garbageQueue).toEqual([]);
    expect(state.garbageReceived).toBe(0);
  });
});

describe('receiveGarbage', () => {
  it('queues rather than landing, and says so', () => {
    const state = receiveGarbage(versus(), 3);
    expect(pendingGarbage(state.garbageQueue)).toBe(3);
    expect(state.board.cells.every((cell) => cell === null)).toBe(true);

    const queued = eventsOfType(state, 'garbageQueued');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.rows).toBe(3);
    expect(queued[0]?.delayMs).toBe(GARBAGE_DELAY_MS);
    expect(queued[0]?.pending).toBe(3);
  });

  it('honours a run-specific delay', () => {
    const state = receiveGarbage(versus({ delayMs: 120 }), 1);
    expect(state.garbageQueue[0]?.delayMs).toBe(120);
  });

  it('is a no-op once the run is over', () => {
    const over: GameState = { ...versus(), status: 'over', outcome: 'toppedOut' };
    expect(receiveGarbage(over, 4).garbageQueue).toEqual([]);
  });

  it('does not touch the piece stream', () => {
    const before = versus({ seed: 3 });
    const after = receiveGarbage(before, 4);
    expect(after.bag).toEqual(before.bag);
    expect(after.next).toEqual(before.next);
    expect(after.garbageRandom).not.toBe(before.garbageRandom);
  });

  it('draws the same hole columns for the same seed, every time', () => {
    const first = receiveGarbage(versus({ seed: 42 }), 8);
    const again = receiveGarbage(versus({ seed: 42 }), 8);
    expect(again.garbageQueue).toEqual(first.garbageQueue);
    // Two batches, and a different seed picks differently often enough that
    // this is a real assertion rather than a coincidence.
    expect(first.garbageQueue).toHaveLength(2);
  });
});

describe('garbage rising in a running game', () => {
  it('waits out its delay and then pushes the well up', () => {
    let state = receiveGarbage(versus({ delayMs: 300 }), 2);
    state = update(state, 299);
    expect(state.garbageReceived).toBe(0);
    expect(eventsOfType(state, 'garbageRose')).toEqual([]);

    state = update(state, 1);
    const rose = eventsOfType(state, 'garbageRose');
    expect(rose).toHaveLength(1);
    expect(rose[0]?.rows).toBe(2);
    expect(state.garbageQueue).toEqual([]);
    expect(state.garbageReceived).toBe(2);

    const hole = rose[0]?.holeColumn ?? -1;
    const rows = filledRows(state.board);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toBe(garbageRow(BOARD_WIDTH, hole).map((cell) => cell ?? '.').join(''));
    }
  });

  it('slices one big delta exactly as it slices many small ones', () => {
    const start = receiveGarbage(versus({ seed: 21, delayMs: 700 }), 5);

    let coarse = start;
    coarse = update(coarse, 5000);

    let fine = start;
    for (let i = 0; i < 500; i += 1) {
      fine = update(fine, 10);
    }

    expect({ ...coarse, events: [] }).toEqual({ ...fine, events: [] });
  });

  it('rises during a line-clear pause, when there is no piece to lift', () => {
    let state = applyInput(pendingClear(versus({ delayMs: 60 }), 2), { type: 'hardDrop' });
    expect(state.active).toBeNull();
    state = receiveGarbage(state, 1);
    state = update(state, 80);
    expect(state.garbageReceived).toBe(1);
    expect(state.active).toBeNull();
    expect(state.clearDelayMs).toBeGreaterThan(0);
    expect(state.clearDelayMs).toBeLessThan(LINE_CLEAR_DELAY_MS);
  });

  it('ends the run when the well overflows', () => {
    const full = boardFromStrings(
      Array.from({ length: BOARD_HEIGHT }, (_, y) => (y === 0 ? 'J'.repeat(BOARD_WIDTH) : '.'.repeat(BOARD_WIDTH))),
    );
    let state: GameState = { ...versus({ delayMs: 10 }), board: full, active: null, clearDelayMs: 500 };
    state = receiveGarbage(state, 1);
    state = update(state, 20);
    expect(state.status).toBe('over');
    expect(state.outcome).toBe('toppedOut');
    expect(eventsOfType(state, 'runEnd')[0]?.outcome).toBe('toppedOut');
  });

  it('lifts the falling piece rather than burying it', () => {
    const resting: GameState = {
      ...versus({ delayMs: 40 }),
      active: { kind: 'T', rotation: 0, x: 3, y: BOARD_HEIGHT - 2 },
    };
    const state = update(receiveGarbage(resting, 2), 50);
    expect(state.active?.y).toBe(BOARD_HEIGHT - 4);
    expect(eventsOfType(state, 'garbageRose')[0]?.nudged).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cancellation — the mechanic the mode is built on
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('spends an outgoing attack on the incoming queue before it lands', () => {
    // A double sends one line; four are queued against us, so three survive.
    let state = receiveGarbage(versus({ delayMs: 5000 }), 4);
    state = applyInput(pendingClear(state, 2), { type: 'hardDrop' });

    expect(attackLines({ count: 2, spin: 'none', combo: 1, backToBack: false })).toBe(ATTACK_LINES[2]);
    expect(pendingGarbage(state.garbageQueue)).toBe(3);
    expect(state.garbageCancelled).toBe(1);
    expect(state.garbageSent).toBe(0);

    const cancelled = eventsOfType(state, 'garbageCancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toEqual({ type: 'garbageCancelled', rows: 1, remaining: 3 });
  });

  it('sends only what the queue could not swallow', () => {
    // A quad sends four; one is queued, so one is cancelled and three cross.
    let state = receiveGarbage(versus({ delayMs: 5000 }), 1);
    state = applyInput(pendingClear(state, 4), { type: 'hardDrop' });

    expect(state.garbageQueue).toEqual([]);
    expect(state.garbageCancelled).toBe(1);
    expect(state.garbageSent).toBe(3);
    expect(eventsOfType(state, 'attack')[0]).toEqual({
      type: 'attack',
      kind: 'I',
      lines: 4,
      cancelled: 1,
      sent: 3,
    });
  });

  it('says nothing about cancelling when there was nothing to cancel', () => {
    const state = applyInput(pendingClear(versus(), 4), { type: 'hardDrop' });
    expect(eventsOfType(state, 'garbageCancelled')).toEqual([]);
    expect(state.garbageSent).toBe(4);
  });

  it('sends nothing at all for a single', () => {
    const state = applyInput(pendingClear(versus(), 1), { type: 'hardDrop' });
    expect(state.lines).toBe(1);
    expect(state.garbageSent).toBe(0);
    expect(eventsOfType(state, 'attack')).toEqual([]);
  });
});

describe('restarting a versus run', () => {
  it('keeps the rules and throws the queue away', () => {
    const state = receiveGarbage(versus({ delayMs: 250 }), 4);
    const again = applyInput(state, { type: 'restart' });
    expect(again.garbageEnabled).toBe(true);
    expect(again.garbageDelayMs).toBe(250);
    expect(again.garbageQueue).toEqual([]);
    expect(again.garbageReceived).toBe(0);
    expect(again.status).toBe('playing');
  });

  it('leaves a solo run solo', () => {
    expect(applyInput(solo(), { type: 'restart' }).garbageEnabled).toBe(false);
  });
});
