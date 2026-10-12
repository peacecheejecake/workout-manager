import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { test } from 'vitest';

import {
  runGalleryCodecContainerEntry,
  GalleryCodecContainerEntryError,
} from './container-entry.mjs';
import { encodeGalleryCodecInputFrame } from './input-frame.mjs';
import { createGalleryCodecOutputFrameDecoder } from './output-frame.mjs';

const source = Uint8Array.of(1, 2, 3, 4);
const outputBytes = Uint8Array.of(10, 11, 12);
const hash = (value) => createHash('sha256').update(value).digest('hex');
function metadata(result) {
  const output = { ...result.output };
  Reflect.deleteProperty(output, 'bytes');
  return { ...result, output };
}
function result(kind = 'image_preview') {
  const original = { sha256: hash(source), byteSize: source.length };
  const build = { sha256: 'a'.repeat(64), version: '9.0.2', buildSha256: 'b'.repeat(64) };
  return {
    recipeVersion: 1,
    kind,
    original,
    sourceObservation:
      kind === 'video_playback'
        ? {
            format: 'mov,mp4,m4a,3gp,3g2,mj2',
            videoCodec: 'h264',
            audioCodec: null,
            width: 8,
            height: 6,
            sampleAspectNumerator: 1,
            sampleAspectDenominator: 1,
            rotationDegrees: 0,
            rotatedWidth: 8,
            rotatedHeight: 6,
            displayAspect: 8 / 6,
            fps: 24,
            durationSeconds: 1,
            frameCount: 24,
            hasAudio: false,
          }
        : {
            format: 'jpeg',
            width: 8,
            height: 6,
            orientation: null,
            pages: null,
            orientedWidth: 8,
            orientedHeight: 6,
          },
    output: {
      mediaType: kind === 'video_playback' ? 'video/mp4' : 'image/webp',
      sha256: hash(outputBytes),
      byteSize: outputBytes.length,
      width: 8,
      height: 6,
      bytes: new Uint8Array(outputBytes),
      ...(kind === 'video_playback' ? { durationSeconds: 1, frameCount: 24, hasAudio: false } : {}),
    },
    build:
      kind === 'video_playback'
        ? { ffmpeg: build, ffprobe: { ...build } }
        : { sharp: '0.35.4', vips: '8.18.0' },
  };
}
function setup({ kind = 'image_preview', input, output, signal, validate, render } = {}) {
  const frames = [];
  const calls = [];
  const stdin = input ?? Readable.from([encodeGalleryCodecInputFrame(source, { kind })]);
  const stdout =
    output ??
    new Writable({
      write(chunk, _encoding, callback) {
        frames.push(Buffer.from(chunk));
        callback();
      },
    });
  const ports = {
    input: stdin,
    output: stdout,
    signal,
    renderImage: async (bytes, options) => {
      calls.push({ kind: options.kind, hash: hash(bytes) });
      return render ? render(bytes, options) : result(options.kind);
    },
    renderVideo: async (bytes, options) => {
      calls.push({ kind: 'video_playback', hash: hash(bytes) });
      return render ? render(bytes, options) : result('video_playback');
    },
    metadata,
    validate: validate ?? ((value, bytes) => ({ ...value, output: { ...value.output, bytes } })),
    codecErrorCode: (error) =>
      error instanceof Error && error.message === 'synthetic_codec_unavailable'
        ? 'codec_unavailable'
        : null,
  };
  return { ports, frames, calls, stdin, stdout };
}

test('one complete original dispatches exact kind and yields one strict output frame', async () => {
  for (const kind of ['image_preview', 'image_thumbnail', 'video_playback']) {
    const harness = setup({ kind });
    const facts = await runGalleryCodecContainerEntry(harness.ports);
    assert.deepEqual(facts, {
      outcome: 'success',
      reason: null,
      exitCode: 0,
      inputComplete: true,
      codecStarted: true,
      outputComplete: true,
    });
    assert.deepEqual(harness.calls, [{ kind, hash: hash(source) }]);
    assert.equal(harness.frames.length, 1);
    const decoder = createGalleryCodecOutputFrameDecoder({
      kind,
      original: { byteSize: source.length, sha256: hash(source) },
    });
    decoder.push(harness.frames[0]);
    const output = decoder.finish();
    assert.deepEqual(output.bytes, outputBytes);
    // Node's async iterator retains its own late-error listener; the entry removes only its own.
    assert.ok(
      harness.stdin.listeners('error').every((listener) => listener.name !== 'onInputError'),
    );
    assert.equal(harness.stdout.listenerCount('error'), 0);
  }
});

test('no dispatch before actual EOF, including trailing/partial/invalid frame rejection', async () => {
  const frame = encodeGalleryCodecInputFrame(source, { kind: 'image_preview' });
  for (const bytes of [
    frame.subarray(0, frame.length - 1),
    Buffer.concat([frame, Buffer.of(0)]),
    Buffer.concat([frame, frame]),
    Buffer.from('invalid'),
  ]) {
    const harness = setup({ input: Readable.from([bytes]) });
    const facts = await runGalleryCodecContainerEntry(harness.ports);
    assert.equal(facts.outcome, 'failed');
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.frames.length, 0);
    assert.equal(facts.inputComplete, false);
  }
});

test('semantic validator runs once after codec settles and before writing any frame', async () => {
  let calls = 0;
  const harness = setup({
    validate: () => {
      calls++;
      throw new Error('private metadata detail');
    },
  });
  const facts = await runGalleryCodecContainerEntry(harness.ports);
  assert.equal(facts.reason, 'semantic_invalid');
  assert.equal(calls, 1);
  assert.equal(harness.frames.length, 0);
  assert.equal(facts.codecStarted, true);
});

test('actual original/kind mismatch and derived hash mismatch deny success after validation', async () => {
  for (const mutate of [
    (r) => {
      r.original.sha256 = 'f'.repeat(64);
    },
    (r) => {
      r.original.byteSize = 3;
    },
    (r) => {
      r.kind = 'image_thumbnail';
    },
    (r) => {
      r.output.sha256 = 'f'.repeat(64);
    },
  ]) {
    const harness = setup({
      render: async () => {
        const value = result();
        mutate(value);
        return value;
      },
    });
    const facts = await runGalleryCodecContainerEntry(harness.ports);
    assert.equal(facts.reason, 'frame_integrity');
    assert.equal(harness.frames.length, 0);
  }
});

test('pre-abort invokes no codec and removes own listeners', async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = setup({ signal: controller.signal });
  const facts = await runGalleryCodecContainerEntry(harness.ports);
  assert.equal(facts.reason, 'aborted');
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.frames.length, 0);
  assert.equal(harness.stdout.listenerCount('error'), 0);
});

test('abort unblocks waiting input EOF; no native dispatch or output', async () => {
  const controller = new AbortController();
  const input = new Readable({ read() {} });
  const harness = setup({ input, signal: controller.signal });
  const pending = runGalleryCodecContainerEntry(harness.ports);
  controller.abort();
  const facts = await pending;
  assert.equal(facts.reason, 'aborted');
  assert.equal(harness.calls.length, 0);
  assert.equal(input.destroyed, true);
});

test('codec abort signal is propagated and entry waits for injected settlement', async () => {
  const controller = new AbortController();
  let started, settle;
  const begun = new Promise((resolve) => {
    started = resolve;
  });
  let received = false;
  const harness = setup({
    signal: controller.signal,
    render: async (_bytes, { signal }) => {
      started();
      return new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            received = true;
            settle = () => resolve(result());
          },
          { once: true },
        );
      });
    },
  });
  let finished = false;
  const pending = runGalleryCodecContainerEntry(harness.ports).then((value) => {
    finished = true;
    return value;
  });
  await begun;
  controller.abort();
  await Promise.resolve();
  assert.equal(received, true);
  assert.equal(finished, false);
  settle();
  const facts = await pending;
  assert.equal(facts.reason, 'aborted');
  assert.equal(harness.frames.length, 0);
});

test('backpressure waits for completed write and drain instead of reporting early success', async () => {
  let callback, started;
  const writing = new Promise((resolve) => {
    started = resolve;
  });
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, done) {
      callback = done;
      started();
    },
  });
  const harness = setup({ output });
  let settled = false;
  const pending = runGalleryCodecContainerEntry(harness.ports).then((value) => {
    settled = true;
    return value;
  });
  await writing;
  assert.equal(settled, false);
  callback();
  const facts = await pending;
  assert.equal(facts.outcome, 'success');
  assert.equal(output.listenerCount('drain'), 0);
});

test('output abort waits for writable close; cancellation cannot become success', async () => {
  const controller = new AbortController();
  let started;
  const writing = new Promise((resolve) => {
    started = resolve;
  });
  let closed = false;
  const output = new Writable({
    highWaterMark: 1,
    write() {
      started();
    },
  });
  output.on('close', () => {
    closed = true;
  });
  const harness = setup({ output, signal: controller.signal });
  const pending = runGalleryCodecContainerEntry(harness.ports);
  await writing;
  controller.abort();
  const facts = await pending;
  assert.equal(facts.reason, 'aborted');
  assert.equal(facts.outputComplete, false);
  assert.equal(closed, true);
});

test('finite native/stream failures contain no raw exception text and output no success frame', async () => {
  const harness = setup({
    render: async () => {
      throw new Error('synthetic_codec_unavailable');
    },
  });
  const facts = await runGalleryCodecContainerEntry(harness.ports);
  assert.equal(facts.reason, 'codec_unavailable');
  assert.equal(harness.frames.length, 0);
  const input = new Readable({
    read() {
      this.destroy(new Error('private input path/token'));
    },
  });
  const failure = await runGalleryCodecContainerEntry(setup({ input }).ports);
  assert.equal(failure.reason, 'io_failed');
  assert.ok(!JSON.stringify(failure).includes('private'));
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('private output value'));
    },
  });
  const failed = await runGalleryCodecContainerEntry(setup({ output }).ports);
  assert.equal(failed.reason, 'io_failed');
  assert.equal(failed.outputComplete, false);
});

test('unknown thrown proxy and arbitrary typed reason cannot emit raw payload', async () => {
  let calls = 0;
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        calls++;
        throw new Error('private');
      },
    },
  );
  for (const error of [proxy, new GalleryCodecContainerEntryError('private/token')]) {
    const harness = setup({
      render: async () => {
        throw error;
      },
    });
    const facts = await runGalleryCodecContainerEntry(harness.ports);
    assert.equal(facts.reason, 'io_failed');
    assert.ok(!JSON.stringify(facts).includes('private'));
  }
  assert.equal(calls, 0);
});
