import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readSuppressionLedgerKey } from '../src/suppression-ledger-config.js';
import {
  runSuppressionLedgerOnce,
  type SuppressionLedgerOnceDependencies,
} from '../src/suppression-ledger-once.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wm-ledger-once-')));
  directories.push(directory);
  const encryptionKeyPath = join(directory, 'encryption.key');
  const headAuthenticationKeyPath = join(directory, 'head.key');
  writeFileSync(encryptionKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  writeFileSync(headAuthenticationKeyPath, Buffer.alloc(32, 2), { mode: 0o600 });
  return {
    directory,
    encryptionKeyPath,
    headAuthenticationKeyPath,
    env: {
      SUPPRESSION_LEDGER_EXPORT_ENABLED: 'true',
      SUPPRESSION_LEDGER_BUCKET: 'private-ledger-bucket',
      SUPPRESSION_LEDGER_PREFIX: 'deletion-ledger/v1',
      SUPPRESSION_LEDGER_BUCKET_OWNER: '123456789012',
      SUPPRESSION_LEDGER_REGION: 'ap-northeast-2',
      SUPPRESSION_LEDGER_SLOT_NAME: 'wm_suppression_primary',
      SUPPRESSION_LEDGER_CLUSTER_ID: '123456789',
      SUPPRESSION_LEDGER_ENCRYPTION_KEY_ID: 'key-1',
      SUPPRESSION_LEDGER_DATABASE_URL: 'postgres://ledger:secret@127.0.0.1/workout',
      SUPPRESSION_LEDGER_ENCRYPTION_KEY_FILE: encryptionKeyPath,
      SUPPRESSION_LEDGER_HEAD_HMAC_KEY_FILE: headAuthenticationKeyPath,
    },
  };
}

function fakeDependencies() {
  const destroy = vi.fn();
  const end = vi.fn(async () => undefined);
  const createS3 = vi.fn(() => ({ send: vi.fn(), destroy }) as unknown as S3Client);
  const createPool = vi.fn(() => ({ end }) as unknown as Pool);
  const coordinate = vi.fn<SuppressionLedgerOnceDependencies['coordinate']>(
    async (_input) => ({}) as Awaited<ReturnType<SuppressionLedgerOnceDependencies['coordinate']>>,
  );
  const dependencies: SuppressionLedgerOnceDependencies = {
    createS3,
    createPool,
    coordinate,
    readKey: readSuppressionLedgerKey,
  };
  return { dependencies, createS3, createPool, coordinate, destroy, end };
}

describe('suppression ledger one-shot worker', () => {
  it('requires both explicit gates and validates all identifiers before opening resources', async () => {
    const { env } = fixture();
    const calls = fakeDependencies();
    await expect(runSuppressionLedgerOnce([], env, calls.dependencies)).rejects.toThrow();
    await expect(
      runSuppressionLedgerOnce(
        ['--run-once'],
        { ...env, SUPPRESSION_LEDGER_EXPORT_ENABLED: 'false' },
        calls.dependencies,
      ),
    ).rejects.toThrow();
    for (const key of [
      'SUPPRESSION_LEDGER_REGION',
      'SUPPRESSION_LEDGER_BUCKET',
      'SUPPRESSION_LEDGER_BUCKET_OWNER',
      'SUPPRESSION_LEDGER_PREFIX',
      'SUPPRESSION_LEDGER_SLOT_NAME',
      'SUPPRESSION_LEDGER_CLUSTER_ID',
      'SUPPRESSION_LEDGER_ENCRYPTION_KEY_ID',
    ] as const) {
      await expect(
        runSuppressionLedgerOnce(
          ['--run-once'],
          { ...env, [key]: 'bad?value' },
          calls.dependencies,
        ),
      ).rejects.toThrow();
    }
    expect(calls.createS3).not.toHaveBeenCalled();
    expect(calls.createPool).not.toHaveBeenCalled();
  });

  it('rejects weak, linked, oversized, and identical keys before S3 or DB calls', async () => {
    const { directory, env, encryptionKeyPath, headAuthenticationKeyPath } = fixture();
    const calls = fakeDependencies();
    chmodSync(encryptionKeyPath, 0o644);
    await expect(
      runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies),
    ).rejects.toThrow();
    chmodSync(encryptionKeyPath, 0o600);
    writeFileSync(encryptionKeyPath, Buffer.alloc(33, 1));
    await expect(
      runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies),
    ).rejects.toThrow();
    writeFileSync(encryptionKeyPath, Buffer.alloc(32, 2));
    await expect(
      runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies),
    ).rejects.toThrow();
    const link = join(directory, 'linked.key');
    symlinkSync(headAuthenticationKeyPath, link);
    await expect(
      runSuppressionLedgerOnce(
        ['--run-once'],
        { ...env, SUPPRESSION_LEDGER_ENCRYPTION_KEY_FILE: link },
        calls.dependencies,
      ),
    ).rejects.toThrow();
    expect(calls.createS3).not.toHaveBeenCalled();
    expect(calls.createPool).not.toHaveBeenCalled();
  });

  it('coordinates once and releases both resources on success and failure', async () => {
    const { env } = fixture();
    const calls = fakeDependencies();
    await runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies);
    expect(calls.coordinate).toHaveBeenCalledTimes(1);
    expect(calls.coordinate.mock.calls[0]?.[0]).toMatchObject({
      slotName: 'wm_suppression_primary',
      expectedClusterId: '123456789',
    });
    expect(calls.end).toHaveBeenCalledTimes(1);
    expect(calls.destroy).toHaveBeenCalledTimes(1);
    calls.coordinate.mockRejectedValueOnce(new Error('secret SQL or S3 details'));
    await expect(
      runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies),
    ).rejects.toThrow();
    expect(calls.coordinate).toHaveBeenCalledTimes(2);
    expect(calls.end).toHaveBeenCalledTimes(2);
    expect(calls.destroy).toHaveBeenCalledTimes(2);
  });

  it('destroys S3 if creating the database pool fails', async () => {
    const { env } = fixture();
    const calls = fakeDependencies();
    calls.createPool.mockImplementationOnce(() => {
      throw new Error('secret connection details');
    });
    await expect(
      runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies),
    ).rejects.toThrow();
    expect(calls.coordinate).not.toHaveBeenCalled();
    expect(calls.destroy).toHaveBeenCalledTimes(1);
  });

  it('prints only a generic failure from the CLI', async () => {
    const { env } = fixture();
    const entrypoint = fileURLToPath(new URL('../src/suppression-ledger-once.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', entrypoint, '--run-once'], {
      env: {
        PATH: process.env['PATH'],
        ...env,
        SUPPRESSION_LEDGER_BUCKET: 'invalid/secret-bucket',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (part: Buffer) => {
          stdout += part.toString();
        });
        child.stderr.on('data', (part: Buffer) => {
          stderr += part.toString();
        });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      },
    );
    expect(output).toEqual({ code: 1, stdout: '', stderr: 'SUPPRESSION_LEDGER_EXPORT_FAILED\n' });
  });
});
