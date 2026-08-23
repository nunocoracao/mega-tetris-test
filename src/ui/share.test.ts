/**
 * The browser half of a shareable run: the compressor, and the link.
 *
 * Vitest runs in Node, which has had `CompressionStream` since 17 — so the
 * happy path really is exercised here rather than mocked. The unhappy path is
 * exercised by taking the constructor away, which is the honest simulation of
 * the old WebView this whole fallback exists for.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_SHARE_CHARS,
  SHARE_CODEC_DEFLATE,
  SHARE_CODEC_STORED,
  createRecorder,
  decodeShare,
  emptyLog,
  fromBase64Url,
  readShareFragment,
  replay,
  type ReplayLog,
  type SharePayload,
} from '../engine';
import { applyInput, createGame, update, type GameState } from '../engine';
import { buildShareLink, deflateBytes, encodeSharePayload, runShareText } from './share';

/** A recorded run, so at least one round trip is a run and not a fixture. */
function recordRun(seed: number, presses: number): { state: GameState; log: ReplayLog } {
  const recorder = createRecorder();
  let state = createGame({ seed });
  const script = ['moveLeft', 'rotateCW', 'moveRight', 'softDrop', 'hardDrop', 'hold'] as const;
  const send = (input: (typeof script)[number] | 'resume'): void => {
    recorder.record(state.elapsedMs, input);
    state = applyInput(state, { type: input });
  };
  send('resume');
  for (let index = 0; index < presses; index += 1) {
    send(script[index % script.length] ?? 'moveLeft');
    let left = 40 + (index % 7) * 13;
    while (left > 0) {
      const frame = Math.min(left, 16);
      state = update(state, frame);
      left -= frame;
      recorder.mark(state.elapsedMs);
    }
  }
  recorder.mark(state.elapsedMs);
  return { state, log: recorder.log() };
}

function payloadFor(seed: number, presses: number): SharePayload {
  return { mode: 'marathon', seed, startLevel: 1, log: recordRun(seed, presses).log };
}

/** Take `CompressionStream` away, the way an old WebView would have. */
function withoutCompression<T>(run: () => T): T {
  const scope = globalThis as { CompressionStream?: unknown };
  const original = scope.CompressionStream;
  delete scope.CompressionStream;
  try {
    return run();
  } finally {
    scope.CompressionStream = original;
  }
}

afterEach(() => {
  expect(typeof CompressionStream).toBe('function');
});

describe('the compressor', () => {
  it('deflates, and the game can read its own output back', () => {
    // Round-tripped through the hand-rolled inflate rather than through
    // `DecompressionStream`: what matters is that the thing that ships can read
    // what the thing that ships wrote.
    const payload = payloadFor(3, 120);
    return encodeSharePayload(payload).then((encoded) => {
      expect(encoded).not.toBeNull();
      const decoded = decodeShare(encoded ?? '');
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.run.log.entries).toEqual(payload.log.entries);
      }
    });
  });

  it('picks the deflate codec for a run of any size', async () => {
    const encoded = (await encodeSharePayload(payloadFor(4, 200))) ?? '';
    expect(fromBase64Url(encoded)?.[1]).toBe(SHARE_CODEC_DEFLATE);
  });

  it('falls back to storing the bytes when the platform has no compressor', async () => {
    const payload = payloadFor(5, 120);
    const encoded = await withoutCompression(() => encodeSharePayload(payload));
    expect(encoded).not.toBeNull();
    expect(fromBase64Url(encoded ?? '')?.[1]).toBe(SHARE_CODEC_STORED);
    // And the link still works, which is the entire point of the fallback.
    const decoded = decodeShare(encoded ?? '');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.run.log.entries).toEqual(payload.log.entries);
    }
  });

  it('returns null rather than throwing when there is no compressor', async () => {
    expect(await withoutCompression(() => deflateBytes(new Uint8Array([1, 2, 3])))).toBeNull();
  });

  it('makes a real run meaningfully smaller', async () => {
    const payload = payloadFor(6, 300);
    const compressed = (await encodeSharePayload(payload))?.length ?? 0;
    const stored = (await withoutCompression(() => encodeSharePayload(payload)))?.length ?? 0;
    expect(compressed).toBeLessThan(stored);
  });
});

describe('the link', () => {
  it('puts the run in the fragment, where no server will ever see it', async () => {
    const link = await buildShareLink('https://example.test/game/', payloadFor(7, 60));
    expect(link.ok).toBe(true);
    if (!link.ok) {
      return;
    }
    expect(link.url.startsWith('https://example.test/game/#r=')).toBe(true);
    expect(readShareFragment(link.url.slice(link.url.indexOf('#')))).toBe(link.payload);
  });

  it('round-trips a real run all the way back to the same final state', async () => {
    const run = recordRun(8, 150);
    const link = await buildShareLink('https://example.test/', {
      mode: 'marathon',
      seed: 8,
      startLevel: 1,
      log: run.log,
    });
    expect(link.ok).toBe(true);
    if (!link.ok) {
      return;
    }
    const fragment = readShareFragment(link.url.slice(link.url.indexOf('#'))) ?? '';
    const decoded = decodeShare(fragment);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(
      replay(
        decoded.run.seed,
        { startLevel: decoded.run.startLevel, mode: decoded.run.mode },
        decoded.run.log,
      ),
    ).toEqual(run.state);
  });

  it('fits a couple of minutes of real play in something pasteable', async () => {
    const link = await buildShareLink('https://example.test/', payloadFor(9, 250));
    expect(link.ok).toBe(true);
    if (link.ok) {
      expect(link.payload.length).toBeLessThan(MAX_SHARE_CHARS);
    }
  });

  it('says so plainly when a run is too long to link', async () => {
    // The honest path. A log of thirty thousand entries cannot fit and must not
    // be pretended into a URL that a chat client will cut in half.
    const enormous: ReplayLog = {
      durationMs: 3_000_000,
      entries: Array.from({ length: 15_000 }, (_, index) => ({
        t: index * 200,
        input: 'moveLeft' as const,
      })),
      truncated: false,
    };
    const link = await buildShareLink('https://example.test/', {
      mode: 'marathon',
      seed: 1,
      startLevel: 1,
      log: enormous,
    });
    expect(link).toEqual({ ok: false, reason: 'tooLong' });
  });

  it('links an empty run rather than falling over on it', async () => {
    const link = await buildShareLink('https://example.test/', {
      mode: 'ultra',
      seed: 2,
      startLevel: 1,
      log: emptyLog(),
    });
    expect(link.ok).toBe(true);
  });
});

describe('the score-only line', () => {
  it('says what happened, and offers the game rather than a replay', () => {
    const text = runShareText({
      mode: 'marathon',
      score: 12_340,
      lines: 42,
      level: 5,
      durationMs: 185_000,
      url: 'https://example.test/',
    });
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toContain('Marathon');
    expect(text).toContain('12,340 points');
    expect(text).toContain('42 lines');
    expect(text).toContain('3:05');
    expect(text).toContain('https://example.test/');
    // It is not a replay and does not pretend to be one.
    expect(text).not.toContain('#r=');
  });
});

/**
 * A match is not a shareable run, and the refusal is a sentence rather than a
 * silence.
 *
 * A tape is one player's keys against a seed. That is the whole of a solo run
 * and nowhere near the whole of a versus one: the opponent's attacks landed on
 * the player's clock at moments no tape records. Both ends refuse — this one so
 * the game never makes such a link, and `decodeShare` so it never opens one.
 */
describe('a versus match in a link', () => {
  it('is refused rather than built', async () => {
    const link = await buildShareLink('https://example.test/', {
      mode: 'versus',
      seed: 42,
      startLevel: 1,
      log: emptyLog(),
    });

    expect(link.ok).toBe(false);
    expect(link.ok === false && link.reason).toBe('match');
  });

  it('still builds a link for every mode that can actually be replayed', async () => {
    for (const mode of ['marathon', 'sprint', 'ultra'] as const) {
      const link = await buildShareLink('https://example.test/', {
        mode,
        seed: 42,
        startLevel: 1,
        log: emptyLog(),
      });

      expect(link.ok, mode).toBe(true);
    }
  });
});
