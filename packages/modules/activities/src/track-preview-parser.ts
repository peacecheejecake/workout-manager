/**
 * The boundary between the local-file preview screen and whatever actually parses bytes.
 *
 * The screen owns no parser. It hands bytes to a {@link TrackPreviewParser} and gets back
 * a value that must satisfy the shared `parsedTrackFileSchema`; a reply that does not is
 * refused, because a worker message is an untrusted bridge boundary like any other.
 *
 * Nothing here uploads anything. There is no transport, no fetch and no storage in this
 * file, so a preview cannot become a stored actual by accident.
 */
import { parsedTrackFileSchema, type ParsedTrackFile } from '@workout/contracts/tracks';
import { z } from 'zod';

/** Preview-owned failures. Parser failures arrive as their own `TRACK_*` codes. */
export type TrackPreviewFailureCode =
  | 'PREVIEW_FILE_EMPTY'
  | 'PREVIEW_FILE_TOO_LARGE'
  | 'PREVIEW_PARSER_UNAVAILABLE'
  | 'PREVIEW_WORKER_FAILED'
  | 'PREVIEW_REPLY_INVALID'
  | 'PREVIEW_TIMEOUT'
  | 'PREVIEW_CANCELLED'
  | 'PREVIEW_PARSE_FAILED';

export class TrackPreviewError extends Error {
  constructor(readonly code: TrackPreviewFailureCode | string) {
    super(code);
    this.name = 'TrackPreviewError';
  }
}

export interface TrackPreviewRequest {
  readonly bytes: Uint8Array;
  /** Display label only. The parser must sniff the content; the name proves nothing. */
  readonly filename: string | null;
}

export interface TrackPreviewParser {
  parse(request: TrackPreviewRequest, signal: AbortSignal): Promise<ParsedTrackFile>;
}

/** A bounded, screaming-snake code. Never a message, so no file content can leak out. */
const failureCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

export const trackPreviewReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('parsed'), requestId: z.string(), file: parsedTrackFileSchema }),
  z.object({ kind: z.literal('failed'), requestId: z.string(), code: failureCodeSchema }),
]);
export type TrackPreviewReply = z.infer<typeof trackPreviewReplySchema>;

export interface TrackPreviewWorkerRequest {
  readonly kind: 'parse';
  readonly requestId: string;
  readonly bytes: Uint8Array;
  readonly filename: string | null;
}

/** The part of `Worker` this client uses. Injected so the protocol is testable. */
export interface PreviewWorkerLike {
  postMessage(message: TrackPreviewWorkerRequest): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'messageerror' | 'error', listener: (event: unknown) => void): void;
}

export interface WorkerTrackParserOptions {
  readonly createWorker: () => PreviewWorkerLike;
  /**
   * Wall-clock deadline enforced by this side. The parser's own budget counts work, so a
   * parse that stalls outside a charge point would otherwise never end; termination is
   * the only bound that does not depend on the parsed code cooperating.
   */
  readonly timeoutMs?: number;
}

/**
 * One worker per parse, always terminated.
 *
 * Termination is the memory bound this layer can actually enforce: the worker's heap
 * goes away with it on success, failure, timeout, cancellation and file replacement.
 * A browser offers no per-worker heap ceiling, so this is a lifetime bound and not a
 * ceiling; see the progress note for what that does and does not cover.
 */
export function createWorkerTrackParser(options: WorkerTrackParserOptions): TrackPreviewParser {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let counter = 0;
  return {
    parse(request, signal) {
      counter += 1;
      const requestId = `preview-${counter}`;
      return new Promise<ParsedTrackFile>((resolve, reject) => {
        if (signal.aborted) {
          reject(new TrackPreviewError('PREVIEW_CANCELLED'));
          return;
        }
        let worker: PreviewWorkerLike;
        try {
          worker = options.createWorker();
        } catch {
          reject(new TrackPreviewError('PREVIEW_PARSER_UNAVAILABLE'));
          return;
        }
        let settled = false;
        const finish = (run: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          worker.terminate();
          run();
        };
        const fail = (code: TrackPreviewFailureCode | string) =>
          finish(() => reject(new TrackPreviewError(code)));
        const timer = setTimeout(() => fail('PREVIEW_TIMEOUT'), timeoutMs);
        const onAbort = () => fail('PREVIEW_CANCELLED');
        signal.addEventListener('abort', onAbort, { once: true });
        worker.addEventListener('message', (event: { data: unknown }) => {
          const reply = trackPreviewReplySchema.safeParse(event.data);
          if (!reply.success) {
            fail('PREVIEW_REPLY_INVALID');
            return;
          }
          // A reply for another request id is not this parse's answer.
          if (reply.data.requestId !== requestId) return;
          if (reply.data.kind === 'failed') {
            fail(reply.data.code);
            return;
          }
          const file = reply.data.file;
          finish(() => resolve(file));
        });
        worker.addEventListener('messageerror', () => fail('PREVIEW_REPLY_INVALID'));
        worker.addEventListener('error', () => fail('PREVIEW_WORKER_FAILED'));
        try {
          worker.postMessage({
            kind: 'parse',
            requestId,
            bytes: request.bytes,
            filename: request.filename,
          });
        } catch {
          fail('PREVIEW_WORKER_FAILED');
        }
      });
    },
  };
}

/**
 * Parser that runs on the calling thread. Provided for hosts without workers and for
 * tests; it blocks the thread it runs on, which is exactly why the worker client above
 * is the default in the shells.
 */
export function createInlineTrackParser(
  parse: (bytes: Uint8Array, filename: string | null) => unknown | Promise<unknown>,
): TrackPreviewParser {
  return {
    async parse(request, signal) {
      if (signal.aborted) throw new TrackPreviewError('PREVIEW_CANCELLED');
      let produced: unknown;
      try {
        produced = await parse(request.bytes, request.filename);
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'PREVIEW_PARSE_FAILED';
        throw new TrackPreviewError(
          failureCodeSchema.safeParse(code).success ? code : 'PREVIEW_PARSE_FAILED',
        );
      }
      const file = parsedTrackFileSchema.safeParse(produced);
      if (!file.success) throw new TrackPreviewError('PREVIEW_REPLY_INVALID');
      if (signal.aborted) throw new TrackPreviewError('PREVIEW_CANCELLED');
      return file.data;
    },
  };
}
