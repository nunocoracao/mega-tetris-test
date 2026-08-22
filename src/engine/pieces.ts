/**
 * Shape data and rotation for the seven tetromino kinds.
 *
 * Each shape is described **once**, in its spawn orientation, as the cells it
 * fills inside a square bounding box:
 *
 *   - `I` lives in a 4x4 box (so its two horizontal and two vertical states
 *     line up with each other),
 *   - `O` lives in a 2x2 box (which is why it never appears to rotate),
 *   - everything else lives in a 3x3 box.
 *
 * Rotation states 1-3 are then derived programmatically by rotating the
 * offsets a quarter turn clockwise inside that box, which keeps the data
 * honest: there is no hand-written table to get subtly wrong, and the derived
 * states are unit-tested against the properties we care about (four cells
 * everywhere, four turns is the identity, `O` is rotation-invariant).
 *
 * A quarter turn clockwise inside an `n x n` box maps `(x, y) -> (n-1-y, x)`.
 * (Remember `y` grows downwards, so this really is clockwise on screen.)
 */

import type { PieceKind, Point, Rotation, RotationDirection } from './types';

/** All piece kinds, in the canonical order used by the 7-bag generator. */
export const PIECE_KINDS = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as const satisfies readonly PieceKind[];

/** Side length of each kind's rotation bounding box. */
const BOX_SIZE: Record<PieceKind, number> = {
  I: 4,
  O: 2,
  T: 3,
  S: 3,
  Z: 3,
  J: 3,
  L: 3,
};

/**
 * Spawn-orientation cells, written out from the geometry of each letter.
 * Rows read top to bottom; `#` marks an occupied cell.
 *
 *   I  ....    O  ##    T  .#.    S  .##    Z  ##.    J  #..    L  ..#
 *      ####       ##       ###       ##.       .##       ###       ###
 *      ....                ...       ...       ...       ...       ...
 *      ....
 */
const SPAWN_CELLS: Record<PieceKind, readonly Point[]> = {
  I: [
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
  ],
  O: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ],
  T: [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ],
  S: [
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ],
  Z: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ],
  J: [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ],
  L: [
    { x: 2, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ],
};

/** The four rotation states of a kind, indexed by `Rotation`. */
type RotationStates = readonly [readonly Point[], readonly Point[], readonly Point[], readonly Point[]];

/** Sort cells top-to-bottom, then left-to-right, so equal shapes compare equal. */
function normalise(cells: readonly Point[]): readonly Point[] {
  return [...cells].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

/** Quarter turn clockwise inside an `size x size` bounding box. */
function rotateCellsCw(cells: readonly Point[], size: number): readonly Point[] {
  return normalise(cells.map(({ x, y }) => ({ x: size - 1 - y, y: x })));
}

function buildRotationStates(kind: PieceKind): RotationStates {
  const size = BOX_SIZE[kind];
  const spawn = normalise(SPAWN_CELLS[kind]);
  const cw1 = rotateCellsCw(spawn, size);
  const cw2 = rotateCellsCw(cw1, size);
  const cw3 = rotateCellsCw(cw2, size);
  return [spawn, cw1, cw2, cw3];
}

const ROTATION_STATES: Record<PieceKind, RotationStates> = {
  I: buildRotationStates('I'),
  O: buildRotationStates('O'),
  T: buildRotationStates('T'),
  S: buildRotationStates('S'),
  Z: buildRotationStates('Z'),
  J: buildRotationStates('J'),
  L: buildRotationStates('L'),
};

/** The four cell offsets a piece occupies, relative to its origin. */
export function getCells(kind: PieceKind, rotation: Rotation): readonly Point[] {
  return ROTATION_STATES[kind][rotation];
}

/** Side length of a kind's rotation bounding box (4 for `I`, 2 for `O`, else 3). */
export function boxSize(kind: PieceKind): number {
  return BOX_SIZE[kind];
}

/** Advance a rotation state one quarter turn in `direction`. */
export function nextRotation(rotation: Rotation, direction: RotationDirection): Rotation {
  const delta = direction === 'cw' ? 1 : 3;
  return ((rotation + delta) % 4) as Rotation;
}

/**
 * Where a freshly spawned piece is placed.
 *
 * Horizontally the bounding box is centred (biased left on an odd remainder,
 * which is what the classic games do). Vertically the origin is row 0, i.e.
 * the top of the board array — with `BUFFER_ROWS` hidden rows above the
 * visible field, every kind spawns just above the playfield and scrolls into
 * view as it falls.
 */
export function spawnPosition(kind: PieceKind, boardWidth: number): Point {
  return { x: Math.floor((boardWidth - BOX_SIZE[kind]) / 2), y: 0 };
}

/**
 * Wall kicks.
 *
 * When a rotation would put the piece inside a wall, the floor or the stack,
 * the engine retries the same rotation at a handful of nudged positions and
 * takes the first one that fits. These lists are our own, deliberately small
 * and easy to reason about, rather than a table lifted from another game.
 *
 * The intent, in order:
 *   1. `(0, 0)`      - no kick; by far the common case.
 *   2. away-from-wall - push out of the wall the rotation was heading into.
 *      A clockwise turn sweeps the piece to the right, so it most often needs
 *      to come back left; counter-clockwise is mirrored.
 *   3. the other side - covers rotating out of the opposite wall.
 *   4. lift by one   - lets a piece rotate up out of the floor or off a flat
 *      stack instead of refusing the input.
 *   5. lift + shift  - the two combined, for a corner that needs both.
 *
 * `y` is negative for "up" because board `y` grows downwards.
 */
export const KICKS_CW: readonly Point[] = [
  { x: 0, y: 0 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
];

/** Counter-clockwise kicks: the clockwise list mirrored horizontally. */
export const KICKS_CCW: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: -1 },
];

/**
 * The `I` piece is four cells long and swings through a 4x4 box, so a
 * one-cell nudge is often not enough to free it from a wall — it gets its own
 * list with two-cell shifts and a two-cell lift for the vertical-to-horizontal
 * case against the floor.
 */
export const KICKS_I_CW: readonly Point[] = [
  { x: 0, y: 0 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -2, y: 0 },
  { x: 2, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: -2 },
];

/** Counter-clockwise `I` kicks: the clockwise list mirrored horizontally. */
export const KICKS_I_CCW: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 2, y: 0 },
  { x: -2, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: -2 },
];

/** The ordered kick candidates to try for this kind and rotation direction. */
export function getKicks(kind: PieceKind, direction: RotationDirection): readonly Point[] {
  if (kind === 'I') {
    return direction === 'cw' ? KICKS_I_CW : KICKS_I_CCW;
  }
  return direction === 'cw' ? KICKS_CW : KICKS_CCW;
}
