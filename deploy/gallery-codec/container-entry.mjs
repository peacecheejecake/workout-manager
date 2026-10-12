import { mkdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';

import {
  createGalleryCodecInputFrameDecoder,
  GalleryCodecInputFrameError,
} from './input-frame.mjs';
import { encodeGalleryCodecOutputFrame, GalleryCodecOutputFrameError } from './output-frame.mjs';

const reasons = [
  'input_invalid',
  'input_budget',
  'codec_unavailable',
  'unsupported_format',
  'unsupported_pages',
  'pixel_budget',
  'invalid_media',
  'decode_failed',
  'output_budget',
  'aborted',
  'timeout',
  'frame_invalid',
  'frame_budget',
  'frame_state',
  'frame_partial',
  'frame_trailing',
  'frame_integrity',
  'semantic_invalid',
  'io_failed',
];
export class GalleryCodecContainerEntryError extends Error {
  constructor(reason) {
    const code = reasons.includes(reason) ? reason : 'io_failed';
    super(code);
    this.name = 'GalleryCodecContainerEntryError';
    this.reason = code;
  }
}
function fail(reason) {
  throw new GalleryCodecContainerEntryError(reason);
}
function checkAbort(signal) {
  if (signal?.aborted) fail('aborted');
}
function finiteReason(error, codecErrorCode) {
  if (types.isProxy(error)) return 'io_failed';
  if (error instanceof GalleryCodecContainerEntryError) return error.reason;
  if (error instanceof GalleryCodecInputFrameError || error instanceof GalleryCodecOutputFrameError)
    return error.code;
  try {
    const code = codecErrorCode(error);
    return reasons.includes(code) ? code : 'io_failed';
  } catch {
    return 'io_failed';
  }
}

// A single bounded frame write waits for both completion callback and required drain.
// Listeners are installed before write so synchronous callbacks/drain cannot race setup.
async function writeFrame(output, frame, signal) {
  checkAbort(signal);
  await new Promise((resolve, reject) => {
    let callbackDone = false,
      drained = false,
      needsDrain,
      settled = false;
    const cleanup = () => {
      output.removeListener('error', onError);
      output.removeListener('close', onClose);
      output.removeListener('drain', onDrain);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      if (!error && (needsDrain === undefined || !callbackDone || (needsDrain && !drained))) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = () => {
      output.destroy();
    };
    const onClose = () =>
      finish(new GalleryCodecContainerEntryError(signal?.aborted ? 'aborted' : 'io_failed'));
    const onAbort = () => {
      output.destroy();
    };
    const onDrain = () => {
      drained = true;
      finish();
    };
    output.on('error', onError);
    output.on('close', onClose);
    output.on('drain', onDrain);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      needsDrain = !output.write(frame, (error) => {
        if (error) onError();
        else {
          callbackDone = true;
          finish();
        }
      });
      finish();
    } catch {
      onError();
    }
    if (signal?.aborted) onAbort();
  });
  checkAbort(signal);
}

/**
 * Trusted test/worker dependency port, never an HTTP input. Codec functions/validator are
 * injected here only; production uses fixed compiled modules below. No owner/lease proof.
 */
export async function runGalleryCodecContainerEntry(ports) {
  const { input, output, signal, renderImage, renderVideo, metadata, validate, codecErrorCode } =
    ports;
  let inputComplete = false,
    codecStarted = false,
    outputComplete = false;
  const onInputError = () => {};
  const onOutputError = () => {};
  // Stream errors are consumed, never printed. Aborting unblocks a pending Readable.next.
  input.on('error', onInputError);
  output.on('error', onOutputError);
  const abort = () => {
    input.destroy();
    output.destroy();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkAbort(signal);
    const decoder = createGalleryCodecInputFrameDecoder();
    for await (const chunk of input) {
      checkAbort(signal);
      decoder.push(chunk);
    }
    checkAbort(signal);
    const original = decoder.finish();
    inputComplete = true;
    codecStarted = true;
    const result =
      original.kind === 'video_playback'
        ? await renderVideo(original.bytes, { signal })
        : await renderImage(original.bytes, { kind: original.kind, signal });
    checkAbort(signal);
    let checked;
    try {
      checked = validate(metadata(result), result.output.bytes);
    } catch {
      fail('semantic_invalid');
    }
    if (
      checked.kind !== original.kind ||
      checked.original.byteSize !== original.original.byteSize ||
      checked.original.sha256 !== original.original.sha256
    )
      fail('frame_integrity');
    const frame = encodeGalleryCodecOutputFrame(checked.output.bytes, metadata(checked));
    checkAbort(signal);
    await writeFrame(output, frame, signal);
    outputComplete = true;
    checkAbort(signal);
    return Object.freeze({
      outcome: 'success',
      reason: null,
      exitCode: 0,
      inputComplete,
      codecStarted,
      outputComplete,
    });
  } catch (error) {
    const reason = signal?.aborted ? 'aborted' : finiteReason(error, codecErrorCode);
    return Object.freeze({
      outcome: 'failed',
      reason,
      exitCode: reason === 'aborted' ? 73 : 70,
      inputComplete,
      codecStarted,
      outputComplete,
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    input.removeListener('error', onInputError);
    output.removeListener('error', onOutputError);
  }
}

async function production() {
  if (
    process.argv.length !== 2 ||
    process.argv[1] !== '/codec/container-entry.mjs' ||
    process.execPath !== '/usr/local/bin/node' ||
    process.execArgv.length !== 0 ||
    process.cwd() !== '/work' ||
    process.getuid?.() !== 20001 ||
    process.getgid?.() !== 20001 ||
    process.env.TMPDIR !== '/work/tmp'
  )
    return 64;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  try {
    await mkdir('/work/tmp', { recursive: true, mode: 0o700 });
    const directory = await lstat('/work/tmp');
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== 20001 ||
      (directory.mode & 0o777) !== 0o700
    )
      return 64;
    let image, video, shared;
    try {
      [image, video, shared] = await Promise.all([
        import('/codec/lib/gallery-image-rendition.js'),
        import('/codec/lib/gallery-video-rendition.js'),
        import('/codec/lib/gallery-codec-supervisor.js'),
      ]);
      if (
        typeof image.renderGalleryImageRendition !== 'function' ||
        typeof video.createGalleryVideoRenditionCodec !== 'function' ||
        typeof shared.galleryCodecMetadata !== 'function' ||
        typeof shared.parseGalleryCodecResultMetadata !== 'function'
      )
        fail('codec_unavailable');
    } catch {
      fail('codec_unavailable');
    }
    const codec = video.createGalleryVideoRenditionCodec({
      ffmpegPath: '/usr/local/bin/ffmpeg',
      ffprobePath: '/usr/local/bin/ffprobe',
    });
    const result = await runGalleryCodecContainerEntry({
      input: process.stdin,
      output: process.stdout,
      signal: controller.signal,
      renderImage: image.renderGalleryImageRendition,
      renderVideo: (bytes, options) => codec.render(bytes, options),
      metadata: shared.galleryCodecMetadata,
      validate: shared.parseGalleryCodecResultMetadata,
      codecErrorCode: (error) =>
        error instanceof image.GalleryImageRenditionError ||
        error instanceof video.GalleryVideoRenditionError
          ? error.code
          : null,
    });
    if (result.outcome === 'failed')
      process.stderr.write(`GALLERY_CODEC_FAILURE:${result.reason}\n`);
    return result.exitCode;
  } catch {
    process.stderr.write('GALLERY_CODEC_FAILURE:codec_unavailable\n');
    return 70;
  } finally {
    process.removeListener('SIGTERM', abort);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await production();
