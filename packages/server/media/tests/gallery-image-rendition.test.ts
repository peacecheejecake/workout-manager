import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { renderGalleryImageRendition } from '../src/gallery-image-rendition.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const recipe = { kind: 'image_preview' as const };
function hasGpsDirectory(exif: Buffer): boolean {
  const start = exif.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? 6 : 0;
  const little = exif.toString('ascii', start, start + 2) === 'II';
  const short = (offset: number) =>
    little ? exif.readUInt16LE(offset) : exif.readUInt16BE(offset);
  const long = (offset: number) => (little ? exif.readUInt32LE(offset) : exif.readUInt32BE(offset));
  const directory = start + long(start + 4);
  const count = short(directory);
  for (let index = 0; index < count; index++) {
    if (short(directory + 2 + index * 12) === 0x8825) return true;
  }
  return false;
}

async function image(width = 8, height = 6) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 80, b: 120, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
}
function pngChunk(type: string, data: Buffer) {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  // The adapter rejects animation before decoder CRC checks; this is a negative marker fixture.
  return result;
}

describe('native gallery image rendition', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'auto-orients actual EXIF orientation %s and strips private metadata',
    async (orientation) => {
      const pixels = Buffer.alloc(8 * 6 * 3);
      for (let y = 0; y < 6; y++)
        for (let x = 0; x < 8; x++) {
          const offset = (y * 8 + x) * 3;
          pixels[offset] = x < 4 ? 240 : 10;
          pixels[offset + 1] = y < 3 ? 240 : 10;
          pixels[offset + 2] = 40;
        }
      const input = await sharp(pixels, { raw: { width: 8, height: 6, channels: 3 } })
        .withExif({
          IFD0: { ImageDescription: 'synthetic-only' },
          IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '1/1 2/1 3/1' },
        })
        .withMetadata({ orientation })
        .png()
        .toBuffer();
      const sourceExif = (await sharp(input).metadata()).exif;
      expect(sourceExif).toBeDefined();
      if (!sourceExif) throw new Error('Synthetic EXIF fixture missing');
      expect(hasGpsDirectory(sourceExif)).toBe(true);
      const before = Buffer.from(input);
      const actual = await renderGalleryImageRendition(input, recipe);
      expect(input).toEqual(before);
      expect(actual.sourceObservation).toEqual({
        format: 'png',
        width: 8,
        height: 6,
        orientation,
        pages: null,
        orientedWidth: orientation >= 5 ? 6 : 8,
        orientedHeight: orientation >= 5 ? 8 : 6,
      });
      expect(actual.original).toEqual({ sha256: digest(before), byteSize: before.length });
      expect([actual.output.width, actual.output.height]).toEqual(
        orientation >= 5 ? [6, 8] : [8, 6],
      );
      const expected = await sharp(input)
        .autoOrient()
        .toColourspace('srgb')
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
      expect(Buffer.from(actual.output.bytes)).toEqual(expected);
      const metadata = await sharp(actual.output.bytes).metadata();
      const raw = await sharp(actual.output.bytes).removeAlpha().raw().toBuffer();
      const w = actual.output.width;
      const h = actual.output.height;
      const corners = [
        [0, 0],
        [w - 1, 0],
        [0, h - 1],
        [w - 1, h - 1],
      ].map(([x = 0, y = 0]) => {
        const index = (y * w + x) * 3;
        return `${(raw[index] ?? 0) > 120 ? 'R' : ''}${(raw[index + 1] ?? 0) > 120 ? 'G' : ''}`;
      });
      const cornerOrder = [
        ['RG', 'G', 'R', ''],
        ['G', 'RG', '', 'R'],
        ['', 'R', 'G', 'RG'],
        ['R', '', 'RG', 'G'],
        ['RG', 'R', 'G', ''],
        ['R', 'RG', '', 'G'],
        ['', 'G', 'R', 'RG'],
        ['G', '', 'RG', 'R'],
      ];
      expect(corners).toEqual(cornerOrder[orientation - 1]);
      expect(metadata.format).toBe('webp');
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
      expect(actual.build).toEqual({ sharp: sharp.versions.sharp, vips: sharp.versions.vips });
    },
  );
  it('preserves alpha, avoids enlargement and produces deterministic same-build hashes', async () => {
    const input = await image();
    const first = await renderGalleryImageRendition(input, { kind: 'image_thumbnail' });
    const second = await renderGalleryImageRendition(input, { kind: 'image_thumbnail' });
    expect(first.sourceObservation).toEqual({
      format: 'png',
      width: 8,
      height: 6,
      orientation: null,
      pages: null,
      orientedWidth: 8,
      orientedHeight: 6,
    });
    expect(first.output.sha256).toBe(second.output.sha256);
    expect([first.output.width, first.output.height]).toEqual([8, 6]);
    expect((await sharp(first.output.bytes).metadata()).hasAlpha).toBe(true);
    const rgba = await sharp(first.output.bytes).ensureAlpha().raw().toBuffer();
    for (let offset = 3; offset < rgba.length; offset += 4) expect(rgba[offset]).toBe(128);
    expect(first.output.byteSize).toBe(first.output.bytes.byteLength);
  });
  it('retains decoder source dimensions separately from downsampled output', async () => {
    const input = await image(640, 480);
    const actual = await renderGalleryImageRendition(input, { kind: 'image_thumbnail' });
    expect(actual.sourceObservation).toMatchObject({
      width: 640,
      height: 480,
      orientedWidth: 640,
      orientedHeight: 480,
      orientation: null,
    });
    expect([actual.output.width, actual.output.height]).toEqual([320, 240]);
    expect(actual.original.sha256).toBe(digest(input));
  });
  it('snapshots mutable caller bytes before asynchronous codec work', async () => {
    const input = await image();
    const before = Buffer.from(input);
    const pending = renderGalleryImageRendition(input, recipe);
    input.fill(0);
    expect((await pending).original.sha256).toBe(digest(before));
  });
  it('rejects shared/proxy/accessor/empty/oversize inputs without invoking caller getters', async () => {
    const input = await image();
    let called = false;
    const accessor = Uint8Array.from(input);
    Object.defineProperty(accessor, 'buffer', {
      get() {
        called = true;
        throw new Error('not invoked');
      },
    });
    for (const value of [
      new Uint8Array(new SharedArrayBuffer(4)),
      new Proxy(input, {}),
      accessor,
      new Uint8Array(),
      new Uint8Array(15 * 1024 * 1024 + 1),
    ]) {
      await expect(renderGalleryImageRendition(value, recipe)).rejects.toHaveProperty(
        'name',
        'GalleryImageRenditionError',
      );
    }
    expect(called).toBe(false);
  });
  it('rejects actual GIF decode format, APNG/WebP animation markers and malformed chunks', async () => {
    const gif = await sharp(await image())
      .gif()
      .toBuffer();
    await expect(renderGalleryImageRendition(gif, recipe)).rejects.toHaveProperty(
      'code',
      'unsupported_format',
    );
    const png = await image();
    const apng = Buffer.concat([
      png.subarray(0, 33),
      pngChunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])),
      png.subarray(33),
    ]);
    await expect(renderGalleryImageRendition(apng, recipe)).rejects.toHaveProperty(
      'code',
      'unsupported_pages',
    );
    const frames = Buffer.alloc(8 * 12 * 4);
    for (let offset = 0; offset < frames.length; offset += 4) {
      frames[offset] = offset < frames.length / 2 ? 240 : 10;
      frames[offset + 2] = offset < frames.length / 2 ? 10 : 240;
      frames[offset + 3] = 255;
    }
    const validAnimated = await sharp(frames, {
      raw: { width: 8, height: 12, pageHeight: 6, channels: 4 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(validAnimated).metadata()).pages).toBe(2);
    await expect(renderGalleryImageRendition(validAnimated, recipe)).rejects.toHaveProperty(
      'code',
      'unsupported_pages',
    );
    const webp = await sharp(png).webp().toBuffer();
    const animated = Buffer.concat([webp, Buffer.from('ANIM'), Buffer.alloc(4)]);
    animated.writeUInt32LE(animated.length - 8, 4);
    await expect(renderGalleryImageRendition(animated, recipe)).rejects.toHaveProperty(
      'code',
      'unsupported_pages',
    );
    await expect(
      renderGalleryImageRendition(png.subarray(0, png.length - 3), recipe),
    ).rejects.toHaveProperty('code', 'decode_failed');
  });
  it('rejects declared pixel bombs and genuinely truncated JPEG decoding', async () => {
    const png = await image();
    const huge = Buffer.from(png);
    huge.writeUInt32BE(100000, 16);
    huge.writeUInt32BE(100000, 20);
    let crc = 0xffffffff;
    for (const byte of huge.subarray(12, 29)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    huge.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
    await expect(renderGalleryImageRendition(huge, recipe)).rejects.toHaveProperty(
      'code',
      'pixel_budget',
    );
    const jpeg = await sharp(png).jpeg().toBuffer();
    await expect(
      renderGalleryImageRendition(jpeg.subarray(0, Math.floor(jpeg.length / 2)), recipe),
    ).rejects.toHaveProperty('code', 'decode_failed');
  });
  it('bounds actual native high-entropy alpha output while streaming', async () => {
    const pixels = Buffer.alloc(1600 * 1600 * 4);
    let state = 0x12345678;
    for (let i = 0; i < pixels.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[i] = state & 255;
    }
    const png = await sharp(pixels, { raw: { width: 1600, height: 1600, channels: 4 } })
      .png()
      .toBuffer();
    await expect(renderGalleryImageRendition(png, recipe)).rejects.toHaveProperty(
      'code',
      'output_budget',
    );
  });
  it('rejects pre-abort and cleans up an abort during actual native processing', async () => {
    const signal = AbortSignal.abort();
    await expect(
      renderGalleryImageRendition(await image(), { ...recipe, signal }),
    ).rejects.toHaveProperty('code', 'aborted');
    const controller = new AbortController();
    const pending = renderGalleryImageRendition(await image(1600, 1600), {
      ...recipe,
      signal: controller.signal,
    });
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toHaveProperty('code', 'aborted');
  });
});
