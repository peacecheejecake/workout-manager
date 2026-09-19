import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('../src/resource-cleanup.ts', import.meta.url));

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

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'RESOURCE_OBJECT_CLEANUP_FAILED\n',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });
});
