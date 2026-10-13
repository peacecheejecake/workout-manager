import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { S3Client } from '@aws-sdk/client-s3';
import { installCurrentRuntimeV10 } from '@workout/server-persistence/current-runtime-installation-v10';
import {
  galleryProfile27MembersV1,
  readGalleryMemberSourceV1,
} from '@workout/server-persistence/gallery-profile27-members-v1';
import { migrate } from '@workout/server-persistence/migrate';
import { exportAuthenticatedSuppressionSegmentForInstalledDomain } from '@workout/server-persistence/restore-suppression-exporter';
import { decodeSuppressionHeadV7 } from '@workout/server-persistence/restore-suppression-replay-v7';
import {
  createSuppressionReplayVerifierV8,
  decodeSuppressionHeadV8,
} from '@workout/server-persistence/restore-suppression-replay-v8';
import {
  decryptReplaySegmentV7,
  decryptReplaySegmentV8,
} from '@workout/server-persistence/restore-suppression-segment';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readSuppressionLedgerKey } from '../src/suppression-ledger-config.js';
import { inspectSuppressionSource } from '../src/suppression-ledger-export.js';
import {
  runSuppressionLedgerOnce,
  type SuppressionLedgerOnceDependencies,
} from '../src/suppression-ledger-once.js';
import { readSuppressionHeadWitness } from '../src/suppression-ledger-witness.js';
import { memoryVersionedBucket } from './suppression-ledger-memory-remote.js';

// Real PostgreSQL 17.6 with wal_level=logical (TEST_PGOUTPUT_CONTRACT=1 and
// TEST_DATABASE_ADMIN_URL). The one-shot worker runs end to end against real sources: a
// profile26-only source exports through V7 (format-2 head), a profile27 source with genuine
// album deletions exports through V8 (format-3 head) and replays into a template-copied
// target, and misconfigured bindings are refused without moving the slot. The remote is an
// in-memory versioned bucket behind the real ledger remote store. Synthetic data only.
const enabled = process.env['TEST_PGOUTPUT_CONTRACT'] === '1';
const adminUrl = enabled ? (process.env['TEST_DATABASE_ADMIN_URL'] ?? '') : '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const p26Name = `ledger_once_p26_${suffix}`;
const p27Name = `ledger_once_p27_${suffix}`;
const targetName = `ledger_once_dst_${suffix}`;
const ownerRole = `ledger_once_owner_${suffix}`;
const p26Slot = `wm_suppression_once26_${suffix}`;
const p27Slot = `wm_suppression_once27_${suffix}`;
const captureId = '3f1e2d4c-5b6a-4789-8abc-def012345678';
const remoteConfig = {
  schemaVersion: 1 as const,
  bucket: 'synthetic-ledger-bucket',
  prefix: 'synthetic/deletion-ledger/v1',
  region: 'ap-northeast-2' as const,
  expectedBucketOwner: '123456789012',
};
const encryptionKey = Buffer.alloc(32, 71);
const authenticationKey = Buffer.alloc(32, 72);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const databases: string[] = [];
const slots: Array<[Pool, string]> = [];
let roleCreated = false;
let admin: Pool, p26: Pool, p27: Pool, p27Owner: Pool, target: Pool, targetOwner: Pool;
let directory = '';
let clusterId = '';

function url(database: string, role?: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${database}`;
  if (role) {
    value.username = role;
    value.password = 'isolated';
  }
  return value.toString();
}
async function inTransaction<T>(pool: Pool, work: (tx: PoolClient) => Promise<T>) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const value = await work(tx);
    await tx.query('COMMIT');
    return value;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}
function ownerTenant<T>(
  pool: Pool,
  athlete: string,
  work: (tx: PoolClient) => Promise<T>,
  fence: 'shared' | 'exclusive' = 'shared',
) {
  return inTransaction(pool, async (tx) => {
    await tx.query(
      fence === 'shared'
        ? 'SELECT pg_advisory_xact_lock_shared(77210,1)'
        : 'SELECT pg_advisory_xact_lock(77210,1)',
    );
    await tx.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    return work(tx);
  });
}
async function waitUntilIdle(name: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const open = await admin.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=$1',
      [name],
    );
    if (Number(open.rows[0]?.total) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('SOURCE_DATABASE_BUSY');
}
async function dropDatabase(name: string) {
  await waitUntilIdle(name).catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}
async function identity(pool: Pool) {
  const row = (
    await pool.query<{ oid: string; system: string; fingerprint: string }>(
      `SELECT (SELECT oid FROM pg_database WHERE datname=current_database())::text AS oid,
         (SELECT system_identifier::text FROM pg_control_system()) AS system,
         encode(sha256(convert_to((SELECT jsonb_agg(jsonb_build_object('version',version,'checksum',checksum) ORDER BY version)::text FROM public.schema_migrations),'UTF8')),'hex') AS fingerprint`,
    )
  ).rows[0];
  if (!row) throw new Error('SOURCE_IDENTITY_MISSING');
  return row;
}
async function slotPosition(pool: Pool, slot: string) {
  const row = (
    await pool.query<{ position: string }>(
      'SELECT confirmed_flush_lsn::text AS position FROM pg_replication_slots WHERE slot_name=$1',
      [slot],
    )
  ).rows[0];
  if (!row) throw new Error('SLOT_MISSING');
  return row.position;
}
async function createAccount(pool: Pool) {
  const row = (
    await pool.query<{ athlete_id: string }>(
      `INSERT INTO identity_private.account(issuer,subject) VALUES('https://issuer.test',$1) RETURNING athlete_id::text`,
      [randomUUID()],
    )
  ).rows[0];
  if (!row) throw new Error('ACCOUNT_MISSING');
  return row.athlete_id;
}
async function albumCall(athlete: string, fn: string, body: unknown) {
  return ownerTenant(p27Owner, athlete, async (tx) => {
    const value = (
      await tx.query(`SELECT public.${fn}($1::jsonb,$2) AS value`, [
        JSON.stringify(body),
        `synthetic-${randomUUID()}`,
      ])
    ).rows[0]?.['value'] as { id?: string; revision: number };
    return value;
  });
}

type Setup = {
  env: Record<string, string>;
  witnessPath: string;
  bucket: ReturnType<typeof memoryVersionedBucket>;
  dependencies: SuppressionLedgerOnceDependencies;
  faults: { crashBeforeAck: boolean; published: boolean };
};
async function setup(
  name: string,
  pool: Pool,
  slot: string,
  profile: 'suppression-physical-v7' | 'suppression-physical-v8',
): Promise<Setup> {
  const live = await identity(pool);
  const state = join(directory, name);
  mkdirSync(state, { mode: 0o700 });
  const witnessPath = join(state, 'head-witness.json');
  const bucket = memoryVersionedBucket(remoteConfig);
  const faults = { crashBeforeAck: false, published: false };
  const dependencies: SuppressionLedgerOnceDependencies = {
    createS3: () => ({ destroy: () => undefined }) as unknown as S3Client,
    createPool: (connectionString) => new Pool({ connectionString, max: 1 }),
    createRemote: () => ({
      client: bucket.client,
      store: {
        ...bucket.store,
        readHead: async () => {
          if (faults.published) {
            // Simulated crash after the head write, before the slot ACK.
            faults.published = false;
            throw new Error('SYNTHETIC_CRASH_BEFORE_ACK');
          }
          return bucket.store.readHead();
        },
        compareAndSetHead: async (expected, bytes) => {
          const changed = await bucket.store.compareAndSetHead(expected, bytes);
          faults.published = faults.crashBeforeAck;
          faults.crashBeforeAck = false;
          return changed;
        },
      },
    }),
    inspectSource: inspectSuppressionSource,
    exportForInstalledDomain: exportAuthenticatedSuppressionSegmentForInstalledDomain,
    readKey: readSuppressionLedgerKey,
  };
  return {
    witnessPath,
    bucket,
    dependencies,
    faults,
    env: {
      SUPPRESSION_LEDGER_EXPORT_ENABLED: 'true',
      SUPPRESSION_LEDGER_BUCKET: remoteConfig.bucket,
      SUPPRESSION_LEDGER_PREFIX: remoteConfig.prefix,
      SUPPRESSION_LEDGER_BUCKET_OWNER: remoteConfig.expectedBucketOwner,
      SUPPRESSION_LEDGER_REGION: remoteConfig.region,
      SUPPRESSION_LEDGER_SLOT_NAME: slot,
      SUPPRESSION_LEDGER_CLUSTER_ID: live.system,
      SUPPRESSION_LEDGER_ENCRYPTION_KEY_ID: 'synthetic-once-key',
      SUPPRESSION_LEDGER_DATABASE_URL: url(name),
      SUPPRESSION_LEDGER_SOURCE_DATABASE_NAME: name,
      SUPPRESSION_LEDGER_SOURCE_DATABASE_OID: live.oid,
      SUPPRESSION_LEDGER_CAPTURE_ID: captureId,
      SUPPRESSION_LEDGER_REGISTRY_FINGERPRINT: live.fingerprint,
      SUPPRESSION_LEDGER_RELATION_PROFILE: profile,
      SUPPRESSION_LEDGER_ENCRYPTION_KEY_FILE: join(directory, 'encryption.key'),
      SUPPRESSION_LEDGER_HEAD_HMAC_KEY_FILE: join(directory, 'head.key'),
      SUPPRESSION_LEDGER_HEAD_WITNESS_FILE: witnessPath,
    },
  };
}
const bootstrap = (s: Setup, env: Record<string, string> = s.env) =>
  runSuppressionLedgerOnce(
    ['--bootstrap-head'],
    { ...env, SUPPRESSION_LEDGER_HEAD_BOOTSTRAP: 'create-initial-head' },
    s.dependencies,
  );
const runOnce = (s: Setup, env: Record<string, string> = s.env) =>
  runSuppressionLedgerOnce(['--run-once'], env, s.dependencies);

describe.skipIf(!enabled).sequential('suppression ledger worker on real logical sources', () => {
  beforeAll(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'wm-ledger-once-it-')));
    writeFileSync(join(directory, 'encryption.key'), encryptionKey, { mode: 0o600 });
    writeFileSync(join(directory, 'head.key'), authenticationKey, { mode: 0o600 });
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    expect((await admin.query('SHOW wal_level')).rows[0]?.['wal_level']).toBe('logical');
    await admin.query(
      `CREATE ROLE "${ownerRole}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    roleCreated = true;
    for (const name of [p26Name, p27Name]) {
      await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
      databases.push(name);
      await migrate(url(name, ownerRole), 107);
      await installCurrentRuntimeV10(url(name, ownerRole));
    }
    // Test-only stand-in for the profile27 installer: pinned 143/144/145 applied raw.
    const members = new Pool({ connectionString: url(p27Name, ownerRole), max: 1 });
    try {
      await inTransaction(members, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
        await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
        for (const member of galleryProfile27MembersV1)
          await tx.query(await readGalleryMemberSourceV1(member));
      });
    } finally {
      await members.end();
    }
    await waitUntilIdle(p27Name);
    await admin.query(`CREATE DATABASE "${targetName}" TEMPLATE "${p27Name}" OWNER "${ownerRole}"`);
    databases.push(targetName);
    p26 = new Pool({ connectionString: url(p26Name), max: 2 });
    p27 = new Pool({ connectionString: url(p27Name), max: 2 });
    p27Owner = new Pool({ connectionString: url(p27Name, ownerRole), max: 2 });
    target = new Pool({ connectionString: url(targetName), max: 1 });
    targetOwner = new Pool({ connectionString: url(targetName, ownerRole), max: 2 });
    clusterId = (await identity(p26)).system;
    for (const [pool, slot] of [
      [p26, p26Slot],
      [p27, p27Slot],
    ] as const) {
      await pool.query('SELECT pg_create_logical_replication_slot($1,$2)', [slot, 'pgoutput']);
      slots.push([pool, slot]);
    }
  }, 600000);

  afterAll(async () => {
    for (const [pool, slot] of slots)
      await pool.query('SELECT pg_drop_replication_slot($1)', [slot]).catch(() => undefined);
    for (const pool of [p26, p27, p27Owner, target, targetOwner])
      await pool?.end().catch(() => undefined);
    for (const name of databases.reverse()) await dropDatabase(name).catch(() => undefined);
    if (roleCreated) await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
    await admin?.end();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }, 60000);

  it('exports a profile26-only source through V7 with a format-2 head', async () => {
    const s = await setup(p26Name, p26, p26Slot, 'suppression-physical-v7');
    // A V8 binding on a profile26-era source is refused before any head exists.
    await expect(
      bootstrap(s, { ...s.env, SUPPRESSION_LEDGER_RELATION_PROFILE: 'suppression-physical-v8' }),
    ).rejects.toThrow('SUPPRESSION_LEDGER_SOURCE_MISMATCH');
    expect(s.bucket.latest(s.bucket.headKey)).toBeNull();

    const initialLsn = await slotPosition(p26, p26Slot);
    await expect(bootstrap(s)).resolves.toEqual({
      outcome: 'bootstrap_created',
      relationProfile: 'suppression-physical-v7',
    });
    await expect(runOnce(s)).resolves.toMatchObject({ outcome: 'no_new_records' });

    // Synthetic record-1 facts written directly (the decoder checks their semantics).
    const athlete = await createAccount(p26);
    for (const id of [randomUUID(), randomUUID()])
      await p26.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at)
         VALUES($1,'course_deleted',$2,now())`,
        [athlete, id],
      );
    const expectedEvents = (
      await p26.query<{ event_id: string }>(
        'SELECT event_id::text FROM restore_suppression_event WHERE athlete_id=$1 ORDER BY event_id',
        [athlete],
      )
    ).rows.map((row) => row.event_id);
    expect(expectedEvents.length).toBeGreaterThan(0);
    await expect(runOnce(s)).resolves.toEqual({
      outcome: 'exported',
      relationProfile: 'suppression-physical-v7',
    });
    const published = s.bucket.latest(s.bucket.headKey);
    const head = decodeSuppressionHeadV7(published?.bytes ?? Buffer.alloc(0), authenticationKey);
    expect(head).toMatchObject({
      formatVersion: 2,
      clusterId,
      fromLsn: initialLsn,
      source: { relationProfile: 'suppression-physical-v7', databaseName: p26Name, captureId },
    });
    expect(head.segments).toHaveLength(1);
    expect(await slotPosition(p26, p26Slot)).toBe(head.throughLsn);
    expect(readSuppressionHeadWitness(s.witnessPath)).toMatchObject({
      headVersionId: published?.versionId,
      headSha256: sha(published?.bytes ?? Buffer.alloc(0)),
      pendingHeadSha256: null,
    });
    const segment = await s.bucket.store.readSegment(
      head.segments[0]?.segmentId ?? '',
      head.segments[0]?.versionId ?? '',
    );
    const envelope = decryptReplaySegmentV7({
      bytes: segment?.bytes ?? Buffer.alloc(0),
      key: encryptionKey,
      expectedKeyId: 'synthetic-once-key',
    });
    expect(
      envelope.transactions
        .flatMap((tx) => tx.records)
        .map((record) => record.eventId)
        .sort(),
    ).toEqual(expectedEvents);
    await expect(runOnce(s)).resolves.toMatchObject({ outcome: 'no_new_records' });

    // A crash after the head publish and before the slot ACK: the next run reconciles the
    // slot to the authenticated head (no second segment), then the chain continues.
    await p26.query(
      `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at)
       VALUES($1,'course_deleted',$2,now())`,
      [athlete, randomUUID()],
    );
    const beforeCrash = await slotPosition(p26, p26Slot);
    s.faults.crashBeforeAck = true;
    await expect(runOnce(s)).rejects.toThrow('SUPPRESSION_LEDGER_EXPORT_FAILED');
    expect(await slotPosition(p26, p26Slot)).toBe(beforeCrash);
    const ahead = decodeSuppressionHeadV7(
      s.bucket.latest(s.bucket.headKey)?.bytes ?? Buffer.alloc(0),
      authenticationKey,
    );
    expect(ahead.segments).toHaveLength(2);
    await expect(runOnce(s)).resolves.toMatchObject({ outcome: 'reconciled' });
    expect(await slotPosition(p26, p26Slot)).toBe(ahead.throughLsn);
    expect(s.bucket.segmentCount()).toBe(2);
    await expect(runOnce(s)).resolves.toMatchObject({ outcome: 'no_new_records' });

    // An empty run is not a success once a head-referenced segment is gone remotely.
    const atHead = await slotPosition(p26, p26Slot);
    s.bucket.removeKey(`${remoteConfig.prefix}/segments/${ahead.segments[0]?.segmentId}.bin`);
    await expect(runOnce(s)).rejects.toThrow('SUPPRESSION_LEDGER_REMOTE_CHAIN_UNVERIFIED');
    expect(await slotPosition(p26, p26Slot)).toBe(atHead);
  });

  it('refuses misconfigured bindings on a profile27 source without advancing the slot, then exports V8 and replays', async () => {
    const s = await setup(p27Name, p27, p27Slot, 'suppression-physical-v8');
    const athlete = await createAccount(p27);
    const first = await albumCall(athlete, 'create_gallery_album_v1', { title: '합성 앨범' });
    const second = await albumCall(athlete, 'create_gallery_album_v1', { title: '두 번째' });
    const backup = (
      await p27.query(
        `SELECT athlete_id,id,title,revision,created_at,updated_at FROM public.gallery_album WHERE id=$1`,
        [first.id],
      )
    ).rows[0];
    const slotBefore = await slotPosition(p27, p27Slot);

    // Bootstrap refuses a V7 binding on the installed V8 domain: no head, no witness.
    await expect(
      bootstrap(s, { ...s.env, SUPPRESSION_LEDGER_RELATION_PROFILE: 'suppression-physical-v7' }),
    ).rejects.toThrow('SUPPRESSION_LEDGER_SOURCE_MISMATCH');
    expect(s.bucket.latest(s.bucket.headKey)).toBeNull();
    expect(readSuppressionHeadWitness(s.witnessPath)).toBeNull();
    await expect(bootstrap(s)).resolves.toMatchObject({ outcome: 'bootstrap_created' });
    const initial = s.bucket.latest(s.bucket.headKey);

    const deleted = [
      {
        id: first.id,
        revision: (
          await albumCall(athlete, 'delete_gallery_album_v1', {
            albumId: first.id,
            expectedRevision: 1,
          })
        ).revision,
      },
      {
        id: second.id,
        revision: (
          await albumCall(athlete, 'delete_gallery_album_v1', {
            albumId: second.id,
            expectedRevision: 1,
          })
        ).revision,
      },
    ];

    for (const [key, value, code] of [
      ['SUPPRESSION_LEDGER_RELATION_PROFILE', 'suppression-physical-v7', 'SOURCE_MISMATCH'],
      ['SUPPRESSION_LEDGER_SOURCE_DATABASE_OID', '4294967295', 'SOURCE_MISMATCH'],
      ['SUPPRESSION_LEDGER_REGISTRY_FINGERPRINT', '0'.repeat(64), 'SOURCE_MISMATCH'],
      ['SUPPRESSION_LEDGER_CLUSTER_ID', '1', 'SOURCE_MISMATCH'],
      [
        'SUPPRESSION_LEDGER_CAPTURE_ID',
        '00000000-0000-4000-8000-000000000000',
        'HEAD_WITNESS_FAILED',
      ],
    ] as const) {
      await expect(runOnce(s, { ...s.env, [key]: value })).rejects.toThrow(
        `SUPPRESSION_LEDGER_${code}`,
      );
      expect(await slotPosition(p27, p27Slot)).toBe(slotBefore);
      expect(s.bucket.latest(s.bucket.headKey)?.versionId).toBe(initial?.versionId);
      expect(s.bucket.segmentCount()).toBe(0);
    }

    await expect(runOnce(s)).resolves.toEqual({
      outcome: 'exported',
      relationProfile: 'suppression-physical-v8',
    });
    const published = s.bucket.latest(s.bucket.headKey);
    const head = decodeSuppressionHeadV8(published?.bytes ?? Buffer.alloc(0), authenticationKey);
    expect(head).toMatchObject({ formatVersion: 3, fromLsn: slotBefore, clusterId });
    expect(head.segments).toHaveLength(1);
    expect(await slotPosition(p27, p27Slot)).toBe(head.throughLsn);
    const segment = await s.bucket.store.readSegment(
      head.segments[0]?.segmentId ?? '',
      head.segments[0]?.versionId ?? '',
    );
    expect(segment?.bytes.subarray(0, 8).toString()).toBe('WMLEDG03');
    const envelope = decryptReplaySegmentV8({
      bytes: segment?.bytes ?? Buffer.alloc(0),
      key: encryptionKey,
      expectedKeyId: 'synthetic-once-key',
    });
    expect(
      envelope.transactions
        .flatMap((tx) => tx.records)
        .map((r) => (r.schemaVersion === 8 ? [r.targetId, r.galleryAccessRevision] : r)),
    ).toEqual(deleted.map((a) => [a.id, a.revision]));
    await expect(runOnce(s)).resolves.toMatchObject({ outcome: 'no_new_records' });

    // Verify the published chain and replay it into the template-copied target.
    const verifier = createSuppressionReplayVerifierV8({
      witness: {
        source: head.source,
        clusterId,
        fromLsn: head.fromLsn,
        throughLsn: head.throughLsn,
        previousHash: null,
        finalLocalHash: head.finalLocalHash ?? '',
        headVersionId: published?.versionId ?? '',
        headSha256: sha(published?.bytes ?? Buffer.alloc(0)),
      },
      encryptionKey,
      keyId: 'synthetic-once-key',
      headAuthenticationKey: authenticationKey,
    });
    await targetOwner.query(
      `INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,'https://issuer.test',$2)`,
      [athlete, randomUUID()],
    );
    await ownerTenant(
      targetOwner,
      athlete,
      async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77206))', [athlete]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
        await tx.query(
          `INSERT INTO public.gallery_album(athlete_id,id,title,revision,created_at,updated_at,deleted_at)
           VALUES($1,$2,$3,$4,$5,$6,NULL)`,
          [
            backup?.['athlete_id'],
            backup?.['id'],
            backup?.['title'],
            backup?.['revision'],
            backup?.['created_at'],
            backup?.['updated_at'],
          ],
        );
      },
      'exclusive',
    );
    const prepared = await verifier.prepareVerifiedSuppressionChainV8(s.bucket.store);
    expect(prepared).toMatchObject({ eventCount: 2, originalEventStage: 'exact_replay' });
    expect(
      await inTransaction(targetOwner, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
        return verifier.replayVerifiedSuppressionChainV8In(tx, prepared);
      }),
    ).toEqual({ status: 'replayed', eventCount: 2, authority: 'none', admissionAllowed: false });
    const events = (pool: Pool) =>
      pool
        .query(
          `SELECT event_id::text,record_version,kind,target_id::text,gallery_access_revision,occurred_at
           FROM public.restore_suppression_event WHERE athlete_id=$1 ORDER BY event_id`,
          [athlete],
        )
        .then((r) => r.rows);
    expect(await events(target)).toEqual(await events(p27));
    expect(
      (
        await target.query(
          `SELECT album_id::text,outcome FROM public.restore_gallery_album_replay_receipt WHERE athlete_id=$1 ORDER BY album_id`,
          [athlete],
        )
      ).rows,
    ).toEqual(
      [
        { album_id: first.id, outcome: 'deleted' },
        { album_id: second.id, outcome: 'recorded_absent' },
      ].sort((a, b) => (a.album_id ?? '').localeCompare(b.album_id ?? '')),
    );
  });
});
