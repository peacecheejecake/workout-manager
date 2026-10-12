import { createHash } from 'node:crypto';
import { types } from 'node:util';

const headerLimit = 16384;
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

export class GalleryCodecOutputFrameError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GalleryCodecOutputFrameError';
    this.code = code;
  }
}
function fail(code) {
  throw new GalleryCodecOutputFrameError(code);
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
    if (error instanceof GalleryCodecOutputFrameError) throw error;
    return fail('frame_invalid');
  }
}
function budget(kind) {
  return kind === 'video_playback' ? videoLimit : imageLimit;
}
function canonical(header) {
  return JSON.stringify(header);
}
function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('frame_invalid');
  return value;
}
function positive(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail('frame_invalid');
  return value;
}
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('frame_invalid');
  return value;
}
function enumeration(value, choices) {
  if (!choices.includes(value)) fail('frame_invalid');
  return value;
}
function boundedPlain(raw) {
  const seen = new Set();
  let bytes = 0,
    nodes = 0;
  function charge(amount) {
    bytes += amount;
    if (bytes > headerLimit) fail('frame_budget');
  }
  function visit(value, depth) {
    if (++nodes > headerLimit || depth > 12) fail('frame_budget');
    if (value === null || typeof value === 'boolean') {
      charge(value === null ? 4 : value ? 4 : 5);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('frame_invalid');
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > headerLimit || /[\uD800-\uDFFF]/u.test(value)) fail('frame_invalid');
      charge(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (
      !value ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      seen.has(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      fail('frame_invalid');
    seen.add(value);
    charge(2);
    const result = {};
    const names = Reflect.ownKeys(value);
    if (names.length > headerLimit || names.some((name) => typeof name !== 'string'))
      fail('frame_invalid');
    for (const [index, key] of names.entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !('value' in descriptor) ||
        !descriptor.enumerable ||
        key.length > headerLimit ||
        /[\uD800-\uDFFF]/u.test(key)
      )
        fail('frame_invalid');
      charge((index ? 1 : 0) + Buffer.byteLength(JSON.stringify(key)) + 1);
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    seen.delete(value);
    return Object.freeze(result);
  }
  return visit(raw, 0);
}
function expectedOriginal(value, kind) {
  const original = record(value, ['byteSize', 'sha256']);
  return Object.freeze({
    byteSize: integer(original.byteSize, budget(kind)),
    sha256: digest(original.sha256),
  });
}
function expectation(raw) {
  const data = record(boundedPlain(raw), ['kind', 'original']);
  enumeration(data.kind, kinds);
  return Object.freeze({ kind: data.kind, original: expectedOriginal(data.original, data.kind) });
}
function buildIdentity(value) {
  const build = record(value, ['sha256', 'version', 'buildSha256']);
  digest(build.sha256);
  digest(build.buildSha256);
  enumeration(build.version, ['9.0.2']);
  return Object.freeze(build);
}
function metadataShape(raw) {
  // Transport shape only. The existing codec semantic validator must run again at consumption.
  const root = record(boundedPlain(raw), [
    'recipeVersion',
    'kind',
    'original',
    'sourceObservation',
    'output',
    'build',
  ]);
  if (root.recipeVersion !== 1) fail('frame_invalid');
  const kind = enumeration(root.kind, kinds);
  const original = record(root.original, ['sha256', 'byteSize']);
  digest(original.sha256);
  integer(original.byteSize, budget(kind));
  const video = kind === 'video_playback';
  const source = record(
    root.sourceObservation,
    video
      ? [
          'format',
          'videoCodec',
          'audioCodec',
          'width',
          'height',
          'sampleAspectNumerator',
          'sampleAspectDenominator',
          'rotationDegrees',
          'rotatedWidth',
          'rotatedHeight',
          'displayAspect',
          'fps',
          'durationSeconds',
          'frameCount',
          'hasAudio',
        ]
      : ['format', 'width', 'height', 'orientation', 'pages', 'orientedWidth', 'orientedHeight'],
  );
  integer(source.width);
  integer(source.height);
  if (video) {
    enumeration(source.format, ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm']);
    enumeration(source.videoCodec, ['h264', 'hevc', 'vp8', 'vp9', 'av1']);
    if (source.audioCodec !== null) enumeration(source.audioCodec, ['aac', 'opus', 'vorbis']);
    for (const key of [
      'sampleAspectNumerator',
      'sampleAspectDenominator',
      'rotatedWidth',
      'rotatedHeight',
      'frameCount',
    ])
      integer(source[key]);
    for (const key of ['displayAspect', 'fps', 'durationSeconds']) positive(source[key]);
    if (
      source.rotationDegrees !== null &&
      (!Number.isSafeInteger(source.rotationDegrees) ||
        Math.abs(source.rotationDegrees) > 360 ||
        source.rotationDegrees % 90 !== 0)
    )
      fail('frame_invalid');
    if (typeof source.hasAudio !== 'boolean') fail('frame_invalid');
  } else {
    enumeration(source.format, ['jpeg', 'png', 'webp']);
    if (source.orientation !== null) integer(source.orientation, 8);
    if (source.pages !== null) integer(source.pages, 1);
    integer(source.orientedWidth);
    integer(source.orientedHeight);
  }
  const output = record(
    root.output,
    video
      ? [
          'mediaType',
          'sha256',
          'byteSize',
          'width',
          'height',
          'durationSeconds',
          'frameCount',
          'hasAudio',
        ]
      : ['mediaType', 'sha256', 'byteSize', 'width', 'height'],
  );
  enumeration(output.mediaType, [video ? 'video/mp4' : 'image/webp']);
  digest(output.sha256);
  integer(output.byteSize, video ? videoLimit : 2097152);
  integer(output.width);
  integer(output.height);
  if (video) {
    positive(output.durationSeconds);
    integer(output.frameCount);
    if (typeof output.hasAudio !== 'boolean') fail('frame_invalid');
  }
  const build = record(root.build, video ? ['ffmpeg', 'ffprobe'] : ['sharp', 'vips']);
  const normalizedBuild = video
    ? { ffmpeg: buildIdentity(build.ffmpeg), ffprobe: buildIdentity(build.ffprobe) }
    : build;
  // Native build strings are transport facts, not execution attestation.
  if (!video)
    for (const name of ['sharp', 'vips'])
      if (typeof build[name] !== 'string' || !/^\d+[.]\d+[.]\d+$/.test(build[name]))
        fail('frame_invalid');
  return Object.freeze({
    recipeVersion: 1,
    kind,
    original: Object.freeze(original),
    sourceObservation: Object.freeze(source),
    output: Object.freeze(output),
    build: Object.freeze(normalizedBuild),
  });
}
function correlate(metadata, output, expected) {
  if (
    metadata.kind !== expected.kind ||
    metadata.original.byteSize !== expected.original.byteSize ||
    metadata.original.sha256 !== expected.original.sha256 ||
    metadata.output.byteSize !== output.byteSize ||
    metadata.output.sha256 !== output.sha256
  )
    fail('frame_integrity');
}
function parseHeader(bytes, expected) {
  let text, value;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail('frame_invalid');
  }
  const root = record(boundedPlain(value), ['protocolVersion', 'metadata', 'output']);
  if (root.protocolVersion !== 1) fail('frame_invalid');
  const metadata = metadataShape(root.metadata);
  const output = record(root.output, ['byteSize', 'sha256']);
  integer(output.byteSize, metadata.kind === 'video_playback' ? videoLimit : 2097152);
  digest(output.sha256);
  correlate(metadata, output, expected);
  const header = { protocolVersion: 1, metadata, output: Object.freeze(output) };
  if (text !== canonical(header)) fail('frame_invalid');
  return Object.freeze(header);
}

/** Internally hashes an owned output snapshot; declared metadata never authorizes bytes. */
export function encodeGalleryCodecOutputFrame(rawBytes, rawMetadata) {
  const metadata = metadataShape(rawMetadata);
  const source = byteView(rawBytes, metadata.kind === 'video_playback' ? videoLimit : 2097152);
  if (source.byteLength < 1) fail('frame_invalid');
  const snapshot = new Uint8Array(source.byteLength);
  copy.call(snapshot, source);
  const output = {
    byteSize: snapshot.byteLength,
    sha256: createHash('sha256').update(snapshot).digest('hex'),
  };
  correlate(metadata, output, { kind: metadata.kind, original: metadata.original });
  const header = Buffer.from(canonical({ protocolVersion: 1, metadata, output }), 'utf8');
  if (header.length > headerLimit) fail('frame_budget');
  const frame = Buffer.allocUnsafe(8 + header.length + snapshot.byteLength);
  frame.writeUInt32BE(header.length, 0);
  frame.set(header, 4);
  frame.writeUInt32BE(snapshot.byteLength, 4 + header.length);
  frame.set(snapshot, 8 + header.length);
  return frame;
}

/** One frame, one finish. Errors permanently poison this invocation; no resync/fallback. */
export function createGalleryCodecOutputFrameDecoder(rawExpected) {
  const expected = expectation(rawExpected);
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
    if (error instanceof GalleryCodecOutputFrameError) throw error;
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
            header = parseHeader(headerBytes, expected);
            headerBytes = undefined;
            prefix = Buffer.alloc(4);
            state = 'body_length';
          } else if (state === 'body_length') {
            const size = prefix.readUInt32BE(0);
            if (
              size !== header.output.byteSize ||
              size < 1 ||
              size > (header.metadata.kind === 'video_playback' ? videoLimit : 2097152)
            )
              fail('frame_invalid');
            // Allocate once, only after both canonical declared size and wire size agree.
            body = new Uint8Array(size);
            hash = createHash('sha256');
            prefix = undefined;
            state = 'body';
          } else {
            if (hash.digest('hex') !== header.output.sha256) fail('frame_integrity');
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
      if (state !== 'complete') return poison(new GalleryCodecOutputFrameError('frame_partial'));
      state = 'finished';
      const result = Object.freeze({
        protocolVersion: 1,
        metadata: header.metadata,
        output: header.output,
        bytes: body,
      });
      body = undefined;
      header = undefined;
      return result;
    },
  });
}
