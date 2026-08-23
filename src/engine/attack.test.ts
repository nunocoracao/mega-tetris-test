import { describe, expect, it } from 'vitest';

import {
  attackLines,
  attackTable,
  comboAttackLines,
  ATTACK_LINES,
  BACK_TO_BACK_ATTACK_BONUS,
  COMBO_ATTACK_LINES,
  KICKED_SPIN_ATTACK_LINES,
  SPIN_ATTACK_LINES,
  type ClearSignals,
} from './attack';
import { applyInput, createGame, update, type GameEvent, type GameState } from './game';
import {
  boardFromStrings,
  boardToStrings,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  type Board,
} from './board';
import type { SpinKind } from './game';

const plain: ClearSignals = { count: 0, spin: 'none', combo: 0, backToBack: false };

describe('the tables themselves', () => {
  it('pays nothing for a clear that took no rows', () => {
    for (const table of [ATTACK_LINES, SPIN_ATTACK_LINES, KICKED_SPIN_ATTACK_LINES]) {
      expect(table[0]).toBe(0);
    }
  });

  it('sends nothing for a single — the rule the rest of it hangs off', () => {
    expect(ATTACK_LINES[1]).toBe(0);
  });

  it('climbs with every extra row', () => {
    for (const table of [ATTACK_LINES, SPIN_ATTACK_LINES, KICKED_SPIN_ATTACK_LINES]) {
      for (let count = 2; count <= 4; count += 1) {
        expect(table[count] ?? 0).toBeGreaterThan(table[count - 1] ?? 0);
      }
    }
  });

  it('pays a spin more than the flat clear of the same size', () => {
    for (let count = 1; count <= 4; count += 1) {
      expect(SPIN_ATTACK_LINES[count] ?? 0).toBeGreaterThan(ATTACK_LINES[count] ?? 0);
      expect(KICKED_SPIN_ATTACK_LINES[count] ?? 0).toBeGreaterThanOrEqual(ATTACK_LINES[count] ?? 0);
    }
  });

  it('pays a kicked spin less than a clean one', () => {
    for (let count = 1; count <= 4; count += 1) {
      expect(KICKED_SPIN_ATTACK_LINES[count] ?? 0).toBeLessThan(SPIN_ATTACK_LINES[count] ?? 0);
    }
  });

  it('picks the table from the kind of spin', () => {
    const tables: Record<SpinKind, Readonly<Record<number, number>>> = {
      none: ATTACK_LINES,
      full: SPIN_ATTACK_LINES,
      kick: KICKED_SPIN_ATTACK_LINES,
    };
    for (const [spin, table] of Object.entries(tables)) {
      expect(attackTable(spin as SpinKind)).toBe(table);
    }
  });

  it('never lets the combo tail go backwards', () => {
    for (let i = 1; i < COMBO_ATTACK_LINES.length; i += 1) {
      expect(COMBO_ATTACK_LINES[i] ?? 0).toBeGreaterThanOrEqual(COMBO_ATTACK_LINES[i - 1] ?? 0);
    }
  });
});

describe('comboAttackLines', () => {
  it('pays nothing until a combo is actually a combo', () => {
    expect(comboAttackLines(0)).toBe(0);
    expect(comboAttackLines(1)).toBe(0);
    expect(comboAttackLines(2)).toBe(COMBO_ATTACK_LINES[2]);
  });

  it('settles at the end of the table rather than running off it', () => {
    const last = COMBO_ATTACK_LINES[COMBO_ATTACK_LINES.length - 1];
    expect(comboAttackLines(200)).toBe(last);
  });
});

describe('attackLines', () => {
  it('is zero for a lock that cleared nothing, however clever', () => {
    expect(attackLines({ ...plain, spin: 'full', combo: 9, backToBack: true })).toBe(0);
  });

  it('is the row table on its own for a first, plain clear', () => {
    for (let count = 1; count <= 4; count += 1) {
      expect(attackLines({ ...plain, count, combo: 1 })).toBe(ATTACK_LINES[count]);
    }
  });

  it('adds the combo tail', () => {
    expect(attackLines({ ...plain, count: 2, combo: 5 })).toBe(
      (ATTACK_LINES[2] ?? 0) + (COMBO_ATTACK_LINES[5] ?? 0),
    );
  });

  it('adds a flat line for a back-to-back', () => {
    const chained = attackLines({ ...plain, count: 4, combo: 1, backToBack: true });
    const first = attackLines({ ...plain, count: 4, combo: 1, backToBack: false });
    expect(chained - first).toBe(BACK_TO_BACK_ATTACK_BONUS);
  });

  it('cannot turn a single into an attack on the strength of a combo alone', () => {
    expect(attackLines({ ...plain, count: 1, combo: 2 })).toBeLessThan(
      attackLines({ ...plain, count: 4, combo: 1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Driven by the game, off the same signals the score is
// ---------------------------------------------------------------------------

const GAP_COLUMN = 3;

function boardWithFloor(rows: number): Board {
  const empty = '.'.repeat(BOARD_WIDTH);
  const almost = Array.from({ length: BOARD_WIDTH }, (_, x) => (x === GAP_COLUMN ? '.' : 'J')).join('');
  return boardFromStrings(
    Array.from({ length: BOARD_HEIGHT }, (_, y) => (y >= BOARD_HEIGHT - rows ? almost : empty)),
  );
}

function versus(seed = 7): GameState {
  return applyInput(createGame({ seed, garbage: {} }), { type: 'resume' });
}

function attackEvents(state: GameState): Extract<GameEvent, { type: 'attack' }>[] {
  return state.events.filter(
    (event): event is Extract<GameEvent, { type: 'attack' }> => event.type === 'attack',
  );
}

/** Slam a vertical `I` into the gap of a floor `rows` deep. */
function clearRowsWithI(state: GameState, rows: number): GameState {
  return applyInput(
    {
      ...state,
      board: boardWithFloor(rows),
      active: { kind: 'I', rotation: 1, x: GAP_COLUMN - 2, y: BOARD_HEIGHT - 4 },
    },
    { type: 'hardDrop' },
  );
}

describe('a clear in a running versus game', () => {
  it('sends exactly what the table says, reading the engine’s own signals', () => {
    for (let rows = 1; rows <= 4; rows += 1) {
      const state = clearRowsWithI(versus(), rows);
      expect(state.garbageSent).toBe(ATTACK_LINES[rows]);
    }
  });

  it('takes the back-to-back bonus the second time round', () => {
    let state = clearRowsWithI(versus(), 4);
    const first = state.garbageSent;
    expect(state.backToBack).toBe(true);

    state = update(state, 400);
    state = clearRowsWithI(state, 4);
    const second = state.garbageSent - first;
    expect(second).toBeGreaterThan(first);
    expect(attackEvents(state)[0]?.lines).toBe(second);
  });

  it('grows with a combo without either of them being recomputed here', () => {
    // Two clears back to back: the second is combo 2, so it carries the tail.
    let state = clearRowsWithI(versus(), 2);
    const first = state.garbageSent;
    state = update(state, 400);
    state = clearRowsWithI(state, 2);
    expect(state.combo).toBe(2);
    expect(state.garbageSent - first).toBe(first + (COMBO_ATTACK_LINES[2] ?? 0));
  });

  it('leaves the board it cleared exactly as a solo run would', () => {
    const soloRun = applyInput(createGame({ seed: 7 }), { type: 'resume' });
    const solo = clearRowsWithI(soloRun, 3);
    const fight = clearRowsWithI(versus(), 3);
    expect(boardToStrings(fight.board)).toEqual(boardToStrings(solo.board));
    expect(fight.score).toBe(solo.score);
  });
});
