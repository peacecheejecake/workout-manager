import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => vi.fn<() => Promise<'finalized'>>());
vi.mock('../src/url-ingestion-worker.js', () => ({ runUrlIngestionWorker: worker }));

const entrypoint = fileURLToPath(new URL('../src/url-ingestion.ts', import.meta.url));
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalEnvironment = {
  release: process.env['WORKOUT_RELEASE'],
  database: process.env['RESOURCE_URL_INGESTION_DATABASE_URL'],
  storage: process.env['RESOURCE_STORAGE_ROOT'],
  hosts: process.env['RESOURCE_URL_ALLOWED_HOSTS'],
};

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  worker.mockReset();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  setEnvironment('WORKOUT_RELEASE', originalEnvironment.release);
  setEnvironment('RESOURCE_URL_INGESTION_DATABASE_URL', originalEnvironment.database);
  setEnvironment('RESOURCE_STORAGE_ROOT', originalEnvironment.storage);
  setEnvironment('RESOURCE_URL_ALLOWED_HOSTS', originalEnvironment.hosts);
});

async function runInvalidConfiguration(secret: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    env: {
      PATH: process.env['PATH'],
      RESOURCE_URL_INGESTION_DATABASE_URL: `postgres://workout_resource_ingestion_worker:${secret}@127.0.0.1/workout`,
      RESOURCE_STORAGE_ROOT: '/',
      RESOURCE_URL_ALLOWED_HOSTS: 'example.com',
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

function configureInProcess(release: string): void {
  process.argv = [process.execPath, entrypoint];
  process.env['WORKOUT_RELEASE'] = release;
  process.env['RESOURCE_URL_INGESTION_DATABASE_URL'] =
    'postgres://workout_resource_ingestion_worker:private@127.0.0.1/workout';
  process.env['RESOURCE_STORAGE_ROOT'] = '/private/resources';
  process.env['RESOURCE_URL_ALLOWED_HOSTS'] = 'example.com';
}

describe('resource URL ingestion CLI log boundary', () => {
  it('keeps invalid configuration credentials and paths out of a structured failure', async () => {
    const secret = 'never-print-this-secret';
    const result = await runInvalidConfiguration(secret);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      kind: 'resource_url_ingestion_failed',
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'unreleased',
    });
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain('/private/resources');
  });

  it('emits only the bounded worker outcome with run id and release', async () => {
    configureInProcess('release-42');
    worker.mockResolvedValue('finalized');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await import('../src/url-ingestion.js');

    expect(errors).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      kind: 'resource_url_ingestion_result',
      result: 'finalized',
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'release-42',
    });
  });

  it('redacts a thrown URL and rejects an untrusted release value', async () => {
    configureInProcess('private URL https://example.com/secret');
    worker.mockRejectedValue(new Error('https://example.com/secret?token=private'));
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await import('../src/url-ingestion.js');

    expect(output).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
      kind: 'resource_url_ingestion_failed',
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'unreleased',
    });
    expect(String(errors.mock.calls[0]?.[0])).not.toContain('example.com');
    expect(process.exitCode).toBe(1);
  });
});
