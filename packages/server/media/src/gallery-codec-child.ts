import { createHash } from 'node:crypto';
import { closeSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';
import {
  GalleryImageRenditionError,
  renderGalleryImageRendition,
} from './gallery-image-rendition.js';
import {
  createGalleryVideoRenditionCodec,
  GalleryVideoRenditionError,
} from './gallery-video-rendition.js';
import { galleryCodecMetadata, parseGalleryCodecChildRequest } from './gallery-codec-supervisor.js';

// Fixed private FD protocol: original 3 (read-only), derivative 4, bounded request 5 (read-only).
// No input URL, arbitrary command arguments, source path or externally supplied module is accepted.
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--gallery-codec-child') {
    process.exitCode = 64;
    return;
  }
  const controller = new AbortController();
  let cancellationSent = false;
  const emit = (value: object) => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > 16000) throw new Error('protocol_invalid');
    writeFileSync(1, bytes);
  };
  const abort = () => {
    controller.abort();
    if (!cancellationSent) {
      cancellationSent = true;
      emit({ protocolVersion: 1, state: 'cancellation_received' });
    }
  };
  process.on('SIGTERM', abort);
  emit({ protocolVersion: 1, state: 'ready' });
  try {
    const requestStat = fstatSync(5);
    if (!requestStat.isFile() || requestStat.size < 1 || requestStat.size > 4096)
      throw new Error('protocol_invalid');
    const requestValue: unknown = JSON.parse(readFileSync(5, 'utf8'));
    const request = parseGalleryCodecChildRequest(requestValue);
    const inputStat = fstatSync(3);
    if (!inputStat.isFile() || inputStat.size !== request.original.byteSize)
      throw new Error('protocol_invalid');
    const input = readFileSync(3);
    if (
      input.length !== request.original.byteSize ||
      createHash('sha256').update(input).digest('hex') !== request.original.sha256
    )
      throw new Error('protocol_invalid');
    emit({ protocolVersion: 1, state: 'started' });
    const result =
      request.kind === 'video_playback'
        ? await createGalleryVideoRenditionCodec({
            ffmpegPath: request.ffmpegPath,
            ffprobePath: request.ffprobePath,
          }).render(input, { signal: controller.signal })
        : await renderGalleryImageRendition(input, {
            kind: request.kind,
            signal: controller.signal,
          });
    if (controller.signal.aborted) throw new GalleryImageRenditionError('aborted');
    writeFileSync(4, result.output.bytes);
    // The existing codec returned after its native subprocess close/finally. Child close
    // additionally disposes the image codec's entire address space; no RSS limit is implied.
    emit({
      protocolVersion: 1,
      state: 'settled',
      outcome: 'success',
      reason: null,
      result: galleryCodecMetadata(result),
    });
  } catch (error) {
    const reason =
      error instanceof GalleryImageRenditionError || error instanceof GalleryVideoRenditionError
        ? error.code
        : 'input_invalid';
    emit({ protocolVersion: 1, state: 'settled', outcome: 'failed', reason, result: null });
  } finally {
    process.removeListener('SIGTERM', abort);
    for (const fd of [3, 4, 5]) closeSync(fd);
  }
}
await main().catch(() => {
  process.exitCode = 70;
});
