/**
 * Minimal RGBA PNG encoder used to generate our own basemap sprite sheet.
 *
 * We generate the sprite instead of downloading one so that the sprite carries no
 * third-party license obligation. Only what MapLibre needs is implemented: 8-bit
 * RGBA, no interlacing, a single zlib-compressed IDAT with filter type 0.
 */
import { deflateSync } from 'node:zlib';

const table = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  table[index] = value >>> 0;
}

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Uint8Array} data */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba row-major RGBA, `width * height * 4` bytes
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('INVALID_RGBA_LENGTH');
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    raw[row * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + row * width * 4, width * 4).copy(
      raw,
      row * (width * 4 + 1) + 1,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * Draw one filled circle with a ring into an RGBA buffer region.
 * @param {{ rgba: Uint8Array, sheetWidth: number, x: number, y: number, size: number,
 *           fill: [number, number, number], ring: [number, number, number] }} options
 */
export function drawCircle({ rgba, sheetWidth, x, y, size, fill, ring }) {
  const radius = size / 2 - 0.5;
  const centre = size / 2 - 0.5;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const distance = Math.hypot(column - centre, row - centre);
      if (distance > radius) continue;
      const inner = distance <= radius - Math.max(1, size / 8);
      const [red, green, blue] = inner ? fill : ring;
      const offset = ((y + row) * sheetWidth + (x + column)) * 4;
      rgba[offset] = red;
      rgba[offset + 1] = green;
      rgba[offset + 2] = blue;
      rgba[offset + 3] = 255;
    }
  }
}
