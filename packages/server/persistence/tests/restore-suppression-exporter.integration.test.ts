import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import {
  exportSuppressionSegment,
  type VerifiedRemoteSegment,
} from '../src/restore-suppression-exporter.js';
import { decryptReplaySegment } from '../src/restore-suppression-segment.js';

const enabled = process.env['TEST_PGOUTPUT_CONTRACT'] === '1';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (enabled && !adminUrl) throw new Error('pgoutput test needs a disposable database');
const pool = enabled ? new Pool({ connectionString: adminUrl }) : null;
const slot = `wm_suppression_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const key = Buffer.alloc(32, 18);
const keyId = 'synthetic-test-key';

function admin(): Pool {
  if (!pool) throw new Error('pgoutput test pool unavailable');
  return pool;
}

async function position(): Promise<string> {
  const result = await admin().query<{ confirmed_flush_lsn: string }>(
    'SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name=$1',
    [slot],
  );
  const value = result.rows[0]?.confirmed_flush_lsn;
  if (!value) throw new Error('missing slot position');
  return value;
}

async function event(): Promise<void> {
  const tenant = randomUUID();
  const client = await admin().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    await client.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [tenant]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function receipt(bytes: Buffer): VerifiedRemoteSegment {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    segmentId: `segment-${randomUUID()}`,
    versionId: `version-${randomUUID()}`,
  };
}

describe.skipIf(!enabled)('suppression exporter remote ACK boundary', () => {
  let clusterId = '';
  let original = '';

  beforeAll(async () => {
    expect((await admin().query<{ wal_level: string }>('SHOW wal_level')).rows[0]?.wal_level).toBe(
      'logical',
    );
    if (!adminUrl) throw new Error('missing admin URL');
    await migrate(adminUrl);
    original =
      (
        await admin().query<{ lsn: string }>(
          'SELECT lsn::text FROM pg_create_logical_replication_slot($1,$2)',
          [slot, 'pgoutput'],
        )
      ).rows[0]?.lsn ?? '';
    clusterId =
      (
        await admin().query<{ system_identifier: string }>(
          'SELECT system_identifier::text FROM pg_control_system()',
        )
      ).rows[0]?.system_identifier ?? '';
    expect(await position()).toBe(original);
  });

  afterAll(async () => {
    await admin()
      .query('SELECT pg_drop_replication_slot($1)', [slot])
      .catch(() => undefined);
    await admin().end();
  });

  it('refuses absent events, wrong cluster, remote failure and uncertain or mismatched receipts', async () => {
    const store = async (bytes: Buffer): Promise<unknown> => receipt(bytes);
    const run = (override: Partial<Parameters<typeof exportSuppressionSegment>[0]> = {}) =>
      exportSuppressionSegment({
        pool: admin(),
        slotName: slot,
        expectedClusterId: clusterId,
        expectedFromLsn: original,
        previousHash: null,
        key,
        keyId,
        storeVerifiedCiphertext: store,
        ...override,
      });
    await expect(run()).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
    await admin().query('CREATE TABLE public.exporter_unrelated_probe (id integer PRIMARY KEY)');
    await admin().query('INSERT INTO public.exporter_unrelated_probe VALUES (1)');
    await expect(run()).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
    expect(await position()).toBe(original);
    await event();
    await expect(run({ expectedClusterId: '123456789' })).rejects.toThrow(
      'SUPPRESSION_EXPORT_FAILED',
    );
    await expect(
      run({
        storeVerifiedCiphertext: async () => {
          throw new Error('response lost after put');
        },
      }),
    ).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
    await expect(run({ storeVerifiedCiphertext: async () => null })).rejects.toThrow(
      'SUPPRESSION_EXPORT_FAILED',
    );
    await expect(
      run({
        storeVerifiedCiphertext: async (bytes) => ({ ...receipt(bytes), sha256: '0'.repeat(64) }),
      }),
    ).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
    await expect(
      run({
        storeVerifiedCiphertext: async (bytes) => {
          const originalReceipt = receipt(bytes);
          const last = bytes.length - 1;
          if (bytes[last] === undefined) throw new Error('empty encrypted segment');
          bytes[last] ^= 1;
          return originalReceipt;
        },
      }),
    ).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
    expect(await position()).toBe(original);
  });

  it('retries after a response-lost put and advances only to the verified committed end', async () => {
    const remote = new Map<string, Buffer>();
    const before = await position();
    let handedCiphertext = false;
    const result = await exportSuppressionSegment({
      pool: admin(),
      slotName: slot,
      expectedClusterId: clusterId,
      expectedFromLsn: before,
      previousHash: null,
      key,
      keyId,
      storeVerifiedCiphertext: async (bytes) => {
        const digest = createHash('sha256').update(bytes).digest('hex');
        expect(bytes.includes(Buffer.from('tenant_erased'))).toBe(false);
        remote.set(digest, Buffer.from(bytes));
        handedCiphertext = true;
        await event(); // This commit must remain after the exported segment's end.
        await expect(
          exportSuppressionSegment({
            pool: admin(),
            slotName: slot,
            expectedClusterId: clusterId,
            expectedFromLsn: before,
            previousHash: null,
            key,
            keyId,
            storeVerifiedCiphertext: async (other) => receipt(other),
          }),
        ).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
        const saved = remote.get(digest);
        if (!saved || !saved.equals(bytes)) throw new Error('remote verification failed');
        return receipt(saved);
      },
    });
    expect(handedCiphertext).toBe(true);
    expect(result.fromLsn).toBe(before);
    expect(await position()).toBe(result.throughLsn);
    const saved = remote.get(result.remote.sha256);
    if (!saved) throw new Error('missing saved segment');
    const envelope = decryptReplaySegment({ bytes: saved, key, expectedKeyId: keyId });
    expect(envelope.fromLsn).toBe(before);
    expect(envelope.throughLsn).toBe(result.throughLsn);
    expect(envelope.transactions.flatMap((transaction) => transaction.records)).toHaveLength(1);
    expect(result.localHash).toBe(envelope.sha256);

    const second = await exportSuppressionSegment({
      pool: admin(),
      slotName: slot,
      expectedClusterId: clusterId,
      expectedFromLsn: result.throughLsn,
      previousHash: result.localHash,
      key,
      keyId,
      storeVerifiedCiphertext: async (bytes) => receipt(bytes),
    });
    expect(second.fromLsn).toBe(result.throughLsn);
    expect(second.throughLsn).not.toBe(result.throughLsn);
    expect(await position()).toBe(second.throughLsn);
    await expect(
      exportSuppressionSegment({
        pool: admin(),
        slotName: slot,
        expectedClusterId: clusterId,
        expectedFromLsn: before,
        previousHash: null,
        key,
        keyId,
        storeVerifiedCiphertext: async (bytes) => receipt(bytes),
      }),
    ).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
    expect(await position()).toBe(second.throughLsn);
  });

  it('shows PostgreSQL can return a position below an advance target', async () => {
    const probeSlot = `wm_suppression_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await admin().query('SELECT * FROM pg_create_logical_replication_slot($1,$2)', [
      probeSlot,
      'pgoutput',
    ]);
    try {
      const result = await admin().query<{ end_lsn: string }>(
        'SELECT end_lsn::text FROM pg_replication_slot_advance($1,$2::pg_lsn)',
        [probeSlot, 'FFFFFFFF/FFFFFFFF'],
      );
      expect(result.rows[0]?.end_lsn).not.toBe('FFFFFFFF/FFFFFFFF');
    } finally {
      await admin().query('SELECT pg_drop_replication_slot($1)', [probeSlot]);
    }
  });
});
