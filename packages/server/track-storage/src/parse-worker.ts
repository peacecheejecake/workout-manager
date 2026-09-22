import { getHeapStatistics } from 'node:v8';
import { parentPort } from 'node:worker_threads';

import { buildMapPath, parseTrackFile, trackAggregates } from '@workout/track-parsing';
import { recordedTrackSchema } from '@workout/contracts/tracks';

import { storedTrackSelectionSchema, type StoredTrackArtifacts } from './artifacts.js';

/**
 * Parse worker entry point. It receives bytes and a selection, and returns either the
 * stored artifacts or a single error code. It holds no database handle, no storage handle
 * and no credentials, and it never reads the file system.
 *
 * Everything expensive happens here on purpose: parsing, normalization, the display
 * geometry and the aggregates are all built under the V8 heap ceiling the parent set
 * through `resourceLimits`, so exceeding it ends this thread instead of the process.
 *
 * The first message this worker sends is the heap limit V8 actually gave it. The parent
 * withholds the bytes until it has checked that value against the ceiling it asked for,
 * because a process-global heap option can silently replace it.
 */
const port = parentPort;
if (!port) throw new Error('TRACK_PARSE_WORKER_REQUIRES_PARENT');

port.postMessage({
  ready: true,
  appliedHeapLimitMb: getHeapStatistics().heap_size_limit / (1024 * 1024),
});

port.on('message', (message: unknown) => {
  const request = message as { bytes?: unknown; filename?: unknown; selection?: unknown } | null;
  const buffer = request?.bytes;
  const selection = storedTrackSelectionSchema.safeParse(request?.selection);
  if (!(buffer instanceof ArrayBuffer) || !selection.success) {
    port.postMessage({ ok: false, code: 'TRACK_PARSE_REQUEST_INVALID' });
    return;
  }
  const filename = typeof request?.filename === 'string' ? request.filename : null;
  void parseTrackFile(new Uint8Array(buffer), { filename })
    .then((file) => {
      const parsed = file.recorded[selection.data.recordedTrackIndex];
      if (!parsed) {
        // A file holding several recordings requires an explicit selection, and a
        // selection that names nothing is an error rather than a silent first-track pick.
        port.postMessage({
          ok: false,
          code: file.recorded.length === 0 ? 'TRACK_NO_TRACK_DATA' : 'TRACK_SELECTION_INVALID',
        });
        return;
      }
      // The stored recording carries `activity-source` provenance; the local-file
      // provenance belongs to a preview and must not survive into storage.
      const stored = recordedTrackSchema.parse({
        ...parsed,
        provenance: selection.data.provenance,
      });
      const artifacts: StoredTrackArtifacts = {
        format: file.format,
        parserId: file.parserId,
        parserVersion: file.parserVersion,
        fileSha256: file.fileSha256,
        fileByteLength: file.fileByteLength,
        originalFilename: file.originalFilename,
        recordedCount: file.recorded.length,
        requiresSelection: file.requiresSelection,
        track: stored,
        mapPath: buildMapPath(stored),
        aggregates: trackAggregates(stored),
      };
      port.postMessage({ ok: true, artifacts });
    })
    .catch((error: unknown) => {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code: unknown }).code
          : undefined;
      port.postMessage({
        ok: false,
        code: typeof code === 'string' ? code : 'TRACK_PARSE_FAILED',
      });
    });
});
