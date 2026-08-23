/**
 * Canvas rendering.
 *
 * The renderer is a painter and nothing else: hand it a `GameState` and it
 * paints that snapshot. It holds no rules, mutates no state and asks the
 * engine no questions beyond the pure queries the engine already exposes
 * (`ghostPiece`, `getCells`). Every colour comes from `./palette`, which reads
 * it from the stylesheet's custom properties, so the visual identity can be
 * redone in CSS without touching a single draw call here.
 *
 * Everything below works in **device pixels**, not CSS pixels: the backing
 * store is sized to `clientSize * devicePixelRatio` and the drawing code
 * rounds to whole device pixels. That is what keeps the grid crisp on retina
 * screens instead of half-covering a pixel row and going soft.
 */

import {
  getCells,
  ghostPiece,
  VISIBLE_HEIGHT,
  type ActivePiece,
  type Board,
  type Cell,
  type GameState,
  type PieceKind,
  type Rotation,
} from '../engine';
import { blockMark, highContrast, type BlockMark } from './contrast';
import {
  GHOST_ALPHA,
  GRID_ALPHA,
  getPalette,
  withAlpha,
  type BlockColor,
  type BlockKey,
} from './palette';

/**
 * How strongly the spawn strip above the well is painted. Enough to see the
 * piece arriving, faint enough that the well is clearly where the game is.
 */
const SPAWN_STRIP_ALPHA = 0.4;

// ---------------------------------------------------------------------------
// Geometry (pure — no canvas, no DOM)
// ---------------------------------------------------------------------------

/** Where a `cols` x `rows` grid of square cells sits inside a pixel box. */
export interface GridLayout {
  /** Side of one cell, in device pixels. Always a whole number, always >= 1. */
  readonly cell: number;
  /** Top-left corner of the grid inside the box, in device pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Largest whole-pixel square grid that fits in the box, centred.
 *
 * Cells are integers so block edges land on pixel boundaries; the leftover
 * fraction becomes padding split evenly around the grid rather than a blurry
 * half-pixel on every line.
 */
export function computeGridLayout(
  boxWidth: number,
  boxHeight: number,
  cols: number,
  rows: number,
  padding = 0,
): GridLayout {
  const usableWidth = Math.max(0, boxWidth - padding * 2);
  const usableHeight = Math.max(0, boxHeight - padding * 2);
  const cell = Math.max(1, Math.floor(Math.min(usableWidth / cols, usableHeight / rows)));
  const width = cell * cols;
  const height = cell * rows;
  return {
    cell,
    x: Math.round((boxWidth - width) / 2),
    y: Math.round((boxHeight - height) / 2),
    width,
    height,
  };
}

/** The tight box a piece's four cells actually occupy inside its bounding box. */
export interface PieceExtents {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Occupied extents of a piece — the I piece is 4x1, the O piece 2x2 — so a
 * preview can centre the *shape* rather than its (often padded) rotation box.
 */
export function pieceExtents(kind: PieceKind, rotation: Rotation = 0): PieceExtents {
  const cells = getCells(kind, rotation);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const cell of cells) {
    minX = Math.min(minX, cell.x);
    minY = Math.min(minY, cell.y);
    maxX = Math.max(maxX, cell.x);
    maxY = Math.max(maxY, cell.y);
  }

  return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** How many rows at the top of the board array are hidden above the field. */
export function hiddenRowCount(board: Board): number {
  return Math.max(0, board.height - VISIBLE_HEIGHT);
}

// ---------------------------------------------------------------------------
// Canvas surface: device pixel ratio + resize
// ---------------------------------------------------------------------------

interface Surface {
  readonly ctx: CanvasRenderingContext2D;
  /** Backing-store size in device pixels. */
  readonly width: number;
  readonly height: number;
}

/**
 * Owns a canvas' backing store: keeps it matched to the element's CSS box
 * times the current device pixel ratio, and re-paints whenever that changes.
 *
 * A `ResizeObserver` covers layout changes (window resize, a panel opening,
 * a phone rotating); the ratio is re-read on every sync so dragging the window
 * to a different-density monitor also refreshes.
 */
class CanvasSurface {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver | null;
  private readonly onResize: () => void;

  constructor(canvas: HTMLCanvasElement, onResize: () => void) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('This browser does not support the 2D canvas context.');
    }
    this.canvas = canvas;
    this.ctx = ctx;
    this.onResize = onResize;

    this.observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (this.sync()) {
              this.onResize();
            }
          })
        : null;
    this.observer?.observe(canvas);
  }

  /**
   * Resize the backing store to the element's current box. Returns `true` when
   * something actually changed, so callers can skip a needless repaint.
   */
  sync(): boolean {
    const ratio = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));

    if (this.canvas.width === width && this.canvas.height === height) {
      return false;
    }
    // Assigning width/height also clears the canvas, which is what we want.
    this.canvas.width = width;
    this.canvas.height = height;
    return true;
  }

  surface(): Surface {
    return { ctx: this.ctx, width: this.canvas.width, height: this.canvas.height };
  }

  destroy(): void {
    this.observer?.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Block drawing
// ---------------------------------------------------------------------------

/** Rounded-rectangle path, built by hand so we do not depend on `roundRect`. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/**
 * The mark stamped into a block's face in high-contrast mode.
 *
 * Colour alone must not be what tells an S from a Z, so each kind carries a
 * shape as well. Two strokes at most, drawn in the block's own near-black
 * outline colour so it reads against every one of the seven faces.
 */
function drawMark(
  ctx: CanvasRenderingContext2D,
  mark: BlockMark,
  left: number,
  top: number,
  side: number,
  color: BlockColor,
): void {
  // Below about eight device pixels a mark is mud, and the heavier outline is
  // already carrying the distinction. Bail rather than smear.
  if (side < 8) {
    return;
  }
  const inset = side * 0.28;
  const a = left + inset;
  const b = left + side - inset;
  const c = top + inset;
  const d = top + side - inset;
  const midX = left + side / 2;
  const midY = top + side / 2;

  ctx.save();
  ctx.strokeStyle = color.outline;
  ctx.lineWidth = Math.max(1, Math.round(side * 0.14));
  ctx.lineCap = 'round';
  ctx.beginPath();
  switch (mark) {
    case 'bar':
      ctx.moveTo(a, midY);
      ctx.lineTo(b, midY);
      break;
    case 'pillar':
      ctx.moveTo(midX, c);
      ctx.lineTo(midX, d);
      break;
    case 'cross':
      ctx.moveTo(a, midY);
      ctx.lineTo(b, midY);
      ctx.moveTo(midX, c);
      ctx.lineTo(midX, d);
      break;
    case 'slashUp':
      ctx.moveTo(a, d);
      ctx.lineTo(b, c);
      break;
    case 'slashDown':
      ctx.moveTo(a, c);
      ctx.lineTo(b, d);
      break;
    case 'stack':
      ctx.moveTo(a, midY - side * 0.15);
      ctx.lineTo(b, midY - side * 0.15);
      ctx.moveTo(a, midY + side * 0.15);
      ctx.lineTo(b, midY + side * 0.15);
      break;
    case 'ring':
      ctx.rect(a, c, b - a, d - c);
      break;
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * A solid block, lit from above.
 *
 * All of the dimension is arithmetic, not artwork: a flat face, a lit band
 * across the top, a shaded band across the bottom, a hairline inner highlight
 * just inside the top edge and a darker outline around the whole thing. Four
 * clipped rectangles and two strokes — cheap enough to do 220 times a frame.
 *
 * In high-contrast mode the outline roughly doubles in weight and darkens to
 * the block's `outline` tone, and the piece's mark is stamped into the face.
 * That is two non-colour cues — boundary weight and shape — on top of the
 * brighter palette the stylesheet switches to.
 */
function drawBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: BlockColor,
  cell?: Cell,
): void {
  const inset = Math.max(1, Math.round(size * 0.06));
  const left = x + inset;
  const top = y + inset;
  const side = size - inset * 2;
  if (side <= 0) {
    return;
  }
  const radius = Math.max(1, Math.round(size * 0.2));
  const band = Math.max(1, Math.round(side * 0.26));
  const bold = highContrast();

  roundedRectPath(ctx, left, top, side, side, radius);
  ctx.fillStyle = color.fill;
  ctx.fill();

  ctx.save();
  ctx.clip();
  ctx.fillStyle = withAlpha(color.light, 0.5);
  ctx.fillRect(left, top, side, band);
  ctx.fillStyle = withAlpha(color.shade, 0.45);
  ctx.fillRect(left, top + side - band, side, band);
  // A short gloss in the top-left corner: the one bit of shine on the block.
  ctx.fillStyle = withAlpha(color.light, 0.35);
  ctx.fillRect(left, top, Math.max(1, Math.round(side * 0.3)), Math.round(side * 0.55));
  ctx.restore();

  // Inner highlight, then the darker edge over it, so the two never overlap.
  // High contrast skips the highlight: it would only soften the boundary the
  // heavy outline is about to draw.
  if (side > 6 && !bold) {
    const line = Math.max(1, Math.round(size * 0.04));
    ctx.strokeStyle = withAlpha(color.light, 0.4);
    ctx.lineWidth = line;
    roundedRectPath(ctx, left + line, top + line, side - line * 2, side - line * 2, radius - line);
    ctx.stroke();
  }

  const mark = bold && cell !== undefined ? blockMark(cell) : null;
  if (mark !== null) {
    drawMark(ctx, mark, left, top, side, color);
  }

  ctx.strokeStyle = bold ? color.outline : color.shade;
  ctx.lineWidth = Math.max(bold ? 2 : 1, Math.round(size * (bold ? 0.1 : 0.05)));
  roundedRectPath(ctx, left, top, side, side, radius);
  ctx.stroke();
}

/** The hollow outline that shows where a hard drop would land. */
function drawGhostBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: BlockColor,
): void {
  const inset = Math.max(1, Math.round(size * 0.1));
  const left = x + inset;
  const top = y + inset;
  const side = size - inset * 2;
  if (side <= 0) {
    return;
  }
  const radius = Math.max(1, Math.round(size * 0.18));

  roundedRectPath(ctx, left, top, side, side, radius);
  ctx.fillStyle = withAlpha(color.fill, GHOST_ALPHA.fill);
  ctx.fill();
  // In high contrast the ghost keeps a full-strength outline and gives up the
  // fill instead — "where it would land" then reads as a shape, not as a shade.
  const bold = highContrast();
  ctx.strokeStyle = withAlpha(color.fill, bold ? 1 : GHOST_ALPHA.stroke);
  ctx.lineWidth = Math.max(1, Math.round(size * (bold ? 0.1 : 0.07)));
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Playfield renderer
// ---------------------------------------------------------------------------

/** A renderer bound to one canvas. Call `render` as often as you like. */
export interface Renderer<T> {
  render(value: T): void;
  destroy(): void;
}

/**
 * Where the field ended up this frame, in device pixels.
 *
 * Handed to the `decorate` hook so the effects layer can place a particle or a
 * score label on a board coordinate without recomputing the layout — and,
 * more importantly, without a second copy of the sizing rules.
 */
export interface FieldView {
  readonly layout: GridLayout;
  /** Buffer rows above the well; board row `hiddenRows` is the field's top row. */
  readonly hiddenRows: number;
  /** Top edge and height of the well proper, buffer rows excluded. */
  readonly wellY: number;
  readonly wellHeight: number;
  /** Backing-store size of the canvas. */
  readonly width: number;
  readonly height: number;
}

/**
 * The three places the delight layer is allowed to reach into a paint.
 *
 * Deliberately narrow. The renderer still owns every decision about how the
 * game itself is drawn; these let something else nudge the whole field, dent
 * individual blocks, and paint on top — nothing more.
 */
export interface BoardRendererOptions {
  /**
   * Displacement for the whole field, in device pixels, given the current cell
   * size. Return `null` for no shake. Called once per paint, before anything is
   * drawn, so the result may be a reused object.
   */
  readonly shake?: (cell: number) => Readonly<{ x: number; y: number }> | null;
  /**
   * How far the locked block at `(x, y)` is squashed toward the floor of its
   * cell, 0..1. Called for every filled cell, so it must be cheap and must
   * return 0 fast when nothing is squashing.
   */
  readonly cellSquash?: (x: number, y: number) => number;
  /** Painted last, over the veil and the frame. */
  readonly decorate?: (ctx: CanvasRenderingContext2D, view: FieldView) => void;
}

/**
 * The playfield: well, grid, locked stack, ghost and active piece.
 *
 * Only the visible rows are drawn — the buffer rows above the field are where
 * pieces spawn, and showing them would make the well look two rows too tall.
 */
export function createBoardRenderer(
  canvas: HTMLCanvasElement,
  options: BoardRendererOptions = {},
): Renderer<GameState> {
  let last: GameState | null = null;

  const surface = new CanvasSurface(canvas, () => {
    if (last !== null) {
      paint(last);
    }
  });

  function paint(state: GameState): void {
    const { ctx, width, height } = surface.surface();
    const { pieces, surfaces } = getPalette();
    const { board } = state;
    const hidden = hiddenRowCount(board);

    // The grid spans the *whole* board, buffer rows included, but only the rows
    // below the buffer get a well drawn around them. That turns the spawn area
    // into a narrow strip above the well where the next piece is already
    // visible, faintly, instead of being invisible for its first row of fall.
    const layout = computeGridLayout(width, height, board.width, board.height);
    const wellY = layout.y + hidden * layout.cell;
    const wellHeight = layout.height - hidden * layout.cell;

    ctx.clearRect(0, 0, width, height);

    // The shake wraps the entire paint, effects included, so the field moves as
    // one object rather than sliding apart. Cleared first, above, so the pixels
    // it uncovers at the edge are the bezel behind the canvas.
    const nudge = options.shake?.(layout.cell) ?? null;
    ctx.save();
    if (nudge !== null) {
      ctx.translate(nudge.x, nudge.y);
    }

    // The well deepens toward the floor, so the stack has something to sit on.
    const wellFill = ctx.createLinearGradient(0, wellY, 0, wellY + wellHeight);
    wellFill.addColorStop(0, surfaces.well);
    wellFill.addColorStop(1, surfaces.wellDeep);
    ctx.fillStyle = wellFill;
    ctx.fillRect(layout.x, wellY, layout.width, wellHeight);

    ctx.strokeStyle = withAlpha(surfaces.gridLine, GRID_ALPHA);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let col = 1; col < board.width; col += 1) {
      const x = layout.x + col * layout.cell + 0.5;
      ctx.moveTo(x, wellY);
      ctx.lineTo(x, wellY + wellHeight);
    }
    for (let row = hidden + 1; row < board.height; row += 1) {
      const y = layout.y + row * layout.cell + 0.5;
      ctx.moveTo(layout.x, y);
      ctx.lineTo(layout.x + layout.width, y);
    }
    ctx.stroke();

    // Locked stack. A piece can lock in the buffer on a losing board, so those
    // rows are painted too — dimmed, like everything else above the well.
    for (let y = 0; y < board.height; y += 1) {
      for (let x = 0; x < board.width; x += 1) {
        const cell = board.cells[y * board.width + x];
        if (cell === null || cell === undefined) {
          continue;
        }
        ctx.globalAlpha = y < hidden ? SPAWN_STRIP_ALPHA : 1;
        const blockX = layout.x + x * layout.cell;
        const blockY = layout.y + y * layout.cell;
        // A squashed block is scaled about the floor of its own cell, so it
        // flattens onto the stack instead of drifting off it.
        const squash = options.cellSquash?.(x, y) ?? 0;
        if (squash > 0) {
          const floor = blockY + layout.cell;
          ctx.save();
          ctx.translate(0, floor);
          ctx.scale(1, 1 - squash);
          ctx.translate(0, -floor);
        }
        drawBlock(ctx, blockX, blockY, layout.cell, pieces[cell], cell);
        if (squash > 0) {
          ctx.restore();
        }
      }
    }
    ctx.globalAlpha = 1;

    // Ghost first, so the real piece always paints over it.
    const ghost = ghostPiece(state);
    if (ghost !== null && state.active !== null && ghost.y !== state.active.y) {
      drawPiece(ctx, ghost, layout, hidden, drawGhostBlock, pieces);
    }
    if (state.active !== null) {
      drawPiece(ctx, state.active, layout, hidden, drawBlock, pieces);
    }

    // Everything but a live game gets a veil, so the DOM overlay reads clearly.
    if (state.status !== 'playing') {
      ctx.fillStyle = withAlpha(surfaces.veil, 0.55);
      ctx.fillRect(layout.x, layout.y, layout.width, layout.height);
    }

    // Frame last, on top of the veil: it is what separates the well from the
    // spawn strip above it, so it scales with the cells rather than staying a
    // hairline on a big screen. The CSS bezel around the canvas does the outer
    // glow; this line is the inner lip of the cabinet.
    const frameWidth = Math.max(1, Math.round(layout.cell * 0.06));
    ctx.strokeStyle = withAlpha(surfaces.frame, 0.9);
    ctx.lineWidth = frameWidth;
    ctx.strokeRect(
      layout.x + frameWidth / 2,
      wellY + frameWidth / 2,
      layout.width - frameWidth,
      wellHeight - frameWidth,
    );

    options.decorate?.(ctx, { layout, hiddenRows: hidden, wellY, wellHeight, width, height });

    ctx.restore();
  }

  return {
    render(state: GameState): void {
      last = state;
      surface.sync();
      paint(state);
    },
    destroy(): void {
      surface.destroy();
    },
  };
}

type BlockPainter = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: BlockColor,
  cell?: Cell,
) => void;

/**
 * Paint a piece's four cells. Cells still in the spawn strip above the well are
 * drawn faintly rather than skipped — a piece the player cannot see is a piece
 * they cannot plan for.
 */
function drawPiece(
  ctx: CanvasRenderingContext2D,
  piece: ActivePiece,
  layout: GridLayout,
  hiddenRows: number,
  painter: BlockPainter,
  pieces: Readonly<Record<BlockKey, BlockColor>>,
): void {
  const color = pieces[piece.kind];
  for (const offset of getCells(piece.kind, piece.rotation)) {
    const row = piece.y + offset.y;
    if (row < 0) {
      continue;
    }
    ctx.globalAlpha = row < hiddenRows ? SPAWN_STRIP_ALPHA : 1;
    painter(
      ctx,
      layout.x + (piece.x + offset.x) * layout.cell,
      layout.y + row * layout.cell,
      layout.cell,
      color,
      piece.kind,
    );
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Side panels: next preview and hold slot
// ---------------------------------------------------------------------------

export interface PiecePanelOptions {
  /** How many stacked slots the canvas is divided into. */
  readonly slots: number;
  /** Draw the first slot larger than the rest — used by the next queue. */
  readonly emphasiseFirst?: boolean;
}

/** What a side panel paints: one kind per slot, `null` for an empty slot. */
export interface PiecePanelValue {
  readonly kinds: readonly (PieceKind | null)[];
  /** Paint at half strength — the hold slot uses this while hold is locked. */
  readonly dimmed?: boolean;
}

/**
 * A stack of small piece thumbnails: the next queue (three slots) and the hold
 * slot (one). Each piece is centred on its occupied extents so an I and an O
 * both look balanced in their slot.
 */
export function createPiecePanelRenderer(
  canvas: HTMLCanvasElement,
  options: PiecePanelOptions,
): Renderer<PiecePanelValue> {
  const slots = Math.max(1, Math.floor(options.slots));
  let last: PiecePanelValue | null = null;

  const surface = new CanvasSurface(canvas, () => {
    if (last !== null) {
      paint(last);
    }
  });

  function paint(value: PiecePanelValue): void {
    const { ctx, width, height } = surface.surface();
    const { pieces, surfaces } = getPalette();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = surfaces.panel;
    ctx.fillRect(0, 0, width, height);

    // The queue runs down a tall canvas and across a wide one, so the narrow
    // layout can lay the preview out as a strip without a second renderer.
    const horizontal = width > height;
    const span = horizontal ? width : height;

    // The first slot gets extra room when emphasised; the rest share the rest.
    const firstShare = options.emphasiseFirst === true && slots > 1 ? 1.35 : 1;
    const unit = span / (firstShare + (slots - 1));

    ctx.save();
    // Dimmed, but not so far that the colour stops reading as its own piece.
    ctx.globalAlpha = value.dimmed === true ? 0.45 : 1;

    let offset = 0;
    for (let slot = 0; slot < slots; slot += 1) {
      const extent = (slot === 0 ? firstShare : 1) * unit;
      const kind = value.kinds[slot] ?? null;
      if (kind !== null) {
        drawThumbnail(
          ctx,
          pieces[kind],
          kind,
          horizontal ? offset : 0,
          horizontal ? 0 : offset,
          horizontal ? extent : width,
          horizontal ? height : extent,
        );
      }
      offset += extent;
    }

    ctx.restore();
  }

  return {
    render(value: PiecePanelValue): void {
      last = value;
      surface.sync();
      paint(value);
    },
    destroy(): void {
      surface.destroy();
    },
  };
}

/** One piece, centred in the given box, at the largest size that fits. */
function drawThumbnail(
  ctx: CanvasRenderingContext2D,
  color: BlockColor,
  kind: PieceKind,
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
): void {
  const extents = pieceExtents(kind);
  const padding = Math.round(Math.min(boxWidth, boxHeight) * 0.18);
  const layout = computeGridLayout(boxWidth, boxHeight, extents.width, extents.height, padding);

  for (const offset of getCells(kind, 0)) {
    drawBlock(
      ctx,
      boxX + layout.x + (offset.x - extents.minX) * layout.cell,
      boxY + layout.y + (offset.y - extents.minY) * layout.cell,
      layout.cell,
      color,
      kind,
    );
  }
}
