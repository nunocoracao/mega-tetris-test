/**
 * The delight layer.
 *
 * The engine is deterministic and presentation-free: it says *what* happened
 * through `GameEvent`s and nothing about how it should feel. This module is the
 * other half of that bargain — it consumes those events and turns them into
 * flashes, shards, dust, popups and a shake, advanced by the same frame delta
 * the engine gets. Not one line of it belongs in `src/engine`.
 *
 * Three decisions shape the whole file.
 *
 * **Everything is measured in cells, not pixels.** A particle's position and
 * velocity are board coordinates (fractional rows and columns) and its size is
 * a fraction of a cell. That is what makes a burst look identical on a 320px
 * phone and a 1440px desktop, and what lets the canvas resize mid-burst without
 * the effect tearing.
 *
 * **Nothing is allocated per frame.** Particles, popups and row flashes live in
 * fixed-size pools built once at construction and mutated in place; a burst
 * that would overflow its pool is capped, not grown. `render` sets
 * `globalAlpha` and reuses the palette's colour strings rather than building
 * `rgba(...)` on the fly. A quad clear allocates nothing.
 *
 * **Reduced motion is checked at spawn, not at construction.** The caller hands
 * in a `reducedMotion()` predicate that it is free to change its mind about
 * mid-session; every effect asks it as it is created and takes a still,
 * instant variant instead — a held highlight rather than a fade, a jump rather
 * than a count-up, no particles and no shake at all.
 *
 * The one import that looks out of place is `./hud`: the floating labels say
 * "T-SPIN DOUBLE" and "COMBO ×4", and those words are copy. Copy has one home
 * in this project, and it is the HUD — a popup and a live-region sentence
 * disagreeing about what just happened would be worse than either.
 */

import {
  PIECE_KINDS,
  boxSize,
  cellAt,
  getCells,
  type Board,
  type Cell,
  type GameEvent,
  type PieceKind,
  type Point,
} from '../engine';
import { clearName, comboName, spinName } from './hud';
import { getPalette, withAlpha, type BlockKey } from './palette';
import type { FieldView } from './renderer';

/** The clear event, named once so `spawnClear` can take the whole thing. */
type RowsClearedEvent = Extract<GameEvent, { type: 'rowsCleared' }>;

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Ceiling on live particles. A quad clears 40 cells; at four shards each that
 * is 160, which is the number this pool is sized for. Past it, bursts are
 * capped rather than dropped — the effect degrades in density, never in kind.
 */
export const PARTICLE_CAPACITY = 168;

/** Shards per cleared cell. A quad earns more of them as well as bigger ones. */
const SHARDS_PER_CELL = 3;
const SHARDS_PER_CELL_QUAD = 4;

/** Shard lifetime, plus the jitter that stops the burst dying all at once. */
const SHARD_LIFE_MS = 560;
const SHARD_LIFE_JITTER_MS = 320;

/** Shard launch speed and gravity, in cells per second (and per second²). */
const SHARD_SPEED = 6.5;
const SHARD_SPEED_QUAD = 9;
const SHARD_GRAVITY = 30;

/** Shard side, as a fraction of a cell. */
const SHARD_SIZE = 0.17;
const SHARD_SIZE_JITTER = 0.13;

/** How many row flashes can overlap. Two clears 250ms apart is the realistic max. */
const FLASH_CAPACITY = 3;


/** How long a cleared row stays visible after it has gone. */
const FLASH_MS = 240;
const FLASH_MS_QUAD = 380;

/** A held, motionless highlight — what a line clear looks like with motion off. */
const FLASH_MS_STILL = 220;

/**
 * How white the row goes at the peak of its flash.
 *
 * The still variant is much gentler on purpose. A moving flash is over in a
 * fifth of a second and the eye reads the *event*; a held one sits there long
 * enough that the eye reads the *rows*, and blowing them out to near-white
 * would lose the colours that say which rows those were.
 */
const FLASH_WASH = 0.6;
const FLASH_WASH_QUAD = 0.85;
const FLASH_WASH_STILL = 0.32;

/** Floating score labels alive at once: up to three per clear (the points, the
 *  name and the combo), and clears can overlap. */
const POPUP_CAPACITY = 9;

const POPUP_MS = 900;
const POPUP_MS_STILL = 700;

/** How far a popup rises over its life, in cells. */
const POPUP_RISE_CELLS = 2.2;

/**
 * Screen shake: how hard, and for how long.
 *
 * Shaken by the clears that earned it — a quad, a spin clear, or a combo that
 * has run long enough to be worth noticing — and by nothing else. Each step of
 * a back-to-back chain or a long combo leans on the amplitude a little harder,
 * up to a ceiling, so a run of them builds rather than repeating.
 */
const SHAKE_MS = 260;
const SHAKE_AMPLITUDE_CELLS = 0.22;
const SHAKE_AMPLITUDE_CELLS_B2B = 0.34;

/** How long a combo has to run before it shakes the cabinet on its own. */
const COMBO_SHAKE_FROM = 3;

/** Extra amplitude per chain step past the first, and where that stops. */
const CHAIN_AMPLITUDE_STEP = 0.04;
const SHAKE_AMPLITUDE_MAX = 0.5;

/** Shards a spin that cleared nothing throws off the piece it just placed. */
const SPIN_SHARDS_PER_CELL = 3;
const SPIN_SHARD_SPEED = 5;

/** The hard-drop streak behind the piece, and the dust it kicks up on landing. */
const TRAIL_MS = 220;
const DUST_PER_COLUMN = 2;
const DUST_LIFE_MS = 340;
const DUST_SPEED = 4;

/** How deep the landing cells squash, and how quickly they spring back. */
const SQUASH_DEPTH = 0.22;
const SQUASH_MS = 170;

/** The level-up banner. Under a second, as the brief asks. */
const BANNER_MS = 850;
const BANNER_MS_STILL = 700;

/** Milliseconds per row of the game-over sweep, counting up from the floor. */
export const GAME_OVER_ROW_MS = 24;

/** How long the score count-up takes, however big the jump. */
export const COUNT_UP_MS = 340;

// -- attract mode -----------------------------------------------------------
//
// The pieces drifting behind the start screen. This is the one effect measured
// in *fractions of the field* rather than in cells, because it is wallpaper
// rather than something happening at a board position: a shape a third of the
// way across belongs a third of the way across at any size.

/** How many drift at once. Few, so the panel over them stays the subject. */
const ATTRACT_COUNT = 7;

/** Field heights per second. A piece takes the best part of a minute to rise. */
const ATTRACT_SPEED = 0.024;
const ATTRACT_SPEED_JITTER = 0.018;

/** Turns per second, in either direction. Slow enough to read as drifting. */
const ATTRACT_SPIN = 0.03;

/** How present they are. Wallpaper, not competition for the Play button. */
const ATTRACT_ALPHA = 0.32;

/** Block side as a fraction of a cell — smaller than a real one, so a drifting
 *  shape never reads as a piece in play. */
const ATTRACT_SCALE = 0.6;

/** No web fonts in this project, so the canvas borrows the same stacks the CSS uses. */
const DISPLAY_FONT = "'Avenir Next', 'Segoe UI', system-ui, sans-serif";
const NUMERIC_FONT = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

// ---------------------------------------------------------------------------
// The score count-up (pure, and separately testable)
// ---------------------------------------------------------------------------

export interface Counter {
  /** The number to put on screen right now. Always a whole number. */
  value(): number;
  target(): number;
  /** Aim at a new number. Going *down* snaps, because that is a new game. */
  set(target: number): void;
  update(deltaMs: number): void;
  /** Arrive immediately — what reduced motion asks for. */
  snap(): void;
}

/**
 * A number that walks to its target over `durationMs` instead of jumping.
 *
 * Linear, and re-based whenever the target moves, so a clear during a count-up
 * neither stalls the counter nor makes it sprint: it always has the same amount
 * of time left to cover whatever is left to cover.
 */
export function createCounter(durationMs: number = COUNT_UP_MS): Counter {
  let current = 0;
  let goal = 0;
  let rate = 0;

  return {
    value: () => Math.round(current),
    target: () => goal,
    set(target: number): void {
      goal = target;
      if (target <= current) {
        current = target;
        rate = 0;
        return;
      }
      rate = (target - current) / Math.max(1, durationMs);
    },
    update(deltaMs: number): void {
      if (current >= goal || !(deltaMs > 0)) {
        return;
      }
      current = Math.min(goal, current + rate * deltaMs);
    },
    snap(): void {
      current = goal;
      rate = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Pooled records
// ---------------------------------------------------------------------------

/**
 * One piece drifting behind the start screen.
 *
 * The only effect whose position is a *fraction of the field* rather than a
 * board cell: it is wallpaper, not something happening at a coordinate, so it
 * should sit a third of the way across whatever size the well happens to be.
 */
interface AttractPiece {
  kind: PieceKind;
  /** 0..1 across the field, and 0..1 down it — `y` runs off both ends. */
  x: number;
  y: number;
  angle: number;
  /** Field heights per second, upwards. */
  speed: number;
  /** Turns per second, signed. */
  spin: number;
}

interface Shard {
  active: boolean;
  /** Board coordinates, in cells. Fractional, and `y` may be off the field. */
  x: number;
  y: number;
  /** Cells per second. */
  vx: number;
  vy: number;
  ageMs: number;
  lifeMs: number;
  /** Side, as a fraction of a cell. */
  size: number;
  angle: number;
  /** Radians per second. */
  spin: number;
  kind: BlockKey;
}

interface Flash {
  active: boolean;
  ageMs: number;
  lifeMs: number;
  /** Board rows, as they were before the collapse. */
  rows: number[];
  rowCount: number;
  boardWidth: number;
  /** `rowCount * boardWidth` cells, row-major, as they were before the clear. */
  kinds: Cell[];
  big: boolean;
  /** Hold at full strength and vanish, rather than fading. */
  still: boolean;
}

interface Popup {
  active: boolean;
  ageMs: number;
  lifeMs: number;
  /** Board coordinates of the label's centre, in cells. */
  x: number;
  y: number;
  text: string;
  big: boolean;
  still: boolean;
}

/** Four cells is a piece; the squash never covers more than one. */
const SQUASH_CELLS = 4;

/** What the `lock` event told us, kept until the `rowsCleared` that may follow. */
interface LockRecord {
  readonly kind: PieceKind;
  readonly cells: readonly Point[];
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** A shake displacement in device pixels. */
export interface Offset {
  readonly x: number;
  readonly y: number;
}

export interface EffectsOptions {
  /**
   * Whether movement should be suppressed *right now*. Asked on every spawn,
   * so the caller can change its answer at any time.
   */
  readonly reducedMotion: () => boolean;
  /** Injected so tests get a deterministic burst. Defaults to `Math.random`. */
  readonly random?: () => number;
}

export interface Effects {
  /**
   * Consume one snapshot's events.
   *
   * `previousBoard` is the board as it stood *before* them, which is the only
   * way to recover the colours of a row the engine has already collapsed: the
   * `lock` event says which cells the piece added, and everything else was
   * already there.
   */
  observe(events: readonly GameEvent[], previousBoard: Board): void;
  /** Advance every live effect. `score` is what the HUD counter chases. */
  update(deltaMs: number, score: number): void;
  /** Paint over the field. Wired to the board renderer's `decorate` hook. */
  render(ctx: CanvasRenderingContext2D, view: FieldView): void;
  /**
   * The field's shake displacement in device pixels, or `null` when still.
   * The same object is handed back every call — read it, do not keep it.
   */
  shake(cell: number): Offset | null;
  /** How far the block at `(x, y)` is squashed toward its floor, 0..1. */
  cellSquash(x: number, y: number): number;
  /** The score to show in the HUD, which trails the real one briefly. */
  displayScore(): number;
  /**
   * Turn the start screen's drifting pieces on or off.
   *
   * Idempotent, and honoured only while movement is wanted: a player who has
   * asked for reduced motion gets a still well behind the panel, which is the
   * whole point of asking.
   */
  setAttract(on: boolean): void;
  /** Drop everything in flight — a new game, or motion being switched off. */
  clear(): void;
  /** Live particle count. For the tests and for the performance note. */
  particleCount(): number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createEffects(options: EffectsOptions): Effects {
  const random = options.random ?? Math.random;
  const counter = createCounter();

  // -- pools, built once ----------------------------------------------------

  const shards: Shard[] = [];
  for (let index = 0; index < PARTICLE_CAPACITY; index += 1) {
    shards.push({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      ageMs: 0,
      lifeMs: 1,
      size: SHARD_SIZE,
      angle: 0,
      spin: 0,
      kind: 'I',
    });
  }
  /** Where the last search for a free shard stopped, so bursts do not rescan. */
  let shardCursor = 0;

  const flashes: Flash[] = [];
  for (let index = 0; index < FLASH_CAPACITY; index += 1) {
    flashes.push({
      active: false,
      ageMs: 0,
      lifeMs: 1,
      rows: [0, 0, 0, 0],
      rowCount: 0,
      boardWidth: 0,
      // Four rows of a board wider than any we ship, so a clear never allocates.
      kinds: new Array<Cell>(4 * 16).fill(null),
      big: false,
      still: false,
    });
  }

  const popups: Popup[] = [];
  for (let index = 0; index < POPUP_CAPACITY; index += 1) {
    popups.push({
      active: false,
      ageMs: 0,
      lifeMs: 1,
      x: 0,
      y: 0,
      text: '',
      big: false,
      still: false,
    });
  }

  // -- single-instance effects ---------------------------------------------

  let shakeAgeMs = 0;
  let shakeLifeMs = 0;
  let shakeAmplitude = 0;
  const shakeOffset = { x: 0, y: 0 };

  let trailAgeMs = 0;
  let trailLifeMs = 0;
  let trailMinX = 0;
  let trailMaxX = 0;
  let trailTopY = 0;
  let trailBottomY = 0;
  let trailKind: PieceKind = 'I';

  let squashAgeMs = 0;
  let squashLifeMs = 0;
  let squashCount = 0;
  const squashX = new Int16Array(SQUASH_CELLS);
  const squashY = new Int16Array(SQUASH_CELLS);

  let bannerAgeMs = 0;
  let bannerLifeMs = 0;
  let bannerStill = false;
  let bannerLevel = 0;

  let sweepAgeMs = 0;
  let sweepActive = false;

  // -- spawning -------------------------------------------------------------

  function calm(): boolean {
    return options.reducedMotion();
  }

  /** Take a free shard, or `null` when the pool is full — the cap, in one place. */
  function takeShard(): Shard | null {
    for (let tries = 0; tries < PARTICLE_CAPACITY; tries += 1) {
      const shard = shards[shardCursor];
      shardCursor = (shardCursor + 1) % PARTICLE_CAPACITY;
      if (shard !== undefined && !shard.active) {
        return shard;
      }
    }
    return null;
  }

  function takeFlash(): Flash | null {
    let oldest: Flash | null = null;
    for (const flash of flashes) {
      if (!flash.active) {
        return flash;
      }
      if (oldest === null || flash.ageMs > oldest.ageMs) {
        oldest = flash;
      }
    }
    // Every slot is busy: the oldest is the one closest to being over anyway.
    return oldest;
  }

  function takePopup(): Popup | null {
    let oldest: Popup | null = null;
    for (const popup of popups) {
      if (!popup.active) {
        return popup;
      }
      if (oldest === null || popup.ageMs > oldest.ageMs) {
        oldest = popup;
      }
    }
    return oldest;
  }

  /** A shard thrown from the centre of cell `(x, y)`. */
  function spawnShard(x: number, y: number, kind: BlockKey, speed: number, lifeMs: number): void {
    const shard = takeShard();
    if (shard === null) {
      return;
    }
    // Biased upward: debris from a collapsing row is thrown up, then falls.
    const angle = random() * Math.PI * 2;
    const power = speed * (0.35 + random() * 0.65);
    shard.active = true;
    shard.x = x + 0.5 + (random() - 0.5) * 0.7;
    shard.y = y + 0.5 + (random() - 0.5) * 0.7;
    shard.vx = Math.cos(angle) * power;
    shard.vy = Math.sin(angle) * power - speed * 0.45;
    shard.ageMs = 0;
    shard.lifeMs = lifeMs;
    shard.size = SHARD_SIZE + random() * SHARD_SIZE_JITTER;
    shard.angle = random() * Math.PI;
    shard.spin = (random() - 0.5) * 9;
    shard.kind = kind;
  }

  function spawnPopup(x: number, y: number, text: string, big: boolean): void {
    const popup = takePopup();
    if (popup === null) {
      return;
    }
    const still = calm();
    popup.active = true;
    popup.ageMs = 0;
    popup.lifeMs = still ? POPUP_MS_STILL : POPUP_MS;
    popup.x = x;
    popup.y = y;
    popup.text = text;
    popup.big = big;
    popup.still = still;
  }

  /**
   * The colour a cell had before this batch of events.
   *
   * The engine collapses cleared rows the instant the piece locks, so by the
   * time we see the `rowsCleared` event the board no longer contains them. The
   * previous board plus the cells the `lock` event just added is exactly the
   * board that was full, and that is what we read the shard colours out of.
   */
  function kindBefore(board: Board, lock: LockRecord | null, x: number, y: number): Cell {
    if (lock !== null) {
      for (const cell of lock.cells) {
        if (cell.x === x && cell.y === y) {
          return lock.kind;
        }
      }
    }
    return cellAt(board, x, y);
  }

  function spawnClear(board: Board, lock: LockRecord | null, event: RowsClearedEvent): void {
    const still = calm();
    const { rows, points } = event;
    /**
     * "Big" is the clear that deserves the loud version of every effect: a
     * quad, or a spin clear. Both are the hard way to take rows out, and the
     * shard count, the flash and the shake all read off this one flag rather
     * than each re-deciding what counts as impressive.
     */
    const big = event.quad || event.spin !== 'none';
    /** How many steps of "keep it going" this clear is riding on. */
    const chain = Math.max(event.backToBackChain, event.combo);

    // The row afterimage: the blocks that went, kept for a moment where they
    // were. This is the part that survives reduced motion, held rather than
    // faded, because it is what actually says *which* rows scored.
    const flash = takeFlash();
    if (flash !== null) {
      flash.active = true;
      flash.ageMs = 0;
      flash.lifeMs = still ? FLASH_MS_STILL : big ? FLASH_MS_QUAD : FLASH_MS;
      flash.rowCount = Math.min(rows.length, 4);
      flash.boardWidth = Math.min(board.width, 16);
      flash.big = big;
      flash.still = still;
      for (let index = 0; index < flash.rowCount; index += 1) {
        const row = rows[index] ?? 0;
        flash.rows[index] = row;
        for (let x = 0; x < flash.boardWidth; x += 1) {
          flash.kinds[index * flash.boardWidth + x] = kindBefore(board, lock, x, row);
        }
      }
    }

    if (!still) {
      const perCell = big ? SHARDS_PER_CELL_QUAD : SHARDS_PER_CELL;
      const speed = big ? SHARD_SPEED_QUAD : SHARD_SPEED;
      for (let index = 0; index < Math.min(rows.length, 4); index += 1) {
        const row = rows[index];
        if (row === undefined) {
          continue;
        }
        for (let x = 0; x < board.width; x += 1) {
          const kind = kindBefore(board, lock, x, row);
          if (kind === null) {
            continue;
          }
          for (let shard = 0; shard < perCell; shard += 1) {
            spawnShard(x, row, kind, speed, SHARD_LIFE_MS + random() * SHARD_LIFE_JITTER_MS);
          }
        }
      }

      if (big || event.combo >= COMBO_SHAKE_FROM) {
        shakeAgeMs = 0;
        shakeLifeMs = SHAKE_MS;
        const base = event.backToBack ? SHAKE_AMPLITUDE_CELLS_B2B : SHAKE_AMPLITUDE_CELLS;
        shakeAmplitude = Math.min(
          SHAKE_AMPLITUDE_MAX,
          base + Math.max(0, chain - 1) * CHAIN_AMPLITUDE_STEP,
        );
      }
    }

    // Where the clear happened, so the label rises out of it.
    let rowSum = 0;
    for (const row of rows) {
      rowSum += row;
    }
    const centreY = rows.length > 0 ? rowSum / rows.length : board.height / 2;
    const centreX = board.width / 2;

    spawnPopup(centreX, centreY, `+${points}`, big);
    // The name of the clear, straight from the HUD's copy — a quad, a spin or
    // a back-to-back is worth reading, a plain single is not.
    if (big || event.backToBack) {
      spawnPopup(centreX, centreY - 1.4, clearName(event).toUpperCase(), true);
    }
    if (event.combo > 1) {
      spawnPopup(centreX, centreY + 1.4, comboName(event.combo).toUpperCase(), event.combo >= COMBO_SHAKE_FROM);
    }
  }

  /**
   * A spin that cleared nothing: a small puff off the piece that just went in,
   * and the flat bonus floating up out of it. Deliberately quieter than a
   * clear — nothing came out of the well — but not silent, because setting one
   * up is the move the scoring is trying to reward.
   */
  function spawnSpin(kind: PieceKind, cells: readonly Point[], points: number): void {
    let sumX = 0;
    let sumY = 0;
    for (const cell of cells) {
      sumX += cell.x;
      sumY += cell.y;
    }
    const count = Math.max(1, cells.length);

    if (!calm()) {
      for (const cell of cells) {
        for (let index = 0; index < SPIN_SHARDS_PER_CELL; index += 1) {
          spawnShard(cell.x, cell.y, kind, SPIN_SHARD_SPEED, SHARD_LIFE_MS);
        }
      }
    }
    spawnPopup(sumX / count + 0.5, sumY / count, `+${points}`, false);
    spawnPopup(sumX / count + 0.5, sumY / count - 1.4, spinName(kind).toUpperCase(), true);
  }

  function spawnHardDrop(lock: LockRecord, distance: number): void {
    const still = calm();

    // The squash is a shape change, not a movement, and it reads as the piece
    // hitting the floor — so it survives reduced motion, just instantly.
    squashCount = 0;
    for (const cell of lock.cells) {
      if (squashCount >= SQUASH_CELLS) {
        break;
      }
      squashX[squashCount] = cell.x;
      squashY[squashCount] = cell.y;
      squashCount += 1;
    }
    squashAgeMs = 0;
    squashLifeMs = still ? 0 : SQUASH_MS;

    if (still || distance < 1) {
      return;
    }

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const cell of lock.cells) {
      minX = Math.min(minX, cell.x);
      maxX = Math.max(maxX, cell.x);
      maxY = Math.max(maxY, cell.y);
    }

    trailAgeMs = 0;
    trailLifeMs = TRAIL_MS;
    trailMinX = minX;
    trailMaxX = maxX + 1;
    trailTopY = maxY - distance;
    trailBottomY = maxY + 1;
    trailKind = lock.kind;

    // Dust along the landing edge, thrown outward and low.
    for (let x = minX; x <= maxX; x += 1) {
      for (let index = 0; index < DUST_PER_COLUMN; index += 1) {
        const shard = takeShard();
        if (shard === null) {
          return;
        }
        const outward = x < (minX + maxX) / 2 ? -1 : 1;
        shard.active = true;
        shard.x = x + 0.5;
        shard.y = maxY + 0.9;
        shard.vx = outward * DUST_SPEED * (0.4 + random() * 0.8);
        shard.vy = -DUST_SPEED * (0.15 + random() * 0.35);
        shard.ageMs = 0;
        shard.lifeMs = DUST_LIFE_MS * (0.7 + random() * 0.6);
        shard.size = SHARD_SIZE * 0.8;
        shard.angle = random() * Math.PI;
        shard.spin = (random() - 0.5) * 4;
        shard.kind = lock.kind;
      }
    }
  }

  // -- the event tap --------------------------------------------------------

  function observe(events: readonly GameEvent[], previousBoard: Board): void {
    let lock: LockRecord | null = null;
    let pendingDrop: number | null = null;

    for (const event of events) {
      switch (event.type) {
        case 'hardDrop':
          pendingDrop = event.distance;
          break;

        case 'lock':
          lock = { kind: event.kind, cells: event.cells };
          if (pendingDrop !== null) {
            spawnHardDrop(lock, pendingDrop);
            pendingDrop = null;
          }
          break;

        case 'spin':
          // A spin that cleared rows gets the clear's celebration instead; two
          // bursts out of one lock is noise, not emphasis.
          if (event.cleared === 0) {
            spawnSpin(event.kind, event.cells, event.points);
          }
          break;

        case 'rowsCleared':
          spawnClear(previousBoard, lock, event);
          break;

        case 'levelUp':
          bannerAgeMs = 0;
          bannerStill = calm();
          bannerLifeMs = bannerStill ? BANNER_MS_STILL : BANNER_MS;
          bannerLevel = event.level;
          break;

        // However a run ended, the field settles the same way: the stack greys
        // out from the floor up and the panel arrives behind it. What it *says*
        // is the panel's business, not the sweep's.
        case 'runEnd':
          sweepActive = true;
          sweepAgeMs = calm() ? Number.POSITIVE_INFINITY : 0;
          break;

        default:
          break;
      }
    }
  }

  // -- attract mode ---------------------------------------------------------

  const attract: AttractPiece[] = [];
  for (let index = 0; index < ATTRACT_COUNT; index += 1) {
    attract.push({ kind: 'T', x: 0.5, y: 0.5, angle: 0, speed: 0, spin: 0 });
  }
  let attractOn = false;
  let attractSeeded = false;

  /** A fresh kind, lane and spin for one drifter. */
  function dealAttract(piece: AttractPiece, lane: number): void {
    piece.kind = PIECE_KINDS[Math.floor(random() * PIECE_KINDS.length)] ?? 'T';
    // Kept off the very edges, where a rotating piece would clip the frame.
    piece.x = 0.12 + random() * 0.76;
    piece.y = lane;
    piece.angle = random() * Math.PI * 2;
    piece.speed = ATTRACT_SPEED + random() * ATTRACT_SPEED_JITTER;
    piece.spin = (random() < 0.5 ? -1 : 1) * ATTRACT_SPIN * (0.5 + random());
  }

  function seedAttract(): void {
    // Spread down the field rather than bunched, so the first frame already
    // looks like something that has been drifting for a while.
    for (let index = 0; index < attract.length; index += 1) {
      const piece = attract[index];
      if (piece !== undefined) {
        dealAttract(piece, (index + random()) / attract.length);
      }
    }
    attractSeeded = true;
  }

  function attractVisible(): boolean {
    return attractOn && !calm();
  }

  function setAttract(on: boolean): void {
    if (on === attractOn) {
      return;
    }
    attractOn = on;
    // Seeded on first use, never at construction: the deterministic `random`
    // the tests inject belongs to the bursts, and must not be spent on
    // wallpaper nobody asked for.
    if (on && !attractSeeded) {
      seedAttract();
    }
  }

  // -- the frame ------------------------------------------------------------

  function update(deltaMs: number, score: number): void {
    if (counter.target() !== score) {
      counter.set(score);
    }
    if (calm()) {
      counter.snap();
    } else {
      counter.update(deltaMs);
    }

    if (!(deltaMs > 0)) {
      return;
    }
    const seconds = deltaMs / 1000;

    if (attractVisible()) {
      for (const piece of attract) {
        piece.y -= piece.speed * seconds;
        piece.angle += piece.spin * seconds * Math.PI * 2;
        if (piece.y < -0.2) {
          // Off the top: deal it again at the bottom, so the field never
          // gradually empties while somebody reads the panel.
          dealAttract(piece, 1.2);
        }
      }
    }

    for (const shard of shards) {
      if (!shard.active) {
        continue;
      }
      shard.ageMs += deltaMs;
      if (shard.ageMs >= shard.lifeMs) {
        shard.active = false;
        continue;
      }
      shard.vy += SHARD_GRAVITY * seconds;
      shard.x += shard.vx * seconds;
      shard.y += shard.vy * seconds;
      shard.angle += shard.spin * seconds;
    }

    for (const flash of flashes) {
      if (!flash.active) {
        continue;
      }
      flash.ageMs += deltaMs;
      if (flash.ageMs >= flash.lifeMs) {
        flash.active = false;
      }
    }

    for (const popup of popups) {
      if (!popup.active) {
        continue;
      }
      popup.ageMs += deltaMs;
      if (popup.ageMs >= popup.lifeMs) {
        popup.active = false;
      }
    }

    if (shakeAgeMs < shakeLifeMs) {
      shakeAgeMs += deltaMs;
    }
    if (trailAgeMs < trailLifeMs) {
      trailAgeMs += deltaMs;
    }
    if (squashAgeMs < squashLifeMs) {
      squashAgeMs += deltaMs;
    }
    if (bannerAgeMs < bannerLifeMs) {
      bannerAgeMs += deltaMs;
    }
    if (sweepActive && Number.isFinite(sweepAgeMs)) {
      sweepAgeMs += deltaMs;
    }
  }

  function clear(): void {
    for (const shard of shards) {
      shard.active = false;
    }
    for (const flash of flashes) {
      flash.active = false;
    }
    for (const popup of popups) {
      popup.active = false;
    }
    shakeAgeMs = shakeLifeMs = 0;
    trailAgeMs = trailLifeMs = 0;
    squashAgeMs = squashLifeMs = 0;
    squashCount = 0;
    bannerAgeMs = bannerLifeMs = 0;
    sweepActive = false;
    sweepAgeMs = 0;
    counter.snap();
  }

  // -- what the renderer asks for ------------------------------------------

  function shake(cell: number): Offset | null {
    if (shakeAgeMs >= shakeLifeMs || shakeLifeMs <= 0) {
      return null;
    }
    const remaining = 1 - shakeAgeMs / shakeLifeMs;
    const amplitude = shakeAmplitude * cell * remaining * remaining;
    // Two incommensurate frequencies, so the nudge never reads as a loop, and
    // a quarter-turn of phase on each so the very first frame is already off
    // centre — a shake that ramps in from zero reads as a wobble, not a hit.
    shakeOffset.x = Math.cos(shakeAgeMs * 0.085) * amplitude;
    shakeOffset.y = Math.sin(shakeAgeMs * 0.061 + Math.PI / 3) * amplitude * 0.7;
    return shakeOffset;
  }

  function cellSquash(x: number, y: number): number {
    if (squashCount === 0 || squashAgeMs >= squashLifeMs) {
      return 0;
    }
    for (let index = 0; index < squashCount; index += 1) {
      if (squashX[index] === x && squashY[index] === y) {
        // Deepest on impact, springing back out over the rest of its life.
        return SQUASH_DEPTH * (1 - squashAgeMs / squashLifeMs);
      }
    }
    return 0;
  }

  // -- painting -------------------------------------------------------------

  function render(ctx: CanvasRenderingContext2D, view: FieldView): void {
    const { layout, hiddenRows } = view;
    const cell = layout.cell;
    if (cell <= 0) {
      return;
    }
    const { pieces, surfaces } = getPalette();
    const left = layout.x;
    const top = layout.y;

    ctx.save();

    // 0. The start screen's drifting pieces, behind everything.
    if (attractVisible()) {
      const block = cell * ATTRACT_SCALE;
      const gap = block * 0.08;
      ctx.globalAlpha = ATTRACT_ALPHA;
      for (const piece of attract) {
        const cells = getCells(piece.kind, 0);
        // Rotate about the middle of the piece's own bounding box, which is
        // what makes the tumble look like a tumble rather than a swing.
        const middle = (boxSize(piece.kind) - 1) / 2;
        ctx.save();
        ctx.translate(left + piece.x * layout.width, top + piece.y * layout.height);
        ctx.rotate(piece.angle);
        ctx.fillStyle = pieces[piece.kind].fill;
        for (const point of cells) {
          ctx.fillRect(
            (point.x - middle) * block - block / 2,
            (point.y - middle) * block - block / 2,
            block - gap,
            block - gap,
          );
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    // 1. The rows that just went, held where they were.
    for (const flash of flashes) {
      if (!flash.active) {
        continue;
      }
      const progress = flash.still ? 0 : Math.min(1, flash.ageMs / flash.lifeMs);
      const fade = 1 - progress * progress;
      const shrink = flash.still ? 1 : 1 - progress * 0.75;
      const peak = flash.still ? FLASH_WASH_STILL : flash.big ? FLASH_WASH_QUAD : FLASH_WASH;
      const wash = withAlpha(surfaces.ink, peak * (1 - progress) ** 1.4);

      for (let index = 0; index < flash.rowCount; index += 1) {
        const row = flash.rows[index] ?? 0;
        const centre = top + (row + 0.5) * cell;
        const height = cell * shrink;
        ctx.globalAlpha = fade;
        for (let x = 0; x < flash.boardWidth; x += 1) {
          const kind = flash.kinds[index * flash.boardWidth + x];
          if (kind === null || kind === undefined) {
            continue;
          }
          ctx.fillStyle = pieces[kind].fill;
          ctx.fillRect(left + x * cell, centre - height / 2, cell, height);
        }
        // A bright bar over the whole row: the flash itself.
        ctx.globalAlpha = 1;
        ctx.fillStyle = wash;
        ctx.fillRect(left, centre - height / 2, flash.boardWidth * cell, height);
      }
    }
    ctx.globalAlpha = 1;

    // 2. The streak a hard drop leaves behind it.
    if (trailAgeMs < trailLifeMs) {
      const progress = trailAgeMs / trailLifeMs;
      const x = left + trailMinX * cell;
      const width = (trailMaxX - trailMinX) * cell;
      const y = top + trailTopY * cell;
      const height = (trailBottomY - trailTopY) * cell;
      const gradient = ctx.createLinearGradient(0, y, 0, y + height);
      gradient.addColorStop(0, withAlpha(pieces[trailKind].fill, 0));
      gradient.addColorStop(1, withAlpha(pieces[trailKind].light, 0.38 * (1 - progress)));
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, width, height);
    }

    // 3. Shards and dust.
    for (const shard of shards) {
      if (!shard.active) {
        continue;
      }
      const remaining = 1 - shard.ageMs / shard.lifeMs;
      const side = shard.size * cell;
      ctx.globalAlpha = remaining * remaining;
      ctx.fillStyle = pieces[shard.kind].fill;
      ctx.save();
      ctx.translate(left + shard.x * cell, top + shard.y * cell);
      ctx.rotate(shard.angle);
      ctx.fillRect(-side / 2, -side / 2, side, side);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // 4. The game-over sweep, climbing the stack from the floor.
    if (sweepActive) {
      const totalRows = Math.max(1, Math.round(layout.height / cell));
      const reach = Number.isFinite(sweepAgeMs)
        ? Math.floor(sweepAgeMs / GAME_OVER_ROW_MS)
        : totalRows;
      ctx.fillStyle = withAlpha(surfaces.veil, 0.5);
      for (let step = 0; step < reach; step += 1) {
        const row = totalRows - 1 - step;
        if (row < hiddenRows) {
          break;
        }
        ctx.fillRect(left, top + row * cell, layout.width, cell);
      }
    }

    // 5. The level-up pulse: a lit lip around the well, plus the number.
    if (bannerAgeMs < bannerLifeMs) {
      const progress = bannerAgeMs / bannerLifeMs;
      const strength = bannerStill ? 1 : Math.sin(Math.PI * Math.min(1, progress * 1.15));
      const line = Math.max(2, Math.round(cell * 0.22 * strength));
      ctx.strokeStyle = withAlpha(surfaces.accent, 0.9 * strength);
      ctx.lineWidth = line;
      ctx.strokeRect(
        left + line / 2,
        view.wellY + line / 2,
        layout.width - line,
        view.wellHeight - line,
      );

      const size = Math.round(cell * 1.1);
      ctx.font = `800 ${size}px ${DISPLAY_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = withAlpha(surfaces.accent, strength);
      ctx.fillText(`LEVEL ${bannerLevel}`, left + layout.width / 2, view.wellY + view.wellHeight / 2);
    }

    // 6. Score labels, last, over everything.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const popup of popups) {
      if (!popup.active) {
        continue;
      }
      const progress = popup.ageMs / popup.lifeMs;
      const rise = popup.still ? 0 : POPUP_RISE_CELLS * easeOut(progress);
      // Fades only over the last third, so the number is readable first.
      const alpha = popup.still ? 1 : Math.min(1, (1 - progress) * 3);
      const size = Math.round(cell * (popup.big ? 0.95 : 0.75));
      ctx.font = `700 ${size}px ${popup.big ? DISPLAY_FONT : NUMERIC_FONT}`;
      const x = left + popup.x * cell;
      const y = top + (popup.y + 0.5 - rise) * cell;
      // An ink outline, so the label reads over blocks as well as over the well.
      ctx.lineWidth = Math.max(2, size * 0.16);
      ctx.strokeStyle = withAlpha(surfaces.veil, 0.85 * alpha);
      ctx.strokeText(popup.text, x, y);
      ctx.fillStyle = withAlpha(popup.big ? surfaces.accent : surfaces.ink, alpha);
      ctx.fillText(popup.text, x, y);
    }

    ctx.restore();
  }

  function particleCount(): number {
    let count = 0;
    for (const shard of shards) {
      if (shard.active) {
        count += 1;
      }
    }
    return count;
  }

  return {
    observe,
    update,
    render,
    setAttract,
    shake,
    cellSquash,
    displayScore: () => counter.value(),
    clear,
    particleCount,
  };
}

/** Fast at first, slow at the top — the arc a thrown label follows. */
function easeOut(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return 1 - (1 - clamped) ** 3;
}
