import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareCandidate } from './prepare-caddy-candidate.mjs';

const [holding, proxy] = await Promise.all([
  readFile(new URL('./workout-holding.caddy', import.meta.url), 'utf8'),
  readFile(new URL('./workout.caddy', import.meta.url), 'utf8'),
]);
const oldBlock = holding.slice(holding.indexOf('workout.red-10-proto.xyz {')).trimEnd();
const apex = 'red-10-proto.xyz {\n\treverse_proxy web:4000\n}\n\n';

test('replaces only the exact 503 site and preserves the apex bytes', () => {
  const candidate = prepareCandidate(apex + oldBlock + '\n', holding, proxy);
  assert.ok(candidate.startsWith(apex));
  assert.ok(candidate.includes('reverse_proxy wm-hosting-app:3100'));
  assert.ok(!candidate.includes('respond "Workout Manager setup in progress" 503'));
  assert.equal((candidate.match(/workout\.red-10-proto\.xyz \{/g) ?? []).length, 1);
});

test('rejects a changed holding block and duplicate Workout sites', () => {
  assert.throws(() => prepareCandidate(apex + oldBlock.replace('503', '200'), holding, proxy));
  assert.throws(() => prepareCandidate(apex + oldBlock + '\n' + oldBlock, holding, proxy));
});

test('CLI creates a private candidate and refuses to overwrite it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workout-caddy-'));
  try {
    const activePath = join(directory, 'Caddyfile');
    const candidatePath = join(directory, 'candidate');
    await writeFile(activePath, apex + oldBlock + '\n');
    const command = [
      fileURLToPath(new URL('./prepare-caddy-candidate.mjs', import.meta.url)),
      activePath,
      candidatePath,
    ];
    assert.equal(
      execFileSync(process.execPath, command, { encoding: 'utf8' }),
      'CADDY_CANDIDATE_WRITTEN\n',
    );
    assert.equal((await stat(candidatePath)).mode & 0o777, 0o600);
    assert.ok((await readFile(candidatePath, 'utf8')).startsWith(apex));
    assert.throws(() => execFileSync(process.execPath, command, { stdio: 'pipe' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
