import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { test } from 'vitest';

import {
  createGalleryCodecInputFrameDecoder,
  encodeGalleryCodecInputFrame,
  GalleryCodecInputFrameError,
} from './input-frame.mjs';

const bytes = Uint8Array.from({ length: 257 }, (_, index) => index % 256);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const header = (patch = {}) => ({
  recipeVersion: 1,
  kind: 'image_preview',
  original: { byteSize: bytes.length, sha256: hash(bytes) },
  ...patch,
});
function wire(text, body = bytes, size = body.length) {
  const encoded = typeof text === 'string' ? Buffer.from(text) : text;
  const frame = Buffer.alloc(8 + encoded.length + body.length);
  frame.writeUInt32BE(encoded.length, 0);
  frame.set(encoded, 4);
  frame.writeUInt32BE(size, 4 + encoded.length);
  frame.set(body, 8 + encoded.length);
  return frame;
}
function rejection(operation, code) {
  assert.throws(
    operation,
    (error) => error instanceof GalleryCodecInputFrameError && (!code || error.code === code),
  );
}
function decode(frame) {
  const decoder = createGalleryCodecInputFrameDecoder();
  decoder.push(frame);
  return decoder.finish();
}

test('all three finite recipes preserve original binary/hash with internally computed header', () => {
  for (const kind of ['image_preview', 'image_thumbnail', 'video_playback']) {
    const frame = encodeGalleryCodecInputFrame(bytes, { kind });
    const result = decode(frame);
    assert.equal(result.kind, kind);
    assert.equal(result.recipeVersion, 1);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.original.sha256, hash(bytes));
    assert.equal(result.original.byteSize, bytes.length);
    assert.ok(Object.isFrozen(result.original));
  }
});

test('every header/prefix/body boundary accepts split transport without truncation', () => {
  const frame = encodeGalleryCodecInputFrame(bytes, { kind: 'image_preview' });
  for (let split = 0; split <= frame.length; split++) {
    const decoder = createGalleryCodecInputFrameDecoder();
    decoder.push(frame.subarray(0, split));
    decoder.push(new Uint8Array());
    decoder.push(frame.subarray(split));
    assert.deepEqual(decoder.finish().bytes, bytes);
  }
});

test('one-byte transport has no cumulative concatenation and preserves exact output', () => {
  const frame = encodeGalleryCodecInputFrame(bytes, { kind: 'image_thumbnail' });
  const decoder = createGalleryCodecInputFrameDecoder();
  for (const value of frame) decoder.push(Uint8Array.of(value));
  assert.equal(decoder.finish().original.sha256, hash(bytes));
});

test('encoder and decoder retain only independent owned bytes despite caller mutation', () => {
  const source = new Uint8Array(bytes);
  const frame = encodeGalleryCodecInputFrame(source, { kind: 'image_preview' });
  source.fill(0);
  const decoder = createGalleryCodecInputFrameDecoder();
  decoder.push(frame);
  frame.fill(0);
  assert.deepEqual(decoder.finish().bytes, bytes);
  assert.deepEqual(
    bytes,
    Uint8Array.from({ length: 257 }, (_, index) => index % 256),
  );
});

test('options reject inherited/extra/getter/proxy/sparse/unknown rather than executing user code', () => {
  let calls = 0;
  const getter = {};
  Object.defineProperty(getter, 'kind', {
    enumerable: true,
    get() {
      calls++;
      return 'image_preview';
    },
  });
  for (const options of [
    getter,
    new Proxy(
      { kind: 'image_preview' },
      {
        get() {
          calls++;
        },
      },
    ),
    Object.create({ kind: 'image_preview' }),
    new Array(1),
    { kind: 'unknown' },
    { kind: 'image_preview', sha256: hash(bytes) },
    { kind: 'image_preview', argv: [] },
    { kind: 'image_preview', path: '/tmp/file' },
    { kind: 'image_preview', env: {} },
  ])
    rejection(() => encodeGalleryCodecInputFrame(bytes, options), 'frame_invalid');
  assert.equal(calls, 0);
});

test('input and chunks reject proxy, shared/resizable, wrong types and shadowed intrinsic getters', () => {
  let calls = 0;
  const accessor = new Uint8Array(bytes);
  Object.defineProperty(accessor, 'byteLength', {
    get() {
      calls++;
      return 1;
    },
  });
  const resizable = new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 }));
  for (const raw of [
    accessor,
    new Proxy(bytes, {}),
    new Uint8Array(new SharedArrayBuffer(4)),
    resizable,
    new Array(4),
    'notbytes',
    null,
    new Uint16Array(4),
  ]) {
    rejection(() => encodeGalleryCodecInputFrame(raw, { kind: 'image_preview' }), 'frame_invalid');
    const decoder = createGalleryCodecInputFrameDecoder();
    rejection(() => decoder.push(raw), 'frame_invalid');
    rejection(() => decoder.finish(), 'frame_state');
  }
  assert.equal(calls, 0);
});

test('zero and oversized original inputs fail before framing', () => {
  rejection(
    () => encodeGalleryCodecInputFrame(new Uint8Array(), { kind: 'image_preview' }),
    'frame_invalid',
  );
  rejection(
    () => encodeGalleryCodecInputFrame(new Uint8Array(15728641), { kind: 'image_thumbnail' }),
    'frame_budget',
  );
  rejection(
    () => encodeGalleryCodecInputFrame(new Uint8Array(67108865), { kind: 'video_playback' }),
    'frame_budget',
  );
});

const invalidHeaders = [
  '{}',
  JSON.stringify(header({ recipeVersion: 2 })),
  JSON.stringify(header({ kind: 'unknown' })),
  JSON.stringify({ ...header(), extra: true }),
  JSON.stringify(
    header({ original: { byteSize: bytes.length, sha256: hash(bytes), path: '/tmp/file' } }),
  ),
  JSON.stringify(header({ original: { byteSize: 0, sha256: hash(bytes) } })),
  JSON.stringify(header({ original: { byteSize: 15728641, sha256: hash(bytes) } })),
  JSON.stringify(
    header({ kind: 'video_playback', original: { byteSize: 67108865, sha256: hash(bytes) } }),
  ),
  JSON.stringify(header({ original: { byteSize: bytes.length, sha256: 'A'.repeat(64) } })),
  JSON.stringify(header({ original: { byteSize: null, sha256: hash(bytes) } })),
  JSON.stringify(header({ original: { byteSize: 1.5, sha256: hash(bytes) } })),
  JSON.stringify(header()).replace('"recipeVersion":1', '"recipeVersion":1,"recipeVersion":1'),
  JSON.stringify(header()).replace('"byteSize":257', '"byteSize":257,"byteSize":257'),
  ' ' + JSON.stringify(header()),
  JSON.stringify({ kind: 'image_preview', recipeVersion: 1, original: header().original }),
  JSON.stringify(header()).replace('"recipeVersion":1', '"recipeVersion":1.0'),
  JSON.stringify(header()).replace('image_preview', 'image_\\u0070review'),
  JSON.stringify(header()).replace('image_preview', '\\ud800'),
  JSON.stringify(header()).replace('"recipeVersion":1', '"recipeVersion":1e0'),
];
for (const [index, text] of invalidHeaders.entries()) {
  test(`canonical header negative ${index + 1}: fails and permanently poisons decoder`, () => {
    const decoder = createGalleryCodecInputFrameDecoder();
    rejection(() => decoder.push(wire(text)), 'frame_invalid');
    rejection(
      () => decoder.push(encodeGalleryCodecInputFrame(bytes, { kind: 'image_preview' })),
      'frame_state',
    );
    rejection(() => decoder.finish(), 'frame_state');
  });
}

test('malformed UTF8/BOM/header lengths cannot become canonical accepted header', () => {
  for (const raw of [
    Buffer.from([0xff]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(header()))]),
  ])
    rejection(() => decode(wire(raw)), 'frame_invalid');
  for (const size of [0, 4097, 0xffffffff]) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(size);
    rejection(() => createGalleryCodecInputFrameDecoder().push(prefix), 'frame_budget');
  }
});

test('wire original length must match the validated canonical header before body allocation', () => {
  for (const size of [0, 1, 256, 258, 0xffffffff])
    rejection(() => decode(wire(JSON.stringify(header()), bytes, size)), 'frame_invalid');
});

test('digest mismatch rejects exact-length tampered body', () => {
  const frame = encodeGalleryCodecInputFrame(bytes, { kind: 'image_preview' });
  frame[frame.length - 1] ^= 1;
  rejection(() => decode(frame), 'frame_integrity');
});

test('every partial boundary fails finish; complete cannot accept trailing or a second frame', () => {
  const frame = encodeGalleryCodecInputFrame(bytes, { kind: 'image_preview' });
  for (let split = 0; split < frame.length; split++) {
    const decoder = createGalleryCodecInputFrameDecoder();
    decoder.push(frame.subarray(0, split));
    rejection(() => decoder.finish(), 'frame_partial');
    rejection(() => decoder.push(frame), 'frame_state');
  }
  rejection(() => decode(Buffer.concat([frame, Buffer.from([0])])), 'frame_trailing');
  rejection(() => decode(Buffer.concat([frame, frame])), 'frame_trailing');
  const complete = createGalleryCodecInputFrameDecoder();
  complete.push(frame);
  rejection(() => complete.push(frame), 'frame_trailing');
  rejection(() => complete.finish(), 'frame_state');
  const finished = createGalleryCodecInputFrameDecoder();
  finished.push(frame);
  finished.finish();
  rejection(() => finished.finish(), 'frame_state');
  rejection(() => finished.push(new Uint8Array()), 'frame_state');
});
