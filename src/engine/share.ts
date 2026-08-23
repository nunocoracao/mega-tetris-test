/**
 * A run in a link.
 *
 * `{version, mode, seed, startLevel, log}` squeezed into something that
 * survives being pasted into a chat window: a compact byte format, optionally
 * deflated, base64url'd, and carried in the URL fragment so it never reaches a
 * server. There is no server.
 *
 * ## Two rules govern everything in this file
 *
 * **A fragment is a stranger's input.** Exactly like `localStorage` in
 * `ui/storage.ts`, it can be truncated by a chat client, mangled by a link
 * rewriter, hand-edited, or simply hostile. So `decodeShare` is total: it
 * returns a rejection for anything it cannot make sense of, it never throws,
 * and it never allocates on the strength of a number it read out of the input.
 * Every length in the payload is checked against a cap *before* it is used.
 *
 * **Decoding is pure and synchronous.** The compressor is
 * `CompressionStream`, which is asynchronous and not everywhere; the
 * decompressor is ours, a hundred-odd lines of raw DEFLATE at the bottom of
 * this file. That asymmetry is deliberate. Writing a link can afford to be
 * async and can always fall back to storing the bytes uncompressed; *reading*
 * one has to work on the first frame, in whatever browser the link was opened
 * in, or a friend's link is a broken promise. No dependency either way — a
 * compression library would cost more than the whole game.
 */

import {
  MAX_LOG_ENTRIES,
  MAX_REPLAY_MS,
  REPLAY_FORMAT_VERSION,
  REPLAY_INPUTS,
  type ReplayEntry,
  type ReplayLog,
} from './replay';
import { GAME_MODES, type GameMode } from './game';

/** How the body was packed. 0 is the bytes as they are; 1 is zlib deflate. */
export const SHARE_CODEC_STORED = 0;
export const SHARE_CODEC_DEFLATE = 1;

/**
 * The longest encoded payload this build will *produce*.
 *
 * Four thousand base64url characters — a URL of about 4.2 KB once the origin
 * and the `#r=` are on the front. Comfortably inside what browsers, chat
 * clients and link previewers all handle, and enough for a run of a couple of
 * thousand inputs. A run that does not fit gets an honest "too long to link"
 * and the score-only share line instead of a link that quietly does not work.
 */
export const MAX_SHARE_CHARS = 4000;

/**
 * The longest payload this build will *read*. Twice what it writes, so a link
 * from a slightly more generous future build is still given a chance, and a
 * hard stop long before anything expensive happens.
 */
export const MAX_DECODE_CHARS = 8192;

/** The most bytes a payload may expand to. A deflate bomb stops here. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * How far ahead a format version may plausibly be. A link stamped beyond this
 * is not a Mega Tetris link from the future, it is noise — see `decodeChecked`.
 */
const PLAUSIBLE_VERSIONS = 16;

/** The start level a link may claim. Beyond this it is not one of ours. */
const MAX_SHARE_START_LEVEL = 99;

/** The fragment a shared run travels in: `#r=<payload>`. */
export const SHARE_FRAGMENT_KEY = 'r';

/** Everything a link carries. The version is stamped on by the encoder. */
export interface SharePayload {
  readonly mode: GameMode;
  readonly seed: number;
  readonly startLevel: number;
  readonly log: ReplayLog;
}

/** A decoded link: the payload, plus the format version it was written in. */
export interface SharedRun extends SharePayload {
  readonly version: number;
}

/**
 * Why a link was refused. The UI turns these into one sentence each; keeping
 * them apart is what lets "made by a newer version" say something more useful
 * than "that did not work".
 */
export type ShareErrorReason = 'empty' | 'oversize' | 'version' | 'malformed';

export type ShareResult =
  | { readonly ok: true; readonly run: SharedRun }
  | { readonly ok: false; readonly reason: ShareErrorReason; readonly message: string };

/** The one place a rejection is worded. Friendly, and never blames the player. */
export const SHARE_ERROR_MESSAGES: Readonly<Record<ShareErrorReason, string>> = {
  empty: 'That link did not carry a replay.',
  oversize: 'That replay link did not work — it is too big to be one of ours.',
  version:
    'That replay link was made by a different version of Mega Tetris, so it cannot be played back here.',
  malformed: 'That replay link did not work — it looks damaged or incomplete.',
};

function reject(reason: ShareErrorReason): ShareResult {
  return { ok: false, reason, message: SHARE_ERROR_MESSAGES[reason] };
}

// ---------------------------------------------------------------------------
// Bytes in, bytes out
// ---------------------------------------------------------------------------

/** A growable byte sink. Doubling beats `number[]` and beats re-allocating. */
class ByteWriter {
  private bytes = new Uint8Array(256);
  private length = 0;

  push(value: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length] = value & 0xff;
    this.length += 1;
  }

  /** LEB128: seven bits a byte, high bit set while more follow. */
  pushVarint(value: number): void {
    let remaining = Math.max(0, Math.floor(value));
    while (remaining >= 0x80) {
      this.push((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 0x80);
    }
    this.push(remaining);
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

/** A cursor over bytes that reports overruns rather than reading rubbish. */
class ByteReader {
  private offset = 0;
  private failed = false;

  constructor(private readonly bytes: Uint8Array) {}

  get broken(): boolean {
    return this.failed;
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  byte(): number {
    if (this.offset >= this.bytes.length) {
      this.failed = true;
      return 0;
    }
    const value = this.bytes[this.offset] ?? 0;
    this.offset += 1;
    return value;
  }

  /** Bounded on both ends: at most five bytes, and never past the buffer. */
  varint(): number {
    let value = 0;
    let scale = 1;
    for (let step = 0; step < 5; step += 1) {
      const byte = this.byte();
      if (this.failed) {
        return 0;
      }
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        return value;
      }
      scale *= 0x80;
    }
    this.failed = true;
    return 0;
  }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Built once: character code → six-bit value, or −1 for "not one of ours". */
const BASE64URL_VALUES = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let index = 0; index < BASE64URL_ALPHABET.length; index += 1) {
    table[BASE64URL_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/** Bytes → base64url, unpadded. Hand-rolled so no platform global is needed. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const left = bytes.length - index;
    out += BASE64URL_ALPHABET[a >> 2];
    out += BASE64URL_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    if (left > 1) {
      out += BASE64URL_ALPHABET[((b & 0x0f) << 2) | (c >> 6)];
    }
    if (left > 2) {
      out += BASE64URL_ALPHABET[c & 0x3f];
    }
  }
  return out;
}

/** base64url → bytes, or `null` for anything that is not base64url. */
export function fromBase64Url(text: string): Uint8Array | null {
  const remainder = text.length % 4;
  if (remainder === 1) {
    return null;
  }
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let written = 0;
  let accumulator = 0;
  let bits = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const value = code < 128 ? (BASE64URL_VALUES[code] ?? -1) : -1;
    if (value < 0) {
      return null;
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (accumulator >> bits) & 0xff;
      written += 1;
    }
  }
  // Whatever is left over must be padding bits, and padding bits must be zero.
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
    return null;
  }
  return bytes.slice(0, written);
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * The run as bytes, before any compression.
 *
 * Times are delta-encoded and folded together with the input index into one
 * varint (`gap * inputCount + input`), which is what makes the common case —
 * a keypress a tenth of a second after the last one — cost two bytes rather
 * than three. `ReplayLog` itself keeps absolute times, because that is the
 * readable form; this is the wire.
 */
export function sharePayloadBytes(payload: SharePayload): Uint8Array {
  const writer = new ByteWriter();
  const modeIndex = Math.max(0, GAME_MODES.indexOf(payload.mode));
  writer.pushVarint(payload.seed);
  writer.push(modeIndex);
  writer.pushVarint(payload.startLevel);
  writer.pushVarint(payload.log.durationMs);
  writer.pushVarint(payload.log.entries.length);

  let previous = 0;
  for (const entry of payload.log.entries) {
    const gap = Math.max(0, Math.round(entry.t) - previous);
    previous += gap;
    const index = Math.max(0, REPLAY_INPUTS.indexOf(entry.input));
    writer.pushVarint(gap * REPLAY_INPUTS.length + index);
  }
  return writer.finish();
}

/**
 * Wrap the body in its two-byte header and base64url it, picking whichever of
 * the stored and deflated forms is smaller.
 *
 * The header is deliberately *outside* the compression: a link from an
 * incompatible version has to be recognised as one before anything is
 * decompressed. Returns `null` when the result would be longer than
 * `MAX_SHARE_CHARS` — the caller's cue to offer the score-only share line
 * instead of a link that will not survive being pasted.
 */
export function packShare(body: Uint8Array, deflated: Uint8Array | null): string | null {
  const useDeflate = deflated !== null && deflated.length < body.length;
  const chosen = useDeflate && deflated !== null ? deflated : body;
  const bytes = new Uint8Array(chosen.length + 2);
  bytes[0] = REPLAY_FORMAT_VERSION;
  bytes[1] = useDeflate ? SHARE_CODEC_DEFLATE : SHARE_CODEC_STORED;
  bytes.set(chosen, 2);
  const text = toBase64Url(bytes);
  return text.length > MAX_SHARE_CHARS ? null : text;
}

/**
 * Read a link. Total: every path out of here is a `ShareResult`, and none of
 * them throws.
 */
export function decodeShare(text: string): ShareResult {
  try {
    return decodeChecked(text);
  } catch {
    // Nothing below is supposed to throw; if something does, it is still a bad
    // link and not a crashed game.
    return reject('malformed');
  }
}

function decodeChecked(text: string): ShareResult {
  if (typeof text !== 'string' || text.length === 0) {
    return reject('empty');
  }
  if (text.length > MAX_DECODE_CHARS) {
    return reject('oversize');
  }

  const bytes = fromBase64Url(text);
  if (bytes === null || bytes.length < 2) {
    return reject('malformed');
  }

  const version = bytes[0] ?? 0;
  if (version !== REPLAY_FORMAT_VERSION) {
    // "Made by a different version" and "this is not a replay link at all" are
    // different pieces of news, and the first is only worth saying when it is
    // plausibly true. Random junk lands on a random first byte, so without this
    // range check 255 links out of 256 pieces of garbage would blame a version
    // that does not exist. A real future format will be 2, or 3 — not 207.
    return reject(version >= 1 && version <= PLAUSIBLE_VERSIONS ? 'version' : 'malformed');
  }

  const codec = bytes[1] ?? 0;
  const packed = bytes.subarray(2);
  let body: Uint8Array | null;
  if (codec === SHARE_CODEC_STORED) {
    body = packed.length > MAX_BODY_BYTES ? null : packed;
  } else if (codec === SHARE_CODEC_DEFLATE) {
    body = inflateZlib(packed, MAX_BODY_BYTES);
  } else {
    return reject('malformed');
  }
  if (body === null) {
    return reject('malformed');
  }

  return readBody(body, version);
}

function readBody(body: Uint8Array, version: number): ShareResult {
  const reader = new ByteReader(body);
  const seed = reader.varint();
  const modeIndex = reader.byte();
  const startLevel = reader.varint();
  const durationMs = reader.varint();
  const count = reader.varint();
  if (reader.broken) {
    return reject('malformed');
  }

  const mode = GAME_MODES[modeIndex];
  if (mode === undefined) {
    return reject('malformed');
  }
  if (startLevel < 1 || startLevel > MAX_SHARE_START_LEVEL) {
    return reject('malformed');
  }
  if (durationMs > MAX_REPLAY_MS) {
    return reject('oversize');
  }
  // Checked before a single entry is allocated: a four-byte varint can claim
  // a hundred million entries, and believing it would be the whole attack.
  if (count > MAX_LOG_ENTRIES) {
    return reject('oversize');
  }
  // Two bytes minimum per entry is generous; one is the real floor. Either way
  // a count that could not possibly fit in what is left is a broken payload,
  // and catching it here means the loop below cannot spin.
  if (count > body.length) {
    return reject('malformed');
  }

  const entries: ReplayEntry[] = [];
  let t = 0;
  for (let index = 0; index < count; index += 1) {
    const packed = reader.varint();
    if (reader.broken) {
      return reject('malformed');
    }
    const inputIndex = packed % REPLAY_INPUTS.length;
    const gap = (packed - inputIndex) / REPLAY_INPUTS.length;
    const input = REPLAY_INPUTS[inputIndex];
    if (input === undefined) {
      return reject('malformed');
    }
    t += gap;
    if (t > MAX_REPLAY_MS) {
      return reject('oversize');
    }
    entries.push({ t, input });
  }

  // Strict about what is left over: trailing bytes mean this was not written
  // by us, and quietly ignoring them is how a format stops being a format.
  if (reader.broken || !reader.done) {
    return reject('malformed');
  }
  if (durationMs < t) {
    return reject('malformed');
  }

  return {
    ok: true,
    run: {
      version,
      mode,
      seed,
      startLevel,
      log: { durationMs, entries, truncated: false },
    },
  };
}

// ---------------------------------------------------------------------------
// The fragment
// ---------------------------------------------------------------------------

/** `<payload>` → `#r=<payload>`. */
export function shareFragment(payload: string): string {
  return `#${SHARE_FRAGMENT_KEY}=${payload}`;
}

/**
 * Pull the payload out of a `location.hash`, or `null` if there is not one.
 *
 * Tolerant about the shape of the hash — a leading `#`, other keys beside ours,
 * either separator — because a link that has been through a chat client, an
 * analytics rewriter and a paste has usually collected something.
 */
export function readShareFragment(hash: string): string | null {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  if (trimmed.length === 0) {
    return null;
  }
  for (const part of trimmed.split(/[&;]/)) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator) === SHARE_FRAGMENT_KEY) {
      return part.slice(separator + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Raw DEFLATE, by hand
// ---------------------------------------------------------------------------

/**
 * zlib-wrapped deflate → bytes, or `null` for anything malformed.
 *
 * This is the "small hand-rolled fallback" the dependency budget asks for, and
 * it is the *only* decompressor the game ships: `DecompressionStream` is
 * asynchronous and merely widely available, and a friend's link has to open on
 * the first frame in whatever browser they clicked it in.
 *
 * The header is two bytes — compression method and flags — with a checksum
 * relation that is worth verifying, because it costs nothing and rejects an
 * enormous share of accidental garbage before any real work happens. The Adler
 * checksum on the tail is deliberately *not* verified: it would be a second
 * hundred lines to catch what the format checks below already catch.
 */
export function inflateZlib(bytes: Uint8Array, maxOut: number): Uint8Array | null {
  if (bytes.length < 2) {
    return null;
  }
  const cmf = bytes[0] ?? 0;
  const flg = bytes[1] ?? 0;
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20) !== 0) {
    return null;
  }
  return inflateRaw(bytes.subarray(2), maxOut);
}

/** The lengths a length code stands for, and how many extra bits it carries. */
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
/** The order the code-length code lengths arrive in. Not an accident; a spec. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman table, counted by length — the compact `puff` shape. */
interface Huffman {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
}

function buildHuffman(lengths: Uint8Array, count: number): Huffman {
  const counts = new Uint16Array(16);
  for (let index = 0; index < count; index += 1) {
    counts[lengths[index] ?? 0] = (counts[lengths[index] ?? 0] ?? 0) + 1;
  }
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let length = 1; length < 16; length += 1) {
    offsets[length] = (offsets[length - 1] ?? 0) + (counts[length - 1] ?? 0);
  }
  const symbols = new Uint16Array(count);
  for (let index = 0; index < count; index += 1) {
    const length = lengths[index] ?? 0;
    if (length !== 0) {
      symbols[offsets[length] ?? 0] = index;
      offsets[length] = (offsets[length] ?? 0) + 1;
    }
  }
  return { counts, symbols };
}

let FIXED_LITERALS: Huffman | null = null;
let FIXED_DISTANCES: Huffman | null = null;

function fixedTables(): { literals: Huffman; distances: Huffman } {
  if (FIXED_LITERALS === null || FIXED_DISTANCES === null) {
    const literals = new Uint8Array(288);
    literals.fill(8, 0, 144);
    literals.fill(9, 144, 256);
    literals.fill(7, 256, 280);
    literals.fill(8, 280, 288);
    FIXED_LITERALS = buildHuffman(literals, 288);
    const distances = new Uint8Array(30).fill(5);
    FIXED_DISTANCES = buildHuffman(distances, 30);
  }
  return { literals: FIXED_LITERALS, distances: FIXED_DISTANCES };
}

/**
 * The decompressor proper.
 *
 * Every failure — a reserved block type, a bit read off the end, a symbol with
 * no code, a back-reference pointing before the start of the output, an output
 * longer than `maxOut` — comes back as `null`. There is no path that throws and
 * no path that allocates more than `maxOut`.
 */
export function inflateRaw(bytes: Uint8Array, maxOut: number): Uint8Array | null {
  let out = new Uint8Array(Math.min(1024, Math.max(64, maxOut)));
  let outLength = 0;
  let bitPosition = 0;
  let broken = false;

  function bits(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byteIndex = bitPosition >> 3;
      if (byteIndex >= bytes.length) {
        broken = true;
        return 0;
      }
      value |= (((bytes[byteIndex] ?? 0) >> (bitPosition & 7)) & 1) << index;
      bitPosition += 1;
    }
    return value;
  }

  function put(byte: number): boolean {
    if (outLength >= maxOut) {
      broken = true;
      return false;
    }
    if (outLength === out.length) {
      const grown = new Uint8Array(Math.min(maxOut, out.length * 2));
      grown.set(out);
      out = grown;
    }
    out[outLength] = byte;
    outLength += 1;
    return true;
  }

  /** Walk the code bit by bit; −1 when the bits are not a code at all. */
  function decode(table: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length < 16; length += 1) {
      code |= bits(1);
      if (broken) {
        return -1;
      }
      const count = table.counts[length] ?? 0;
      if (code - first < count) {
        return table.symbols[index + (code - first)] ?? -1;
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return -1;
  }

  function block(literals: Huffman, distances: Huffman): boolean {
    for (;;) {
      const symbol = decode(literals);
      if (symbol < 0) {
        return false;
      }
      if (symbol < 256) {
        if (!put(symbol)) {
          return false;
        }
        continue;
      }
      if (symbol === 256) {
        return true;
      }
      const lengthIndex = symbol - 257;
      if (lengthIndex >= LENGTH_BASE.length) {
        return false;
      }
      const length = (LENGTH_BASE[lengthIndex] ?? 0) + bits(LENGTH_EXTRA[lengthIndex] ?? 0);
      const distanceSymbol = decode(distances);
      if (distanceSymbol < 0 || distanceSymbol >= DIST_BASE.length) {
        return false;
      }
      const distance =
        (DIST_BASE[distanceSymbol] ?? 0) + bits(DIST_EXTRA[distanceSymbol] ?? 0);
      if (broken || distance <= 0 || distance > outLength) {
        return false;
      }
      for (let step = 0; step < length; step += 1) {
        if (!put(out[outLength - distance] ?? 0)) {
          return false;
        }
      }
    }
  }

  function dynamicTables(): { literals: Huffman; distances: Huffman } | null {
    const literalCount = bits(5) + 257;
    const distanceCount = bits(5) + 1;
    const codeCount = bits(4) + 4;
    if (broken || literalCount > 286 || distanceCount > 30) {
      return null;
    }
    const codeLengths = new Uint8Array(19);
    for (let index = 0; index < codeCount; index += 1) {
      codeLengths[CODE_LENGTH_ORDER[index] ?? 0] = bits(3);
    }
    if (broken) {
      return null;
    }
    const codeTable = buildHuffman(codeLengths, 19);

    const lengths = new Uint8Array(literalCount + distanceCount);
    let index = 0;
    while (index < lengths.length) {
      const symbol = decode(codeTable);
      if (symbol < 0) {
        return null;
      }
      if (symbol < 16) {
        lengths[index] = symbol;
        index += 1;
        continue;
      }
      let repeat = 0;
      let value = 0;
      if (symbol === 16) {
        if (index === 0) {
          return null;
        }
        value = lengths[index - 1] ?? 0;
        repeat = 3 + bits(2);
      } else if (symbol === 17) {
        repeat = 3 + bits(3);
      } else {
        repeat = 11 + bits(7);
      }
      if (broken || index + repeat > lengths.length) {
        return null;
      }
      lengths.fill(value, index, index + repeat);
      index += repeat;
    }

    return {
      literals: buildHuffman(lengths.subarray(0, literalCount), literalCount),
      distances: buildHuffman(lengths.subarray(literalCount), distanceCount),
    };
  }

  for (;;) {
    const final = bits(1);
    const type = bits(2);
    if (broken) {
      return null;
    }
    if (type === 0) {
      // Stored: skip to the byte boundary, then a length and its complement.
      bitPosition = (bitPosition + 7) & ~7;
      const start = bitPosition >> 3;
      if (start + 4 > bytes.length) {
        return null;
      }
      const length = (bytes[start] ?? 0) | ((bytes[start + 1] ?? 0) << 8);
      const complement = (bytes[start + 2] ?? 0) | ((bytes[start + 3] ?? 0) << 8);
      if ((length ^ 0xffff) !== complement || start + 4 + length > bytes.length) {
        return null;
      }
      for (let step = 0; step < length; step += 1) {
        if (!put(bytes[start + 4 + step] ?? 0)) {
          return null;
        }
      }
      bitPosition = (start + 4 + length) << 3;
    } else if (type === 1) {
      const { literals, distances } = fixedTables();
      if (!block(literals, distances)) {
        return null;
      }
    } else if (type === 2) {
      const tables = dynamicTables();
      if (tables === null || !block(tables.literals, tables.distances)) {
        return null;
      }
    } else {
      return null;
    }
    if (final === 1) {
      break;
    }
  }

  return out.slice(0, outLength);
}
