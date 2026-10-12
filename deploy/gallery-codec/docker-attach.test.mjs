import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  createGalleryCodecDockerAttachDecoder,
  GalleryCodecAttachError,
} from './docker-attach.mjs';
import { encodeGalleryCodecOutputFrame } from './output-frame.mjs';

const bytes = Buffer.from('synthetic derivative');
const original = { sha256: 'a'.repeat(64), byteSize: 512 };
const metadata = {
  recipeVersion: 1,
  kind: 'image_thumbnail',
  original,
  sourceObservation: {
    format: 'png',
    width: 8,
    height: 6,
    orientation: null,
    pages: null,
    orientedWidth: 8,
    orientedHeight: 6,
  },
  output: {
    mediaType: 'image/webp',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
    width: 8,
    height: 6,
  },
  build: { sharp: '0.35.4', vips: '8.18.0' },
};
const codecWire = encodeGalleryCodecOutputFrame(bytes, metadata);
const make = () => createGalleryCodecDockerAttachDecoder({ kind: 'image_thumbnail', original });
function packet(stream, body) {
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}
function rejects(operation, code) {
  assert.throws(
    operation,
    (error) => error instanceof GalleryCodecAttachError && error.code === code,
  );
}

test('Docker multiplex splitting and stderr interleaving retain original codec integrity', () => {
  const wire = Buffer.concat([
    packet(1, codecWire.subarray(0, 17)),
    packet(2, Buffer.from('untrusted payload')),
    packet(1, codecWire.subarray(17)),
    packet(2, Buffer.alloc(0)),
  ]);
  for (const size of [1, 2, 7, 8, 9, 17, 1024]) {
    const decoder = make();
    for (let offset = 0; offset < wire.length; offset += size)
      decoder.push(wire.subarray(offset, offset + size));
    const result = decoder.finish();
    assert.deepEqual(Buffer.from(result.result.bytes), bytes);
    assert.equal(result.result.metadata.original.sha256, original.sha256);
    assert.equal(result.stderrBytes, 17);
    assert.equal(result.frameCount, 4);
    assert.equal(result.processingAuthority, 'none');
    assert.equal(JSON.stringify(result).includes('untrusted payload'), false);
  }
});

test('every truncated Docker frame is rejected, including missing stdout body', () => {
  const wire = packet(1, codecWire);
  for (let end = 0; end < wire.length; end++) {
    const decoder = make();
    decoder.push(wire.subarray(0, end));
    assert.throws(() => decoder.finish(), GalleryCodecAttachError);
  }
});

test('stdin, unknown stream types and reserved bits fail without payload diagnostics', () => {
  for (const stream of [0, 3, 255]) {
    const decoder = make();
    rejects(() => decoder.push(packet(stream, Buffer.from('secret'))), 'attach_invalid');
    rejects(() => decoder.finish(), 'attach_state');
  }
  for (const position of [1, 2, 3]) {
    const wire = packet(1, Buffer.alloc(0));
    wire[position] = 1;
    rejects(() => make().push(wire), 'attach_invalid');
  }
});

test('declared stdout and stderr overruns fail at the header before body allocation', () => {
  for (const [stream, size] of [
    [1, 67108864 + 16384 + 9],
    [2, 65537],
  ]) {
    const header = packet(stream, Buffer.alloc(0));
    header.writeUInt32BE(size, 4);
    const decoder = make();
    rejects(() => decoder.push(header), 'attach_budget');
    rejects(() => decoder.push(Buffer.alloc(0)), 'attach_state');
  }
});

test('stderr is aggregate bounded and empty frame floods are finite', () => {
  const decoder = make();
  decoder.push(packet(2, Buffer.alloc(65536)));
  rejects(() => decoder.push(packet(2, Buffer.alloc(1))), 'attach_budget');
  const empty = make();
  for (let index = 0; index < 65536; index++) empty.push(packet(2, Buffer.alloc(0)));
  rejects(() => empty.push(packet(2, Buffer.alloc(0))), 'attach_budget');
});

test('stdout integrity or trailing codec bytes poison the complete attach decoder', () => {
  const altered = Buffer.from(codecWire);
  altered[altered.length - 1] ^= 1;
  rejects(() => make().push(packet(1, altered)), 'attach_output_invalid');
  const trailing = make();
  trailing.push(packet(1, codecWire));
  rejects(() => trailing.push(packet(1, Buffer.from('x'))), 'attach_output_invalid');
});

test('byte inputs cannot execute accessors or accept shared buffers', () => {
  let called = 0;
  const poison = Buffer.alloc(1);
  Object.defineProperty(poison, 'byteLength', {
    get() {
      called++;
      throw new Error('secret');
    },
  });
  rejects(() => make().push(poison), 'attach_invalid');
  assert.equal(called, 0);
  rejects(() => make().push(new Uint8Array(new SharedArrayBuffer(8))), 'attach_invalid');
  rejects(() => make().push(new Proxy(Buffer.alloc(8), {})), 'attach_invalid');
});

test('single finish cannot be replayed or accept late bytes', () => {
  const decoder = make();
  decoder.push(packet(1, codecWire));
  decoder.finish();
  rejects(() => decoder.finish(), 'attach_state');
  rejects(() => decoder.push(packet(2, Buffer.alloc(0))), 'attach_state');
});
