import { describe, expect, it } from 'vitest';

import { BOARD_WIDTH, PIECE_KINDS, VISIBLE_HEIGHT, createBoard, getCells } from '../engine';
import { PIECE_PALETTE, withAlpha } from './palette';
import { computeGridLayout, hiddenRowCount, pieceExtents } from './renderer';

describe('computeGridLayout', () => {
  it('fills a box that matches the grid exactly', () => {
    const layout = computeGridLayout(300, 600, 10, 20);

    expect(layout).toEqual({ cell: 30, x: 0, y: 0, width: 300, height: 600 });
  });

  it('fits to the tighter axis and centres the leftover', () => {
    // 400 wide would allow 40px cells, but 600 tall only allows 30.
    const layout = computeGridLayout(400, 600, 10, 20);

    expect(layout.cell).toBe(30);
    expect(layout.width).toBe(300);
    expect(layout.height).toBe(600);
    expect(layout.x).toBe(50);
    expect(layout.y).toBe(0);
  });

  it('keeps cells whole so blocks land on pixel boundaries', () => {
    const layout = computeGridLayout(307, 613, 10, 20);

    expect(Number.isInteger(layout.cell)).toBe(true);
    expect(layout.cell).toBe(30);
    expect(layout.x + layout.width).toBeLessThanOrEqual(307);
    expect(layout.y + layout.height).toBeLessThanOrEqual(613);
  });

  it('subtracts padding from the usable box', () => {
    const layout = computeGridLayout(100, 100, 4, 4, 10);

    expect(layout.cell).toBe(20);
    expect(layout.x).toBe(10);
  });

  it('never collapses to a zero-sized cell', () => {
    expect(computeGridLayout(0, 0, 10, 20).cell).toBe(1);
    expect(computeGridLayout(4, 4, 10, 20, 20).cell).toBe(1);
  });
});

describe('pieceExtents', () => {
  it('measures the shape, not its rotation box', () => {
    expect(pieceExtents('I')).toMatchObject({ width: 4, height: 1 });
    expect(pieceExtents('O')).toMatchObject({ width: 2, height: 2 });
    expect(pieceExtents('T')).toMatchObject({ width: 3, height: 2 });
  });

  it('covers every cell of every piece', () => {
    for (const kind of PIECE_KINDS) {
      const extents = pieceExtents(kind);
      for (const cell of getCells(kind, 0)) {
        expect(cell.x - extents.minX).toBeGreaterThanOrEqual(0);
        expect(cell.x - extents.minX).toBeLessThan(extents.width);
        expect(cell.y - extents.minY).toBeGreaterThanOrEqual(0);
        expect(cell.y - extents.minY).toBeLessThan(extents.height);
      }
    }
  });
});

describe('hiddenRowCount', () => {
  it('hides the spawn buffer above the visible field', () => {
    const board = createBoard();

    expect(hiddenRowCount(board)).toBe(board.height - VISIBLE_HEIGHT);
    expect(board.width).toBe(BOARD_WIDTH);
  });

  it('hides nothing on a board shorter than the visible field', () => {
    expect(hiddenRowCount(createBoard(4, 4))).toBe(0);
  });
});

describe('palette', () => {
  it('has a colour for every piece kind', () => {
    for (const kind of PIECE_KINDS) {
      expect(PIECE_PALETTE[kind].fill).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('builds valid translucent variants', () => {
    expect(withAlpha('#35d0ee', 0)).toBe('#35d0ee00');
    expect(withAlpha('#35d0ee', 1)).toBe('#35d0eeff');
    expect(withAlpha('#35d0ee', 0.5)).toBe('#35d0ee80');
    expect(withAlpha('#35d0ee', 5)).toBe('#35d0eeff');
  });
});
