import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { importActivitySchema } from '@workout/contracts/activity';
import type {
  GarminActivityCollector,
  GarminCollectionFailure,
  GarminCollectionRequest,
  GarminCollectionResult,
} from './collection.js';

/**
 * The TypeScript <-> Python bridge of the temporary unofficial collector (M1-06b-tmp).
 *
 * Choice: one short-lived child process per operation (a login with its MFA step, or one
 * collection run), speaking newline-delimited JSON over stdin/stdout. Not a long-running
 * Python service: nothing listens on a port, a crashed or hung worker is killed with its
 * whole state, and the pending MFA state lives exactly as long as that one process.
 *
 * What never crosses into the process except over stdin: the password, the MFA code and
 * the stored session. argv is fixed (`-I -m workout_manager.garmin_worker`, plus the
 * fixture path in tests) and the environment is an allowlist that sets HOME and TMPDIR to a
 * fresh private directory. `-I` makes Python ignore every PYTHON* variable and the user
 * site. stderr, where the library's own (scrubbed, best effort) log records go, is
 * discarded: no provider text reaches the app's logs. After the process exits the private
 * sandbox (HOME, TMPDIR and the working directory) must hold no file; a file there may be a
 * token file, and the operation fails closed.
 */
export interface GarminWorkerOptions {
  /** Absolute path of the Python interpreter of an environment with the `garmin` extra. */
  readonly python: string;
  /** Synthetic provider scenario (tests and local E2E only; never from deployment config). */
  readonly fixture?: string;
  /** Minimum seconds between provider requests; the fetch default (2) when unset. */
  readonly minIntervalSeconds?: number;
  readonly loginTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  readonly spawnProcess?: typeof spawn;
  /** Bound on one stdout line and on buffered stdout; 48 MiB when unset (tests lower it). */
  readonly outputLimitBytes?: number;
  /** Receives fixed event names only. */
  readonly onEvent?: (event: { event: string; code?: string }) => void;
}

/** Bound on one stdout line and on everything buffered from stdout at once. */
const MAX_OUTPUT_BYTES = 48 * 1024 * 1024;
const failureKinds = z.enum(['auth', 'mfa_invalid', 'rate_limited', 'transient', 'permanent']);
const failedSchema = z.object({
  type: z.literal('failed'),
  kind: failureKinds,
  code: z.string().regex(/^[A-Z_]{1,64}$/),
  retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
  session: z.string().min(1).max(16_384).optional(),
});
const loginReplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mfa_required') }),
  z.object({
    type: z.literal('connected'),
    profileId: z.string().regex(/^[1-9]\d{0,24}$/),
    session: z.string().min(1).max(16_384),
  }),
  failedSchema,
]);
const garminId = z.string().regex(/^[1-9]\d{0,23}$/);
const collectReplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('opened'), profileId: z.string().regex(/^\d{1,25}$/) }),
  z.object({
    type: z.literal('listed'),
    activities: z.array(z.object({ id: garminId, startedAtLocal: z.string().max(40) })).max(200),
    complete: z.boolean(),
    notes: z.array(z.string().max(500)).max(10),
  }),
  z.object({
    type: z.literal('activity'),
    id: garminId,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    imports: z.array(importActivitySchema).min(1).max(100),
  }),
  z.object({
    type: z.literal('activity_failed'),
    id: garminId,
    code: z.string().regex(/^[A-Za-z_]{1,64}$/),
  }),
  z.object({
    type: z.literal('finished'),
    session: z.string().min(1).max(16_384),
    complete: z.boolean(),
  }),
  failedSchema,
]);

export class GarminWorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Newline-delimited stdout, bounded and linear. Bytes are counted as they arrive (a partial
 * line is kept as chunks and joined once), a line longer than `limit` overflows, and so does
 * everything buffered at once (partial line plus lines not yet received). While a complete
 * line waits to be received the producer is paused, so a worker that writes faster than the
 * server reads is held back rather than buffered.
 */
export class LineQueue {
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private readonly lines: { text: string; bytes: number }[] = [];
  private queuedBytes = 0;
  private waiter: ((line: string | null) => void) | null = null;
  overflowed = false;
  /** Set when the reader is torn down: nothing is queued or paused after this. */
  private closed = false;

  constructor(
    private readonly limit: number,
    private readonly flow: { pause(): void; resume(): void; overflow(): void },
  ) {}

  /** Bytes held right now: the partial line and the lines not yet received. */
  get bufferedBytes(): number {
    return this.partialBytes + this.queuedBytes;
  }

  push(chunk: Buffer): void {
    if (this.overflowed || this.closed) return;
    let start = 0;
    for (;;) {
      const index = chunk.indexOf(0x0a, start);
      if (index < 0) {
        const rest = chunk.subarray(start);
        if (rest.length > 0) {
          this.partial.push(rest);
          this.partialBytes += rest.length;
        }
        if (this.partialBytes > this.limit || this.bufferedBytes > this.limit) this.overflow();
        return;
      }
      const piece = chunk.subarray(start, index);
      const bytes = this.partialBytes + piece.length;
      if (bytes > this.limit) {
        this.overflow();
        return;
      }
      const text = Buffer.concat([...this.partial, piece], bytes).toString('utf8');
      this.partial = [];
      this.partialBytes = 0;
      this.deliver(text, bytes);
      if (this.overflowed) return;
      start = index + 1;
    }
  }

  private overflow() {
    this.overflowed = true;
    this.partial = [];
    this.partialBytes = 0;
    this.lines.length = 0;
    this.queuedBytes = 0;
    this.flow.overflow();
    this.end();
  }

  private deliver(text: string, bytes: number) {
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(text);
      return;
    }
    this.lines.push({ text, bytes });
    this.queuedBytes += bytes;
    if (this.bufferedBytes > this.limit) {
      this.overflow();
      return;
    }
    this.flow.pause();
  }

  /** A queued line, or undefined. Resumes the producer once the queue is empty. */
  shift(): string | undefined {
    const next = this.lines.shift();
    if (next === undefined) return undefined;
    this.queuedBytes -= next.bytes;
    if (this.lines.length === 0) this.flow.resume();
    return next.text;
  }

  wait(waiter: ((line: string | null) => void) | null): void {
    this.waiter = waiter;
  }

  /**
   * Stop reading for good: drop what is queued and never pause the producer again. A paused
   * stream with unread data never emits 'close', so a teardown that waits for the process to
   * close must call this (and destroy the stream) first.
   */
  close(): void {
    this.closed = true;
    this.partial = [];
    this.partialBytes = 0;
    this.lines.length = 0;
    this.queuedBytes = 0;
    this.end();
  }

  /** The producer ended (or overflowed): a waiting receiver gets null. */
  end(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(null);
  }
}

/** One worker process: bounded line reader, deadline, kill and sandbox cleanup. */
class WorkerProcess {
  private readonly queue: LineQueue;
  private exited = false;
  /** The signal that ended the process (SIGKILL from a timeout, abort or overflow), or null. */
  private exitSignal: NodeJS.Signals | null = null;
  private readonly exit: Promise<void>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly sandbox: string,
    limit: number,
  ) {
    this.queue = new LineQueue(limit, {
      pause: () => child.stdout?.pause(),
      resume: () => child.stdout?.resume(),
      overflow: () => {
        child.kill('SIGKILL');
      },
    });
    child.once('exit', (_code, signal) => {
      this.exitSignal = signal;
    });
    this.exit = new Promise((resolve) => {
      child.once('close', () => {
        this.exited = true;
        this.queue.end();
        resolve();
      });
      child.once('error', () => {
        this.exited = true;
        this.queue.end();
        resolve();
      });
    });
    child.stdout?.on('data', (chunk: Buffer) => this.queue.push(chunk));
    // A write to a worker that has already exited must not become an unhandled error.
    child.stdin?.on('error', () => undefined);
  }

  static async start(options: GarminWorkerOptions): Promise<WorkerProcess> {
    const sandbox = await mkdtemp(join(tmpdir(), 'garmin-unofficial-'));
    const home = join(sandbox, 'home');
    const temporary = join(sandbox, 'tmp');
    await mkdir(home, { mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    const args = ['-I', '-m', 'workout_manager.garmin_worker'];
    if (options.fixture !== undefined) args.push('--fixture', options.fixture);
    if (options.minIntervalSeconds !== undefined)
      args.push('--min-interval', String(options.minIntervalSeconds));
    const child = (options.spawnProcess ?? spawn)(options.python, args, {
      cwd: sandbox,
      stdio: ['pipe', 'pipe', 'ignore'],
      // An allowlist, not the server's environment: no database URL, no key material, no
      // GARMINTOKENS, and no credential of any kind ever travels this way.
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        TMPDIR: temporary,
        LANG: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      windowsHide: true,
    });
    return new WorkerProcess(child, sandbox, options.outputLimitBytes ?? MAX_OUTPUT_BYTES);
  }

  send(message: object): void {
    if (this.exited) throw new GarminWorkerError('WORKER_EXITED');
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  /** The next message, or a fixed error on exit, oversize, malformed JSON or deadline. */
  async receive(deadline: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new GarminWorkerError('WORKER_ABORTED');
    const queued = this.queue.shift();
    const line =
      queued ??
      (this.exited || this.queue.overflowed
        ? null
        : await new Promise<string | null>((resolve, reject) => {
            const remaining = deadline - Date.now();
            const timer = setTimeout(
              () => {
                this.queue.wait(null);
                reject(new GarminWorkerError('WORKER_TIMEOUT'));
              },
              Math.max(0, remaining),
            );
            const abort = () => {
              clearTimeout(timer);
              this.queue.wait(null);
              reject(new GarminWorkerError('WORKER_ABORTED'));
            };
            signal?.addEventListener('abort', abort, { once: true });
            this.queue.wait((value) => {
              clearTimeout(timer);
              signal?.removeEventListener('abort', abort);
              resolve(value);
            });
          }));
    if (line === null)
      throw new GarminWorkerError(
        this.queue.overflowed ? 'WORKER_OUTPUT_TOO_LARGE' : 'WORKER_EXITED',
      );
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new GarminWorkerError('WORKER_PROTOCOL');
    }
  }

  /**
   * Kill (if still running), wait, then check the WHOLE sandbox -- the private HOME, TMPDIR
   * and the working directory -- holds no file before removing it. A leftover file may be a
   * token file, a cache or a download written outside the worker's own cleanup: the
   * operation fails closed either way.
   */
  async close(): Promise<{ leftoverFiles: boolean }> {
    if (!this.exited) {
      this.child.stdin?.end();
      this.child.kill('SIGKILL');
    }
    // A paused stdout with unread lines never lets 'close' fire: stop reading and destroy it
    // before waiting, or a run ended with lines still queued would wait forever.
    this.queue.close();
    this.child.stdout?.destroy();
    await this.exit;
    // A worker killed by a signal mid-download may leave its own download directory behind
    // (it removes it itself whenever it gets to finish). Only that file is exempt, and only
    // after a signal kill: after any exit the worker made itself -- clean (0) or not (e.g. a
    // protocol exit, 2) -- a leftover file still fails closed.
    const killed = this.exitSignal !== null;
    const ownDownload = join(this.sandbox, 'tmp');
    let leftoverFiles = false;
    try {
      const entries = await readdir(this.sandbox, { recursive: true, withFileTypes: true });
      leftoverFiles = entries.some((entry) => {
        if (entry.isDirectory()) return false;
        const parent = entry.parentPath;
        const exempt =
          killed &&
          dirname(parent) === ownDownload &&
          basename(parent).startsWith('garmin-collect-') &&
          entry.name === 'original.fit';
        return !exempt;
      });
    } catch {
      leftoverFiles = true;
    }
    await rm(this.sandbox, { recursive: true, force: true });
    return { leftoverFiles };
  }
}

export type GarminLoginFailure =
  | { kind: 'auth' | 'mfa_invalid' | 'transient' | 'permanent'; code: string }
  | { kind: 'rate_limited'; code: string; retryAfterSeconds: number | null };
export type GarminLoginStep =
  | { kind: 'connected'; profileId: string; session: string }
  | { kind: 'failed'; failure: GarminLoginFailure }
  | {
      kind: 'mfa_required';
      /** Submit a code to the SAME process; a wrong code keeps the step open. */
      submit(code: string): Promise<GarminLoginStep>;
      cancel(): Promise<void>;
    };

function loginFailure(reply: z.infer<typeof failedSchema>): GarminLoginFailure {
  return reply.kind === 'rate_limited'
    ? { kind: 'rate_limited', code: reply.code, retryAfterSeconds: reply.retryAfterSeconds ?? null }
    : { kind: reply.kind, code: reply.code };
}
function collectionFailure(reply: z.infer<typeof failedSchema>): GarminCollectionFailure {
  switch (reply.kind) {
    case 'auth':
    case 'mfa_invalid':
      return { kind: 'auth' };
    case 'rate_limited':
      return { kind: 'rate_limited', retryAfterSeconds: reply.retryAfterSeconds ?? null };
    case 'transient':
      return { kind: 'transient', code: reply.code };
    case 'permanent':
      return { kind: 'permanent', code: reply.code };
  }
}

export interface GarminUnofficialWorker {
  /** An abort (server shutdown) kills the login's process and answers WORKER_ABORTED. */
  login(
    credentials: { email: string; password: string },
    signal?: AbortSignal,
  ): Promise<GarminLoginStep>;
  readonly collector: GarminActivityCollector;
}

export function createGarminUnofficialWorker(options: GarminWorkerOptions): GarminUnofficialWorker {
  const loginTimeout = options.loginTimeoutMs ?? 120_000;
  const runTimeout = options.runTimeoutMs ?? 15 * 60_000;

  async function finish(worker: WorkerProcess) {
    const { leftoverFiles } = await worker.close();
    if (leftoverFiles) options.onEvent?.({ event: 'garmin_unofficial_sandbox_file_refused' });
    return leftoverFiles;
  }

  async function loginStep(
    worker: WorkerProcess,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<GarminLoginStep> {
    let reply: z.infer<typeof loginReplySchema>;
    try {
      reply = loginReplySchema.parse(await worker.receive(deadline, signal));
    } catch (error) {
      await finish(worker);
      return {
        kind: 'failed',
        failure: {
          kind: 'transient',
          code: error instanceof GarminWorkerError ? error.code : 'WORKER_PROTOCOL',
        },
      };
    }
    if (reply.type === 'mfa_required') {
      let closed = false;
      const step: GarminLoginStep = {
        kind: 'mfa_required',
        submit: async (code) => {
          if (closed) return { kind: 'failed', failure: { kind: 'auth', code: 'MFA_EXPIRED' } };
          try {
            worker.send({ op: 'mfa', code });
          } catch {
            closed = true;
            await finish(worker);
            return { kind: 'failed', failure: { kind: 'transient', code: 'WORKER_EXITED' } };
          }
          const next = await loginStep(worker, Date.now() + loginTimeout);
          // A wrong code keeps this same step (and process) usable; anything else ends it.
          if (next.kind === 'failed' && next.failure.kind === 'mfa_invalid') return next;
          closed = true;
          return next;
        },
        cancel: async () => {
          if (closed) return;
          closed = true;
          try {
            worker.send({ op: 'cancel' });
          } catch {
            /* already gone */
          }
          await finish(worker);
        },
      };
      return step;
    }
    if (reply.type === 'failed') {
      if (reply.kind === 'mfa_invalid') return { kind: 'failed', failure: loginFailure(reply) };
      await finish(worker);
      return { kind: 'failed', failure: loginFailure(reply) };
    }
    // Wait for the process to end before trusting the result: a token file in the private
    // HOME fails the login closed, and the session is never stored.
    if (await finish(worker))
      return { kind: 'failed', failure: { kind: 'permanent', code: 'SANDBOX_FILE_LEFT' } };
    return { kind: 'connected', profileId: reply.profileId, session: reply.session };
  }

  async function login(credentials: { email: string; password: string }, signal?: AbortSignal) {
    const worker = await WorkerProcess.start(options);
    try {
      // stdin only. The object is built here and handed straight to the pipe.
      worker.send({ op: 'login', email: credentials.email, password: credentials.password });
    } catch {
      await finish(worker);
      return {
        kind: 'failed',
        failure: { kind: 'transient', code: 'WORKER_EXITED' },
      } satisfies GarminLoginStep;
    }
    return loginStep(worker, Date.now() + loginTimeout, signal);
  }

  const collector: GarminActivityCollector = {
    provider: 'garmin-connect-unofficial',
    official: false,
    async collect(request: GarminCollectionRequest): Promise<GarminCollectionResult> {
      const worker = await WorkerProcess.start(options);
      const deadline = Date.now() + runTimeout;
      const next = async () =>
        collectReplySchema.parse(await worker.receive(deadline, request.signal));
      let result: GarminCollectionResult;
      try {
        worker.send({
          op: 'collect',
          session: request.credential,
          start: request.window.start,
          end: request.window.end,
          limit: request.window.limit,
        });
        result = await (async (): Promise<GarminCollectionResult> => {
          const opened = await next();
          if (opened.type === 'failed')
            return { kind: 'failed', failure: collectionFailure(opened), credential: null };
          if (opened.type !== 'opened') throw new GarminWorkerError('WORKER_PROTOCOL');
          if (!request.verifyAccount(opened.profileId)) {
            worker.send({ op: 'abort' });
            return { kind: 'account_mismatch' };
          }
          worker.send({ op: 'continue' });
          const listed = await next();
          if (listed.type === 'failed')
            return {
              kind: 'failed',
              failure: collectionFailure(listed),
              credential: listed.session ?? null,
            };
          if (listed.type !== 'listed') throw new GarminWorkerError('WORKER_PROTOCOL');
          const wanted = await request.select(listed.activities);
          if (request.signal.aborted) return { kind: 'aborted' };
          const allowed = new Set(listed.activities.map((item) => item.id));
          const ids = wanted.filter((id) => allowed.has(id));
          worker.send({ op: 'download', ids });
          for (;;) {
            const message = await next();
            if (request.signal.aborted) return { kind: 'aborted' };
            if (message.type === 'activity') {
              if (!allowed.has(message.id)) throw new GarminWorkerError('WORKER_PROTOCOL');
              await request.accept({ id: message.id, imports: message.imports });
            } else if (message.type === 'activity_failed') {
              await request.acceptFailure(message.id, message.code);
            } else if (message.type === 'finished') {
              return {
                kind: 'finished',
                complete: message.complete && listed.complete,
                credential: message.session,
              };
            } else if (message.type === 'failed') {
              return {
                kind: 'failed',
                failure: collectionFailure(message),
                credential: message.session ?? null,
              };
            } else throw new GarminWorkerError('WORKER_PROTOCOL');
          }
        })();
      } catch (error) {
        const code = error instanceof GarminWorkerError ? error.code : 'WORKER_PROTOCOL';
        result =
          code === 'WORKER_ABORTED'
            ? { kind: 'aborted' }
            : { kind: 'failed', failure: { kind: 'transient', code }, credential: null };
      }
      if (await finish(worker))
        return {
          kind: 'failed',
          failure: { kind: 'permanent', code: 'SANDBOX_FILE_LEFT' },
          credential: null,
        };
      return result;
    },
  };
  return { login, collector };
}
