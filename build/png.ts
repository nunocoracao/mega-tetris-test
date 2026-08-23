/**
 * A rasteriser and a PNG encoder, in about a hundred lines.
 *
 * The icon is five rounded rectangles. Turning five rounded rectangles into a
 * PNG does not need an image library, a headless browser or a build plugin with
 * a native binary attached to it — it needs a point-in-rounded-rect test, some
 * supersampling, and `node:zlib`. That is the whole of this file, and it is the
 * reason the project still has no runtime dependencies and no image assets.
 *
 * Everything here is deterministic: the same shapes and the same size produce
 * byte-identical output, which is what lets the build be reproducible and the
 * tests assert on real bytes.
 */

import { deflateSync } from 'node:zlib';

import type { IconShape } from './icon';

/** Samples per pixel per axis. Sixteen samples is plenty for a rounded corner. */
const SUBSAMPLES = 4;

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** `#rgb` and `#rrggbb`. The palette writes nothing else for these properties. */
export function parseHex(value: string): Rgb {
  const text = value.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (short !== null) {
    return {
      r: Number.parseInt(`${short[1]}${short[1]}`, 16),
      g: Number.parseInt(`${short[2]}${short[2]}`, 16),
      b: Number.parseInt(`${short[3]}${short[3]}`, 16),
    };
  }
  if (long !== null) {
    return {
      r: Number.parseInt(long[1] ?? '0', 16),
      g: Number.parseInt(long[2] ?? '0', 16),
      b: Number.parseInt(long[3] ?? '0', 16),
    };
  }
  throw new Error(`The icon can only be drawn in hex colours; got "${value}".`);
}

/**
 * Is the point inside the rounded rectangle?
 *
 * Clamp the point into the rectangle the corner arcs are centred on: inside the
 * straight parts one of the two offsets is zero and the test is the bounds
 * check, and inside a corner it is the distance to that corner's centre.
 */
function inside(px: number, py: number, shape: IconShape): boolean {
  if (px < shape.x || py < shape.y || px > shape.x + shape.w || py > shape.y + shape.h) {
    return false;
  }
  if (shape.r <= 0) {
    return true;
  }
  const cx = Math.min(Math.max(px, shape.x + shape.r), shape.x + shape.w - shape.r);
  const cy = Math.min(Math.max(py, shape.y + shape.r), shape.y + shape.h - shape.r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= shape.r * shape.r;
}

/**
 * The shapes, painted back to front into `size × size` RGBA pixels.
 *
 * Antialiasing is supersampling and nothing cleverer: each pixel is probed on a
 * 4×4 grid, the topmost shape containing each probe wins it, and the pixel is
 * the average. Coverage becomes alpha, which is what gives the rounded tile a
 * clean edge against a home screen of any colour.
 */
export function rasterize(
  shapes: readonly IconShape[],
  size: number,
  tile: number,
): Uint8Array {
  const colors = shapes.map((shape) => parseHex(shape.fill));
  const pixels = new Uint8Array(size * size * 4);
  const scale = tile / size;
  const step = scale / SUBSAMPLES;
  const first = step / 2;
  const total = SUBSAMPLES * SUBSAMPLES;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
        const py = y * scale + first + sy * step;
        for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
          const px = x * scale + first + sx * step;
          for (let index = shapes.length - 1; index >= 0; index -= 1) {
            const shape = shapes[index];
            if (shape !== undefined && inside(px, py, shape)) {
              const color = colors[index];
              if (color !== undefined) {
                r += color.r;
                g += color.g;
                b += color.b;
                hits += 1;
              }
              break;
            }
          }
        }
      }

      const offset = (y * size + x) * 4;
      if (hits > 0) {
        pixels[offset] = Math.round(r / hits);
        pixels[offset + 1] = Math.round(g / hits);
        pixels[offset + 2] = Math.round(b / hits);
        pixels[offset + 3] = Math.round((hits / total) * 255);
      }
    }
  }

  return pixels;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 8-bit RGBA, no interlacing, filter 0 on every scanline.
 *
 * The filters exist to help the compressor find patterns in photographs. This
 * image is flat colour, which deflate already compresses to nothing, so paying
 * for a filter search would buy bytes that are not there.
 */
export function encodePng(pixels: Uint8Array, size: number): Buffer {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Draw the shapes and encode them, which is every use this file has. */
export function renderPng(shapes: readonly IconShape[], size: number, tile: number): Buffer {
  return encodePng(rasterize(shapes, size, tile), size);
}
