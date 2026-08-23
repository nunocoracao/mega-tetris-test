/**
 * Shared value types for the game engine.
 *
 * Nothing in `src/engine/` may touch the DOM, `window`, `document`, canvas or
 * any Vite-only API: the engine is pure data + pure functions so it can run
 * (and be tested) in a plain Node process.
 *
 * Coordinate system
 * -----------------
 * Board coordinates are `x` to the right and `y` **downwards**, with the
 * origin at the top-left of the board array. "Up" is therefore `y - 1`, which
 * is why the wall-kick tables in `pieces.ts` use negative `y` to lift a piece.
 */

/** The seven classic four-cell shapes, named after the letters they resemble. */
export type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

/**
 * A cell that was pushed up from the bottom of the well rather than placed by
 * a player — a garbage row's block. It is deliberately *not* a `PieceKind`: no
 * piece ever locked there, it has no shape and no owner, and code that maps a
 * cell to a colour or a mark has to decide what to do with it rather than
 * quietly painting it as an `L`.
 *
 * The rules do not care: collision, line clearing and top-out treat every
 * non-`null` cell alike. Only the renderer tells them apart.
 */
export type GarbageCell = 'G';

/** The one garbage cell value, so nothing has to write the letter twice. */
export const GARBAGE_CELL: GarbageCell = 'G';

/**
 * A board cell: empty (`null`), the kind that locked there, or a garbage block
 * pushed up from below.
 */
export type Cell = PieceKind | GarbageCell | null;

/** Rotation state, counted clockwise from the spawn orientation. */
export type Rotation = 0 | 1 | 2 | 3;

/** Which way a rotation input turns the piece. */
export type RotationDirection = 'cw' | 'ccw';

/** An integer point; used both for board positions and for piece-local offsets. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A piece in play. `x`/`y` is the piece origin — the top-left corner of the
 * piece's bounding box — expressed in board coordinates. The four occupied
 * cells are the origin plus the offsets from `getCells(kind, rotation)`.
 */
export interface ActivePiece {
  readonly kind: PieceKind;
  readonly rotation: Rotation;
  readonly x: number;
  readonly y: number;
}
