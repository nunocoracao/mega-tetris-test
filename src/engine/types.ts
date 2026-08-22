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

/** A board cell: either empty (`null`) or filled with the kind that locked there. */
export type Cell = PieceKind | null;

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
