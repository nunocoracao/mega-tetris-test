/**
 * The browser half of a shareable run.
 *
 * `src/engine/share.ts` owns the *format*: the bytes, the header, the varints,
 * and a decoder that is pure, synchronous and total. What is left here is the
 * one thing a pure module cannot do — reach for `CompressionStream`, which is
 * asynchronous and not everywhere.
 *
 * That asymmetry is the design, not an accident. **Writing** a link can afford
 * to be async and can always fall back to storing the bytes as they are;
 * **reading** one has to work on the first frame, in whatever browser the link
 * was opened in, which is why the game ships its own inflate and never depends
 * on `DecompressionStream` at all. A friend's link opening is not negotiable;
 * a friend's link being 40% shorter is a nicety.
 *
 * No compression dependency was added and none should be. A library would cost
 * more than the rest of the game put together.
 */

import {
  MAX_SHARE_CHARS,
  MODE_RULES,
  packShare,
  sharePayloadBytes,
  shareFragment,
  type GameMode,
  type SharePayload,
} from '../engine';
import { MODE_LABELS, formatDuration, formatNumber } from './hud';

/** What came of trying to put a run in a link. */
export type ShareLink =
  | { readonly ok: true; readonly payload: string; readonly url: string }
  /**
   * The run does not fit. Not a failure to be swallowed: the caller owes the
   * player an honest sentence and the score-only share line instead of a link
   * that a chat client would quietly cut in half.
   */
  | { readonly ok: false; readonly reason: 'tooLong' }
  /**
   * The run was a match, and a match cannot be put in a link.
   *
   * A tape is one player's keys against a seed. That is the whole of a solo run
   * and nowhere near the whole of a versus one: the opponent's attacks landed on
   * the player's clock at moments no tape records, so a replay built from it
   * would show a clean well where the real run took four rows in the face. The
   * refusal is here as well as in `decodeShare` because a link that plays back
   * the wrong match is worse than no link, and neither end should make one.
   */
  | { readonly ok: false; readonly reason: 'match' };

/**
 * zlib-deflate some bytes, or `null` when the platform cannot.
 *
 * `CompressionStream` has been in every engine since 2023, but "every engine
 * since 2023" is not "every browser a link is opened in", and a share button
 * that throws in an old WebView is worse than one that produces a slightly
 * longer link. Every failure — missing constructor, unsupported format, a
 * stream that errors — comes back as `null` and the caller stores the bytes
 * uncompressed instead.
 */
export async function deflateBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  const available = typeof CompressionStream !== 'undefined' && typeof Response !== 'undefined';
  if (!available) {
    return null;
  }
  try {
    // `new Response(bytes).body` rather than a hand-driven writer: the reader
    // and the writer of a transform stream have to be pumped concurrently, and
    // getting that wrong is a deadlock rather than an error.
    const source = new Response(bytes as BodyInit).body;
    if (source === null) {
      return null;
    }
    const piped = source.pipeThrough(new CompressionStream('deflate'));
    const buffer = await new Response(piped).arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

/**
 * A run, as a payload — compressed if the platform can, stored if it cannot,
 * and refused outright if the result would be too long to paste.
 */
export async function encodeSharePayload(payload: SharePayload): Promise<string | null> {
  const body = sharePayloadBytes(payload);
  // Not worth compressing what will not fit even compressed: deflate never
  // manages better than about a third on this data, so a body four times the
  // budget is hopeless and the work can be skipped.
  if (body.length > MAX_SHARE_CHARS * 4) {
    return null;
  }
  const deflated = await deflateBytes(body);
  return packShare(body, deflated);
}

/**
 * The whole link: the page's own address with the run in its fragment.
 *
 * The fragment, deliberately. A query string would be sent to the server on
 * every load, and there is no server — a replay is nobody's business but the
 * two people looking at it.
 */
export async function buildShareLink(base: string, payload: SharePayload): Promise<ShareLink> {
  if (MODE_RULES[payload.mode].garbage) {
    return { ok: false, reason: 'match' };
  }
  const encoded = await encodeSharePayload(payload);
  if (encoded === null) {
    return { ok: false, reason: 'tooLong' };
  }
  return { ok: true, payload: encoded, url: `${base}${shareFragment(encoded)}` };
}

// ---------------------------------------------------------------------------
// The consolation prize
// ---------------------------------------------------------------------------

export interface RunShareOptions {
  readonly mode: GameMode;
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  readonly durationMs: number;
  readonly url: string;
}

/**
 * A run in three lines of text, with no replay in it.
 *
 * This is what a marathon too long to fit in a link gets instead — the same
 * shape as the daily challenge's share line, because it goes to the same place
 * and gets pasted into the same chat window. It says what happened and where to
 * play; it deliberately does not pretend to be a replay.
 */
export function runShareText(options: RunShareOptions): string {
  return [
    `Mega Tetris — ${MODE_LABELS[options.mode]}`,
    `${formatNumber(options.score)} points · ${formatNumber(options.lines)} lines · level ${formatNumber(options.level)} · ${formatDuration(options.durationMs)}`,
    options.url,
  ].join('\n');
}
