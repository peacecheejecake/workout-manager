import { chmod, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  deadWriterGraceMs,
  processIsAlive,
  sweepStaleHandoffFiles,
  unknownWriterMaxAgeMs,
} from '../../../scripts/fixtures/identity-handoff-sweep';

const now = Date.parse('2026-09-24T12:00:00Z');
const runId = '6f1c2d34-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const livePid = 4001;
const deadPid = 4002;
const isAlive = (pid: number) => pid === livePid;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'handoff-sweep-test-'));
});
afterEach(async () => {
  await chmod(directory, 0o700);
  await rm(directory, { recursive: true, force: true });
});

async function file(name: string, ageMs: number, content: unknown) {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(content), { mode: 0o600 });
  const at = new Date(now - ageMs);
  await utimes(path, at, at);
  return path;
}
async function sweep(options: { uid?: number } = {}) {
  const result = await sweepStaleHandoffFiles({ directory, now, isAlive, ...options });
  expect(result.skipped).toEqual([]);
  return result.removed;
}
const remaining = async () => (await readdir(directory)).sort();

it('removes the hand-off files of a killed harness once its pid is gone', async () => {
  await file(`workout-coaching-worker-e2e-4300-${runId}.json`, deadWriterGraceMs + 1, {
    databaseUrl: 'postgresql://synthetic',
    harnessPid: deadPid,
  });
  await file(`workout-certified-oidc-e2e-4300-${runId}.json`, deadWriterGraceMs + 1, {
    passwords: {},
    harnessPid: deadPid,
  });
  expect((await sweep()).sort()).toEqual([
    `workout-certified-oidc-e2e-4300-${runId}.json`,
    `workout-coaching-worker-e2e-4300-${runId}.json`,
  ]);
  expect(await remaining()).toEqual([]);
});

it("keeps a running harness's file however old it is", async () => {
  const name = `workout-coaching-worker-e2e-4300-${runId}.json`;
  await file(name, unknownWriterMaxAgeMs * 3, { harnessPid: livePid });
  expect(await sweep()).toEqual([]);
  expect(await remaining()).toEqual([name]);
});

it('leaves a just-written file alone even when its writer is gone', async () => {
  const name = `workout-coaching-worker-e2e-4300-${runId}.json`;
  await file(name, deadWriterGraceMs - 1, { harnessPid: deadPid });
  expect(await sweep()).toEqual([]);
  expect(await remaining()).toEqual([name]);
});

it('removes a file without a recorded writer only after a day', async () => {
  await file('workout-coaching-worker-e2e-4300-default.json', unknownWriterMaxAgeMs + 1, {
    databaseUrl: 'postgresql://synthetic',
  });
  await file(`workout-coaching-worker-e2e-4301-${runId}.json`, unknownWriterMaxAgeMs - 1, {
    databaseUrl: 'postgresql://synthetic',
  });
  await file(`workout-certified-oidc-e2e-4300-${runId}.json`, unknownWriterMaxAgeMs - 1, '{"par');
  expect(await sweep()).toEqual(['workout-coaching-worker-e2e-4300-default.json']);
  expect(await remaining()).toEqual([
    `workout-certified-oidc-e2e-4300-${runId}.json`,
    `workout-coaching-worker-e2e-4301-${runId}.json`,
  ]);
});

it('touches nothing but the exact hand-off names', async () => {
  const old = unknownWriterMaxAgeMs * 2;
  const content = { harnessPid: deadPid };
  const names = [
    'workout-coaching-worker-e2e-4300.json', // port-only name from before run ids
    `workout-coaching-worker-e2e-4300-${runId}.json.bak`,
    `workout-coaching-worker-e2e-abc-${runId}.json`,
    `workout-coaching-worker-e2e-4300-${runId.toUpperCase()}.json`,
    `workout-coaching-worker-e2e-4300-${runId}/x.json`,
    `other-workout-certified-oidc-e2e-4300-${runId}.json`,
    `workout-identity-e2e-${runId}.json`,
  ];
  for (const name of names) {
    if (name.includes('/')) await mkdir(join(directory, name.split('/')[0] ?? ''));
    await file(name, old, content);
  }
  expect(await sweep()).toEqual([]);
  expect(await remaining()).toHaveLength(names.length);
});

it('never follows a symlink or removes a directory with a matching name', async () => {
  const target = await file('target.json', unknownWriterMaxAgeMs * 2, { harnessPid: deadPid });
  const link = join(directory, `workout-coaching-worker-e2e-4300-${runId}.json`);
  await symlink(target, link);
  await mkdir(join(directory, `workout-certified-oidc-e2e-4300-${runId}.json`));
  expect(await sweep()).toEqual([]);
  expect(await remaining()).toHaveLength(3);
});

it("skips another user's files", async () => {
  const name = `workout-coaching-worker-e2e-4300-${runId}.json`;
  await file(name, unknownWriterMaxAgeMs * 2, { harnessPid: deadPid });
  const uid = process.getuid?.() ?? 0;
  expect(await sweep({ uid: uid + 1 })).toEqual([]);
  expect(await remaining()).toEqual([name]);
});

it('reports what it cannot remove instead of throwing, so the harness still starts', async () => {
  const name = `workout-coaching-worker-e2e-4300-${runId}.json`;
  await file(name, deadWriterGraceMs + 1, { harnessPid: deadPid });
  // A directory this user cannot write: the unlink fails with EACCES.
  await chmod(directory, 0o500);
  const result = await sweepStaleHandoffFiles({ directory, now, isAlive });
  await chmod(directory, 0o700);
  expect(result).toEqual({ removed: [], skipped: [{ name, reason: 'EACCES' }] });
  expect(await remaining()).toEqual([name]);
  const missing = join(directory, 'missing');
  expect(await sweepStaleHandoffFiles({ directory: missing, now, isAlive })).toEqual({
    removed: [],
    skipped: [{ name: missing, reason: 'ENOENT' }],
  });
});

it('reports this process as alive and an exited one as gone', async () => {
  expect(processIsAlive(process.pid)).toBe(true);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  await new Promise((resolve) => child.once('exit', resolve));
  expect(pid).toBeTypeOf('number');
  expect(processIsAlive(pid ?? -1)).toBe(false);
});
