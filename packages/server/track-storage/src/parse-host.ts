import { fork, type ChildProcess } from 'node:child_process';
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
 * **The parse runs in its own process** (M2-01ai). Each parse forks one `parse-child.ts`
 * with `--max-old-space-size` set to the ceiling. Until M2-01ai it ran in a worker thread
 * with `resourceLimits`, which normally ends only the worker — but not always: when the
 * limit is reached inside a native, uninterruptible allocation (M2-01k-f observed
 * structured-clone deserialization, `ValueDeserializer`), Node's near-heap-limit grace can
 * be exhausted and V8 aborts the *whole process*, the API included (M2-01k-f.md F1).
 * A V8 abort in a child process ends that child. The host sees it exit, recognizes V8's
 * out-of-memory report on the child's stderr, and answers `TRACK_PARSE_MEMORY_EXCEEDED`;
 * the API keeps serving. One process per parse also gives the same lifetime bound the
 * browser preview has: success, failure, deadline, cancellation and shutdown all end in a
 * kill, and the host waits for the exit before it frees the slot.
 *
 * **A configured ceiling is not an applied ceiling.** The child is started with an
 * environment of at most `TMPDIR` (so no `NODE_OPTIONS`) and with the ceiling as its last CLI
 * option. A heap option explicitly passed in `execArgv` is refused at construction; the
 * host's own heap options are dropped from what the child inherits. They no longer reach the
 * parse at all: they were process-global for a worker thread. Still, the bound is
 * *verified, not assumed*: every child reports the total V8 heap limit it was given before
 * it is handed any bytes, and anything above {@link BoundedTrackParserOptions.maxHeapLimitMb}
 * fails the parse closed with `TRACK_PARSE_CEILING_NOT_APPLIED`. Nothing is parsed under an
 * unverified bound.
 *
 * This is one of two layers. The other is the deployment's cgroup/container memory limit,
 * which bounds the whole process tree and is not something this code can assert.
 */
export const DEFAULT_TRACK_PARSE_HEAP_MEGABYTES = 256;
const DEFAULT_TRACK_PARSE_TIMEOUT_MS = 30_000;

/**
 * V8 reports a total heap limit above the old-generation ceiling: young generation and code
 * range are added to it. Measured on Node 24.12.0 (arm64) the difference is exactly 192 MiB
 * for every ceiling from 16 to 1024 MiB, the same for a process started with
 * `--max-old-space-size` (M2-01ai) as for a worker with `resourceLimits` (M2-01k-f). The
 * default budget is therefore `ceiling + 192`, checked exactly. A platform whose overhead
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
  /** Hard V8 old-generation ceiling for one parse process (`--max-old-space-size`). */
  readonly maxOldGenerationSizeMb?: number;
  /**
   * The total V8 heap limit a parse process may report. This is the value actually verified
   * before any work is sent; it defaults to the old-generation ceiling plus the measured
   * {@link MEASURED_HEAP_OVERHEAD_MEGABYTES}.
   */
  readonly maxHeapLimitMb?: number;
  /** Wall-clock deadline measured by the parent, independent of the parser's own budget. */
  readonly timeoutMs?: number;
  /** Parse processes this parser runs at once. Work past it is refused, not queued. */
  readonly concurrency?: number;
  /** Node CLI options for the parse process. The default carries the parent's own loader setup. */
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
  /** Parses currently admitted. A slot is freed only after its process has exited. */
  active(): number;
  /** Process ids of the parse processes currently alive (operations and tests). */
  processIds(): readonly number[];
  /**
   * Shutdown: every running parse ends as `TRACK_PARSE_CANCELLED` and its process is
   * killed; later calls are refused the same way. Resolves once every process has exited.
   */
  close(): Promise<void>;
}

const childEntry = fileURLToPath(new URL('./parse-child.ts', import.meta.url));
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const HEAP_OPTION_PATTERN =
  /^--(?:max[-_]old[-_]space[-_]size|max[-_]semi[-_]space[-_]size|max[-_]heap[-_]size)(?:=|$)/;
/**
 * What V8 writes to stderr when a heap limit ends the process: "FATAL ERROR: Reached heap
 * limit Allocation failed - JavaScript heap out of memory" and its "Ineffective
 * mark-compacts near heap limit" and "CALL_AND_RETRY_LAST" variants all end the same way.
 */
const V8_OUT_OF_MEMORY = 'JavaScript heap out of memory';

export class TrackParseRuntimeConflictError extends Error {
  readonly code = 'TRACK_PARSE_HEAP_OPTION_CONFLICT';

  constructor() {
    super('A parse process heap option would defeat the configured parse ceiling.');
    this.name = 'TrackParseRuntimeConflictError';
  }
}

/**
 * Every parse process alive in this process, across parsers. If the host process exits
 * — normally, or through an uncaught exception — they are killed with it. A host that dies
 * without running `exit` handlers (SIGKILL, a V8 abort) closes their IPC channel instead,
 * and `parse-child.ts` exits on that.
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;
function trackChild(child: ChildProcess) {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const alive of liveChildren) alive.kill('SIGKILL');
    });
  }
  liveChildren.add(child);
}

/**
 * Only an error *code* crosses the boundary — never a message, a stack, a file name or any
 * file content. An unrecognized shape is reported as an invalid reply rather than being
 * forwarded, so a misbehaving child cannot inject text into an API response or a log.
 */
function replyCode(value: unknown): TrackParseFailureCode {
  return typeof value === 'string' && CODE_PATTERN.test(value)
    ? value
    : 'TRACK_PARSE_REPLY_INVALID';
}

/**
 * Watches a child's stderr for V8's out-of-memory report without keeping the stream: only a
 * short tail is carried between chunks so the marker is found across a chunk boundary.
 * Nothing read here is logged or returned.
 */
function watchForOutOfMemory(child: ChildProcess): () => boolean {
  let seen = false;
  let tail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (seen) return;
    const window = tail + chunk;
    if (window.includes(V8_OUT_OF_MEMORY)) seen = true;
    tail = window.slice(-V8_OUT_OF_MEMORY.length);
  });
  return () => seen;
}

type RunOutcome<T> = { ok: true; value: T } | { ok: false; code: TrackParseFailureCode };

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
  // The child entry is TypeScript, as every server entry point in this repository is, so
  // it needs the same loader the parent was started with. `process.execArgv` carries it
  // when the parent itself runs under `tsx`; a test host passes the option explicitly.
  //
  // The host's own heap options are the host's business: an API started with
  // `--max-old-space-size=2048` is sized for itself, not for a parse. They are left out of
  // what the child inherits (review NB-2; they used to make construction throw, so such a
  // host could not boot). A heap option the caller *explicitly* hands the child would fight
  // the ceiling, and that is refused with a name of its own. The ceiling is also appended
  // last, so it wins over anything that slipped past this scan, and the measured check below
  // is what actually decides.
  if (options.execArgv?.some((argument) => HEAP_OPTION_PATTERN.test(argument)))
    throw new TrackParseRuntimeConflictError();
  const execArgv = (options.execArgv ?? process.execArgv).filter(
    (argument) => !HEAP_OPTION_PATTERN.test(argument),
  );
  const childExecArgv = [...execArgv, `--max-old-space-size=${heapMegabytes}`];
  const temporaryDirectory = process.env['TMPDIR'];
  const childEnvironment: NodeJS.ProcessEnv =
    temporaryDirectory === undefined || temporaryDirectory === ''
      ? {}
      : { TMPDIR: temporaryDirectory };
  let active = 0;
  let closed = false;
  /** Running parses: how to end each one, and when its process is gone. */
  const running = new Map<ChildProcess, { cancel: () => void; exited: Promise<void> }>();

  /**
   * One bounded parse in one child process.
   *
   * `request` is what the child is handed once its heap ceiling has been verified, and
   * `accept` turns a successful reply into the caller's outcome — or refuses it, because a
   * child's reply is untrusted like any other boundary. Both callers below share every
   * bound: concurrency, file size, cancellation, the deadline, shutdown, and the kill in
   * `finally` that ends the child on every path and is awaited before the slot frees.
   */
  async function run<T>(
    bytes: Uint8Array,
    parseOptions: { readonly filename?: string | null; readonly signal?: AbortSignal },
    request: (bytes: Uint8Array, filename: string | null) => Record<string, unknown>,
    accept: (reply: unknown) => T | null,
  ): Promise<RunOutcome<T>> {
    if (closed) return { ok: false, code: 'TRACK_PARSE_CANCELLED' };
    if (active >= concurrency) return { ok: false, code: 'TRACK_PARSER_BUSY' };
    if (bytes.byteLength > trackLimits.fileBytes)
      return { ok: false, code: 'TRACK_FILE_TOO_LARGE' };
    if (parseOptions.signal?.aborted) return { ok: false, code: 'TRACK_PARSE_CANCELLED' };
    active += 1;
    const child = fork(childEntry, [], {
      execArgv: childExecArgv,
      // A parse process needs no stdin/stdout, no inherited handles and almost no
      // environment: no `NODE_OPTIONS`, no credentials. The one allow-listed variable is
      // `TMPDIR` (review NB-7), passed only when the host has it, so the loader's cache and
      // anything else that asks `os.tmpdir()` use the host's temporary directory rather than
      // falling back to /tmp. stderr is read only for V8's out-of-memory report and never
      // forwarded.
      env: childEnvironment,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      // V8 serialization: the bytes cross as one binary copy of the exact range (no
      // base64, no JSON), and the reply is the same structured clone a worker received.
      serialization: 'advanced',
    });
    trackChild(child);
    const outOfMemory = watchForOutOfMemory(child);
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      // A fork that never started has no process to exit.
      child.once('error', () => {
        if (child.pid === undefined) resolve();
      });
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<RunOutcome<T>>((resolve) => {
        const finish = (outcome: RunOutcome<T>) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        running.set(child, {
          cancel: () => finish({ ok: false, code: 'TRACK_PARSE_CANCELLED' }),
          exited,
        });
        timer = setTimeout(() => finish({ ok: false, code: 'TRACK_PARSE_TIMEOUT' }), timeoutMs);
        if (parseOptions.signal) {
          onAbort = () => finish({ ok: false, code: 'TRACK_PARSE_CANCELLED' });
          parseOptions.signal.addEventListener('abort', onAbort, { once: true });
        }
        child.on('message', (message: unknown) => {
          const reply = message as {
            ready?: unknown;
            appliedHeapLimitMb?: unknown;
            ok?: unknown;
            code?: unknown;
          } | null;
          if (reply?.ready === true) {
            // The ceiling is checked before the child is handed any bytes, so a runtime
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
            child.send(request(bytes, parseOptions.filename ?? null), (error) => {
              if (error) finish({ ok: false, code: 'TRACK_PARSE_WORKER_FAILED' });
            });
            return;
          }
          if (reply && reply.ok === true) {
            // The child is not trusted either: its reply must satisfy the contract.
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
        child.on('error', () => finish({ ok: false, code: 'TRACK_PARSE_WORKER_FAILED' }));
        // `close` comes after the child's stderr has ended, so V8's out-of-memory report —
        // written just before it aborts — has been read by then. A child that ends without
        // a reply and without that report failed for some other reason.
        child.once('close', () =>
          finish({
            ok: false,
            code: outOfMemory() ? 'TRACK_PARSE_MEMORY_EXCEEDED' : 'TRACK_PARSE_WORKER_FAILED',
          }),
        );
        // Nothing is sent yet: the child speaks first, with the heap limit it was actually
        // given.
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) parseOptions.signal?.removeEventListener('abort', onAbort);
      // Every path kills the child: success, parser failure, memory ceiling, deadline,
      // caller cancellation and shutdown. The slot is freed only once the process is gone,
      // so `active()` never undercounts live parse processes.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      liveChildren.delete(child);
      running.delete(child);
      active -= 1;
    }
  }

  return {
    active: () => active,
    processIds: () =>
      [...running.keys()].flatMap((child) =>
        child.pid !== undefined && child.exitCode === null && child.signalCode === null
          ? [child.pid]
          : [],
      ),
    async close() {
      closed = true;
      const ending = [...running.values()];
      for (const parse of ending) parse.cancel();
      await Promise.all(ending.map((parse) => parse.exited));
    },
    async parse(bytes, rawSelection, parseOptions = {}) {
      const selection = storedTrackSelectionSchema.parse(rawSelection);
      const outcome = await run(
        bytes,
        parseOptions,
        (input, filename) => ({ bytes: input, filename, selection }),
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
        (input, filename) => ({ bytes: input, filename, purpose: 'whole-file' }),
        (reply) => {
          const parsed = parsedTrackFileSchema.safeParse((reply as { file?: unknown }).file);
          return parsed.success ? parsed.data : null;
        },
      );
      return outcome.ok ? { ok: true, file: outcome.value } : outcome;
    },
  };
}
