'use client';

/**
 * The parser the two shells actually use.
 *
 * A dedicated worker per parse, and nothing else. The worker is the only thing that gives
 * this screen the two properties the local-file path depends on: the parse cannot block
 * the interface, and the host can end it — `terminate()` on cancellation, on a replaced
 * file and on the deadline. Browsers expose no per-worker heap ceiling, so termination is
 * the whole mitigation; running the same parse on the calling thread instead would keep
 * neither the deadline nor the cancel button working, so a runtime without workers gets
 * `PREVIEW_PARSER_UNAVAILABLE` rather than a quietly degraded parse.
 *
 * `createInlineTrackParser` stays available for callers that deliberately want a
 * calling-thread parse (tests, non-browser hosts); it is never selected implicitly here.
 *
 * The parser itself is loaded by the worker entry, so it stays out of the main bundle.
 */
import {
  createWorkerTrackParser,
  type PreviewWorkerLike,
  type TrackPreviewParser,
} from './track-preview-parser';

export interface BrowserTrackParserOptions {
  readonly timeoutMs?: number;
  /** Injected in tests; defaults to a module worker built from this package's entry. */
  readonly createWorker?: () => PreviewWorkerLike;
}

function defaultWorker(): PreviewWorkerLike {
  return new Worker(new URL('./track-preview-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as PreviewWorkerLike;
}

export function createBrowserTrackParser(
  options: BrowserTrackParserOptions = {},
): TrackPreviewParser {
  return createWorkerTrackParser({
    createWorker: options.createWorker ?? defaultWorker,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
