import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GarminCollectionRequest } from '../src/garmin/collection.js';
import {
  createGarminUnofficialWorker,
  LineQueue,
  type GarminLoginStep,
  type GarminWorkerOptions,
} from '../src/garmin/unofficial-worker.js';

/**
 * The real bridge against the real Python worker (M1-06b-tmp), with the worker's synthetic
 * provider (`--fixture`): no live Garmin, no network. The interpreter is the repository's
 * `uv sync` environment (default install, without the `garmin` extra) or WORKOUT_PYTHON.
 */
// Real Python processes under a shared, loaded machine: allow for slow starts rather than
// failing on the default 5 s (the review saw one such failure at load 59).
vi.setConfig({ testTimeout: 60_000 });

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const python = process.env['WORKOUT_PYTHON'] ?? join(root, '.venv/bin/python');
const PASSWORD = 'synthetic-pass-1';
const EMAIL = 'owner@example.test';
let directory: string;
let scenarioPath: string;
async function scenario(overrides: Record<string, unknown> = {}) {
  await writeFile(
    scenarioPath,
    JSON.stringify({
      accounts: [
        { email: EMAIL, password: PASSWORD, profileId: 1001 },
        {
          email: 'mfa@example.test',
          password: 'synthetic-pass-2',
          profileId: 1001,
          mfaCode: '123456',
        },
      ],
      activities: {
        '1001': [
          {
            id: 9001,
            startedAt: '2026-09-20T06:00:00+00:00',
            sport: 'running',
            seconds: 1800,
            meters: 5000,
          },
          {
            id: 9002,
            startedAt: '2026-09-21T06:00:00+00:00',
            sport: 'cycling',
            seconds: 3600,
            meters: 20000,
          },
        ],
      },
      ...overrides,
    }),
  );
}
beforeAll(async () => {
  if (!existsSync(python))
    throw new Error(`Python bridge tests need ${python}: run \`uv sync\` (or set WORKOUT_PYTHON).`);
  directory = await mkdtemp(join(tmpdir(), 'garmin-worker-test-'));
  scenarioPath = join(directory, 'scenario.json');
  await scenario();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface Spawned {
  args: readonly string[];
  env: Record<string, string | undefined>;
}
function recordingOptions(extra: Partial<GarminWorkerOptions> = {}) {
  const spawned: Spawned[] = [];
  const options: GarminWorkerOptions = {
    python,
    fixture: scenarioPath,
    minIntervalSeconds: 1,
    ...extra,
    spawnProcess: ((
      command: string,
      args: readonly string[],
      spawnOptions: Parameters<typeof spawn>[2],
    ) => {
      spawned.push({ args, env: { ...(spawnOptions?.env ?? {}) } });
      return (extra.spawnProcess ?? spawn)(command, args, spawnOptions);
    }) as typeof spawn,
  };
  return { options, spawned };
}

describe('login through the real worker process', () => {
  it('connects, and the password travels over stdin only', async () => {
    const { options, spawned } = recordingOptions();
    const step = await createGarminUnofficialWorker(options).login({
      email: EMAIL,
      password: PASSWORD,
    });
    // What the process was started with (argv and environment) never carries a credential.
    expect(spawned).toHaveLength(1);
    const visible = JSON.stringify(spawned);
    expect(visible).not.toContain(PASSWORD);
    expect(visible).not.toContain(EMAIL);
    expect(step).toMatchObject({ kind: 'connected', profileId: '1001' });
    expect(spawned[0]?.args).toEqual([
      '-I',
      '-m',
      'workout_manager.garmin_worker',
      '--fixture',
      scenarioPath,
      '--min-interval',
      '1',
    ]);
    // An allowlisted environment: no inherited variable, and never a token store.
    expect(Object.keys(spawned[0]?.env ?? {}).sort()).toEqual(
      ['HOME', 'LANG', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'TMPDIR'].sort(),
    );
  });

  it('keeps the MFA step in the same process and accepts a retry', async () => {
    const worker = createGarminUnofficialWorker(recordingOptions().options);
    const step = await worker.login({ email: 'mfa@example.test', password: 'synthetic-pass-2' });
    expect(step.kind).toBe('mfa_required');
    const pending = step as Extract<GarminLoginStep, { kind: 'mfa_required' }>;
    expect(await pending.submit('000000')).toMatchObject({
      kind: 'failed',
      failure: { kind: 'mfa_invalid' },
    });
    expect(await pending.submit('123456')).toMatchObject({ kind: 'connected', profileId: '1001' });
  });

  it('classifies a wrong password without echoing anything', async () => {
    const worker = createGarminUnofficialWorker(recordingOptions().options);
    const step = await worker.login({ email: EMAIL, password: 'wrong-password-9' });
    expect(step).toEqual({
      kind: 'failed',
      failure: { kind: 'auth', code: 'AUTHENTICATION_REJECTED' },
    });
  });

  it('fails closed when anything writes a file into the private HOME', async () => {
    const { options } = recordingOptions({
      spawnProcess: ((
        command: string,
        args: readonly string[],
        spawnOptions: Parameters<typeof spawn>[2],
      ) => {
        const home = String(spawnOptions?.env?.['HOME']);
        // Stands in for a library writing its token file during the login.
        writeFileSync(join(home, 'garmin_tokens.json'), '{}');
        return spawn(command, args, spawnOptions);
      }) as typeof spawn,
    });
    const step = await createGarminUnofficialWorker(options).login({
      email: EMAIL,
      password: PASSWORD,
    });
    expect(step).toEqual({
      kind: 'failed',
      failure: { kind: 'permanent', code: 'SANDBOX_FILE_LEFT' },
    });
  });

  for (const [where, place] of [
    ['TMPDIR', (env: NodeJS.ProcessEnv | undefined, _cwd: string) => String(env?.['TMPDIR'])],
    ['the working directory', (_env: NodeJS.ProcessEnv | undefined, cwd: string) => cwd],
  ] as const) {
    it(`fails closed when a file is left in ${where}, not only in HOME`, async () => {
      const { options } = recordingOptions({
        spawnProcess: ((
          command: string,
          args: readonly string[],
          spawnOptions: Parameters<typeof spawn>[2],
        ) => {
          writeFileSync(
            join(place(spawnOptions?.env, String(spawnOptions?.cwd)), 'left.json'),
            '{}',
          );
          return spawn(command, args, spawnOptions);
        }) as typeof spawn,
      });
      const step = await createGarminUnofficialWorker(options).login({
        email: EMAIL,
        password: PASSWORD,
      });
      expect(step).toEqual({
        kind: 'failed',
        failure: { kind: 'permanent', code: 'SANDBOX_FILE_LEFT' },
      });
    });
  }

  it('kills the login process when the server aborts (shutdown)', async () => {
    await scenario({ loginDelaySeconds: 30 });
    try {
      const controller = new AbortController();
      const started = Date.now();
      const pending = createGarminUnofficialWorker(recordingOptions().options).login(
        { email: EMAIL, password: PASSWORD },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 500);
      expect(await pending).toEqual({
        kind: 'failed',
        failure: { kind: 'transient', code: 'WORKER_ABORTED' },
      });
      expect(Date.now() - started).toBeLessThan(25_000);
    } finally {
      await scenario();
    }
  });

  it('refuses stdout past the output bound and kills the process', async () => {
    // A stand-in worker that answers with one line longer than the bound.
    const { options } = recordingOptions({
      outputLimitBytes: 4096,
      spawnProcess: ((
        _c: string,
        _a: readonly string[],
        spawnOptions: Parameters<typeof spawn>[2],
      ) =>
        spawn(
          process.execPath,
          [
            '-e',
            'process.stdout.write(\'{"type":"mfa_required","pad":"\' + \'x\'.repeat(100000) + \'"}\\n\')',
          ],
          spawnOptions,
        )) as typeof spawn,
    });
    const step = await createGarminUnofficialWorker(options).login({
      email: EMAIL,
      password: PASSWORD,
    });
    expect(step).toEqual({
      kind: 'failed',
      failure: { kind: 'transient', code: 'WORKER_OUTPUT_TOO_LARGE' },
    });
  });
});

describe('stdout line queue', () => {
  function queue(limit: number) {
    const flow = { paused: 0, resumed: 0, overflowed: 0 };
    const lines = new LineQueue(limit, {
      pause: () => (flow.paused += 1),
      resume: () => (flow.resumed += 1),
      overflow: () => (flow.overflowed += 1),
    });
    return { lines, flow };
  }

  it('joins a line split over chunks and pauses the producer while lines wait', () => {
    const { lines, flow } = queue(1024);
    lines.push(Buffer.from('{"a":'));
    lines.push(Buffer.from('1}\n{"b":2}\n{"c"'));
    expect(flow.paused).toBeGreaterThan(0);
    expect(lines.bufferedBytes).toBe(Buffer.byteLength('{"a":1}{"b":2}{"c"'));
    expect(lines.shift()).toBe('{"a":1}');
    expect(flow.resumed).toBe(0);
    expect(lines.shift()).toBe('{"b":2}');
    expect(flow.resumed).toBe(1);
    lines.push(Buffer.from(':3}\n'));
    expect(lines.shift()).toBe('{"c":3}');
  });

  it('counts multi-byte text in bytes, not characters', () => {
    const { lines, flow } = queue(10);
    lines.push(Buffer.from('가나다라'));
    expect(flow.overflowed).toBe(1);
    expect(lines.overflowed).toBe(true);
  });

  it('bounds the whole buffer, not only one line', () => {
    const { lines, flow } = queue(64);
    for (let index = 0; index < 5; index++) lines.push(Buffer.from(`${'x'.repeat(20)}\n`));
    expect(flow.overflowed).toBe(1);
    expect(lines.bufferedBytes).toBeLessThanOrEqual(64);
  });

  it('stays linear on a long line delivered in small chunks', () => {
    const { lines, flow } = queue(64 * 1024 * 1024);
    const chunk = Buffer.alloc(1024, 0x61);
    const started = performance.now();
    for (let index = 0; index < 32 * 1024; index++) lines.push(chunk);
    lines.push(Buffer.from('\n'));
    // 32 MiB in 1 KiB chunks: re-measuring the whole buffer per chunk (the old reader) is
    // quadratic and takes minutes; counting incrementally takes well under a second. The
    // bound is generous so a loaded machine does not fail it.
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(flow.overflowed).toBe(0);
    expect(lines.shift()?.length).toBe(32 * 1024 * 1024);
  });
});

function request(
  credential: string,
  overrides: Partial<GarminCollectionRequest> = {},
): GarminCollectionRequest & { accepted: string[]; failures: string[]; listed: string[] } {
  const accepted: string[] = [],
    failures: string[] = [],
    listed: string[] = [];
  return {
    credential,
    window: { start: '2026-09-01', end: '2026-09-30', limit: 10 },
    verifyAccount: (id) => id === '1001',
    select: async (items) => {
      listed.push(...items.map((item) => item.id));
      return items.map((item) => item.id).filter((id) => id !== '9002');
    },
    accept: async (activity) => {
      accepted.push(activity.id);
      expect(activity.imports[0]?.source.kind).toBe('fit');
    },
    acceptFailure: async (id) => {
      failures.push(id);
    },
    signal: new AbortController().signal,
    ...overrides,
    accepted,
    failures,
    listed,
  };
}

describe('collection through the real worker process', () => {
  async function session() {
    await scenario();
    const step = await createGarminUnofficialWorker(recordingOptions().options).login({
      email: EMAIL,
      password: PASSWORD,
    });
    if (step.kind !== 'connected') throw new Error('EXPECTED_CONNECTED');
    return step.session;
  }

  it('lists, downloads only the selected activities and returns the refreshed session', async () => {
    const credential = await session();
    const { options, spawned } = recordingOptions();
    const input = request(credential);
    const result = await createGarminUnofficialWorker(options).collector.collect(input);
    expect(result).toMatchObject({ kind: 'finished', complete: true });
    expect(result.kind === 'finished' && result.credential).not.toBe(credential);
    expect(input.listed).toEqual(['9002', '9001']);
    expect(input.accepted).toEqual(['9001']);
    expect(JSON.stringify(spawned)).not.toContain(credential);
  });

  it('refuses a session that opens a different Garmin profile', async () => {
    const credential = await session();
    const input = request(credential, { verifyAccount: () => false });
    const result = await createGarminUnofficialWorker(recordingOptions().options).collector.collect(
      input,
    );
    expect(result).toEqual({ kind: 'account_mismatch' });
    expect(input.listed).toEqual([]);
  });

  it('reports a 429 with Retry-After and a rejected session as auth', async () => {
    const credential = await session();
    await scenario({ listFailure: 'rate_limited', retryAfter: '600' });
    const limited = await createGarminUnofficialWorker(
      recordingOptions().options,
    ).collector.collect(request(credential));
    expect(limited).toMatchObject({
      kind: 'failed',
      failure: { kind: 'rate_limited', retryAfterSeconds: 600 },
    });
    await scenario({ revokedProfiles: [1001] });
    const rejected = await createGarminUnofficialWorker(
      recordingOptions().options,
    ).collector.collect(request(credential));
    expect(rejected).toMatchObject({ kind: 'failed', failure: { kind: 'auth' } });
    await scenario();
  });
});

/**
 * A stand-in worker (Node, no Python) that speaks the collect protocol up to the download
 * step and then either floods stdout with `activity_failed` lines or leaves a half-written
 * download behind and hangs. It never exits on its own.
 */
const floodingWorker = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[1];
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.op === 'collect') process.stdout.write(JSON.stringify({ type: 'opened', profileId: '1001' }) + '\n');
    if (message.op === 'continue')
      process.stdout.write(JSON.stringify({ type: 'listed', activities: [{ id: '9001', startedAtLocal: '2026-09-20 06:00:00' }], complete: true, notes: [] }) + '\n');
    if (message.op === 'download') {
      if (mode.startsWith('leave-download')) {
        const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'garmin-collect-'));
        fs.writeFileSync(path.join(dir, 'original.fit'), 'partial');
        // 'leave-download' hangs (until killed); '-exit-N' exits by itself with code N.
        const exit = /-exit-(\d+)$/.exec(mode);
        if (exit) process.exit(Number(exit[1]));
        setInterval(() => {}, 1000);
        return;
      }
      const line = JSON.stringify({ type: 'activity_failed', id: '9001', code: 'ValueError' }) + '\n';
      const pump = () => { while (process.stdout.write(line)); process.stdout.once('drain', pump); };
      pump();
    }
  }
});
`;
function fakeWorker(
  mode: 'flood' | 'leave-download' | 'leave-download-exit-0' | 'leave-download-exit-2',
  extra: Partial<GarminWorkerOptions> = {},
) {
  return recordingOptions({
    ...extra,
    spawnProcess: ((_c: string, _a: readonly string[], spawnOptions: Parameters<typeof spawn>[2]) =>
      spawn(process.execPath, ['-e', floodingWorker, mode], spawnOptions)) as typeof spawn,
  }).options;
}
async function settlesWithin<T>(work: Promise<T>, milliseconds: number): Promise<T | 'HUNG'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'HUNG'>((resolve) => {
    timer = setTimeout(() => resolve('HUNG'), milliseconds);
  });
  try {
    return await Promise.race([work, hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe('ending a run while worker lines are still queued (review r2)', () => {
  it('an abort (disconnect) mid-flood settles promptly', async () => {
    const controller = new AbortController();
    let seen = 0;
    const input = request('{"di_token":"t"}', {
      signal: controller.signal,
      acceptFailure: async () => {
        seen += 1;
        if (seen === 3) controller.abort();
        // Slow consumer: lines pile up and stdout is paused.
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    const result = await settlesWithin(
      createGarminUnofficialWorker(fakeWorker('flood')).collector.collect(input),
      15_000,
    );
    expect(result).toEqual({ kind: 'aborted' });
  });

  it('an exception from the consumer mid-flood settles promptly', async () => {
    let seen = 0;
    const input = request('{"di_token":"t"}', {
      acceptFailure: async () => {
        seen += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (seen === 3) throw new Error('consumer failed');
      },
    });
    const result = await settlesWithin(
      createGarminUnofficialWorker(fakeWorker('flood')).collector.collect(input),
      15_000,
    );
    expect(result).toMatchObject({ kind: 'failed', failure: { kind: 'transient' } });
  });

  it('a timeout mid-download stays transient: the worker-owned download left by the kill is not a token file', async () => {
    const result = await createGarminUnofficialWorker(
      fakeWorker('leave-download', { runTimeoutMs: 1500 }),
    ).collector.collect(request('{"di_token":"t"}'));
    expect(result).toEqual({
      kind: 'failed',
      failure: { kind: 'transient', code: 'WORKER_TIMEOUT' },
      credential: null,
    });
  });

  for (const code of [0, 2] as const) {
    it(`the same leftover download after the worker's own exit ${code} still fails closed`, async () => {
      const result = await createGarminUnofficialWorker(
        fakeWorker(`leave-download-exit-${code}`, { runTimeoutMs: 15_000 }),
      ).collector.collect(request('{"di_token":"t"}'));
      expect(result).toEqual({
        kind: 'failed',
        failure: { kind: 'permanent', code: 'SANDBOX_FILE_LEFT' },
        credential: null,
      });
    });
  }
});
