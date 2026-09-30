import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import {
  coordinateSuppressionExport,
  decodeSuppressionHead,
  encodeSuppressionHead,
  type SuppressionHead,
  type SuppressionRemoteStore,
  type VersionedObject,
} from '../src/restore-suppression-coordinator.js';

const enabled = process.env['TEST_PGOUTPUT_CONTRACT'] === '1';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (enabled && !adminUrl) throw new Error('pgoutput test needs a disposable database');
const pool = enabled ? new Pool({ connectionString: adminUrl }) : null;
const slotName = `wm_suppression_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const encryptionKey = Buffer.alloc(32, 23);
const headAuthenticationKey = Buffer.alloc(32, 91);
const encryptionKeyId = 'synthetic-coordinator-key';

function admin(): Pool {
  if (!pool) throw new Error('pgoutput test pool unavailable');
  return pool;
}

class SyntheticVersionedStore implements SuppressionRemoteStore {
  private sequence = 0;
  private head: VersionedObject | null = null;
  private readonly segments = new Map<string, Buffer>();
  failAt: 'none' | 'beforePut' | 'afterPut' | 'beforeCas' | 'afterCas' = 'none';
  puts = 0;

  seed(head: SuppressionHead): void {
    this.head = { bytes: encodeSuppressionHead(head, headAuthenticationKey), versionId: 'head-0' };
  }

  readHead(): Promise<VersionedObject | null> {
    return Promise.resolve(
      this.head && {
        bytes: Buffer.from(this.head.bytes),
        versionId: this.head.versionId,
      },
    );
  }

  readSegment(segmentId: string, versionId: string): Promise<VersionedObject | null> {
    const bytes = this.segments.get(`${segmentId}/${versionId}`);
    return Promise.resolve(bytes ? { bytes: Buffer.from(bytes), versionId } : null);
  }

  putImmutableSegment(bytes: Buffer): Promise<{ segmentId: string; versionId: string }> {
    if (this.failAt === 'beforePut') throw new Error('synthetic put failed');
    const segmentId = `segment-${++this.sequence}`;
    const versionId = `version-${this.sequence}`;
    this.segments.set(`${segmentId}/${versionId}`, Buffer.from(bytes));
    this.puts++;
    if (this.failAt === 'afterPut') throw new Error('response lost after put');
    return Promise.resolve({ segmentId, versionId });
  }

  compareAndSetHead(expectedVersionId: string, bytes: Buffer): Promise<{ versionId: string }> {
    if (this.head?.versionId !== expectedVersionId) throw new Error('head conflict');
    if (this.failAt === 'beforeCas') throw new Error('synthetic CAS conflict');
    const versionId = `head-${++this.sequence}`;
    this.head = { bytes: Buffer.from(bytes), versionId };
    if (this.failAt === 'afterCas') throw new Error('response lost after CAS');
    return Promise.resolve({ versionId });
  }

  corruptCurrentSegment(): void {
    const head = this.head && decodeSuppressionHead(this.head.bytes, headAuthenticationKey);
    if (!head?.segment) throw new Error('missing segment');
    const key = `${head.segment.segmentId}/${head.segment.versionId}`;
    const bytes = this.segments.get(key);
    if (!bytes) throw new Error('missing bytes');
    const last = bytes.length - 1;
    if (bytes[last] === undefined) throw new Error('empty segment');
    bytes[last] ^= 1;
  }

  corruptHead(): void {
    if (!this.head) throw new Error('missing head');
    const last = this.head.bytes.length - 1;
    if (this.head.bytes[last] === undefined) throw new Error('empty head');
    this.head.bytes[last] ^= 1;
  }
}

async function position(): Promise<string> {
  const result = await admin().query<{ confirmed_flush_lsn: string }>(
    'SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name=$1',
    [slotName],
  );
  return result.rows[0]?.confirmed_flush_lsn ?? '';
}

async function event(): Promise<void> {
  const athleteId = randomUUID();
  const client = await admin().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    await client.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [athleteId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!enabled)('versioned suppression coordinator and ACK crash windows', () => {
  let clusterId = '';
  let initial = '';
  const store = new SyntheticVersionedStore();

  beforeAll(async () => {
    if (!adminUrl) throw new Error('missing admin URL');
    await migrate(adminUrl);
    initial =
      (
        await admin().query<{ lsn: string }>(
          'SELECT lsn::text FROM pg_create_logical_replication_slot($1,$2)',
          [slotName, 'pgoutput'],
        )
      ).rows[0]?.lsn ?? '';
    clusterId =
      (
        await admin().query<{ system_identifier: string }>(
          'SELECT system_identifier::text FROM pg_control_system()',
        )
      ).rows[0]?.system_identifier ?? '';
    store.seed({
      formatVersion: 1,
      clusterId,
      slotName,
      throughLsn: initial,
      localHash: null,
      segment: null,
    });
  });

  afterAll(async () => {
    await admin()
      .query('SELECT pg_drop_replication_slot($1)', [slotName])
      .catch(() => undefined);
    await admin().end();
  });

  const run = (remoteStore: SuppressionRemoteStore = store) =>
    coordinateSuppressionExport({
      pool: admin(),
      store: remoteStore,
      slotName,
      expectedClusterId: clusterId,
      encryptionKey,
      encryptionKeyId,
      headAuthenticationKey,
    });

  it('handles before-put, after-put, after-head and after-ACK retry windows', async () => {
    expect((await run()).throughLsn).toBe(initial);
    await expect(
      run({
        readHead: async () => null,
        readSegment: (id, version) => store.readSegment(id, version),
        putImmutableSegment: (bytes) => store.putImmutableSegment(bytes),
        compareAndSetHead: (version, bytes) => store.compareAndSetHead(version, bytes),
      }),
    ).rejects.toThrow('SUPPRESSION_REMOTE_COORDINATION_FAILED');
    expect(await position()).toBe(initial);
    await event();
    store.failAt = 'beforePut';
    await expect(run()).rejects.toThrow('SUPPRESSION_REMOTE_COORDINATION_FAILED');
    expect(await position()).toBe(initial);
    expect((await store.readHead())?.versionId).toBe('head-0');

    store.failAt = 'afterPut';
    await expect(run()).rejects.toThrow('SUPPRESSION_REMOTE_COORDINATION_FAILED');
    expect(await position()).toBe(initial);
    expect((await store.readHead())?.versionId).toBe('head-0');

    store.failAt = 'beforeCas';
    await expect(run()).rejects.toThrow('SUPPRESSION_REMOTE_COORDINATION_FAILED');
    expect(await position()).toBe(initial);
    expect((await store.readHead())?.versionId).toBe('head-0');

    store.failAt = 'afterCas';
    await expect(run()).rejects.toThrow('SUPPRESSION_REMOTE_COORDINATION_FAILED');
    expect(await position()).toBe(initial);
    const pending = await store.readHead();
    if (!pending) throw new Error('missing pending head');
    const pendingHead = decodeSuppressionHead(pending.bytes, headAuthenticationKey);
    expect(pendingHead.throughLsn).not.toBe(initial);
    await event(); // A later commit must not be included in the pending segment's ACK.

    store.failAt = 'none';
    const putsBeforeReconcile = store.puts;
    const recovered = await run();
    expect(recovered).toEqual(pendingHead);
    expect(store.puts).toBe(putsBeforeReconcile);
    expect(await position()).toBe(recovered.throughLsn);

    // The pending later commit is exported only on a subsequent run.
    const next = await run();
    expect(next.segment?.fromLsn).toBe(recovered.throughLsn);
    expect(next.segment?.previousHash).toBe(recovered.localHash);
    expect(store.puts).toBe(putsBeforeReconcile + 1);
    expect(await position()).toBe(next.throughLsn);

    // The caller may lose the success response after slot ACK. Repeating it is a read-only no-op.
    const again = await run();
    expect(again).toEqual(next);
    expect(store.puts).toBe(putsBeforeReconcile + 1);
    expect(await position()).toBe(next.throughLsn);
  });

  it('continues the cluster/slot/local-hash chain and rejects corrupted exact versions', async () => {
    const prior = await run();
    await event();
    const next = await run();
    expect(next.segment?.fromLsn).toBe(prior.throughLsn);
    expect(next.segment?.previousHash).toBe(prior.localHash);
    expect(next.clusterId).toBe(clusterId);
    expect(next.slotName).toBe(slotName);
    expect(next.localHash).toMatch(/^[a-f0-9]{64}$/);
    expect(next.segment?.sha256).toBeDefined();
    store.corruptCurrentSegment();
    const before = await position();
    await expect(run()).rejects.toThrow('SUPPRESSION_REMOTE_COORDINATION_FAILED');
    expect(await position()).toBe(before);
    // The head MAC itself is independently checked against the supplied key.
    store.corruptHead();
    await expect(run()).rejects.toThrow('SUPPRESSION_REMOTE_COORDINATION_FAILED');
    expect(await position()).toBe(before);
  });
});
