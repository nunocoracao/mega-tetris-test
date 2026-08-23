/**
 * The decoder is the only part of this game that reads something a stranger
 * wrote, so it is the part that gets the rough treatment: truncated payloads,
 * oversized payloads, payloads from a version that does not exist, and several
 * thousand pieces of pure junk. The bar is not "handles it gracefully" — it is
 * **never throws and never returns a run it did not fully understand**.
 *
 * The compressor is checked against `node:zlib`, which is the only way to know
 * the hand-rolled inflate at the bottom of `share.ts` is a real DEFLATE
 * decoder rather than something that happens to undo our own compressor.
 */

import { deflateSync, deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { createRandom } from './random';
import {
  MAX_DECODE_CHARS,
  MAX_SHARE_CHARS,
  SHARE_CODEC_DEFLATE,
  SHARE_CODEC_STORED,
  decodeShare,
  fromBase64Url,
  inflateRaw,
  inflateZlib,
  packShare,
  readShareFragment,
  shareFragment,
  sharePayloadBytes,
  toBase64Url,
  type SharePayload,
} from './share';
import {
  MAX_LOG_ENTRIES,
  REPLAY_FORMAT_VERSION,
  REPLAY_INPUTS,
  createRecorder,
  emptyLog,
  replay,
  type ReplayEntry,
  type ReplayInput,
  type ReplayLog,
} from './replay';
import { applyInput, createGame, update, type GameState } from './game';

// ---------------------------------------------------------------------------
// A run to put in a link
// ---------------------------------------------------------------------------

/** A believable log, seeded so a failure can be re-run. */
function makeLog(seed: number, count: number): ReplayLog {
  const random = createRandom(seed);
  const entries: ReplayEntry[] = [];
  let t = 0;
  for (let index = 0; index < count; index += 1) {
    t += Math.floor(random() * 220);
    const input = REPLAY_INPUTS[Math.floor(random() * REPLAY_INPUTS.length)] ?? 'moveLeft';
    entries.push({ t, input });
  }
  return { durationMs: t + 500, entries, truncated: false };
}

function makePayload(seed = 12_345, count = 400): SharePayload {
  return { mode: 'marathon', seed, startLevel: 1, log: makeLog(seed, count) };
}

/** The encoder, without the browser's compressor: the stored path. */
function packStored(payload: SharePayload): string {
  const text = packShare(sharePayloadBytes(payload), null);
  expect(text).not.toBeNull();
  return text ?? '';
}

/** The encoder with a real deflate, standing in for `CompressionStream`. */
function packDeflated(payload: SharePayload): string {
  const body = sharePayloadBytes(payload);
  const text = packShare(body, new Uint8Array(deflateSync(body)));
  expect(text).not.toBeNull();
  return text ?? '';
}

/** Play a real run, so at least one round trip is a run and not a fixture. */
function playRealRun(seed: number, presses: number): { state: GameState; log: ReplayLog } {
  const random = createRandom(seed);
  const recorder = createRecorder();
  let state = createGame({ seed });
  const send = (input: ReplayInput): void => {
    recorder.record(state.elapsedMs, input);
    state = applyInput(state, { type: input });
  };
  send('resume');
  for (let index = 0; index < presses; index += 1) {
    send(REPLAY_INPUTS[Math.floor(random() * (REPLAY_INPUTS.length - 2))] ?? 'moveLeft');
    let left = 1 + Math.floor(random() * 120);
    while (left > 0) {
      const frame = Math.min(left, 17);
      state = update(state, frame);
      left -= frame;
      recorder.mark(state.elapsedMs);
    }
  }
  recorder.mark(state.elapsedMs);
  return { state, log: recorder.log() };
}

// ---------------------------------------------------------------------------

describe('base64url', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) {
      bytes[index] = index;
    }
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it('round-trips every length modulo four', () => {
    for (let length = 0; length < 9; length += 1) {
      const bytes = new Uint8Array(length).fill(0xa5);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it('uses only URL-safe characters and no padding', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x01]);
    expect(toBase64Url(bytes)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses anything that is not base64url', () => {
    expect(fromBase64Url('****')).toBeNull();
    expect(fromBase64Url('AA==')).toBeNull();
    expect(fromBase64Url('A')).toBeNull();
    // Leftover bits have to be zero, or the same bytes would have two spellings
    // and a payload could be smuggled past a length check.
    expect(fromBase64Url('AB')).toBeNull();
    expect(fromBase64Url('AA')).toEqual(new Uint8Array([0]));
  });
});

describe('the hand-rolled inflate', () => {
  it('undoes zlib, which is the only proof it is really DEFLATE', () => {
    // If this only ever undid our own compressor it would prove nothing. These
    // are bytes deflated by zlib, at every level, in all three block types it
    // reaches for.
    const samples: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([1]),
      new Uint8Array(5000).fill(7),
      sharePayloadBytes(makePayload(1, 900)),
      (() => {
        const random = createRandom(9);
        const noise = new Uint8Array(4096);
        for (let index = 0; index < noise.length; index += 1) {
          noise[index] = Math.floor(random() * 256);
        }
        return noise;
      })(),
    ];
    for (const sample of samples) {
      for (const level of [0, 1, 6, 9]) {
        expect(inflateZlib(new Uint8Array(deflateSync(sample, { level })), 1 << 20)).toEqual(
          sample,
        );
        expect(inflateRaw(new Uint8Array(deflateRawSync(sample, { level })), 1 << 20)).toEqual(
          sample,
        );
      }
    }
  });

  it('stops at the output cap rather than expanding a bomb', () => {
    const bomb = new Uint8Array(deflateSync(new Uint8Array(200_000)));
    expect(bomb.length).toBeLessThan(1000);
    expect(inflateZlib(bomb, 4096)).toBeNull();
  });

  it('refuses a broken zlib header', () => {
    expect(inflateZlib(new Uint8Array([0, 0, 0, 0]), 1024)).toBeNull();
    expect(inflateZlib(new Uint8Array([0x78]), 1024)).toBeNull();
    expect(inflateZlib(new Uint8Array(0), 1024)).toBeNull();
  });

  it('refuses truncated and corrupted streams rather than throwing', () => {
    const good = new Uint8Array(deflateSync(sharePayloadBytes(makePayload(3, 200))));
    for (let cut = 2; cut < good.length; cut += 7) {
      expect(() => inflateZlib(good.subarray(0, cut), 1 << 20)).not.toThrow();
    }
    const random = createRandom(77);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const damaged = good.slice();
      const at = 2 + Math.floor(random() * (damaged.length - 2));
      damaged[at] = (damaged[at] ?? 0) ^ 0xff;
      expect(() => inflateZlib(damaged, 1 << 20)).not.toThrow();
    }
  });
});

describe('a run in a link', () => {
  it('round-trips through the stored codec', () => {
    const payload = makePayload();
    const decoded = decodeShare(packStored(payload));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.run.version).toBe(REPLAY_FORMAT_VERSION);
    expect(decoded.run.seed).toBe(payload.seed);
    expect(decoded.run.mode).toBe(payload.mode);
    expect(decoded.run.startLevel).toBe(payload.startLevel);
    expect(decoded.run.log.entries).toEqual(payload.log.entries);
    expect(decoded.run.log.durationMs).toBe(payload.log.durationMs);
  });

  it('round-trips through the deflate codec, and is smaller for it', () => {
    const payload = makePayload();
    const stored = packStored(payload);
    const deflated = packDeflated(payload);
    expect(deflated.length).toBeLessThan(stored.length);
    const decoded = decodeShare(deflated);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.run.log.entries).toEqual(payload.log.entries);
    }
  });

  it('keeps the stored form when deflate would not help', () => {
    // Tiny payloads deflate to *more* than they started as, because of the
    // header. Picking the smaller of the two is what stops a two-input replay
    // paying for a compression header it does not need.
    const payload: SharePayload = { mode: 'sprint', seed: 3, startLevel: 1, log: emptyLog() };
    const body = sharePayloadBytes(payload);
    const text = packShare(body, new Uint8Array(deflateSync(body))) ?? '';
    const bytes = fromBase64Url(text);
    expect(bytes?.[1]).toBe(SHARE_CODEC_STORED);
    expect(decodeShare(text).ok).toBe(true);
  });

  it('stamps the deflate codec when it is the smaller of the two', () => {
    const bytes = fromBase64Url(packDeflated(makePayload()));
    expect(bytes?.[1]).toBe(SHARE_CODEC_DEFLATE);
  });

  it('carries every mode and start level it is given', () => {
    for (const mode of ['marathon', 'sprint', 'ultra'] as const) {
      for (const startLevel of [1, 7, 10]) {
        const payload: SharePayload = { mode, seed: 42, startLevel, log: makeLog(5, 30) };
        const decoded = decodeShare(packStored(payload));
        expect(decoded.ok && decoded.run.mode).toBe(mode);
        expect(decoded.ok && decoded.run.startLevel).toBe(startLevel);
      }
    }
  });

  it('encodes, decodes, replays, and lands on the very same state', () => {
    // The end-to-end claim, in one test: a run played here, put in a link, and
    // rebuilt from that link alone, arrives at the same `GameState`.
    for (const seed of [2, 55, 90_210]) {
      const live = playRealRun(seed, 250);
      const payload: SharePayload = { mode: 'marathon', seed, startLevel: 1, log: live.log };
      const decoded = decodeShare(packDeflated(payload));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) {
        return;
      }
      const rebuilt = replay(decoded.run.seed, { startLevel: decoded.run.startLevel, mode: decoded.run.mode }, decoded.run.log);
      expect(rebuilt).toEqual(live.state);
    }
  });

  it('fits a real run in a link a chat window will not mangle', () => {
    // The budget the whole format is designed around. Four hundred inputs is a
    // couple of minutes of real play.
    const link = packDeflated(makePayload(8, 400));
    expect(link.length).toBeLessThan(MAX_SHARE_CHARS);
    expect(link.length).toBeLessThan(2000);
  });

  it('refuses to make a link for a run that is too long, rather than a broken one', () => {
    // The honest path: `packShare` returns `null`, and the caller offers the
    // score-only share line instead of a URL that would arrive cut in half.
    const enormous = makePayload(9, 12_000);
    expect(packShare(sharePayloadBytes(enormous), null)).toBeNull();
  });
});

describe('the fragment', () => {
  it('round-trips', () => {
    expect(readShareFragment(shareFragment('abc'))).toBe('abc');
    expect(readShareFragment('#r=abc')).toBe('abc');
    expect(readShareFragment('r=abc')).toBe('abc');
  });

  it('finds our key among others, and reports its absence', () => {
    expect(readShareFragment('#utm=1&r=abc')).toBe('abc');
    expect(readShareFragment('#r=abc&utm=1')).toBe('abc');
    expect(readShareFragment('')).toBeNull();
    expect(readShareFragment('#')).toBeNull();
    expect(readShareFragment('#something')).toBeNull();
    expect(readShareFragment('#rr=abc')).toBeNull();
  });
});

describe('a link from a stranger', () => {
  const good = packDeflated(makePayload(4, 120));

  it('says so when there is nothing there', () => {
    expect(decodeShare('')).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('refuses a payload too big to be one of ours, before decoding it', () => {
    const huge = 'A'.repeat(MAX_DECODE_CHARS + 1);
    expect(decodeShare(huge)).toMatchObject({ ok: false, reason: 'oversize' });
  });

  it('refuses a version it does not understand, and says which problem it is', () => {
    const bytes = fromBase64Url(good);
    expect(bytes).not.toBeNull();
    if (bytes === null) {
      return;
    }
    for (const version of [2, 3, 7, 16]) {
      const other = bytes.slice();
      other[0] = version;
      const result = decodeShare(toBase64Url(other));
      expect(result).toMatchObject({ ok: false, reason: 'version' });
      // The message has to be more useful than "that did not work": a player
      // with a link from another build should be told which problem it is.
      expect(result.ok === false && result.message).toContain('version');
    }
  });

  it('blames the format rather than a version when the version is nonsense', () => {
    // Junk lands on a random first byte. Without a plausibility range, 255
    // pieces of garbage out of every 256 would be blamed on a version of the
    // game that has never existed — which reads as "your friend is out of
    // date" when the truth is "that link is broken".
    const bytes = fromBase64Url(good);
    if (bytes === null) {
      return;
    }
    for (const version of [0, 17, 158, 207, 255]) {
      const other = bytes.slice();
      other[0] = version;
      expect(decodeShare(toBase64Url(other))).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('refuses a codec it does not understand', () => {
    const bytes = fromBase64Url(good)?.slice();
    if (bytes === undefined) {
      return;
    }
    bytes[1] = 9;
    expect(decodeShare(toBase64Url(bytes))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('refuses every truncation of a real link', () => {
    for (let length = 1; length < good.length; length += 1) {
      const result = decodeShare(good.slice(0, length));
      // A truncation can only ever be a rejection or — by pure chance at the
      // very end — a shorter run. What it may never be is a throw.
      expect(typeof result.ok).toBe('boolean');
      if (result.ok) {
        expect(result.run.log.entries.length).toBeLessThanOrEqual(120);
      }
    }
  });

  it('refuses a log that claims more entries than the payload could hold', () => {
    // The allocation guard. A four-byte varint can claim a hundred million
    // entries; believing it and sizing an array from it is the whole attack.
    const bytes = new Uint8Array([
      REPLAY_FORMAT_VERSION,
      SHARE_CODEC_STORED,
      1, // seed
      0, // mode
      1, // startLevel
      0, // durationMs
      0xff,
      0xff,
      0xff,
      0x7f, // entry count: about 268 million
    ]);
    const result = decodeShare(toBase64Url(bytes));
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toBe('oversize');
  });

  it('refuses a run that claims to have lasted longer than any run can', () => {
    const bytes = new Uint8Array([
      REPLAY_FORMAT_VERSION,
      SHARE_CODEC_STORED,
      1,
      0,
      1,
      0xff,
      0xff,
      0xff,
      0x7f, // durationMs: about 268 million ms, three days
      0,
    ]);
    expect(decodeShare(toBase64Url(bytes))).toMatchObject({ ok: false, reason: 'oversize' });
  });

  it('refuses trailing rubbish after a perfectly good run', () => {
    const bytes = fromBase64Url(packStored(makePayload(6, 20)));
    if (bytes === null) {
      return;
    }
    const extended = new Uint8Array(bytes.length + 3);
    extended.set(bytes);
    extended.set([1, 2, 3], bytes.length);
    expect(decodeShare(toBase64Url(extended))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('refuses a start level nobody could have played', () => {
    const payload: SharePayload = { mode: 'marathon', seed: 1, startLevel: 500, log: emptyLog() };
    expect(decodeShare(packStored(payload))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('never claims a cap it does not enforce', () => {
    expect(MAX_LOG_ENTRIES).toBeGreaterThan(0);
    expect(MAX_SHARE_CHARS).toBeLessThan(MAX_DECODE_CHARS);
  });

  it('survives several thousand pieces of pure junk without ever throwing', () => {
    // The fuzz. Random strings, random bytes, near-misses of a real link, and
    // real links with one bit flipped. Every one of them has to come back as a
    // `ShareResult`, and any run it does hand back has to be one the replayer
    // can be handed without blowing up.
    const random = createRandom(4242);
    const alphabets = [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
      'ABC=+/ \n\t<>&%#?',
      ' ÿ😀abc',
    ];

    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const alphabet = alphabets[attempt % alphabets.length] ?? '';
      const length = Math.floor(random() * 300);
      let junk = '';
      for (let index = 0; index < length; index += 1) {
        junk += alphabet[Math.floor(random() * alphabet.length)] ?? 'A';
      }
      const result = decodeShare(junk);
      expect(typeof result.ok).toBe('boolean');
      if (result.ok) {
        // Whatever it accepted has to be a run the engine can be handed.
        expect(() => replay(result.run.seed, { mode: result.run.mode }, result.run.log)).not.toThrow();
      }
    }

    // And the nastier half: real links with one character changed.
    for (let attempt = 0; attempt < 1500; attempt += 1) {
      const at = Math.floor(random() * good.length);
      const alphabet = alphabets[0] ?? '';
      const swapped =
        good.slice(0, at) + (alphabet[Math.floor(random() * alphabet.length)] ?? 'A') + good.slice(at + 1);
      const result = decodeShare(swapped);
      expect(typeof result.ok).toBe('boolean');
      if (result.ok) {
        expect(() =>
          replay(
            result.run.seed,
            { startLevel: result.run.startLevel, mode: result.run.mode },
            result.run.log,
          ),
        ).not.toThrow();
      }
    }
  });

  it('never hands back a run with an input it does not know', () => {
    const random = createRandom(11);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const bytes = new Uint8Array(2 + Math.floor(random() * 60));
      bytes[0] = REPLAY_FORMAT_VERSION;
      bytes[1] = random() < 0.5 ? SHARE_CODEC_STORED : SHARE_CODEC_DEFLATE;
      for (let index = 2; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(random() * 256);
      }
      const result = decodeShare(toBase64Url(bytes));
      if (result.ok) {
        for (const entry of result.run.log.entries) {
          expect(REPLAY_INPUTS).toContain(entry.input);
          expect(Number.isFinite(entry.t)).toBe(true);
          expect(entry.t).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

/**
 * A link that claims to be a match.
 *
 * The game never makes one — `ui/share.ts` refuses first — but a link is a
 * stranger's input and hand-editing one byte is free. Playing it back would
 * show a well that never took a single row of the garbage the real run did, so
 * the decoder refuses it in words. The three replayable modes are untouched,
 * which is the half of this that actually needs proving.
 */
describe('a versus link', () => {
  /** A payload with the mode byte written by hand, whatever the encoder thinks. */
  function linkForMode(mode: SharePayload['mode']): string {
    const body = sharePayloadBytes({ mode, seed: 424_242, startLevel: 1, log: emptyLog() });
    const packed = packShare(body, null);
    expect(packed, 'an empty log always fits').not.toBeNull();
    return packed ?? '';
  }

  it('is refused with a sentence that says why', () => {
    const result = decodeShare(linkForMode('versus'));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('match');
    expect(result.ok === false && result.message).toMatch(/match cannot be replayed/);
  });

  it('leaves every mode that can be replayed exactly as it was', () => {
    for (const mode of ['marathon', 'sprint', 'ultra'] as const) {
      const result = decodeShare(linkForMode(mode));

      expect(result.ok, mode).toBe(true);
      expect(result.ok && result.run.mode).toBe(mode);
      expect(result.ok && result.run.seed).toBe(424_242);
    }
  });
});
