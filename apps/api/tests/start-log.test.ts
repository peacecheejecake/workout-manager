import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('../src/start.ts', import.meta.url));
const sensitiveMarker = 'private-health-provider-password';

async function runStartupFailure(
  release: string | undefined,
  port = sensitiveMarker,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    env: {
      PATH: process.env['PATH'],
      PORT: port,
      NODE_ENV: 'invalid-environment',
      DATABASE_URL: `postgres://runtime:${sensitiveMarker}@127.0.0.1/workout`,
      OIDC_ISSUER: `https://provider.invalid/${sensitiveMarker}`,
      OIDC_CLIENT_SECRET: sensitiveMarker,
      PRIVATE_RESOURCE_STORAGE_ROOT: `/private/${sensitiveMarker}`,
      ...(release === undefined ? {} : { WORKOUT_RELEASE: release }),
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

function expectSafeFailure(result: Awaited<ReturnType<typeof runStartupFailure>>, version: string) {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.stderr)).toEqual({
    kind: 'api_startup_failed',
    runId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
    version,
  });
  expect(result.stderr).not.toContain(sensitiveMarker);
  expect(result.stderr).not.toContain('postgres://');
  expect(result.stderr).not.toContain('https://');
  expect(result.stderr).not.toContain('/private/');
}

describe('API startup failure log', () => {
  it.each([
    { release: undefined, version: 'unreleased' },
    { release: '', version: 'unreleased' },
    { release: '-leading', version: 'unreleased' },
    { release: 'x'.repeat(65), version: 'unreleased' },
    { release: `secret /private/${sensitiveMarker}`, version: 'unreleased' },
    { release: '2026.10.05+release-42', version: '2026.10.05+release-42' },
    { release: 'a'.repeat(64), version: 'a'.repeat(64) },
  ])('bounds release metadata ($release) before port parsing', async ({ release, version }) => {
    expectSafeFailure(await runStartupFailure(release), version);
  });

  it('also redacts factory configuration failures after a valid port', async () => {
    expectSafeFailure(await runStartupFailure('release-42', '4300'), 'release-42');
  });
});
