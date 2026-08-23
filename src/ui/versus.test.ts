import { describe, expect, it } from 'vitest';

import {
  GARBAGE_DELAY_MS,
  VISIBLE_HEIGHT,
  applyInput,
  createGame,
  pendingGarbage,
  receiveGarbage,
  update,
  winMatch,
  type GameState,
} from '../engine';
import { applyVersus, defaultStats } from './stats';
import {
  DANGER_ROWS,
  IMMINENT_CHARGE,
  METER_SEGMENTS,
  REPLAY_REFUSAL,
  createMatch,
  garbageMeter,
  matchResultCopy,
  meterSegments,
  opponentInDanger,
  opponentMoment,
  opponentSummary,
  versusOverlay,
  versusStartNote,
  versusSummary,
  type MatchResult,
} from './versus';

/** A live Versus game with nothing thrown at it yet. */
function live(seed = 3): GameState {
  return applyInput(createGame({ seed, mode: 'versus' }), { type: 'resume' });
}

/** A live game with `rows` queued against it, `spentMs` into their delay. */
function under(rows: number, spentMs = 0): GameState {
  return update(receiveGarbage(live(), rows), spentMs);
}

describe('the incoming meter', () => {
  it('says nothing at all when nothing is coming', () => {
    const meter = garbageMeter(live());

    expect(meter).toEqual({
      rows: 0,
      imminent: 0,
      charge: 0,
      level: 'clear',
      label: 'Nothing incoming.',
    });
    expect(meterSegments(meter).every((segment) => segment === 'empty')).toBe(true);
  });

  it('counts every queued row, whichever batch it is in', () => {
    // Batches cap at four rows, so six arrives as two — and the meter is about
    // what is coming, not about how it was parcelled up.
    const meter = garbageMeter(under(6));

    expect(meter.rows).toBe(6);
    expect(meter.label).toBe('6 rows incoming.');
  });

  it('charges from nothing to full over the queue delay', () => {
    expect(garbageMeter(under(2)).charge).toBe(0);
    expect(garbageMeter(under(2, GARBAGE_DELAY_MS / 2)).charge).toBeCloseTo(0.5, 5);
    // One millisecond short of landing: the batch is still in the queue.
    expect(garbageMeter(under(2, GARBAGE_DELAY_MS - 1)).charge).toBeGreaterThan(0.99);
  });

  it('switches from queued to imminent, in shape as well as in colour', () => {
    const queued = garbageMeter(under(3));
    const soon = garbageMeter(under(3, GARBAGE_DELAY_MS * (IMMINENT_CHARGE + 0.1)));

    expect(queued.level).toBe('queued');
    expect(soon.level).toBe('imminent');
    // The shape difference is the point: `queued` blocks are inset and
    // `imminent` blocks are notched arrows. The stylesheet reads these.
    expect(meterSegments(queued).slice(0, 3)).toEqual(['queued', 'queued', 'queued']);
    expect(meterSegments(soon).slice(0, 3)).toEqual(['imminent', 'imminent', 'imminent']);
    expect(soon.label).toBe('3 rows incoming, 3 landing now.');
  });

  it('marks only the batch that is actually about to land', () => {
    // The soonest four are arriving; the two behind them are not, and drawing
    // all six as arrows would be a lie a player would act on.
    const first = update(receiveGarbage(live(), 4), GARBAGE_DELAY_MS * 0.9);
    const both = receiveGarbage(first, 2);

    const meter = garbageMeter(both);

    expect(meter.rows).toBe(6);
    expect(meter.imminent).toBe(4);
    expect(meterSegments(meter).slice(0, 6)).toEqual([
      'imminent',
      'imminent',
      'imminent',
      'imminent',
      'queued',
      'queued',
    ]);
  });

  it('keeps the meter to its own length and lets the number carry the rest', () => {
    const meter = garbageMeter(under(METER_SEGMENTS + 8));

    expect(meter.rows).toBe(METER_SEGMENTS + 8);
    expect(meterSegments(meter)).toHaveLength(METER_SEGMENTS);
    expect(meterSegments(meter).every((segment) => segment !== 'empty')).toBe(true);
  });

  it('says one row in the singular, because a meter that says "1 rows" is not finished', () => {
    expect(garbageMeter(under(1)).label).toBe('1 row incoming.');
  });
});

describe('the opponent in words', () => {
  it('is a summary, not a commentary', () => {
    const summary = opponentSummary(live(), 'medium');

    expect(summary).toBe('Quick opponent. Sent 0 rows.');
    // Deliberately silent about the falling piece: it moves sixty times a
    // second and a player cannot act on it.
    expect(summary).not.toMatch(/falling|column|row \d/i);
  });

  it('mentions what is coming and how close the machine is to the top', () => {
    const pressed = { ...under(3), board: stackedTo(DANGER_ROWS) };

    expect(opponentInDanger(pressed)).toBe(true);
    expect(opponentSummary(pressed, 'hard')).toBe(
      'Relentless opponent. Sent 0 rows. Taking 3. Nearly topped out.',
    );
  });

  it('draws the danger line inside the well rather than at the lip of it', () => {
    expect(DANGER_ROWS).toBeLessThan(VISIBLE_HEIGHT);
    expect(opponentInDanger({ ...live(), board: stackedTo(DANGER_ROWS - 1) })).toBe(false);
  });

  it('says so when the machine goes, and stops describing the well', () => {
    const finished = { ...live(), status: 'over' as const };

    expect(opponentSummary(finished, 'easy')).toBe('Steady opponent. Topped out.');
  });

  it('only changes at moments worth rewriting for', () => {
    // The whole reason the opponent does not flood a screen reader: the
    // signature moves on an exchange, not on a frame.
    const before = live();
    const later = update(before, 400);
    expect(opponentMoment(later)).toBe(opponentMoment(before));

    const hit = receiveGarbage(before, 2);
    expect(opponentMoment(hit)).not.toBe(opponentMoment(before));

    const landed = update(hit, GARBAGE_DELAY_MS + 20);
    expect(opponentMoment(landed)).not.toBe(opponentMoment(hit));
  });
});

/** A board with the bottom `rows` rows filled, bar one column. */
function stackedTo(rows: number): GameState['board'] {
  const empty = createGame({ seed: 1 }).board;
  const cells = [...empty.cells];
  for (let y = empty.height - rows; y < empty.height; y += 1) {
    for (let x = 0; x < empty.width; x += 1) {
      if (x !== 0) {
        cells[y * empty.width + x] = 'G';
      }
    }
  }
  return { ...empty, cells };
}

describe('a match', () => {
  it('deals the opponent its own pieces from its own seed', () => {
    const player = createGame({ seed: 11, mode: 'versus' });
    const match = createMatch({ seed: 12, difficulty: 'medium' });

    expect(match.state().mode).toBe('versus');
    expect(match.state().garbageEnabled).toBe(true);
    expect(match.state().next).not.toEqual(player.next);
  });

  it('is deterministic: the same seed pair plays the same match twice', () => {
    const first = playMatch(21, 22, 'medium', 20_000);
    const second = playMatch(21, 22, 'medium', 20_000);

    expect(second.opponent.board.cells).toEqual(first.opponent.board.cells);
    expect(second.opponent.score).toBe(first.opponent.score);
    expect(second.sent).toBe(first.sent);
  });

  it('waits until it is resumed, and stops when it is paused', () => {
    const match = createMatch({ seed: 4, difficulty: 'hard' });

    match.update(1_000);
    expect(match.state().status).toBe('ready');
    expect(match.state().elapsedMs).toBe(0);

    match.resume();
    match.update(1_000);
    expect(match.state().elapsedMs).toBe(1_000);

    match.pause();
    match.update(1_000);
    expect(match.state().elapsedMs).toBe(1_000);
  });

  it('takes what the player sends and queues it like any other attack', () => {
    const match = createMatch({ seed: 4, difficulty: 'hard' });
    match.resume();

    match.attack(4);

    expect(pendingGarbage(match.state().garbageQueue)).toBe(4);
  });

  it('reports what it sent from the running total, not from an event', () => {
    // `stepBot` can apply several inputs in one call and each replaces the
    // snapshot's events, so a clear in the middle of a placement can leave no
    // event behind. `garbageSent` is a total and cannot be missed.
    const played = playMatch(31, 32, 'hard', 60_000);

    expect(played.sent).toBe(played.opponent.garbageSent);
    expect(played.sent).toBeGreaterThan(0);
  });

  it('plays the hard opponent well enough to be worth beating', () => {
    const played = playMatch(41, 42, 'hard', 60_000);

    expect(played.opponent.lines).toBeGreaterThan(20);
    expect(played.opponent.status).toBe('playing');
  });

  it('stops for good once its well goes', () => {
    const match = createMatch({ seed: 5, difficulty: 'easy' });
    match.resume();
    // Gravity alone with nobody playing tops a well out inside two minutes.
    let toppedOut = false;
    for (let frame = 0; frame < 60_000 && !toppedOut; frame += 1) {
      toppedOut = match.update(16).toppedOut;
      match.attack(4);
    }

    expect(toppedOut).toBe(true);
    expect(match.finished()).toBe(true);
    expect(match.state().status).toBe('over');
    // And nothing moves afterwards, however long the loop keeps running.
    const settled = match.state();
    match.update(5_000);
    expect(match.state()).toBe(settled);
  });
});

/**
 * A whole match, driven the way `src/main.ts` drives one: both games on the
 * same delta, the player's attacks crossing in `setState` and the opponent's on
 * the way back out of `update`.
 */
function playMatch(
  playerSeed: number,
  opponentSeed: number,
  difficulty: 'easy' | 'medium' | 'hard',
  durationMs: number,
): { player: GameState; opponent: GameState; sent: number; received: number } {
  let player = applyInput(createGame({ seed: playerSeed, mode: 'versus' }), { type: 'resume' });
  const match = createMatch({ seed: opponentSeed, difficulty });
  match.resume();

  let received = 0;
  for (let elapsed = 0; elapsed < durationMs; elapsed += 16) {
    const before = player.garbageSent;
    player = update(player, 16);
    if (player.garbageSent > before) {
      match.attack(player.garbageSent - before);
    }
    const step = match.update(16);
    if (step.incoming > 0) {
      received += step.incoming;
      player = receiveGarbage(player, step.incoming);
    }
    if (step.toppedOut && player.status === 'playing') {
      player = winMatch(player);
    }
    if (player.status !== 'playing') {
      match.stop();
      break;
    }
  }
  return { player, opponent: match.state(), sent: match.sent(), received };
}

describe('the result screen', () => {
  const won: MatchResult = {
    difficulty: 'hard',
    won: true,
    sent: 24,
    received: 17,
    durationMs: 192_000,
  };

  it('names the winner and says why, with both halves of the exchange', () => {
    const copy = matchResultCopy(won, applyVersus(defaultStats(), versusSummary(won)));

    expect(copy.title).toBe('You win');
    expect(copy.hint).toBe('Relentless topped out after 3:12.');
    expect(copy.line).toBe('Garbage sent — you 24 rows, Relentless 17 rows.');
  });

  it('says who won when it was not you, and does not pretend otherwise', () => {
    const lost: MatchResult = { ...won, won: false, sent: 3, received: 26 };

    const copy = matchResultCopy(lost, applyVersus(defaultStats(), versusSummary(lost)));

    expect(copy.title).toBe('Relentless wins');
    expect(copy.hint).toBe('You topped out after 3:12, and Relentless was still standing.');
    expect(copy.line).toBe('Garbage sent — you 3 rows, Relentless 26 rows.');
  });

  it('carries the record the match has just changed', () => {
    const update = applyVersus(defaultStats(), versusSummary(won));

    const copy = matchResultCopy(won, update);

    expect(copy.note).toContain('Relentless: 1 win, 0 losses.');
    expect(copy.note).toContain('Best win sent 24 rows.');
    expect(copy.note).toContain('Your best attack yet in a win.');
  });

  /**
   * The refusal, and why it is a refusal.
   *
   * A tape is the player's keys against a seed. That is the whole of a solo run
   * and nowhere near the whole of a match: the opponent's attacks land on this
   * clock at moments no tape records. A link that plays back the wrong match is
   * worse than no link, so the panel says so and offers nothing.
   */
  it('refuses a replay link in words rather than quietly not offering one', () => {
    const copy = matchResultCopy(won, applyVersus(defaultStats(), versusSummary(won)));

    expect(copy.note).toContain(REPLAY_REFUSAL);
    expect(REPLAY_REFUSAL).toMatch(/replay/i);
    expect(REPLAY_REFUSAL).toMatch(/opponent/i);
  });

  it('reads honestly with one win and one row', () => {
    const thin: MatchResult = { ...won, sent: 1, received: 1, durationMs: 61_000 };

    const copy = matchResultCopy(thin, applyVersus(defaultStats(), versusSummary(thin)));

    expect(copy.line).toBe('Garbage sent — you 1 row, Relentless 1 row.');
  });
});

describe('the start screen’s record', () => {
  it('says nothing before the first match against an opponent', () => {
    expect(versusStartNote(defaultStats(), 'easy')).toBeNull();
    expect(versusOverlay(defaultStats(), 'easy', null)).toEqual({ startNote: null, result: null });
  });

  it('reads back wins and losses against the opponent that was chosen', () => {
    const after = applyVersus(defaultStats(), {
      difficulty: 'medium',
      won: true,
      sent: 12,
    }).stats;
    const both = applyVersus(after, { difficulty: 'medium', won: false, sent: 4 }).stats;

    expect(versusStartNote(both, 'medium')).toBe('Quick: 1 win, 1 loss. Best win sent 12 rows.');
    // And says nothing about the other two, which have not been played.
    expect(versusStartNote(both, 'hard')).toBeNull();
  });
});
