import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('../src/resource-cleanup-worker.js', () => ({ runResourceCleanupWorker: worker }));
vi.mock('../src/config.js', () => ({
  parseResourceCleanupWorkerConfig: vi.fn(() => ({
    connectionString: 'private-connection',
    storageRoot: '/private/objects',
  })),
}));

const entrypoint = fileURLToPath(new URL('../src/resource-cleanup.ts', import.meta.url));
const originalRelease = process.env['WORKOUT_RELEASE'];
const originalExitCode = process.exitCode;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  worker.mockReset();
  if (originalRelease === undefined) delete process.env['WORKOUT_RELEASE'];
  else process.env['WORKOUT_RELEASE'] = originalRelease;
  process.exitCode = originalExitCode;
});

async function runInvalidConfiguration(secret: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    env: {
      PATH: process.env['PATH'],
      RESOURCE_CLEANUP_DATABASE_URL: `postgres://workout_resource_cleanup_worker:${secret}@127.0.0.1/workout`,
      DATABASE_URL: `postgres://workout_api:${secret}@127.0.0.1/workout`,
      RESOURCE_STORAGE_ROOT: '/',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

describe('resource cleanup CLI', () => {
  it('emits only a generic failure without credentials or storage paths', async () => {
    const secret = 'never-print-this-secret';

    const result = await runInvalidConfiguration(secret);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      kind: 'resource_cleanup_failed',
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'unreleased',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it('logs only bounded result fields with a run id and release', async () => {
    process.env['WORKOUT_RELEASE'] = 'release-42';
    const boundedResult = {
      objects: 'empty',
      derived: 'empty',
      tenantPurges: [],
      scopePurges: [],
      trackReconciliation: { inspected: 0, queued: 0, faulted: 0, deferred: 0, wrapped: true },
      thumbnailReconciliation: { inspected: 0, queued: 0, faulted: 0, deferred: 0, wrapped: true },
    };
    worker.mockResolvedValue(boundedResult);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await import('../src/resource-cleanup.js');

    expect(errors).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      kind: 'resource_cleanup_result',
      result: boundedResult,
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'release-42',
    });
  });

  it('redacts a thrown object path and invalid release', async () => {
    process.env['WORKOUT_RELEASE'] = 'private path /objects/secret';
    worker.mockRejectedValue(new Error('credential and /private/objects/key'));
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await import('../src/resource-cleanup.js');

    expect(output).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
      kind: 'resource_cleanup_failed',
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'unreleased',
    });
    expect(String(errors.mock.calls[0]?.[0])).not.toContain('private');
    expect(process.exitCode).toBe(1);
  });
});
