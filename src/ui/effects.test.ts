import { describe, expect, it } from 'vitest';

import { BOARD_HEIGHT, BOARD_WIDTH, createBoard, setCells, type Board, type GameEvent } from '../engine';
import {
  COUNT_UP_MS,
  PARTICLE_CAPACITY,
  createCounter,
  createEffects,
  type Effects,
} from './effects';
import { computeGridLayout, type FieldView } from './renderer';

/**
 * A canvas that records nothing and draws nothing.
 *
 * Vitest runs in `node`, so there is no real 2D context to hand `render`. What
 * we actually want to assert about painting is that it completes, touches only
 * the API it claims to, and leaves the context the way it found it — a stub is
 * enough for all three, and it keeps the effects module honest about not
 * quietly reaching for something exotic.
 */
function stubContext(): CanvasRenderingContext2D & { readonly calls: string[] } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(`${name}(${args.length})`);
    };

  const stub = {
    calls,
    globalAlpha: 1,
    fillStyle: '' as string | CanvasGradient,
    strokeStyle: '' as string | CanvasGradient,
    lineWidth: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    rotate: record('rotate'),
    scale: record('scale'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    createLinearGradient: (): CanvasGradient =>
      ({ addColorStop: (): void => {} }),
  };

  return stub as unknown as CanvasRenderingContext2D & { readonly calls: string[] };
}

function fieldView(cell = 24): FieldView {
  const layout = computeGridLayout(cell * BOARD_WIDTH, cell * BOARD_HEIGHT, BOARD_WIDTH, BOARD_HEIGHT);
  const hiddenRows = BOARD_HEIGHT - 20;
  return {
    layout,
    hiddenRows,
    wellY: layout.y + hiddenRows * layout.cell,
    wellHeight: layout.height - hiddenRows * layout.cell,
    width: layout.width,
    height: layout.height,
  };
}

/** A board whose bottom `count` rows are solid, ready to be cleared. */
function filledRows(count: number): { board: Board; rows: number[] } {
  const rows: number[] = [];
  const updates = [];
  for (let index = 0; index < count; index += 1) {
    const y = BOARD_HEIGHT - 1 - index;
    rows.push(y);
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      updates.push({ x, y, value: 'T' as const });
    }
  }
  return { board: setCells(createBoard(), updates), rows: rows.slice().sort((a, b) => a - b) };
}

function clearEvent(rows: readonly number[], quad = false, backToBack = false): GameEvent {
  return {
    type: 'rowsCleared',
    rows,
    count: rows.length,
    quad,
    backToBack,
    points: rows.length * 100,
  };
}

/** A deterministic stand-in for `Math.random`, cycling through a fixed ramp. */
function fixedRandom(): () => number {
  let step = 0;
  return () => {
    step = (step + 1) % 17;
    return step / 17;
  };
}

function makeEffects(reduced = false): { effects: Effects; setReduced: (value: boolean) => void } {
  let calm = reduced;
  const effects = createEffects({
    reducedMotion: () => calm,
    random: fixedRandom(),
  });
  return {
    effects,
    setReduced: (value: boolean) => {
      calm = value;
    },
  };
}

describe('createCounter', () => {
  it('walks to its target over the count-up window', () => {
    const counter = createCounter();
    counter.set(800);

    expect(counter.value()).toBe(0);
    counter.update(COUNT_UP_MS / 2);
    expect(counter.value()).toBeGreaterThan(0);
    expect(counter.value()).toBeLessThan(800);

    counter.update(COUNT_UP_MS / 2);
    expect(counter.value()).toBe(800);
  });

  it('never overshoots, however large the frame', () => {
    const counter = createCounter();
    counter.set(1200);
    counter.update(10_000);

    expect(counter.value()).toBe(1200);
  });

  it('re-bases on a new target instead of stalling or sprinting', () => {
    const counter = createCounter();
    counter.set(1000);
    counter.update(COUNT_UP_MS / 2);
    const midway = counter.value();

    counter.set(2000);
    counter.update(COUNT_UP_MS);

    expect(midway).toBeGreaterThan(0);
    expect(counter.value()).toBe(2000);
  });

  it('snaps downward, because a lower score means a new game', () => {
    const counter = createCounter();
    counter.set(5000);
    counter.update(COUNT_UP_MS);
    counter.set(0);

    expect(counter.value()).toBe(0);
  });

  it('arrives immediately when asked to snap', () => {
    const counter = createCounter();
    counter.set(4321);
    counter.snap();

    expect(counter.value()).toBe(4321);
  });
});

describe('line clears', () => {
  it('throws shards in the colours of the row that went', () => {
    const { effects } = makeEffects();
    const { board, rows } = filledRows(1);

    effects.observe([clearEvent(rows)], board);

    expect(effects.particleCount()).toBeGreaterThan(20);
  });

  it('celebrates a quad harder than a single', () => {
    const single = makeEffects().effects;
    const quad = makeEffects().effects;
    const one = filledRows(1);
    const four = filledRows(4);

    single.observe([clearEvent(one.rows)], one.board);
    quad.observe([clearEvent(four.rows, true)], four.board);

    expect(quad.particleCount()).toBeGreaterThan(single.particleCount());
    expect(quad.shake(24)).not.toBeNull();
    expect(single.shake(24)).toBeNull();
  });

  it('shakes harder for a back-to-back quad', () => {
    const plain = makeEffects().effects;
    const b2b = makeEffects().effects;
    const four = filledRows(4);

    plain.observe([clearEvent(four.rows, true, false)], four.board);
    b2b.observe([clearEvent(four.rows, true, true)], four.board);

    const a = plain.shake(24);
    const b = b2b.shake(24);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Math.abs(b!.x)).toBeGreaterThan(Math.abs(a!.x));
  });

  it('lets the shake decay back to nothing', () => {
    const { effects } = makeEffects();
    const four = filledRows(4);

    effects.observe([clearEvent(four.rows, true)], four.board);
    expect(effects.shake(24)).not.toBeNull();

    effects.update(600, 0);
    expect(effects.shake(24)).toBeNull();
  });

  it('reads the colours of cells the locking piece itself filled', () => {
    // The engine collapses the row before we ever see it, and the piece that
    // completed it is not in the previous board. Without the `lock` event
    // there would be nothing to colour those cells with.
    const { effects } = makeEffects();
    const y = BOARD_HEIGHT - 1;
    const updates = [];
    for (let x = 0; x < BOARD_WIDTH - 1; x += 1) {
      updates.push({ x, y, value: 'S' as const });
    }
    const board = setCells(createBoard(), updates);

    effects.observe(
      [
        { type: 'lock', kind: 'L', cells: [{ x: BOARD_WIDTH - 1, y }] },
        clearEvent([y]),
      ],
      board,
    );

    // Ten cells' worth of shards, not nine: the gap the piece filled counts.
    expect(effects.particleCount()).toBe(BOARD_WIDTH * 3);
  });
});

describe('the particle pool', () => {
  it('never exceeds its capacity, however many clears land at once', () => {
    const { effects } = makeEffects();
    const four = filledRows(4);

    for (let burst = 0; burst < 20; burst += 1) {
      effects.observe([clearEvent(four.rows, true)], four.board);
    }

    expect(effects.particleCount()).toBeLessThanOrEqual(PARTICLE_CAPACITY);
  });

  it('gives every shard back once it has lived out its life', () => {
    const { effects } = makeEffects();
    const four = filledRows(4);

    effects.observe([clearEvent(four.rows, true)], four.board);
    expect(effects.particleCount()).toBeGreaterThan(0);

    for (let frame = 0; frame < 120; frame += 1) {
      effects.update(16, 0);
    }

    expect(effects.particleCount()).toBe(0);
  });

  it('is emptied by clear()', () => {
    const { effects } = makeEffects();
    const four = filledRows(4);

    effects.observe([clearEvent(four.rows, true)], four.board);
    effects.clear();

    expect(effects.particleCount()).toBe(0);
    expect(effects.shake(24)).toBeNull();
  });
});

describe('hard drops', () => {
  const lock: GameEvent = {
    type: 'lock',
    kind: 'O',
    cells: [
      { x: 4, y: 20 },
      { x: 5, y: 20 },
      { x: 4, y: 21 },
      { x: 5, y: 21 },
    ],
  };

  it('squashes the cells the piece landed on, and nothing else', () => {
    const { effects } = makeEffects();

    effects.observe([{ type: 'hardDrop', kind: 'O', distance: 12 }, lock], createBoard());

    expect(effects.cellSquash(4, 21)).toBeGreaterThan(0);
    expect(effects.cellSquash(5, 20)).toBeGreaterThan(0);
    expect(effects.cellSquash(3, 21)).toBe(0);
  });

  it('springs the squash back out', () => {
    const { effects } = makeEffects();

    effects.observe([{ type: 'hardDrop', kind: 'O', distance: 12 }, lock], createBoard());
    const first = effects.cellSquash(4, 21);
    effects.update(80, 0);
    const later = effects.cellSquash(4, 21);
    effects.update(400, 0);

    expect(later).toBeLessThan(first);
    expect(effects.cellSquash(4, 21)).toBe(0);
  });

  it('kicks up dust', () => {
    const { effects } = makeEffects();

    effects.observe([{ type: 'hardDrop', kind: 'O', distance: 12 }, lock], createBoard());

    expect(effects.particleCount()).toBeGreaterThan(0);
  });

  it('leaves a piece that had nowhere to fall alone', () => {
    const { effects } = makeEffects();

    effects.observe([{ type: 'hardDrop', kind: 'O', distance: 0 }, lock], createBoard());

    expect(effects.particleCount()).toBe(0);
  });

  it('does not squash a piece that merely ran out of lock delay', () => {
    const { effects } = makeEffects();

    effects.observe([lock], createBoard());

    expect(effects.cellSquash(4, 21)).toBe(0);
  });
});

describe('reduced motion', () => {
  it('drops particles and shake entirely', () => {
    const { effects } = makeEffects(true);
    const four = filledRows(4);

    effects.observe([clearEvent(four.rows, true)], four.board);

    expect(effects.particleCount()).toBe(0);
    expect(effects.shake(24)).toBeNull();
  });

  it('still paints something over the rows that scored', () => {
    const still = makeEffects(true);
    const moving = makeEffects(false);
    const one = filledRows(1);

    still.effects.observe([clearEvent(one.rows)], one.board);
    moving.effects.observe([clearEvent(one.rows)], one.board);

    const stillCtx = stubContext();
    const movingCtx = stubContext();
    still.effects.render(stillCtx, fieldView());
    moving.effects.render(movingCtx, fieldView());

    // The row afterimage is the part that survives: filled rectangles are
    // drawn either way, the calm one simply has no shards flying beside them.
    expect(stillCtx.calls.filter((call) => call.startsWith('fillRect')).length).toBeGreaterThan(0);
    expect(movingCtx.calls.filter((call) => call.startsWith('rotate')).length).toBeGreaterThan(0);
    expect(stillCtx.calls.filter((call) => call.startsWith('rotate')).length).toBe(0);
  });

  it('snaps the score counter instead of counting up', () => {
    const { effects } = makeEffects(true);

    effects.update(16, 1200);

    expect(effects.displayScore()).toBe(1200);
  });

  it('counts up when motion is allowed', () => {
    const { effects } = makeEffects(false);

    effects.update(16, 1200);

    expect(effects.displayScore()).toBeGreaterThan(0);
    expect(effects.displayScore()).toBeLessThan(1200);
  });

  it('reacts to the preference changing mid-session', () => {
    const { effects, setReduced } = makeEffects(false);
    const four = filledRows(4);

    effects.observe([clearEvent(four.rows, true)], four.board);
    expect(effects.particleCount()).toBeGreaterThan(0);

    setReduced(true);
    effects.clear();
    effects.observe([clearEvent(four.rows, true)], four.board);

    expect(effects.particleCount()).toBe(0);
    expect(effects.shake(24)).toBeNull();
  });
});

describe('render', () => {
  it('paints a whole quad — flash, shards, popups — and puts the context back', () => {
    const { effects } = makeEffects();
    const four = filledRows(4);

    effects.observe(
      [clearEvent(four.rows, true, true), { type: 'levelUp', level: 3, previousLevel: 2 }],
      four.board,
    );
    effects.update(16, 3200);

    const ctx = stubContext();
    effects.render(ctx, fieldView());

    expect(ctx.calls.filter((call) => call.startsWith('fillText')).length).toBeGreaterThan(0);
    expect(ctx.globalAlpha).toBe(1);
    // Every save is matched: one for the pass, plus one per rotated shard.
    const saves = ctx.calls.filter((call) => call.startsWith('save')).length;
    const restores = ctx.calls.filter((call) => call.startsWith('restore')).length;
    expect(saves).toBe(restores);
  });

  it('draws nothing on a degenerate layout rather than dividing by zero', () => {
    const { effects } = makeEffects();
    const ctx = stubContext();

    effects.render(ctx, {
      ...fieldView(),
      layout: { cell: 0, x: 0, y: 0, width: 0, height: 0 },
    });

    expect(ctx.calls).toHaveLength(0);
  });

  it('sweeps the game-over grey up the field over time', () => {
    const { effects } = makeEffects();

    effects.observe([{ type: 'gameOver', score: 10, lines: 1, level: 1 }], createBoard());

    const early = stubContext();
    effects.update(60, 10);
    effects.render(early, fieldView());

    const late = stubContext();
    effects.update(500, 10);
    effects.render(late, fieldView());

    const rowsAt = (ctx: { calls: string[] }): number =>
      ctx.calls.filter((call) => call.startsWith('fillRect')).length;
    expect(rowsAt(late)).toBeGreaterThan(rowsAt(early));
  });

  it('greys the whole field at once when motion is reduced', () => {
    const { effects } = makeEffects(true);

    effects.observe([{ type: 'gameOver', score: 10, lines: 1, level: 1 }], createBoard());
    const ctx = stubContext();
    effects.update(16, 10);
    effects.render(ctx, fieldView());

    // Twenty visible rows, greyed in the first frame rather than one by one.
    expect(ctx.calls.filter((call) => call.startsWith('fillRect')).length).toBe(20);
  });
});
