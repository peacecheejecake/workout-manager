import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  createGalleryCodecOutputFrameDecoder,
  encodeGalleryCodecOutputFrame,
  GalleryCodecOutputFrameError,
} from './output-frame.mjs';
const bytes = Uint8Array.from({ length: 127 }, (_, index) => index);
const hash = (value) => createHash('sha256').update(value).digest('hex');
function fixture(kind = 'image_preview') {
  const video = kind === 'video_playback';
  const original = { sha256: 'a'.repeat(64), byteSize: 512 };
  const identity = { sha256: 'b'.repeat(64), version: '9.0.2', buildSha256: 'c'.repeat(64) };
  return {
    recipeVersion: 1,
    kind,
    original,
    sourceObservation: video
      ? {
          format: 'mov,mp4,m4a,3gp,3g2,mj2',
          videoCodec: 'h264',
          audioCodec: null,
          width: 10,
          height: 8,
          sampleAspectNumerator: 1,
          sampleAspectDenominator: 1,
          rotationDegrees: 0,
          rotatedWidth: 10,
          rotatedHeight: 8,
          displayAspect: 1.25,
          fps: 24,
          durationSeconds: 1,
          frameCount: 24,
          hasAudio: false,
        }
      : {
          format: 'jpeg',
          width: 10,
          height: 8,
          orientation: null,
          pages: null,
          orientedWidth: 10,
          orientedHeight: 8,
        },
    output: video
      ? {
          mediaType: 'video/mp4',
          sha256: hash(bytes),
          byteSize: bytes.length,
          width: 10,
          height: 8,
          durationSeconds: 1,
          frameCount: 24,
          hasAudio: false,
        }
      : {
          mediaType: 'image/webp',
          sha256: hash(bytes),
          byteSize: bytes.length,
          width: 10,
          height: 8,
        },
    build: video
      ? { ffmpeg: identity, ffprobe: { ...identity } }
      : { sharp: '0.35.4', vips: '8.18.0' },
  };
}
function expected(metadata = fixture()) {
  return {
    kind: metadata.kind,
    original: { byteSize: metadata.original.byteSize, sha256: metadata.original.sha256 },
  };
}
function wire(text, body = bytes, size = body.length) {
  const header = typeof text === 'string' ? Buffer.from(text) : text;
  const frame = Buffer.alloc(8 + header.length + body.length);
  frame.writeUInt32BE(header.length);
  frame.set(header, 4);
  frame.writeUInt32BE(size, 4 + header.length);
  frame.set(body, 8 + header.length);
  return frame;
}
function envelope(metadata = fixture()) {
  return { protocolVersion: 1, metadata, output: { byteSize: bytes.length, sha256: hash(bytes) } };
}
function decode(frame, expectation = expected()) {
  const decoder = createGalleryCodecOutputFrameDecoder(expectation);
  decoder.push(frame);
  return decoder.finish();
}
function rejects(operation, code) {
  assert.throws(
    operation,
    (error) => error instanceof GalleryCodecOutputFrameError && (!code || error.code === code),
  );
}

test('three kinds correlate existing metadata, expected original and internally hashed output', () => {
  for (const kind of ['image_preview', 'image_thumbnail', 'video_playback']) {
    const metadata = fixture(kind);
    const frame = encodeGalleryCodecOutputFrame(bytes, metadata);
    const result = decode(frame, expected(metadata));
    assert.deepEqual(result.metadata, metadata);
    assert.equal(result.output.sha256, hash(bytes));
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.protocolVersion, 1);
    assert.ok(Object.isFrozen(result.metadata.original));
  }
});
test('every prefix/header/body boundary and one-byte streaming preserve data', () => {
  const frame = encodeGalleryCodecOutputFrame(bytes, fixture());
  for (let split = 0; split <= frame.length; split++) {
    const decoder = createGalleryCodecOutputFrameDecoder(expected());
    decoder.push(frame.subarray(0, split));
    decoder.push(new Uint8Array());
    decoder.push(frame.subarray(split));
    assert.deepEqual(decoder.finish().bytes, bytes);
  }
  const decoder = createGalleryCodecOutputFrameDecoder(expected());
  for (const value of frame) decoder.push(Uint8Array.of(value));
  assert.equal(decoder.finish().output.sha256, hash(bytes));
});
test('independent snapshot protects encoder and decoder from caller mutation', () => {
  const source = new Uint8Array(bytes);
  const metadata = fixture();
  const frame = encodeGalleryCodecOutputFrame(source, metadata);
  source.fill(0);
  metadata.output.width = 1;
  const decoder = createGalleryCodecOutputFrameDecoder(expected());
  decoder.push(frame);
  frame.fill(0);
  assert.deepEqual(decoder.finish().bytes, bytes);
});
test('expected original/kind is strict and mandatory before accepting any stream', () => {
  for (const raw of [
    null,
    {},
    [],
    Object.create(expected()),
    { ...expected(), path: '/tmp/file' },
    { ...expected(), kind: 'other' },
    { ...expected(), original: { byteSize: 0, sha256: 'a'.repeat(64) } },
    { ...expected(), original: { byteSize: 512, sha256: 'A'.repeat(64) } },
  ])
    rejects(() => createGalleryCodecOutputFrameDecoder(raw));
  for (const expectation of [
    { ...expected(), kind: 'image_thumbnail' },
    { ...expected(), original: { byteSize: 511, sha256: 'a'.repeat(64) } },
    { ...expected(), original: { byteSize: 512, sha256: 'b'.repeat(64) } },
  ])
    rejects(
      () => decode(encodeGalleryCodecOutputFrame(bytes, fixture()), expectation),
      'frame_integrity',
    );
});
test('caller-declared output digest/size never substitutes actual body hash or size', () => {
  for (const patch of [{ sha256: 'd'.repeat(64) }, { byteSize: 1 }]) {
    const metadata = fixture();
    Object.assign(metadata.output, patch);
    rejects(() => encodeGalleryCodecOutputFrame(bytes, metadata), 'frame_integrity');
  }
  const frame = encodeGalleryCodecOutputFrame(bytes, fixture());
  frame[frame.length - 1] ^= 1;
  rejects(() => decode(frame), 'frame_integrity');
  const outer = envelope();
  outer.output.sha256 = 'd'.repeat(64);
  rejects(() => decode(wire(JSON.stringify(outer))), 'frame_integrity');
});
test('native computed semantic facts are not manufactured by framing', () => {
  const metadata = fixture();
  metadata.sourceObservation.orientedWidth = 8;
  const result = decode(encodeGalleryCodecOutputFrame(bytes, metadata));
  assert.equal(result.metadata.sourceObservation.orientedWidth, 8);
  // Intentionally shape-valid but semantically inconsistent: existing codec validator must reject at consumption.
});
test('metadata/expected getters, proxies and cycles execute no attacker code', () => {
  let calls = 0;
  const getter = fixture();
  Object.defineProperty(getter.output, 'sha256', {
    enumerable: true,
    get() {
      calls++;
      return hash(bytes);
    },
  });
  rejects(() => encodeGalleryCodecOutputFrame(bytes, getter));
  rejects(() =>
    encodeGalleryCodecOutputFrame(
      bytes,
      new Proxy(fixture(), {
        get() {
          calls++;
        },
      }),
    ),
  );
  const cycle = fixture();
  cycle.sourceObservation.loop = cycle;
  rejects(() => encodeGalleryCodecOutputFrame(bytes, cycle));
  const inherited = Object.create(fixture());
  rejects(() => encodeGalleryCodecOutputFrame(bytes, inherited));
  const expectedGetter = expected();
  Object.defineProperty(expectedGetter, 'kind', {
    enumerable: true,
    get() {
      calls++;
      return 'image_preview';
    },
  });
  rejects(() => createGalleryCodecOutputFrameDecoder(expectedGetter));
  assert.equal(calls, 0);
});
test('extra/private/config fields and invalid source/build/output shape are rejected', () => {
  const mutations = [
    (m) => {
      m.extra = true;
    },
    (m) => {
      m.output.bytes = bytes;
    },
    (m) => {
      m.sourceObservation.gps = 'private';
    },
    (m) => {
      m.build.path = '/tmp/codec';
    },
    (m) => {
      m.original.byteSize = 0;
    },
    (m) => {
      m.output.width = 0;
    },
    (m) => {
      m.sourceObservation.pages = 2;
    },
    (m) => {
      m.output.mediaType = 'video/mp4';
    },
    (m) => {
      m.build.sharp = 'unknown';
    },
    (m) => {
      m.sourceObservation.width = NaN;
    },
    (m) => {
      m.sourceObservation.orientation = 'unknown';
    },
    (m) => {
      m.sourceObservation = { ...m.sourceObservation, unknown: new Array(2) };
    },
    (m) => {
      m.build.sharp = 'x'.repeat(16385);
    },
    (m) => {
      m.build.sharp = '\ud800';
    },
  ];
  for (const mutate of mutations) {
    const metadata = fixture();
    mutate(metadata);
    rejects(() => encodeGalleryCodecOutputFrame(bytes, metadata));
  }
});
test('unknown/traversal/deep/envelope/duplicatekey/alternate JSON forms fail closed', () => {
  const canonical = JSON.stringify(envelope());
  const texts = [
    JSON.stringify({ ...envelope(), extra: true }),
    canonical.replace('"protocolVersion":1', '"protocolVersion":1,"protocolVersion":1'),
    canonical.replace('"byteSize":127', '"byteSize":127,"byteSize":127'),
    ' ' + canonical,
    canonical.replace('"protocolVersion":1', '"protocolVersion":1.0'),
    canonical.replace('image_preview', 'image_\\u0070review'),
    JSON.stringify({ output: envelope().output, protocolVersion: 1, metadata: fixture() }),
    canonical.replace('image_preview', '\\ud800'),
  ];
  for (const text of texts) {
    const decoder = createGalleryCodecOutputFrameDecoder(expected());
    rejects(() => decoder.push(wire(text)));
    rejects(() => decoder.finish(), 'frame_state');
  }
  const metadata = fixture();
  metadata.build.depth = Array.from({ length: 13 }).reduce((v) => ({ next: v }), 0);
  rejects(() => encodeGalleryCodecOutputFrame(bytes, metadata));
});
test('malformed UTF8, BOM and oversized header lengths fail before allocation', () => {
  for (const text of [
    Buffer.from([0xff]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(envelope()))]),
  ])
    rejects(() => decode(wire(text)));
  for (const size of [0, 16385, 0xffffffff]) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(size);
    rejects(() => createGalleryCodecOutputFrameDecoder(expected()).push(prefix), 'frame_budget');
  }
});
test('output caps/bodylength equality and invalid bytes are strict', () => {
  for (const size of [0, 126, 128, 0xffffffff])
    rejects(() => decode(wire(JSON.stringify(envelope()), bytes, size)));
  rejects(() => encodeGalleryCodecOutputFrame(new Uint8Array(2097153), fixture()), 'frame_budget');
  rejects(() => encodeGalleryCodecOutputFrame(new Uint8Array(), fixture()));
  for (const raw of [
    new Proxy(bytes, {}),
    new Uint8Array(new SharedArrayBuffer(4)),
    new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 })),
    new Uint16Array(4),
    new Array(4),
  ]) {
    rejects(() => encodeGalleryCodecOutputFrame(raw, fixture()));
    rejects(() => createGalleryCodecOutputFrameDecoder(expected()).push(raw));
  }
});
test('each truncation, trailing byte, second frame and poisoned decoder reuse are denied', () => {
  const frame = encodeGalleryCodecOutputFrame(bytes, fixture());
  for (let split = 0; split < frame.length; split++) {
    const decoder = createGalleryCodecOutputFrameDecoder(expected());
    decoder.push(frame.subarray(0, split));
    rejects(() => decoder.finish(), 'frame_partial');
    rejects(() => decoder.push(frame), 'frame_state');
  }
  rejects(() => decode(Buffer.concat([frame, Buffer.of(0)])), 'frame_trailing');
  rejects(() => decode(Buffer.concat([frame, frame])), 'frame_trailing');
  const decoder = createGalleryCodecOutputFrameDecoder(expected());
  decoder.push(frame);
  decoder.finish();
  rejects(() => decoder.finish(), 'frame_state');
  rejects(() => decoder.push(new Uint8Array()), 'frame_state');
});
