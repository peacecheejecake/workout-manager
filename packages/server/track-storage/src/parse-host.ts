import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import {
  parsedTrackFileSchema,
  trackLimits,
  type ParsedTrackFile,
} from '@workout/contracts/tracks';

import {
  storedTrackArtifactsSchema,
  storedTrackSelectionSchema,
  type StoredTrackArtifacts,
  type StoredTrackSelection,
} from './artifacts.js';

/**
 * A real memory ceiling for server-side parsing — and a check that it actually applied.
 *
 * M2-01a's parse budget bounds *work*: it charges the input buffer, the decoded text and
 * the samples, and refuses to go further. It never sees V8's heap, the XML scanner's
 * temporaries or Zod's copies, so it cannot be a memory bound. M2-01b could not close that
 * gap because a browser exposes no per-worker heap ceiling.
 *
 * A Node worker does: `resourceLimits.maxOldGenerationSizeMb` normally ends the worker —
 * and only the worker — when the parse exceeds it, and the failure arrives as
 * `ERR_WORKER_OUT_OF_MEMORY`. That containment is not guaranteed: when the limit is reached
 * inside a native, uninterruptible allocation (M2-01k-f observed structured-clone
 * deserialization, `ValueDeserializer`), Node's near-heap-limit grace can be exhausted and
 * V8 aborts the process (M2-01k-f.md F1). One worker per parse also gives the same lifetime bound the
 * browser preview has: success, failure, deadline and cancellation all end in `terminate()`.
 *
 * **A configured ceiling is not an applied ceiling.** V8's heap options are process-global:
 * a parent started with `--max-old-space-size=1024` hands that constraint to its workers
 * and the per-worker ceiling stops being enforced. Measured on Node 24.12.0, the same
 * 60,000-point GPX ends in `TRACK_PARSE_MEMORY_EXCEEDED` with a 32 MiB ceiling and a plain
 * parent, and in `TRACK_OUTPUT_TOO_LARGE` — parsed under roughly 1 GiB — when the parent
 * carries that flag. A string scan cannot settle this: the option can arrive through the
 * command line, `NODE_OPTIONS`, a wrapper, or `v8.setFlagsFromString`.
 *
 * So the bound is *verified, not assumed*, and what is verified is stated exactly: the
 * total V8 heap limit the worker is allowed to have. Every worker reports the limit V8 gave
 * it before it is handed any work, and anything above {@link BoundedTrackParserOptions.maxHeapLimitMb}
 * fails the parse closed with `TRACK_PARSE_CEILING_NOT_APPLIED`. Nothing is parsed under an
 * unverified bound, and the check is an equality with a stated budget rather than a
 * tolerance around a requested old-generation size.
 *
 * This is one of two layers. The other is the deployment's cgroup/container memory limit,
 * which bounds the whole process and is not something this code can assert.
 */
export const DEFAULT_TRACK_PARSE_HEAP_MEGABYTES = 256;
const DEFAULT_TRACK_PARSE_TIMEOUT_MS = 30_000;

/**
 * V8 reports a total heap limit above the old-generation ceiling: young generation and code
 * range are added to it. Measured on Node 24.12.0 (arm64) the difference is exactly 192 MiB
 * for every ceiling from 16 to 1024 MiB, while a parent heap option makes the worker report
 * the parent's own limit instead. The default budget is therefore `ceiling + 192`, checked
 * exactly: a parent option that raises the limit at all — `--max-old-space-size=128` against
 * a 32 MiB ceiling included — is above the budget and refused. A platform whose overhead
 * differs states its own budget through `maxHeapLimitMb` instead of widening this one; an
 * unstated difference fails closed rather than parsing under an unverified limit.
 */
export const MEASURED_HEAP_OVERHEAD_MEGABYTES = 192;

/** Failures the host itself decides. Parser codes from `TrackIngestionError` pass through. */
export const trackParseHostFailureCodes = [
  'TRACK_PARSE_MEMORY_EXCEEDED',
  'TRACK_PARSE_CEILING_NOT_APPLIED',
  'TRACK_PARSE_TIMEOUT',
  'TRACK_PARSE_CANCELLED',
  'TRACK_PARSE_WORKER_FAILED',
  'TRACK_PARSE_REPLY_INVALID',
  'TRACK_PARSER_BUSY',
] as const;
/** Always an `^[A-Z][A-Z0-9_]{2,63}$` code, never a message, a stack or file content. */
export type TrackParseFailureCode = string;

export type TrackParseOutcome =
  | { readonly ok: true; readonly artifacts: StoredTrackArtifacts }
  | { readonly ok: false; readonly code: TrackParseFailureCode };

/**
 * The whole parsed file, for a caller that needs more than one recorded track out of it.
 *
 * A course import (M2-01j) is such a caller: it has to see the file's routes and its
 * waypoints as well as its recordings, because a GPX `trk`, a `rte` and a `wpt` are three
 * different things and it must not merge them. The bytes still go through this host, so an
 * import is parsed under the same heap ceiling, the same deadline and the same
 * cancellation as a stored recording, and the reply is validated against the contract
 * before the parent looks at it.
 */
export type TrackFileParseOutcome =
  | { readonly ok: true; readonly file: ParsedTrackFile }
  | { readonly ok: false; readonly code: TrackParseFailureCode };

export interface BoundedTrackParserOptions {
  /** Hard V8 old-generation ceiling for one parse worker. */
  readonly maxOldGenerationSizeMb?: number;
  /**
   * The total V8 heap limit a parse worker may report. This is the value actually verified
   * before any work is sent; it defaults to the old-generation ceiling plus the measured
   * {@link MEASURED_HEAP_OVERHEAD_MEGABYTES}.
   */
  readonly maxHeapLimitMb?: number;
  /** Wall-clock deadline measured by the parent, independent of the parser's own budget. */
  readonly timeoutMs?: number;
  /** Concurrent parse workers in this process. */
  readonly concurrency?: number;
  /** Node CLI options for the worker. The default carries the parent's own loader setup. */
  readonly execArgv?: readonly string[];
}

export interface BoundedTrackParser {
  parse(
    bytes: Uint8Array,
    selection: StoredTrackSelection,
    options?: { readonly filename?: string | null; readonly signal?: AbortSignal },
  ): Promise<TrackParseOutcome>;
  /** The whole file, under the same bounds. Used by course import (M2-01j). */
  parseFile(
    bytes: Uint8Array,
    options?: { readonly filename?: string | null; readonly signal?: AbortSignal },
  ): Promise<TrackFileParseOutcome>;
  /** Workers currently running. */
  active(): number;
}

const workerEntry = fileURLToPath(new URL('./parse-worker.ts', import.meta.url));
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const HEAP_OPTION_PATTERN =
  /^--(?:max[-_]old[-_]space[-_]size|max[-_]semi[-_]space[-_]size|max[-_]heap[-_]size)(?:=|$)/;

export class TrackParseRuntimeConflictError extends Error {
  readonly code = 'TRACK_PARSE_HEAP_OPTION_CONFLICT';

  constructor() {
    super('A worker heap option would defeat the configured parse ceiling.');
    this.name = 'TrackParseRuntimeConflictError';
  }
}

/**
 * Only an error *code* crosses the boundary — never a message, a stack, a file name or any
 * file content. An unrecognized shape is reported as an invalid reply rather than being
 * forwarded, so a misbehaving worker cannot inject text into an API response or a log.
 */
function replyCode(value: unknown): TrackParseFailureCode {
  return typeof value === 'string' && CODE_PATTERN.test(value)
    ? value
    : 'TRACK_PARSE_REPLY_INVALID';
}

export function createBoundedTrackParser(
  options: BoundedTrackParserOptions = {},
): BoundedTrackParser {
  const heapMegabytes = options.maxOldGenerationSizeMb ?? DEFAULT_TRACK_PARSE_HEAP_MEGABYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRACK_PARSE_TIMEOUT_MS;
  const concurrency = options.concurrency ?? trackLimits.workerConcurrency;
  const heapBudgetMegabytes =
    options.maxHeapLimitMb ??
    (options.maxOldGenerationSizeMb ?? DEFAULT_TRACK_PARSE_HEAP_MEGABYTES) +
      MEASURED_HEAP_OVERHEAD_MEGABYTES;
  if (!Number.isInteger(heapMegabytes) || heapMegabytes < 16 || heapMegabytes > 4096)
    throw new RangeError('INVALID_TRACK_PARSE_HEAP_LIMIT');
  if (
    !Number.isInteger(heapBudgetMegabytes) ||
    heapBudgetMegabytes < heapMegabytes ||
    heapBudgetMegabytes > 8192
  )
    throw new RangeError('INVALID_TRACK_PARSE_HEAP_BUDGET');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000)
    throw new RangeError('INVALID_TRACK_PARSE_TIMEOUT');
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > trackLimits.workerConcurrency
  )
    throw new RangeError('INVALID_TRACK_PARSE_CONCURRENCY');
  // The worker entry is TypeScript, as every server entry point in this repository is, so
  // it needs the same loader the parent was started with. `process.execArgv` carries it
  // when the parent itself runs under `tsx`; a test host passes the option explicitly.
  const execArgv = [...(options.execArgv ?? process.execArgv)];
  // Options we are about to hand the worker are the one part of this we control, so a heap
  // option there is refused here with a name of its own rather than as Node's opaque
  // ERR_WORKER_INVALID_EXEC_ARGV. It is not the guard: process-global options arrive by
  // routes no string scan can see, and the measured check below is what catches those.
  if (execArgv.some((argument) => HEAP_OPTION_PATTERN.test(argument)))
    throw new TrackParseRuntimeConflictError();
  let active = 0;

  /**
   * One bounded parse in one worker.
   *
   * `request` is what the worker is handed once its heap ceiling has been verified, and
   * `accept` turns a successful reply into the caller's outcome — or refuses it, because a
   * worker reply is untrusted like any other boundary. Both callers below share every
   * bound: concurrency, file size, cancellation, the deadline and the terminate in
   * `finally` that ends the worker on success, failure, timeout and cancellation alike.
   */
  async function run<T>(
    bytes: Uint8Array,
    parseOptions: { readonly filename?: string | null; readonly signal?: AbortSignal },
    request: (payload: ArrayBuffer, filename: string | null) => Record<string, unknown>,
    accept: (reply: unknown) => T | null,
  ): Promise<{ ok: true; value: T } | { ok: false; code: TrackParseFailureCode }> {
    if (active >= concurrency) return { ok: false, code: 'TRACK_PARSER_BUSY' };
    if (bytes.byteLength > trackLimits.fileBytes)
      return { ok: false, code: 'TRACK_FILE_TOO_LARGE' };
    if (parseOptions.signal?.aborted) return { ok: false, code: 'TRACK_PARSE_CANCELLED' };
    active += 1;
    // Copy the exact range once and transfer it. The copy is what both the digest and the
    // parse see; the transfer hands the only reference to the worker, so the parent is
    // not holding a second copy of the file while the parse runs.
    const payload = new Uint8Array(bytes).buffer;
    const worker = new Worker(workerEntry, {
      execArgv,
      resourceLimits: { maxOldGenerationSizeMb: heapMegabytes },
      // A parse worker needs no environment, no stdio and no inherited handles.
      env: {},
      stdout: true,
      stderr: true,
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<{ ok: true; value: T } | { ok: false; code: TrackParseFailureCode }>(
        (resolve) => {
          const finish = (
            outcome: { ok: true; value: T } | { ok: false; code: TrackParseFailureCode },
          ) => {
            if (settled) return;
            settled = true;
            resolve(outcome);
          };
          timer = setTimeout(() => finish({ ok: false, code: 'TRACK_PARSE_TIMEOUT' }), timeoutMs);
          if (parseOptions.signal) {
            onAbort = () => finish({ ok: false, code: 'TRACK_PARSE_CANCELLED' });
            parseOptions.signal.addEventListener('abort', onAbort, { once: true });
          }
          worker.on('message', (message: unknown) => {
            const reply = message as {
              ready?: unknown;
              appliedHeapLimitMb?: unknown;
              ok?: unknown;
              code?: unknown;
            } | null;
            if (reply?.ready === true) {
              // The ceiling is checked before the worker is handed any bytes, so a runtime
              // whose heap option defeated it parses nothing at all.
              const applied = reply.appliedHeapLimitMb;
              if (
                typeof applied !== 'number' ||
                !Number.isFinite(applied) ||
                applied > heapBudgetMegabytes
              ) {
                finish({ ok: false, code: 'TRACK_PARSE_CEILING_NOT_APPLIED' });
                return;
              }
              worker.postMessage(request(payload, parseOptions.filename ?? null), [payload]);
              return;
            }
            if (reply && reply.ok === true) {
              // The worker is not trusted either: its reply must satisfy the contract.
              const value = accept(reply);
              finish(
                value === null
                  ? { ok: false, code: 'TRACK_PARSE_REPLY_INVALID' }
                  : { ok: true, value },
              );
              return;
            }
            finish({ ok: false, code: replyCode(reply?.code) });
          });
          worker.on('error', (error: NodeJS.ErrnoException) => {
            finish({
              ok: false,
              code:
                error.code === 'ERR_WORKER_OUT_OF_MEMORY'
                  ? 'TRACK_PARSE_MEMORY_EXCEEDED'
                  : 'TRACK_PARSE_WORKER_FAILED',
            });
          });
          worker.on('exit', () => finish({ ok: false, code: 'TRACK_PARSE_WORKER_FAILED' }));
          // Nothing is sent yet: the worker speaks first, with the heap limit it was
          // actually given.
        },
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) parseOptions.signal?.removeEventListener('abort', onAbort);
      // Every path terminates the worker: success, parser failure, memory ceiling,
      // deadline and caller cancellation. When the worker is gone, so is its heap.
      await worker.terminate().catch(() => undefined);
      active -= 1;
    }
  }

  return {
    active: () => active,
    async parse(bytes, rawSelection, parseOptions = {}) {
      const selection = storedTrackSelectionSchema.parse(rawSelection);
      const outcome = await run(
        bytes,
        parseOptions,
        (payload, filename) => ({ bytes: payload, filename, selection }),
        (reply) => {
          const parsed = storedTrackArtifactsSchema.safeParse(
            (reply as { artifacts?: unknown }).artifacts,
          );
          return parsed.success ? parsed.data : null;
        },
      );
      return outcome.ok ? { ok: true, artifacts: outcome.value } : outcome;
    },
    async parseFile(bytes, parseOptions = {}) {
      const outcome = await run(
        bytes,
        parseOptions,
        (payload, filename) => ({ bytes: payload, filename, purpose: 'whole-file' }),
        (reply) => {
          const parsed = parsedTrackFileSchema.safeParse((reply as { file?: unknown }).file);
          return parsed.success ? parsed.data : null;
        },
      );
      return outcome.ok ? { ok: true, file: outcome.value } : outcome;
    },
  };
}
