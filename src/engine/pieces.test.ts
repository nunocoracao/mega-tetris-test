import { describe, expect, it } from 'vitest';

import { boardFromStrings, createBoard, isValidPosition, BOARD_WIDTH, BUFFER_ROWS } from './board';
import type { Board } from './board';
import {
  boxSize,
  getCells,
  getKicks,
  nextRotation,
  spawnPosition,
  KICKS_CCW,
  KICKS_CW,
  KICKS_I_CCW,
  KICKS_I_CW,
  PIECE_KINDS,
} from './pieces';
import type { ActivePiece, PieceKind, Point, Rotation } from './types';

/**
 * Walk a kick table and return the first nudged position the board accepts,
 * or `null` if the rotation has to be refused. This is the algorithm the game
 * loop will use; it lives here so the tables can be exercised end to end.
 */
function firstFit(board: Board, piece: ActivePiece, kicks: readonly Point[]): ActivePiece | null {
  for (const kick of kicks) {
    const candidate: ActivePiece = { ...piece, x: piece.x + kick.x, y: piece.y + kick.y };
    if (isValidPosition(board, candidate)) {
      return candidate;
    }
  }
  return null;
}

const ROTATIONS: readonly Rotation[] = [0, 1, 2, 3];

/** Draw a set of offsets as ASCII art inside a `size x size` box. */
function drawBox(cells: readonly Point[], size: number): string[] {
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => '.'));
  for (const { x, y } of cells) {
    const row = grid[y];
    if (row) {
      row[x] = '#';
    }
  }
  return grid.map((row) => row.join(''));
}

/**
 * An independent quarter-turn clockwise, written here so the tests check the
 * derived rotation states against something other than the code that built
 * them.
 */
function turnCw(cells: readonly Point[], size: number): Point[] {
  return cells
    .map(({ x, y }) => ({ x: size - 1 - y, y: x }))
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

function sorted(cells: readonly Point[]): Point[] {
  return [...cells].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

describe('piece geometry', () => {
  it.each([...PIECE_KINDS])('%s has exactly four cells in every rotation state', (kind) => {
    for (const rotation of ROTATIONS) {
      const cells = getCells(kind, rotation);
      expect(cells).toHaveLength(4);

      // No duplicates: four *distinct* cells.
      const unique = new Set(cells.map(({ x, y }) => `${x},${y}`));
      expect(unique.size).toBe(4);
    }
  });

  it.each([...PIECE_KINDS])('%s stays inside its bounding box in every rotation', (kind) => {
    const size = boxSize(kind);
    for (const rotation of ROTATIONS) {
      for (const { x, y } of getCells(kind, rotation)) {
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(size);
        expect(y).toBeLessThan(size);
      }
    }
  });

  it.each([...PIECE_KINDS])('each rotation state of %s is the previous one turned clockwise', (kind) => {
    const size = boxSize(kind);
    for (const rotation of ROTATIONS) {
      const next = nextRotation(rotation, 'cw');
      expect(sorted(getCells(kind, next))).toEqual(turnCw(getCells(kind, rotation), size));
    }
  });

  it.each([...PIECE_KINDS])('rotating %s four times returns it to the spawn shape', (kind) => {
    const size = boxSize(kind);
    let cells = sorted(getCells(kind, 0));
    for (let turn = 0; turn < 4; turn += 1) {
      cells = turnCw(cells, size);
    }
    expect(cells).toEqual(sorted(getCells(kind, 0)));
  });

  it('the O piece is identical in all four rotations', () => {
    const spawn = drawBox(getCells('O', 0), boxSize('O'));
    for (const rotation of ROTATIONS) {
      expect(drawBox(getCells('O', rotation), boxSize('O'))).toEqual(spawn);
    }
    expect(spawn).toEqual(['##', '##']);
  });

  it('draws the expected spawn shapes', () => {
    const spawn = (kind: PieceKind): string[] => drawBox(getCells(kind, 0), boxSize(kind));

    expect(spawn('I')).toEqual(['....', '####', '....', '....']);
    expect(spawn('O')).toEqual(['##', '##']);
    expect(spawn('T')).toEqual(['.#.', '###', '...']);
    expect(spawn('S')).toEqual(['.##', '##.', '...']);
    expect(spawn('Z')).toEqual(['##.', '.##', '...']);
    expect(spawn('J')).toEqual(['#..', '###', '...']);
    expect(spawn('L')).toEqual(['..#', '###', '...']);
  });

  it('draws the expected first clockwise rotation of each shape', () => {
    const turned = (kind: PieceKind): string[] => drawBox(getCells(kind, 1), boxSize(kind));

    expect(turned('I')).toEqual(['..#.', '..#.', '..#.', '..#.']);
    expect(turned('T')).toEqual(['.#.', '.##', '.#.']);
    expect(turned('S')).toEqual(['.#.', '.##', '..#']);
    expect(turned('Z')).toEqual(['..#', '.##', '.#.']);
    expect(turned('J')).toEqual(['.##', '.#.', '.#.']);
    expect(turned('L')).toEqual(['.#.', '.#.', '.##']);
  });

  it('the half turn is the spawn shape upside down', () => {
    for (const kind of PIECE_KINDS) {
      const size = boxSize(kind);
      const flipped = sorted(
        getCells(kind, 0).map(({ x, y }) => ({ x: size - 1 - x, y: size - 1 - y })),
      );
      expect(sorted(getCells(kind, 2))).toEqual(flipped);
    }
  });
});

describe('nextRotation', () => {
  it('cycles clockwise through 0-1-2-3', () => {
    expect(ROTATIONS.map((r) => nextRotation(r, 'cw'))).toEqual([1, 2, 3, 0]);
  });

  it('cycles counter-clockwise the other way', () => {
    expect(ROTATIONS.map((r) => nextRotation(r, 'ccw'))).toEqual([3, 0, 1, 2]);
  });

  it('is reversible', () => {
    for (const rotation of ROTATIONS) {
      expect(nextRotation(nextRotation(rotation, 'cw'), 'ccw')).toBe(rotation);
    }
  });
});

describe('spawnPosition', () => {
  it('centres each kind horizontally on a standard board', () => {
    expect(spawnPosition('I', BOARD_WIDTH)).toEqual({ x: 3, y: 0 });
    expect(spawnPosition('O', BOARD_WIDTH)).toEqual({ x: 4, y: 0 });
    for (const kind of ['T', 'S', 'Z', 'J', 'L'] as const) {
      expect(spawnPosition(kind, BOARD_WIDTH)).toEqual({ x: 3, y: 0 });
    }
  });

  it('keeps every spawned piece inside the board and within the hidden buffer', () => {
    for (const kind of PIECE_KINDS) {
      const origin = spawnPosition(kind, BOARD_WIDTH);
      for (const offset of getCells(kind, 0)) {
        const x = origin.x + offset.x;
        const y = origin.y + offset.y;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(BOARD_WIDTH);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(BUFFER_ROWS);
      }
    }
  });

  it('re-centres on a narrower board', () => {
    expect(spawnPosition('T', 6)).toEqual({ x: 1, y: 0 });
    expect(spawnPosition('I', 6)).toEqual({ x: 1, y: 0 });
    expect(spawnPosition('O', 6)).toEqual({ x: 2, y: 0 });
  });
});

describe('wall kicks', () => {
  it('always tries the un-nudged position first', () => {
    for (const table of [KICKS_CW, KICKS_CCW, KICKS_I_CW, KICKS_I_CCW]) {
      expect(table[0]).toEqual({ x: 0, y: 0 });
    }
  });

  it('gives the I piece its own, longer-reaching table', () => {
    expect(getKicks('I', 'cw')).toBe(KICKS_I_CW);
    expect(getKicks('I', 'ccw')).toBe(KICKS_I_CCW);
    expect(KICKS_I_CW.some((k) => Math.abs(k.x) === 2)).toBe(true);
    expect(KICKS_CW.some((k) => Math.abs(k.x) === 2)).toBe(false);
  });

  it('uses the shared table for every other kind', () => {
    for (const kind of PIECE_KINDS.filter((k) => k !== 'I')) {
      expect(getKicks(kind, 'cw')).toBe(KICKS_CW);
      expect(getKicks(kind, 'ccw')).toBe(KICKS_CCW);
    }
  });

  it('mirrors the counter-clockwise tables horizontally', () => {
    const mirror = (table: readonly Point[]): Point[] =>
      table.map(({ x, y }) => ({ x: x === 0 ? 0 : -x, y }));

    expect(KICKS_CCW).toEqual(mirror(KICKS_CW));
    expect(KICKS_I_CCW).toEqual(mirror(KICKS_I_CW));
  });

  it('only ever kicks upwards, never down into the stack', () => {
    for (const table of [KICKS_CW, KICKS_CCW, KICKS_I_CW, KICKS_I_CCW]) {
      for (const { y } of table) {
        expect(y).toBeLessThanOrEqual(0);
      }
    }
  });

  /**
   * The kick tables only earn their keep if walking them actually rescues a
   * rotation. These cases apply the tables the way the game loop will: try
   * each candidate in order, take the first position the board accepts.
   */
  it('frees an I piece rotating away from the right wall', () => {
    const board = createBoard();
    // Upright against the right wall: rotation 1 sits in box column 2, so
    // origin x = 7 puts it in board column 9.
    const upright: ActivePiece = { kind: 'I', rotation: 1, x: 7, y: 4 };
    expect(isValidPosition(board, upright)).toBe(true);

    const rotated = { ...upright, rotation: nextRotation(upright.rotation, 'cw') } as ActivePiece;
    expect(isValidPosition(board, rotated)).toBe(false); // would poke through the wall

    const kicked = firstFit(board, rotated, getKicks('I', 'cw'));
    expect(kicked).not.toBeNull();
    expect(kicked?.x).toBe(6);
  });

  it('lifts an I piece rotating up off the floor', () => {
    const board = createBoard();
    // Flat on the floor: rotation 0 sits in box row 1, so origin y = 20 puts
    // it on the bottom row of a 22-row board.
    const flat: ActivePiece = { kind: 'I', rotation: 0, x: 3, y: 20 };
    expect(isValidPosition(board, flat)).toBe(true);

    const rotated = { ...flat, rotation: nextRotation(flat.rotation, 'cw') } as ActivePiece;
    expect(isValidPosition(board, rotated)).toBe(false); // three cells below the floor

    const kicked = firstFit(board, rotated, getKicks('I', 'cw'));
    expect(kicked).not.toBeNull();
    expect(kicked?.y).toBe(18); // lifted by two so all four cells fit
  });

  it('nudges a T piece out of the left wall', () => {
    const board = createBoard();
    // Rotation 1 keeps the T in box columns 1-2, so origin x = -1 hugs the wall.
    const against: ActivePiece = { kind: 'T', rotation: 1, x: -1, y: 5 };
    expect(isValidPosition(board, against)).toBe(true);

    const rotated = { ...against, rotation: nextRotation(against.rotation, 'cw') } as ActivePiece;
    expect(isValidPosition(board, rotated)).toBe(false);

    const kicked = firstFit(board, rotated, getKicks('T', 'cw'));
    expect(kicked?.x).toBe(0);
  });

  it('gives up when no candidate fits', () => {
    // A board packed solid leaves nowhere for any kick to land.
    const board = boardFromStrings(Array<string>(6).fill('ZZZZZZ'));
    const boxed: ActivePiece = { kind: 'T', rotation: 1, x: 2, y: 2 };
    expect(firstFit(board, boxed, getKicks('T', 'cw'))).toBeNull();
  });

  it('offers no duplicate candidates', () => {
    for (const table of [KICKS_CW, KICKS_CCW, KICKS_I_CW, KICKS_I_CCW]) {
      const unique = new Set(table.map(({ x, y }) => `${x},${y}`));
      expect(unique.size).toBe(table.length);
    }
  });
});
