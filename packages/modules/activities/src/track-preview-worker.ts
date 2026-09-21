/**
 * Worker entry for the local-file preview.
 *
 * Bytes in, a contract-shaped parsed file or a bounded error code out. The parse runs
 * here so a large recording cannot block the interface, and so the host can end it by
 * terminating this worker: on cancellation, on a replaced file and on its deadline.
 *
 * Nothing in this file fetches, stores or uploads anything.
 */
import { parseTrackFile, TrackIngestionError } from '@workout/track-parsing';
import { z } from 'zod';

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const requestSchema = z.object({
  kind: z.literal('parse'),
  requestId: z.string().min(1).max(64),
  bytes: z.instanceof(Uint8Array),
  filename: z.string().max(256).nullable(),
});

const scope = globalThis as unknown as WorkerScope;

scope.addEventListener('message', (event) => {
  // The message crosses a boundary, so it is validated like any other untrusted input.
  const request = requestSchema.safeParse(event.data);
  if (!request.success) {
    scope.postMessage({ kind: 'failed', requestId: 'unknown', code: 'PREVIEW_REPLY_INVALID' });
    return;
  }
  const { requestId, bytes, filename } = request.data;
  void parseTrackFile(bytes, { filename })
    .then((file) => {
      scope.postMessage({ kind: 'parsed', requestId, file });
    })
    .catch((error: unknown) => {
      // Only the code travels: no message, no stack and no file content.
      const code = error instanceof TrackIngestionError ? error.code : 'PREVIEW_PARSE_FAILED';
      scope.postMessage({ kind: 'failed', requestId, code });
    });
});
