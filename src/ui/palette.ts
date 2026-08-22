/**
 * The one place block colours live.
 *
 * The renderer never writes a colour literal: it looks everything up here, so
 * restyling the game is a matter of editing this file and nothing else.
 * Colours are plain 6-digit hex so `withAlpha` can build translucent variants
 * (the ghost piece, the paused veil) without a colour-parsing dependency.
 */

import type { PieceKind } from '../engine';

/** One block's three tones: the face, its lit bevel and its shaded edge. */
export interface BlockColor {
  readonly fill: string;
  readonly light: string;
  readonly shade: string;
}

/**
 * The seven piece colours — a bright, high-contrast set that stays legible
 * against the dark well. Every hue is distinguishable from its neighbours in
 * value as well as in hue, so the board still reads without colour vision.
 */
export const PIECE_PALETTE: Readonly<Record<PieceKind, BlockColor>> = {
  I: { fill: '#35d0ee', light: '#a9f2ff', shade: '#127a92' },
  O: { fill: '#ffd166', light: '#fff0c2', shade: '#a67714' },
  T: { fill: '#c084fc', light: '#e9d5ff', shade: '#7228c4' },
  S: { fill: '#5fd97f', light: '#c3f6cf', shade: '#238843' },
  Z: { fill: '#ff6b8b', light: '#ffc4d0', shade: '#b02545' },
  J: { fill: '#5b8dff', light: '#c0d3ff', shade: '#2148b8' },
  L: { fill: '#ff9f45', light: '#ffd9b0', shade: '#b45f0d' },
};

/** Colours for everything that is not a block: the well, its grid and frame. */
export const SURFACE_PALETTE = {
  /** Background of the playfield itself. */
  well: '#12112a',
  /** Faint checker that makes the columns countable. */
  gridLine: '#ffffff',
  /** Frame drawn just inside the playfield edge. */
  frame: '#332f6b',
  /** Background of the small preview and hold canvases. */
  panel: '#171639',
  /** Drawn over the whole well while the run is not `playing`. */
  veil: '#0a0a1c',
} as const;

/** How strongly the ghost piece is painted, as fill and outline alpha. */
export const GHOST_ALPHA = { fill: 0.18, stroke: 0.75 } as const;

/** Grid line alpha — low enough to read as texture, not as content. */
export const GRID_ALPHA = 0.05;

/**
 * `#rrggbb` plus an alpha channel, as `#rrggbbaa`.
 *
 * Alpha is clamped to 0..1 and rounded to a byte, so the result is always a
 * valid CSS colour that canvas accepts directly.
 */
export function withAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const byte = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${byte}`;
}
