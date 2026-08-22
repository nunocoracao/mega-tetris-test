import { describe, expect, it } from 'vitest';

import {
  boardFromStrings,
  boardToStrings,
  cellAt,
  clearRows,
  createBoard,
  findFullRows,
  isBoardEmpty,
  isInsideBoard,
  isValidPosition,
  lockPiece,
  pieceCells,
  setCells,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BUFFER_ROWS,
  VISIBLE_HEIGHT,
} from './board';
import { getCells, spawnPosition } from './pieces';
import type { ActivePiece, Rotation } from './types';

function piece(
  kind: ActivePiece['kind'],
  x: number,
  y: number,
  rotation: Rotation = 0,
): ActivePiece {
  return { kind, rotation, x, y };
}

describe('board construction', () => {
  it('uses the standard field size with a hidden spawn buffer', () => {
    expect(BOARD_WIDTH).toBe(10);
    expect(VISIBLE_HEIGHT).toBe(20);
    expect(BUFFER_ROWS).toBe(2);
    expect(BOARD_HEIGHT).toBe(22);
  });

  it('creates an empty board of the right shape', () => {
    const board = createBoard();
    expect(board.width).toBe(BOARD_WIDTH);
    expect(board.height).toBe(BOARD_HEIGHT);
    expect(board.cells).toHaveLength(BOARD_WIDTH * BOARD_HEIGHT);
    expect(isBoardEmpty(board)).toBe(true);
    expect(boardToStrings(board).every((row) => row === '.'.repeat(BOARD_WIDTH))).toBe(true);
  });

  it('accepts custom dimensions and rejects nonsense ones', () => {
    const board = createBoard(4, 3);
    expect(boardToStrings(board)).toEqual(['....', '....', '....']);
    expect(() => createBoard(0, 5)).toThrow();
    expect(() => createBoard(5, -1)).toThrow();
    expect(() => createBoard(5.5, 5)).toThrow();
  });
});

describe('ascii helpers', () => {
  it('round-trips a board through strings', () => {
    const art = ['....', '.T..', 'TTT.', 'JJZZ'];
    expect(boardToStrings(boardFromStrings(art))).toEqual(art);
  });

  it('reads dimensions from the art', () => {
    const board = boardFromStrings(['.....', '..I..']);
    expect(board.width).toBe(5);
    expect(board.height).toBe(2);
    expect(cellAt(board, 2, 1)).toBe('I');
  });

  it('rejects ragged rows and unknown characters', () => {
    expect(() => boardFromStrings(['...', '..'])).toThrow(/expected/);
    expect(() => boardFromStrings(['.X.'])).toThrow(/piece letter/);
    expect(() => boardFromStrings([])).toThrow();
    expect(() => boardFromStrings([''])).toThrow();
  });
});

describe('cellAt', () => {
  const board = boardFromStrings(['.I.', 'OO.']);

  it('reads filled and empty cells', () => {
    expect(cellAt(board, 1, 0)).toBe('I');
    expect(cellAt(board, 0, 0)).toBeNull();
    expect(cellAt(board, 0, 1)).toBe('O');
  });

  it('reports null outside the board', () => {
    expect(cellAt(board, -1, 0)).toBeNull();
    expect(cellAt(board, 3, 0)).toBeNull();
    expect(cellAt(board, 0, -1)).toBeNull();
    expect(cellAt(board, 0, 2)).toBeNull();
    expect(isInsideBoard(board, 3, 0)).toBe(false);
    expect(isInsideBoard(board, 2, 1)).toBe(true);
  });
});

describe('setCells', () => {
  it('returns a new board and leaves the original untouched', () => {
    const before = createBoard(3, 2);
    const after = setCells(before, [{ x: 1, y: 1, value: 'T' }]);

    expect(boardToStrings(after)).toEqual(['...', '.T.']);
    expect(boardToStrings(before)).toEqual(['...', '...']);
    expect(after).not.toBe(before);
    expect(after.cells).not.toBe(before.cells);
  });

  it('can clear a cell back to empty', () => {
    const board = boardFromStrings(['ZZ.']);
    expect(boardToStrings(setCells(board, [{ x: 0, y: 0, value: null }]))).toEqual(['.Z.']);
  });

  it('is a no-op for an empty update list', () => {
    const board = createBoard(3, 2);
    expect(setCells(board, [])).toBe(board);
  });

  it('refuses writes outside the board', () => {
    const board = createBoard(3, 2);
    expect(() => setCells(board, [{ x: 3, y: 0, value: 'L' }])).toThrow(/outside/);
    expect(() => setCells(board, [{ x: 0, y: -1, value: 'L' }])).toThrow(/outside/);
  });
});

describe('pieceCells', () => {
  it('offsets the shape by the piece origin', () => {
    expect(pieceCells(piece('O', 4, 7))).toEqual([
      { x: 4, y: 7 },
      { x: 5, y: 7 },
      { x: 4, y: 8 },
      { x: 5, y: 8 },
    ]);
  });
});

describe('isValidPosition', () => {
  const empty = createBoard(6, 6);

  it('accepts a piece sitting in open space', () => {
    expect(isValidPosition(empty, piece('T', 2, 2))).toBe(true);
  });

  it('rejects a piece off the left edge', () => {
    // T's spawn shape occupies x = 0..2, so origin -1 pushes a cell to x = -1.
    expect(isValidPosition(empty, piece('T', -1, 2))).toBe(false);
    expect(isValidPosition(empty, piece('T', 0, 2))).toBe(true);
  });

  it('rejects a piece off the right edge', () => {
    expect(isValidPosition(empty, piece('T', 3, 2))).toBe(true);
    expect(isValidPosition(empty, piece('T', 4, 2))).toBe(false);
  });

  it('rejects a piece below the floor', () => {
    // The T's cells are on box rows 0 and 1, so origin y = 4 is the last fit
    // on a 6-row board.
    expect(isValidPosition(empty, piece('T', 2, 4))).toBe(true);
    expect(isValidPosition(empty, piece('T', 2, 5))).toBe(false);
  });

  it('allows cells above the top of the field', () => {
    // Origin y = -1 puts the T's nub on row -1, in the spawn buffer above the
    // array. That is legal; only the cells that have entered the board matter.
    expect(isValidPosition(empty, piece('T', 2, -1))).toBe(true);
    expect(isValidPosition(empty, piece('I', 1, -1, 1))).toBe(true);
  });

  it('rejects an overlap with a filled cell', () => {
    const board = boardFromStrings([
      '......',
      '......',
      '......',
      '...Z..',
      '......',
      '......',
    ]);

    // The T at (2, 2) covers (3,2), (2,3), (3,3), (4,3) — (3,3) is taken.
    expect(isValidPosition(board, piece('T', 2, 2))).toBe(false);
    // One row higher it clears the obstacle.
    expect(isValidPosition(board, piece('T', 2, 1))).toBe(true);
  });

  it('lets a piece rest exactly on top of the stack', () => {
    const board = boardFromStrings([
      '......',
      '......',
      '......',
      '......',
      '......',
      'IIIIII',
    ]);

    expect(isValidPosition(board, piece('O', 2, 3))).toBe(true);
    expect(isValidPosition(board, piece('O', 2, 4))).toBe(false);
  });

  it('validates every spawn position on a fresh standard board', () => {
    const board = createBoard();
    for (const kind of ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as const) {
      const origin = spawnPosition(kind, board.width);
      expect(isValidPosition(board, piece(kind, origin.x, origin.y))).toBe(true);
    }
  });
});

describe('lockPiece', () => {
  it('writes exactly four cells and does not mutate the source board', () => {
    const before = createBoard(6, 6);
    const after = lockPiece(before, piece('L', 1, 3));

    expect(after.cells.filter((cell) => cell !== null)).toHaveLength(4);
    expect(boardToStrings(after)).toEqual([
      '......',
      '......',
      '......',
      '...L..',
      '.LLL..',
      '......',
    ]);

    expect(boardToStrings(before)).toEqual(Array<string>(6).fill('......'));
    expect(isBoardEmpty(before)).toBe(true);
    expect(after).not.toBe(before);
  });

  it('stamps the piece kind into every cell it fills', () => {
    const after = lockPiece(createBoard(4, 4), piece('S', 1, 1));
    expect(new Set(after.cells.filter((cell) => cell !== null))).toEqual(new Set(['S']));
  });

  it('keeps existing cells around the new piece', () => {
    const board = boardFromStrings(['....', '....', 'JJJJ']);
    const after = lockPiece(board, piece('O', 1, 0));
    expect(boardToStrings(after)).toEqual(['.OO.', '.OO.', 'JJJJ']);
  });

  it('drops the part of a piece that is still above the board', () => {
    const board = createBoard(4, 4);
    const after = lockPiece(board, piece('T', 1, -1));
    // Only the three cells on box row 1 land on row 0; the nub on row -1 is
    // above the array and is discarded rather than throwing.
    expect(boardToStrings(after)).toEqual(['.TTT', '....', '....', '....']);
  });
});

describe('findFullRows', () => {
  it('finds nothing on an empty board', () => {
    expect(findFullRows(createBoard(5, 5))).toEqual([]);
  });

  it('ignores a row with a single gap', () => {
    expect(findFullRows(boardFromStrings(['IIII', 'III.']))).toEqual([0]);
  });

  it('lists every full row, top to bottom', () => {
    const board = boardFromStrings([
      'ZZZZ',
      '.Z..',
      'JJJJ',
      'J..J',
      'LLLL',
    ]);
    expect(findFullRows(board)).toEqual([0, 2, 4]);
  });
});

describe('clearRows', () => {
  it('removes a single row and drops everything above it', () => {
    const board = boardFromStrings([
      '....',
      '.T..',
      'TTTT',
      'J..J',
    ]);

    const { board: next, cleared } = clearRows(board, findFullRows(board));

    expect(cleared).toBe(1);
    expect(boardToStrings(next)).toEqual([
      '....',
      '....',
      '.T..',
      'J..J',
    ]);
  });

  it('clears several non-adjacent rows at once and shifts correctly', () => {
    const board = boardFromStrings([
      '.S..',
      'IIII',
      '..Z.',
      'OOOO',
      'L...',
    ]);

    const { board: next, cleared } = clearRows(board, findFullRows(board));

    expect(cleared).toBe(2);
    // Two rows vanish; '.S..' falls by two, '..Z.' by one, 'L...' stays put.
    expect(boardToStrings(next)).toEqual([
      '....',
      '....',
      '.S..',
      '..Z.',
      'L...',
    ]);
  });

  it('clears the whole board when every row is full', () => {
    const board = boardFromStrings(['SSS', 'ZZZ']);
    const { board: next, cleared } = clearRows(board, [0, 1]);
    expect(cleared).toBe(2);
    expect(isBoardEmpty(next)).toBe(true);
  });

  it('does not mutate the source board', () => {
    const board = boardFromStrings(['TTTT', '.T..']);
    const { board: next } = clearRows(board, [0]);

    expect(boardToStrings(board)).toEqual(['TTTT', '.T..']);
    expect(boardToStrings(next)).toEqual(['....', '.T..']);
    expect(next.cells).not.toBe(board.cells);
    expect(next.width).toBe(board.width);
    expect(next.height).toBe(board.height);
  });

  it('is a no-op when asked to clear nothing', () => {
    const board = boardFromStrings(['.I..']);
    const result = clearRows(board, []);
    expect(result.cleared).toBe(0);
    expect(result.board).toBe(board);
  });

  it('ignores row indices outside the board', () => {
    const board = boardFromStrings(['.I..', 'IIII']);
    const result = clearRows(board, [-1, 9]);
    expect(result.cleared).toBe(0);
    expect(result.board).toBe(board);
  });

  it('counts a repeated row index only once', () => {
    const board = boardFromStrings(['.I..', 'IIII']);
    const { board: next, cleared } = clearRows(board, [1, 1]);
    expect(cleared).toBe(1);
    expect(boardToStrings(next)).toEqual(['....', '.I..']);
  });
});

describe('lock-and-clear round trip', () => {
  it('completes a row with the final piece and clears it', () => {
    const board = boardFromStrings([
      '......',
      '......',
      '......',
      'JJJJ..',
      'JJJJ..',
    ]);

    // An O piece drops into the notch on the right, completing both rows.
    const dropped = piece('O', 4, 3);
    expect(isValidPosition(board, dropped)).toBe(true);

    const locked = lockPiece(board, dropped);
    const full = findFullRows(locked);
    expect(full).toEqual([3, 4]);

    const { board: next, cleared } = clearRows(locked, full);
    expect(cleared).toBe(2);
    expect(isBoardEmpty(next)).toBe(true);
  });
});

describe('isBoardEmpty', () => {
  it('is true only when nothing is filled', () => {
    expect(isBoardEmpty(createBoard(3, 3))).toBe(true);
    expect(isBoardEmpty(boardFromStrings(['...', '..I']))).toBe(false);
  });
});

describe('rotation on the board', () => {
  it('a piece keeps four cells wherever it is rotated', () => {
    for (const rotation of [0, 1, 2, 3] as const) {
      expect(getCells('J', rotation)).toHaveLength(4);
      expect(pieceCells(piece('J', 3, 5, rotation))).toHaveLength(4);
    }
  });

  it('an I piece stood upright against the left wall is valid, one step further is not', () => {
    const board = createBoard(6, 6);
    // Rotation 1 puts the I in box column 2, so origin x = -2 hugs the wall.
    expect(isValidPosition(board, piece('I', -2, 1, 1))).toBe(true);
    expect(isValidPosition(board, piece('I', -3, 1, 1))).toBe(false);
  });
});
