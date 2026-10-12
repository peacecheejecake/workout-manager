import { createHash } from 'node:crypto';
import { types } from 'node:util';

const INPUT_BYTES = 15 * 1024 * 1024;
const OUTPUT_BYTES = 2 * 1024 * 1024;
const PIXELS = 20_000_000;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
export type GalleryImageRenditionKind = 'image_preview' | 'image_thumbnail';
export type GalleryImageRenditionCode =
  | 'input_invalid'
  | 'input_budget'
  | 'unsupported_format'
  | 'unsupported_pages'
  | 'pixel_budget'
  | 'decode_failed'
  | 'output_budget'
  | 'aborted'
  | 'timeout'
  | 'codec_unavailable';
export class GalleryImageRenditionError extends Error {
  constructor(readonly code: GalleryImageRenditionCode) {
    super(code);
    this.name = 'GalleryImageRenditionError';
  }
}
function fail(code: GalleryImageRenditionCode): never {
  throw new GalleryImageRenditionError(code);
}
function snapshot(input: unknown): Buffer {
  if (!types.isUint8Array(input) || types.isProxy(input)) fail('input_invalid');
  if (
    Object.getPrototypeOf(input) !== Uint8Array.prototype &&
    Object.getPrototypeOf(input) !== Buffer.prototype
  )
    fail('input_invalid');
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'length']) {
    if (Object.getOwnPropertyDescriptor(input, key)) fail('input_invalid');
  }
  if (!bufferGetter || !lengthGetter || !offsetGetter) fail('input_invalid');
  const buffer: unknown = bufferGetter.call(input);
  const length: unknown = lengthGetter.call(input);
  const offset: unknown = offsetGetter.call(input);
  if (!types.isArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer)) fail('input_invalid');
  if (typeof length !== 'number' || typeof offset !== 'number' || length < 1) fail('input_invalid');
  if (length > INPUT_BYTES) fail('input_budget');
  try {
    return Buffer.from(new Uint8Array(buffer, offset, length));
  } catch {
    return fail('input_invalid');
  }
}
function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
// Scan bounded container chunks, never search arbitrary payload bytes for marker text.
function assertSingleFrame(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let position = 8;
    let ended = false;
    while (position < bytes.length) {
      if (position + 12 > bytes.length) fail('decode_failed');
      const length = bytes.readUInt32BE(position);
      if (length > bytes.length - position - 12) fail('decode_failed');
      const type = bytes.toString('ascii', position + 4, position + 8);
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('unsupported_pages');
      position += length + 12;
      if (type === 'IEND') {
        ended = true;
        break;
      }
    }
    if (!ended || position !== bytes.length) fail('decode_failed');
  } else if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    if (bytes.length < 12 || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('decode_failed');
    let position = 12;
    while (position < bytes.length) {
      if (position + 8 > bytes.length) fail('decode_failed');
      const length = bytes.readUInt32LE(position + 4);
      if (length > bytes.length - position - 8) fail('decode_failed');
      const type = bytes.toString('ascii', position, position + 4);
      if (['ANIM', 'ANMF'].includes(type)) fail('unsupported_pages');
      if (type === 'VP8X' && length > 0 && ((bytes[position + 8] ?? 0) & 2) !== 0)
        fail('unsupported_pages');
      position += 8 + length + (length % 2);
    }
    if (position !== bytes.length) fail('decode_failed');
  }
}
function decodeError(error: unknown, signal?: AbortSignal): never {
  if (error instanceof GalleryImageRenditionError) throw error;
  if (signal?.aborted) fail('aborted');
  if (error instanceof Error && /timeout/i.test(error.message)) fail('timeout');
  if (error instanceof Error && /pixel limit/i.test(error.message)) fail('pixel_budget');
  fail('decode_failed');
}
export async function renderGalleryImageRendition(
  unknownBytes: unknown,
  options: { kind: GalleryImageRenditionKind; signal?: AbortSignal },
) {
  if (options.kind !== 'image_preview' && options.kind !== 'image_thumbnail') fail('input_invalid');
  if (options.signal?.aborted) fail('aborted');
  const input = snapshot(unknownBytes);
  const original = { sha256: hash(input), byteSize: input.byteLength };
  assertSingleFrame(input);
  const sharp = await import('sharp')
    .then((module) => module.default)
    .catch(() => fail('codec_unavailable'));
  if (options.signal?.aborted) fail('aborted');
  const sharpVersion = sharp.versions.sharp;
  const vipsVersion = sharp.versions.vips;
  if (
    typeof sharpVersion !== 'string' ||
    !sharpVersion ||
    typeof vipsVersion !== 'string' ||
    !vipsVersion
  )
    fail('codec_unavailable');
  const decoder = sharp(input, { failOn: 'warning', limitInputPixels: PIXELS }).timeout({
    seconds: 10,
  });
  const abort = () => decoder.destroy(new GalleryImageRenditionError('aborted'));
  decoder.on('error', () => undefined);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const metadata = await decoder.metadata();
    if (options.signal?.aborted) fail('aborted');
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) fail('unsupported_format');
    if ((metadata.pages ?? 1) !== 1) fail('unsupported_pages');
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > PIXELS)
      fail('pixel_budget');
    if (metadata.channels > 4) fail('unsupported_format');
    const orientation = metadata.orientation ?? null;
    const pages = metadata.pages ?? null;
    if (
      orientation !== null &&
      (!Number.isSafeInteger(orientation) || orientation < 1 || orientation > 8)
    )
      fail('decode_failed');
    if (pages !== null && (!Number.isSafeInteger(pages) || pages !== 1)) fail('unsupported_pages');
    const orientedWidth = metadata.autoOrient.width;
    const orientedHeight = metadata.autoOrient.height;
    if (
      !Number.isSafeInteger(metadata.width) ||
      !Number.isSafeInteger(metadata.height) ||
      !Number.isSafeInteger(orientedWidth) ||
      !Number.isSafeInteger(orientedHeight) ||
      orientedWidth < 1 ||
      orientedHeight < 1
    )
      fail('decode_failed');
    const sourceObservation = {
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      orientation,
      pages,
      orientedWidth,
      orientedHeight,
    };

    const edge = options.kind === 'image_preview' ? 1600 : 320;
    decoder
      .autoOrient()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .webp({ quality: 80, effort: 4 });
    let size = 0;
    const chunks: Buffer[] = [];
    const dimensions: { width: number; height: number }[] = [];
    decoder.on('info', (info) => {
      dimensions.push({ width: info.width, height: info.height });
    });
    for await (const unknownChunk of decoder) {
      if (options.signal?.aborted) fail('aborted');
      if (!Buffer.isBuffer(unknownChunk)) fail('decode_failed');
      size += unknownChunk.byteLength;
      if (size > OUTPUT_BYTES) fail('output_budget');
      chunks.push(unknownChunk);
    }
    const dimension = dimensions[0];
    if (!dimension || dimensions.length !== 1 || size === 0) fail('decode_failed');
    const bytes = Buffer.concat(chunks, size);
    return {
      recipeVersion: 1 as const,
      kind: options.kind,
      original,
      sourceObservation,
      output: {
        mediaType: 'image/webp' as const,
        sha256: hash(bytes),
        byteSize: size,
        width: dimension.width,
        height: dimension.height,
        bytes: Uint8Array.from(bytes),
      },
      build: { sharp: sharpVersion, vips: vipsVersion },
    };
  } catch (error) {
    return decodeError(error, options.signal);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    decoder.destroy();
  }
}
