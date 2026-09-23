import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('../src/course-thumbnail.ts', import.meta.url));

async function runInvalidConfiguration(secret: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    env: {
      PATH: process.env['PATH'],
      // The wrong role, so configuration is refused — carrying a password the refusal must
      // not print. An unguarded parse would put the whole connection string in a stack.
      COURSE_THUMBNAIL_DATABASE_URL: `postgres://workout_runtime:${secret}@127.0.0.1/workout`,
      DATABASE_URL: `postgres://workout_api:${secret}@127.0.0.1/workout`,
      RESOURCE_STORAGE_ROOT: '/var/lib/workout/objects',
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

describe('course thumbnail render CLI', () => {
  it('emits only a generic failure without credentials or storage paths', async () => {
    const secret = 'never-print-this-secret';

    const result = await runInvalidConfiguration(secret);

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'COURSE_THUMBNAIL_RENDER_FAILED\n',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });
});
