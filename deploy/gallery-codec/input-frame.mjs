import { createHash } from 'node:crypto';
import { types } from 'node:util';

const headerLimit = 4096;
const imageLimit = 15728640;
const videoLimit = 67108864;
const aggregateLimit = 4 + headerLimit + 4 + videoLimit;
const kinds = ['image_preview', 'image_thumbnail', 'video_playback'];
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer').get;
const getSize = Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get;
const getOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset').get;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const copy = Uint8Array.prototype.set;

export class GalleryCodecInputFrameError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GalleryCodecInputFrameError';
    this.code = code;
  }
}
function fail(code) {
  throw new GalleryCodecInputFrameError(code);
}
function record(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('frame_invalid');
  const names = Reflect.ownKeys(value);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    fail('frame_invalid');
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('frame_invalid');
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result;
}
function byteView(raw, maximum) {
  try {
    if (
      !types.isUint8Array(raw) ||
      types.isProxy(raw) ||
      ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(raw))
    )
      fail('frame_invalid');
    for (const key of ['buffer', 'byteLength', 'byteOffset', 'length'])
      if (Object.getOwnPropertyDescriptor(raw, key)) fail('frame_invalid');
    if (Object.getOwnPropertySymbols(raw).length) fail('frame_invalid');
    const buffer = getBuffer.call(raw);
    const size = getSize.call(raw);
    const offset = getOffset.call(raw);
    if (
      !(buffer instanceof ArrayBuffer) ||
      types.isSharedArrayBuffer(buffer) ||
      getResizable?.call(buffer)
    )
      fail('frame_invalid');
    if (size > maximum) fail('frame_budget');
    // No overridable iterator/subarray/property access is used. This view is consumed
    // synchronously and never retained; stored bytes are copied into owned buffers.
    return new Uint8Array(buffer, offset, size);
  } catch (error) {
    if (error instanceof GalleryCodecInputFrameError) throw error;
    return fail('frame_invalid');
  }
}
function budget(kind) {
  return kind === 'video_playback' ? videoLimit : imageLimit;
}
function canonical(header) {
  return JSON.stringify(header);
}
function parseHeader(bytes) {
  let text, value;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail('frame_invalid');
  }
  const fields = record(value, ['recipeVersion', 'kind', 'original']);
  const original = record(fields.original, ['byteSize', 'sha256']);
  if (
    fields.recipeVersion !== 1 ||
    !kinds.includes(fields.kind) ||
    !Number.isSafeInteger(original.byteSize) ||
    original.byteSize < 1 ||
    original.byteSize > budget(fields.kind) ||
    typeof original.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(original.sha256)
  )
    fail('frame_invalid');
  const normalized = {
    recipeVersion: 1,
    kind: fields.kind,
    original: { byteSize: original.byteSize, sha256: original.sha256 },
  };
  // Duplicate keys, whitespace, alternate number/escape spelling, BOM and member order
  // are rejected, not silently normalized into an accepted wire.
  if (text !== canonical(normalized)) fail('frame_invalid');
  return Object.freeze({ ...normalized, original: Object.freeze(normalized.original) });
}

/** Protocol 1. Caller hashes, commands, paths and configuration are not accepted. */
export function encodeGalleryCodecInputFrame(rawBytes, options) {
  const { kind } = record(options, ['kind']);
  if (!kinds.includes(kind)) fail('frame_invalid');
  const source = byteView(rawBytes, budget(kind));
  if (source.byteLength < 1) fail('frame_invalid');
  const snapshot = new Uint8Array(source.byteLength);
  copy.call(snapshot, source);
  const sha256 = createHash('sha256').update(snapshot).digest('hex');
  const header = Buffer.from(
    canonical({ recipeVersion: 1, kind, original: { byteSize: snapshot.byteLength, sha256 } }),
    'utf8',
  );
  if (header.length > headerLimit) fail('frame_budget');
  const frame = Buffer.allocUnsafe(8 + header.length + snapshot.byteLength);
  frame.writeUInt32BE(header.length, 0);
  frame.set(header, 4);
  frame.writeUInt32BE(snapshot.byteLength, 4 + header.length);
  frame.set(snapshot, 8 + header.length);
  return frame;
}

/** One frame, one finish. Errors permanently poison this invocation; no resync/fallback. */
export function createGalleryCodecInputFrameDecoder() {
  let state = 'header_length';
  let prefix = Buffer.alloc(4);
  let written = 0;
  let headerBytes;
  let header;
  let body;
  let hash;
  let charged = 0;
  const poison = (error) => {
    state = 'poisoned';
    headerBytes = undefined;
    header = undefined;
    body = undefined;
    hash = undefined;
    if (error instanceof GalleryCodecInputFrameError) throw error;
    fail('frame_invalid');
  };
  return Object.freeze({
    push(rawChunk) {
      if (state === 'poisoned' || state === 'finished') fail('frame_state');
      try {
        const chunk = byteView(rawChunk, aggregateLimit - charged);
        charged += chunk.byteLength;
        if (state === 'complete' && chunk.byteLength) fail('frame_trailing');
        let offset = 0;
        while (offset < chunk.byteLength) {
          if (state === 'complete') fail('frame_trailing');
          const destination =
            state === 'header_length' || state === 'body_length'
              ? prefix
              : state === 'header'
                ? headerBytes
                : body;
          const count = Math.min(destination.byteLength - written, chunk.byteLength - offset);
          const part = new Uint8Array(chunk.buffer, chunk.byteOffset + offset, count);
          copy.call(destination, part, written);
          if (state === 'body') hash.update(part);
          written += count;
          offset += count;
          if (written !== destination.byteLength) continue;
          written = 0;
          if (state === 'header_length') {
            const size = prefix.readUInt32BE(0);
            if (size < 1 || size > headerLimit) fail('frame_budget');
            headerBytes = Buffer.allocUnsafe(size);
            state = 'header';
          } else if (state === 'header') {
            header = parseHeader(headerBytes);
            headerBytes = undefined;
            prefix = Buffer.alloc(4);
            state = 'body_length';
          } else if (state === 'body_length') {
            const size = prefix.readUInt32BE(0);
            if (size !== header.original.byteSize || size < 1 || size > budget(header.kind))
              fail('frame_invalid');
            // Allocate once, only after both canonical declared size and wire size agree.
            body = new Uint8Array(size);
            hash = createHash('sha256');
            prefix = undefined;
            state = 'body';
          } else {
            if (hash.digest('hex') !== header.original.sha256) fail('frame_integrity');
            hash = undefined;
            state = 'complete';
          }
        }
      } catch (error) {
        poison(error);
      }
    },
    finish() {
      if (state === 'poisoned' || state === 'finished') fail('frame_state');
      if (state !== 'complete') return poison(new GalleryCodecInputFrameError('frame_partial'));
      state = 'finished';
      const result = Object.freeze({
        recipeVersion: 1,
        kind: header.kind,
        original: header.original,
        bytes: body,
      });
      body = undefined;
      header = undefined;
      return result;
    },
  });
}
