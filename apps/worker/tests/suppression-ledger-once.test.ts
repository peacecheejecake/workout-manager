import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { S3Client } from '@aws-sdk/client-s3';
import { decodeSuppressionHeadV7 } from '@workout/server-persistence/restore-suppression-replay-v7';
import {
  decodeSuppressionHeadV8,
  encodeSuppressionHeadV8,
} from '@workout/server-persistence/restore-suppression-replay-v8';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseSuppressionLedgerOnceConfig,
  readSuppressionLedgerKey,
  suppressionLedgerEnvironmentNames,
} from '../src/suppression-ledger-config.js';
import type { SuppressionSourceInspection } from '../src/suppression-ledger-export.js';
import {
  runSuppressionLedgerCli,
  runSuppressionLedgerOnce,
  type SuppressionLedgerOnceDependencies,
} from '../src/suppression-ledger-once.js';
import { readSuppressionHeadWitness } from '../src/suppression-ledger-witness.js';
import { memoryVersionedBucket } from './suppression-ledger-memory-remote.js';

const directories: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

const fingerprint = 'f'.repeat(64);
const captureId = '7c0d9a5e-2b1f-4c3d-8e9f-0a1b2c3d4e5f';
const remoteConfig = {
  schemaVersion: 1 as const,
  bucket: 'private-ledger-bucket',
  prefix: 'deletion-ledger/v1',
  region: 'ap-northeast-2' as const,
  expectedBucketOwner: '123456789012',
};
type Profile = 'suppression-physical-v7' | 'suppression-physical-v8';

function fixture(profile: Profile = 'suppression-physical-v8') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wm-ledger-once-')));
  directories.push(directory);
  const encryptionKeyPath = join(directory, 'encryption.key');
  const headAuthenticationKeyPath = join(directory, 'head.key');
  const witnessDirectory = join(directory, 'state');
  mkdirSync(witnessDirectory, { mode: 0o700 });
  const headWitnessPath = join(witnessDirectory, 'head-witness.json');
  writeFileSync(encryptionKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  writeFileSync(headAuthenticationKeyPath, Buffer.alloc(32, 2), { mode: 0o600 });
  return {
    directory,
    encryptionKeyPath,
    headAuthenticationKeyPath,
    headWitnessPath,
    env: {
      SUPPRESSION_LEDGER_EXPORT_ENABLED: 'true',
      SUPPRESSION_LEDGER_BUCKET: remoteConfig.bucket,
      SUPPRESSION_LEDGER_PREFIX: remoteConfig.prefix,
      SUPPRESSION_LEDGER_BUCKET_OWNER: remoteConfig.expectedBucketOwner,
      SUPPRESSION_LEDGER_REGION: 'ap-northeast-2',
      SUPPRESSION_LEDGER_SLOT_NAME: 'wm_suppression_primary',
      SUPPRESSION_LEDGER_CLUSTER_ID: '123456789',
      SUPPRESSION_LEDGER_ENCRYPTION_KEY_ID: 'key-1',
      SUPPRESSION_LEDGER_DATABASE_URL: 'postgres://ledger:secret@127.0.0.1/workout',
      SUPPRESSION_LEDGER_SOURCE_DATABASE_NAME: 'workout',
      SUPPRESSION_LEDGER_SOURCE_DATABASE_OID: '16384',
      SUPPRESSION_LEDGER_CAPTURE_ID: captureId,
      SUPPRESSION_LEDGER_REGISTRY_FINGERPRINT: fingerprint,
      SUPPRESSION_LEDGER_RELATION_PROFILE: profile,
      SUPPRESSION_LEDGER_ENCRYPTION_KEY_FILE: encryptionKeyPath,
      SUPPRESSION_LEDGER_HEAD_HMAC_KEY_FILE: headAuthenticationKeyPath,
      SUPPRESSION_LEDGER_HEAD_WITNESS_FILE: headWitnessPath,
    } as Record<string, string | undefined>,
  };
}
const bootstrapEnv = (env: Record<string, string | undefined>) => ({
  ...env,
  SUPPRESSION_LEDGER_HEAD_BOOTSTRAP: 'create-initial-head',
});

function inspection(
  overrides: Partial<SuppressionSourceInspection> = {},
): SuppressionSourceInspection {
  return {
    clusterId: '123456789',
    databaseName: 'workout',
    databaseOid: 16384,
    registryFingerprint: fingerprint,
    relationProfile: 'suppression-physical-v8',
    confirmedFlushLsn: '0/1A2B3C8',
    pendingMessages: 0,
    ...overrides,
  };
}

function fakeDependencies(live: SuppressionSourceInspection = inspection()) {
  const destroy = vi.fn();
  const end = vi.fn(async () => undefined);
  const bucket = memoryVersionedBucket(remoteConfig);
  const createS3 = vi.fn(() => ({ send: vi.fn(), destroy }) as unknown as S3Client);
  const createPool = vi.fn(() => ({ end }) as unknown as Pool);
  const inspectSource = vi.fn<SuppressionLedgerOnceDependencies['inspectSource']>(async () => live);
  const exportForInstalledDomain = vi.fn<
    SuppressionLedgerOnceDependencies['exportForInstalledDomain']
  >(async (input) => ({
    clusterId: input.expectedClusterId,
    slotName: input.source.slotName,
    fromLsn: '0/1',
    throughLsn: '0/2',
    localHash: 'a'.repeat(64),
    remote: { sha256: 'b'.repeat(64), byteLength: 1, versionId: 'v', segmentId: 's' },
    source: input.source,
  }));
  const dependencies: SuppressionLedgerOnceDependencies = {
    createS3,
    createPool,
    createRemote: () => ({ client: bucket.client, store: bucket.store }),
    inspectSource,
    exportForInstalledDomain,
    readKey: readSuppressionLedgerKey,
  };
  return {
    dependencies,
    bucket,
    createS3,
    createPool,
    inspectSource,
    exportForInstalledDomain,
    destroy,
    end,
  };
}

describe('suppression ledger configuration contract', () => {
  it('lists every variable the parser reads', () => {
    const { env } = fixture();
    expect(
      Object.keys(env).every((name) => suppressionLedgerEnvironmentNames.includes(name as never)),
    ).toBe(true);
    expect(suppressionLedgerEnvironmentNames).toContain('SUPPRESSION_LEDGER_HEAD_BOOTSTRAP');
  });

  it('parses an exact V7 or V8 binding from explicit values', () => {
    for (const profile of ['suppression-physical-v7', 'suppression-physical-v8'] as const) {
      const { env } = fixture(profile);
      expect(parseSuppressionLedgerOnceConfig(['--run-once'], env)).toMatchObject({
        command: 'run-once',
        source: {
          databaseName: 'workout',
          databaseOid: 16384,
          slotName: 'wm_suppression_primary',
          publication: 'workout_restore_suppression_events',
          relationProfile: profile,
          captureId,
          registryFingerprint: fingerprint,
        },
      });
      expect(
        parseSuppressionLedgerOnceConfig(['--bootstrap-head'], bootstrapEnv(env)).command,
      ).toBe('bootstrap-head');
    }
  });

  it('requires both explicit gates and validates all identifiers before opening resources', async () => {
    const { env, directory, encryptionKeyPath } = fixture();
    const calls = fakeDependencies();
    const refused: Array<[string[], Record<string, string | undefined>]> = [
      [[], env],
      [['--run-once', '--run-once'], env],
      [['--run-once'], { ...env, SUPPRESSION_LEDGER_EXPORT_ENABLED: 'false' }],
      [['--run-once'], bootstrapEnv(env)],
      [['--bootstrap-head'], env],
      [['--bootstrap-head'], { ...env, SUPPRESSION_LEDGER_HEAD_BOOTSTRAP: 'yes' }],
    ];
    for (const key of [
      'SUPPRESSION_LEDGER_REGION',
      'SUPPRESSION_LEDGER_BUCKET',
      'SUPPRESSION_LEDGER_BUCKET_OWNER',
      'SUPPRESSION_LEDGER_PREFIX',
      'SUPPRESSION_LEDGER_SLOT_NAME',
      'SUPPRESSION_LEDGER_CLUSTER_ID',
      'SUPPRESSION_LEDGER_ENCRYPTION_KEY_ID',
      'SUPPRESSION_LEDGER_SOURCE_DATABASE_NAME',
      'SUPPRESSION_LEDGER_SOURCE_DATABASE_OID',
      'SUPPRESSION_LEDGER_CAPTURE_ID',
      'SUPPRESSION_LEDGER_REGISTRY_FINGERPRINT',
      'SUPPRESSION_LEDGER_RELATION_PROFILE',
      'SUPPRESSION_LEDGER_HEAD_WITNESS_FILE',
    ]) {
      refused.push([['--run-once'], { ...env, [key]: 'bad?value' }]);
      refused.push([['--run-once'], { ...env, [key]: undefined }]);
    }
    for (const [key, value] of [
      ['SUPPRESSION_LEDGER_SOURCE_DATABASE_OID', '0'],
      ['SUPPRESSION_LEDGER_SOURCE_DATABASE_OID', '4294967296'],
      ['SUPPRESSION_LEDGER_SOURCE_DATABASE_OID', '016384'],
      ['SUPPRESSION_LEDGER_CAPTURE_ID', captureId.toUpperCase()],
      ['SUPPRESSION_LEDGER_REGISTRY_FINGERPRINT', 'F'.repeat(64)],
      ['SUPPRESSION_LEDGER_REGISTRY_FINGERPRINT', 'f'.repeat(63)],
      ['SUPPRESSION_LEDGER_RELATION_PROFILE', 'suppression-physical-v9'],
      ['SUPPRESSION_LEDGER_RELATION_PROFILE', 'suppression-physical-v1'],
      // The connection must name exactly the bound database.
      ['SUPPRESSION_LEDGER_SOURCE_DATABASE_NAME', 'other'],
      ['SUPPRESSION_LEDGER_DATABASE_URL', 'postgres://ledger:secret@127.0.0.1/other'],
      ['SUPPRESSION_LEDGER_HEAD_WITNESS_FILE', 'relative/witness.json'],
      ['SUPPRESSION_LEDGER_HEAD_WITNESS_FILE', join(directory, 'missing', 'witness.json')],
      ['SUPPRESSION_LEDGER_HEAD_WITNESS_FILE', encryptionKeyPath],
      ['SUPPRESSION_LEDGER_HEAD_WITNESS_FILE', join(directory, 'state', 'w.json.tmp-1')],
    ] as const)
      refused.push([['--run-once'], { ...env, [key]: value }]);
    const linkedDirectory = join(directory, 'linked-state');
    symlinkSync(join(directory, 'state'), linkedDirectory);
    refused.push([
      ['--run-once'],
      { ...env, SUPPRESSION_LEDGER_HEAD_WITNESS_FILE: join(linkedDirectory, 'w.json') },
    ]);
    for (const [args, candidate] of refused)
      await expect(runSuppressionLedgerOnce(args, candidate, calls.dependencies)).rejects.toThrow(
        'SUPPRESSION_LEDGER_CONFIG_FAILED',
      );
    expect(calls.createS3).not.toHaveBeenCalled();
    expect(calls.createPool).not.toHaveBeenCalled();
  });

  it('rejects weak, linked, oversized, and identical keys before S3 or DB calls', async () => {
    const { directory, env, encryptionKeyPath, headAuthenticationKeyPath } = fixture();
    const calls = fakeDependencies();
    chmodSync(encryptionKeyPath, 0o644);
    await expect(runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies)).rejects.toThrow(
      'SUPPRESSION_LEDGER_CONFIG_FAILED',
    );
    chmodSync(encryptionKeyPath, 0o600);
    writeFileSync(encryptionKeyPath, Buffer.alloc(33, 1));
    await expect(runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies)).rejects.toThrow(
      'SUPPRESSION_LEDGER_CONFIG_FAILED',
    );
    writeFileSync(encryptionKeyPath, Buffer.alloc(32, 2));
    await expect(runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies)).rejects.toThrow(
      'SUPPRESSION_LEDGER_CONFIG_FAILED',
    );
    const link = join(directory, 'linked.key');
    symlinkSync(headAuthenticationKeyPath, link);
    await expect(
      runSuppressionLedgerOnce(
        ['--run-once'],
        { ...env, SUPPRESSION_LEDGER_ENCRYPTION_KEY_FILE: link },
        calls.dependencies,
      ),
    ).rejects.toThrow('SUPPRESSION_LEDGER_CONFIG_FAILED');
    expect(calls.createS3).not.toHaveBeenCalled();
    expect(calls.createPool).not.toHaveBeenCalled();
  });
});

describe('suppression ledger head bootstrap', () => {
  it('creates a format-3 (V8) or format-2 (V7) head at the slot and pins it locally', async () => {
    for (const profile of ['suppression-physical-v7', 'suppression-physical-v8'] as const) {
      const { env, headWitnessPath } = fixture(profile);
      const calls = fakeDependencies(inspection({ relationProfile: profile }));
      await expect(
        runSuppressionLedgerOnce(['--bootstrap-head'], bootstrapEnv(env), calls.dependencies),
      ).resolves.toEqual({ outcome: 'bootstrap_created', relationProfile: profile });
      const head = calls.bucket.latest(calls.bucket.headKey);
      expect(head).not.toBeNull();
      const decoded =
        profile === 'suppression-physical-v8'
          ? decodeSuppressionHeadV8(head?.bytes ?? Buffer.alloc(0), Buffer.alloc(32, 2))
          : decodeSuppressionHeadV7(head?.bytes ?? Buffer.alloc(0), Buffer.alloc(32, 2));
      expect(decoded).toMatchObject({
        formatVersion: profile === 'suppression-physical-v8' ? 3 : 2,
        clusterId: '123456789',
        fromLsn: '0/1A2B3C8',
        throughLsn: '0/1A2B3C8',
        previousHash: null,
        finalLocalHash: null,
        segments: [],
        source: { relationProfile: profile, captureId, databaseOid: 16384 },
      });
      expect(readSuppressionHeadWitness(headWitnessPath)).toEqual({
        schemaVersion: 1,
        captureId,
        relationProfile: profile,
        headVersionId: head?.versionId,
        headSha256: createHash('sha256')
          .update(head?.bytes ?? Buffer.alloc(0))
          .digest('hex'),
        pendingHeadSha256: null,
      });
      // A second bootstrap refuses: the head and the witness exist.
      await expect(
        runSuppressionLedgerOnce(['--bootstrap-head'], bootstrapEnv(env), calls.dependencies),
      ).rejects.toThrow('SUPPRESSION_LEDGER_HEAD_EXISTS');
      expect(calls.exportForInstalledDomain).not.toHaveBeenCalled();
    }
  });

  it('refuses when any head version exists without a local witness', async () => {
    const { env, headWitnessPath } = fixture();
    const calls = fakeDependencies();
    calls.bucket.forcePut(calls.bucket.headKey, Buffer.from('foreign'));
    await expect(
      runSuppressionLedgerOnce(['--bootstrap-head'], bootstrapEnv(env), calls.dependencies),
    ).rejects.toThrow('SUPPRESSION_LEDGER_HEAD_EXISTS');
    expect(existsSync(headWitnessPath)).toBe(false);
  });

  it('refuses a source that does not match the binding before touching the bucket', async () => {
    const { env, headWitnessPath } = fixture();
    for (const live of [
      inspection({ relationProfile: 'suppression-physical-v7' }),
      inspection({ databaseOid: 16385 }),
      inspection({ registryFingerprint: 'e'.repeat(64) }),
      inspection({ clusterId: '987654321' }),
      inspection({ databaseName: 'other' }),
    ]) {
      const calls = fakeDependencies(live);
      await expect(
        runSuppressionLedgerOnce(['--bootstrap-head'], bootstrapEnv(env), calls.dependencies),
      ).rejects.toThrow('SUPPRESSION_LEDGER_SOURCE_MISMATCH');
      expect(calls.bucket.latest(calls.bucket.headKey)).toBeNull();
      expect(calls.end).toHaveBeenCalledOnce();
      expect(calls.destroy).toHaveBeenCalledOnce();
    }
    expect(existsSync(headWitnessPath)).toBe(false);
  });

  it('completes only its own interrupted creation (pending sha256 equals the remote head)', async () => {
    const { env, headWitnessPath } = fixture();
    const calls = fakeDependencies();
    const realPut = calls.bucket.client.putIfAbsent.bind(calls.bucket.client);
    calls.bucket.client.putIfAbsent = async (key, bytes) => {
      await realPut(key, bytes);
      throw new Error('timeout after write');
    };
    await expect(
      runSuppressionLedgerOnce(['--bootstrap-head'], bootstrapEnv(env), calls.dependencies),
    ).rejects.toThrow('SUPPRESSION_LEDGER_BOOTSTRAP_FAILED');
    expect(readSuppressionHeadWitness(headWitnessPath)).toMatchObject({
      headVersionId: null,
      pendingHeadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    calls.bucket.client.putIfAbsent = realPut;
    await expect(
      runSuppressionLedgerOnce(['--bootstrap-head'], bootstrapEnv(env), calls.dependencies),
    ).resolves.toMatchObject({ outcome: 'bootstrap_completed' });
    expect(readSuppressionHeadWitness(headWitnessPath)).toMatchObject({
      headVersionId: calls.bucket.latest(calls.bucket.headKey)?.versionId,
      pendingHeadSha256: null,
    });
  });
});

describe('suppression ledger export through the installed-domain exporter', () => {
  async function bootstrapped(profile: Profile, live = inspection({ relationProfile: profile })) {
    const setup = fixture(profile);
    const calls = fakeDependencies(live);
    await runSuppressionLedgerOnce(
      ['--bootstrap-head'],
      bootstrapEnv(setup.env),
      calls.dependencies,
    );
    return { ...setup, calls };
  }

  it('chooses the V8 or V7 binding by the configured and installed record domain', async () => {
    for (const profile of ['suppression-physical-v7', 'suppression-physical-v8'] as const) {
      const { env, calls } = await bootstrapped(
        profile,
        inspection({ relationProfile: profile, pendingMessages: 3 }),
      );
      const head = calls.bucket.latest(calls.bucket.headKey);
      await expect(
        runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies),
      ).resolves.toEqual({ outcome: 'exported', relationProfile: profile });
      expect(calls.exportForInstalledDomain).toHaveBeenCalledOnce();
      expect(calls.exportForInstalledDomain.mock.calls[0]?.[0]).toMatchObject({
        source: { relationProfile: profile, captureId, slotName: 'wm_suppression_primary' },
        expectedClusterId: '123456789',
        keyId: 'key-1',
        expectedHeadVersionId: head?.versionId,
        expectedHeadSha256: createHash('sha256')
          .update(head?.bytes ?? Buffer.alloc(0))
          .digest('hex'),
      });
    }
  });

  it('refuses a binding whose profile differs from the installed domain, without exporting', async () => {
    for (const [configured, installed] of [
      ['suppression-physical-v7', 'suppression-physical-v8'],
      ['suppression-physical-v8', 'suppression-physical-v7'],
    ] as const) {
      const { env, calls } = await bootstrapped(configured);
      calls.inspectSource.mockResolvedValue(
        inspection({ relationProfile: installed, pendingMessages: 2 }),
      );
      await expect(
        runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies),
      ).rejects.toThrow('SUPPRESSION_LEDGER_SOURCE_MISMATCH');
      expect(calls.exportForInstalledDomain).not.toHaveBeenCalled();
    }
  });

  it('is a verified no-op when the slot is at the head and nothing is pending', async () => {
    const { env, calls } = await bootstrapped('suppression-physical-v8');
    await expect(
      runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies),
    ).resolves.toEqual({
      outcome: 'no_new_records',
      relationProfile: 'suppression-physical-v8',
    });
    expect(calls.exportForInstalledDomain).not.toHaveBeenCalled();
  });

  it('refuses without a witness, with a foreign head, or with a head for another binding', async () => {
    const { env, headWitnessPath, calls } = await bootstrapped('suppression-physical-v8');
    calls.inspectSource.mockResolvedValue(inspection({ pendingMessages: 1 }));
    // Witness pins another capture.
    const witness = readFileSync(headWitnessPath, 'utf8');
    writeFileSync(
      headWitnessPath,
      witness.replace(captureId, '00000000-0000-4000-8000-000000000000'),
    );
    await expect(runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies)).rejects.toThrow(
      'SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED',
    );
    writeFileSync(headWitnessPath, witness);
    // A validly signed head for another source binding is refused even when pinned.
    const other = encodeSuppressionHeadV8(
      {
        formatVersion: 3,
        source: {
          databaseName: 'workout',
          databaseOid: 16385,
          slotName: 'wm_suppression_primary',
          publication: 'workout_restore_suppression_events',
          relationProfile: 'suppression-physical-v8',
          captureId,
          registryFingerprint: fingerprint,
        },
        clusterId: '123456789',
        fromLsn: '0/1A2B3C8',
        throughLsn: '0/1A2B3C8',
        previousHash: null,
        finalLocalHash: null,
        segments: [],
      },
      Buffer.alloc(32, 2),
    );
    const forged = calls.bucket.forcePut(calls.bucket.headKey, other);
    await expect(runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies)).rejects.toThrow(
      'SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED',
    );
    writeFileSync(
      headWitnessPath,
      JSON.stringify({
        schemaVersion: 1,
        captureId,
        relationProfile: 'suppression-physical-v8',
        headVersionId: forged.versionId,
        headSha256: createHash('sha256').update(other).digest('hex'),
        pendingHeadSha256: null,
      }) + '\n',
    );
    await expect(runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies)).rejects.toThrow(
      'SUPPRESSION_LEDGER_HEAD_INVALID',
    );
    rmSync(headWitnessPath);
    await expect(runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies)).rejects.toThrow(
      'SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED',
    );
    expect(calls.exportForInstalledDomain).not.toHaveBeenCalled();
  });

  it('records the pending head before the conditional write and adopts exactly that head', async () => {
    const { env, headWitnessPath, calls } = await bootstrapped('suppression-physical-v8');
    calls.inspectSource.mockResolvedValue(inspection({ pendingMessages: 1 }));
    const initial = readSuppressionHeadWitness(headWitnessPath);
    const next = Buffer.from('next-head-bytes');
    const nextSha = createHash('sha256').update(next).digest('hex');
    let beforeWrite: ReturnType<typeof readSuppressionHeadWitness> = null;
    calls.exportForInstalledDomain.mockImplementationOnce(async (input) => {
      const original = calls.bucket.client.putIfMatch;
      calls.bucket.client.putIfMatch = async (key, etag, bytes) => {
        // The pending sha256 is durable before the remote head can change.
        beforeWrite = readSuppressionHeadWitness(headWitnessPath);
        await original(key, etag, bytes);
        throw new Error('crash after the conditional write');
      };
      await input.store.compareAndSetHead(input.expectedHeadVersionId, next);
      throw new Error('unreachable');
    });
    await expect(runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies)).rejects.toThrow(
      'SUPPRESSION_LEDGER_EXPORT_FAILED',
    );
    expect(beforeWrite).toMatchObject({
      headVersionId: initial?.headVersionId,
      headSha256: initial?.headSha256,
      pendingHeadSha256: nextSha,
    });
    expect(calls.bucket.latest(calls.bucket.headKey)?.bytes.equals(next)).toBe(true);
    // Next run: remote head is exactly the pending bytes -> adopted and pinned, then used.
    await expect(runSuppressionLedgerOnce(['--run-once'], env, calls.dependencies)).rejects.toThrow(
      'SUPPRESSION_LEDGER_HEAD_INVALID', // the synthetic bytes are not a signed head
    );
    expect(readSuppressionHeadWitness(headWitnessPath)).toMatchObject({
      headVersionId: calls.bucket.latest(calls.bucket.headKey)?.versionId,
      headSha256: nextSha,
      pendingHeadSha256: null,
    });
  });
});

describe('suppression ledger CLI', () => {
  it('closes resources on success and failure', async () => {
    const { env } = fixture();
    const calls = fakeDependencies();
    calls.inspectSource.mockRejectedValueOnce(new Error('secret SQL details'));
    await expect(
      runSuppressionLedgerOnce(['--bootstrap-head'], bootstrapEnv(env), calls.dependencies),
    ).rejects.toThrow('SUPPRESSION_LEDGER_SOURCE_MISMATCH');
    expect(calls.end).toHaveBeenCalledTimes(1);
    expect(calls.destroy).toHaveBeenCalledTimes(1);
    calls.createPool.mockImplementationOnce(() => {
      throw new Error('secret connection details');
    });
    await expect(
      runSuppressionLedgerOnce(['--bootstrap-head'], bootstrapEnv(env), calls.dependencies),
    ).rejects.toThrow('SUPPRESSION_LEDGER_BOOTSTRAP_FAILED');
    expect(calls.destroy).toHaveBeenCalledTimes(2);
    expect(calls.inspectSource).toHaveBeenCalledTimes(1);
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
    expect(output.code).toBe(1);
    expect(output.stdout).toBe('');
    expect(JSON.parse(output.stderr)).toEqual({
      kind: 'suppression_ledger_export_failed',
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'unreleased',
      reason: 'SUPPRESSION_LEDGER_CONFIG_FAILED',
    });
    expect(output.stderr).not.toContain('invalid/secret-bucket');
  });

  it('logs completion with only a finite outcome and profile', async () => {
    const { env } = fixture();
    const calls = fakeDependencies();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runSuppressionLedgerCli(
      ['--bootstrap-head'],
      { ...bootstrapEnv(env), WORKOUT_RELEASE: 'release-42' },
      calls.dependencies,
    );
    expect(errors).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      kind: 'suppression_ledger_export_attempt_completed',
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'release-42',
      outcome: 'bootstrap_created',
      relationProfile: 'suppression-physical-v8',
    });
    const line = String(output.mock.calls[0]?.[0]);
    for (const secret of ['private-ledger-bucket', 'secret', '0/1A2B3C8', captureId])
      expect(line).not.toContain(secret);
  });

  it('redacts exporter errors and rejects an untrusted release value', async () => {
    const { env } = fixture();
    const calls = fakeDependencies(inspection({ pendingMessages: 4 }));
    await runSuppressionLedgerOnce(['--bootstrap-head'], bootstrapEnv(env), calls.dependencies);
    calls.exportForInstalledDomain.mockRejectedValueOnce(
      new Error('secret key /private/ledger/path'),
    );
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runSuppressionLedgerCli(
      ['--run-once'],
      { ...env, WORKOUT_RELEASE: 'secret /private/ledger/path' },
      calls.dependencies,
    );
    expect(output).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
      kind: 'suppression_ledger_export_failed',
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'unreleased',
      reason: 'SUPPRESSION_LEDGER_EXPORT_FAILED',
    });
    expect(String(errors.mock.calls[0]?.[0])).not.toContain('secret');
    expect(process.exitCode).toBe(1);
    expect(calls.end).toHaveBeenCalledTimes(2);
    expect(calls.destroy).toHaveBeenCalledTimes(2);
  });
});
