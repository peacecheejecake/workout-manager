import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { installCurrentRuntimeV10 } from '../src/current-runtime-installation-v10.js';
import type { SuppressionRemoteStore } from '../src/restore-suppression-coordinator.js';
import {
  exportAuthenticatedSuppressionSegmentForInstalledDomain,
  exportAuthenticatedSuppressionSegmentV7,
  exportAuthenticatedSuppressionSegmentV8,
  readSuppressionRelationProfileIn,
} from '../src/restore-suppression-exporter.js';
import { encodeSuppressionHeadV7 } from '../src/restore-suppression-replay-v7.js';
import {
  createSuppressionReplayVerifierV8,
  decodeSuppressionHeadV8,
  encodeSuppressionHeadV8,
} from '../src/restore-suppression-replay-v8.js';
import {
  decryptReplaySegmentV8,
  type SuppressionSourceBindingV7,
  type SuppressionSourceBindingV8,
} from '../src/restore-suppression-segment.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import { installProfile26WithGalleryMembers } from './gallery-profile27-fixture.js';

// Real PostgreSQL 17.6, wal_level=logical. A profile27 source (profile26 V10 + pinned
// 143/144/145) with genuine album deletions exports through the explicit V8 exporter into an
// authenticated format-3 head, verifies and replays into a template-copied target. A V7
// exporter on the same slot fails closed without advancing it; a profile26-era source keeps
// the V7 domain and refuses V8. Synthetic data and in-memory remote store only.
const enabled = process.env['TEST_PGOUTPUT_CONTRACT'] === '1';
const adminUrl = enabled ? z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']) : '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const sourceName = `p27_export_src_${suffix}`;
const targetName = `p27_export_dst_${suffix}`;
const legacyName = `p27_export_p26_${suffix}`;
const ownerRole = `p27_export_owner_${suffix}`;
const slot = `wm_suppression_p27x_${suffix}`;
const keyId = 'synthetic-v8-local-key';
const encryptionKey = Buffer.alloc(32, 61);
const authenticationKey = Buffer.alloc(32, 62);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const databases: string[] = [];
let roleCreated = false;
let slotCreated = false;
let admin: Pool, owner: Pool, control: Pool, targetOwner: Pool, targetControl: Pool;
let clusterId = '';
let slotLsn = '';
let fingerprint = '';
let databaseOid = 0;

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
function memoryStore(initialHead: Buffer) {
  let headBytes = Buffer.from(initialHead);
  let headVersion = 'head-0';
  let sequence = 0;
  const objects = new Map<string, { bytes: Buffer; versionId: string }>();
  const store: SuppressionRemoteStore = {
    readHead: async () => ({ bytes: Buffer.from(headBytes), versionId: headVersion }),
    putImmutableSegment: async (bytes) => {
      const segmentId = `segment-${++sequence}`;
      const versionId = `immutable-${sequence}`;
      objects.set(segmentId, { bytes: Buffer.from(bytes), versionId });
      return { segmentId, versionId };
    },
    readSegment: async (id, version) => {
      const object = objects.get(id);
      return object && object.versionId === version
        ? { bytes: Buffer.from(object.bytes), versionId: object.versionId }
        : null;
    },
    compareAndSetHead: async (expected, bytes) => {
      if (expected !== headVersion) throw Error('SYNTHETIC_CAS_CONFLICT');
      headVersion = `head-${++sequence}`;
      headBytes = Buffer.from(bytes);
      return { versionId: headVersion };
    },
  };
  return {
    store,
    head: () => ({ bytes: Buffer.from(headBytes), versionId: headVersion }),
    segments: () => objects.size,
  };
}
async function slotPosition() {
  const r = await control.query<{ position: string }>(
    'SELECT confirmed_flush_lsn::text AS position FROM pg_replication_slots WHERE slot_name=$1',
    [slot],
  );
  return z.string().parse(r.rows[0]?.position);
}
async function createAlbum(athlete: string, title: string) {
  return ownerTenant(owner, athlete, async (tx) =>
    z
      .object({ id: z.string(), revision: z.number() })
      .parse(
        (
          await tx.query('SELECT public.create_gallery_album_v1($1::jsonb,$2) AS value', [
            JSON.stringify({ title }),
            `synthetic-${randomUUID()}`,
          ])
        ).rows[0]?.['value'],
      ),
  );
}
async function deleteAlbum(athlete: string, albumId: string, expectedRevision: number) {
  return ownerTenant(owner, athlete, async (tx) =>
    z
      .object({ revision: z.number() })
      .parse(
        (
          await tx.query('SELECT public.delete_gallery_album_v1($1::jsonb,$2) AS value', [
            JSON.stringify({ albumId, expectedRevision }),
            `synthetic-${randomUUID()}`,
          ])
        ).rows[0]?.['value'],
      ),
  );
}
const binding = <P extends 'suppression-physical-v7' | 'suppression-physical-v8'>(
  relationProfile: P,
) => ({
  databaseName: sourceName,
  databaseOid,
  slotName: slot,
  publication: 'workout_restore_suppression_events' as const,
  relationProfile,
  captureId: '7c0d9a5e-2b1f-4c3d-8e9f-0a1b2c3d4e5f',
  registryFingerprint: fingerprint,
});

describe.skipIf(!enabled).sequential('V8 suppression exporter on a profile27 source', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    expect((await admin.query('SHOW wal_level')).rows[0]?.['wal_level']).toBe('logical');
    await admin.query(
      `CREATE ROLE "${ownerRole}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    roleCreated = true;
    for (const name of [sourceName, legacyName]) {
      await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
      databases.push(name);
      await migrate(url(name, ownerRole), 107);
    }
    await installCurrentRuntimeV10(url(legacyName, ownerRole));
    await installProfile26WithGalleryMembers(url(sourceName, ownerRole));
    await waitUntilIdle(sourceName);
    await admin.query(
      `CREATE DATABASE "${targetName}" TEMPLATE "${sourceName}" OWNER "${ownerRole}"`,
    );
    databases.push(targetName);
    owner = new Pool({ connectionString: url(sourceName, ownerRole), max: 2 });
    control = new Pool({ connectionString: url(sourceName), max: 2 });
    targetOwner = new Pool({ connectionString: url(targetName, ownerRole), max: 2 });
    targetControl = new Pool({ connectionString: url(targetName), max: 1 });
    const identity = (
      await control.query<{ oid: number; system: string; fingerprint: string }>(
        `SELECT (SELECT oid FROM pg_database WHERE datname=current_database())::int AS oid,
          (SELECT system_identifier::text FROM pg_control_system()) AS system,
          encode(sha256(convert_to((SELECT jsonb_agg(jsonb_build_object('version',version,'checksum',checksum) ORDER BY version)::text FROM public.schema_migrations),'UTF8')),'hex') AS fingerprint`,
      )
    ).rows[0];
    if (!identity) throw new Error('SOURCE_IDENTITY_MISSING');
    databaseOid = identity.oid;
    clusterId = identity.system;
    fingerprint = identity.fingerprint;
    const created = await control.query<{ lsn: string }>(
      'SELECT lsn::text FROM pg_create_logical_replication_slot($1,$2)',
      [slot, 'pgoutput'],
    );
    slotCreated = true;
    slotLsn = z.string().parse(created.rows[0]?.lsn);
  }, 600000);
  afterAll(async () => {
    if (slotCreated)
      await control.query('SELECT pg_drop_replication_slot($1)', [slot]).catch(() => undefined);
    for (const pool of [owner, control, targetOwner, targetControl])
      await pool?.end().catch(() => undefined);
    for (const name of databases.reverse()) await dropIsolatedDatabase(admin, name);
    if (roleCreated) await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
    await admin?.end();
  }, 60000);

  it('selects the codec from the installed record domain, never by fallback', async () => {
    const legacy = new Pool({ connectionString: url(legacyName), max: 1 });
    try {
      const client = await legacy.connect();
      try {
        expect(await readSuppressionRelationProfileIn(client)).toBe('suppression-physical-v7');
      } finally {
        client.release();
      }
      // A V8 binding against a profile26-era source is refused before any slot read.
      await expect(
        exportAuthenticatedSuppressionSegmentForInstalledDomain({
          pool: legacy,
          source: { ...binding('suppression-physical-v8'), databaseName: legacyName },
          expectedClusterId: clusterId,
          encryptionKey,
          keyId,
          headAuthenticationKey: authenticationKey,
          store: memoryStore(Buffer.alloc(0)).store,
          expectedHeadVersionId: 'head-0',
          expectedHeadSha256: 'a'.repeat(64),
        }),
      ).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
    } finally {
      await legacy.end();
    }
    const client = await control.connect();
    try {
      expect(await readSuppressionRelationProfileIn(client)).toBe('suppression-physical-v8');
    } finally {
      client.release();
    }
  });

  it('exports genuine album deletions into V8 segments, verifies and replays into the target; V7 fails closed', async () => {
    const athlete = z
      .string()
      .parse(
        (
          await owner.query<{ athlete_id: string }>(
            `INSERT INTO identity_private.account(issuer,subject) VALUES('https://issuer.test',$1) RETURNING athlete_id::text`,
            [randomUUID()],
          )
        ).rows[0]?.athlete_id,
      );
    const first = await createAlbum(athlete, '합성 앨범');
    const second = await createAlbum(athlete, '두 번째');
    const backup = (
      await control.query(
        `SELECT athlete_id,id,title,revision,created_at,updated_at FROM public.gallery_album WHERE id=$1`,
        [first.id],
      )
    ).rows[0];
    const deleted = [
      { id: first.id, revision: (await deleteAlbum(athlete, first.id, 1)).revision },
      { id: second.id, revision: (await deleteAlbum(athlete, second.id, 1)).revision },
    ];

    // V7 exporter and V7 head on the same profile27 slot: refused, slot not advanced.
    const v7Source: SuppressionSourceBindingV7 = binding('suppression-physical-v7');
    const v7Head = encodeSuppressionHeadV7(
      {
        formatVersion: 2,
        source: v7Source,
        clusterId,
        fromLsn: slotLsn,
        throughLsn: slotLsn,
        previousHash: null,
        finalLocalHash: null,
        segments: [],
      },
      authenticationKey,
    );
    const v7 = memoryStore(v7Head);
    const v7Input = {
      pool: control,
      source: v7Source,
      expectedClusterId: clusterId,
      encryptionKey,
      keyId,
      headAuthenticationKey: authenticationKey,
      store: v7.store,
      expectedHeadVersionId: 'head-0',
      expectedHeadSha256: sha(v7Head),
    };
    await expect(exportAuthenticatedSuppressionSegmentV7(v7Input)).rejects.toThrow(
      'SUPPRESSION_EXPORT_FAILED',
    );
    await expect(exportAuthenticatedSuppressionSegmentForInstalledDomain(v7Input)).rejects.toThrow(
      'SUPPRESSION_EXPORT_FAILED',
    );
    expect(v7.segments()).toBe(0);
    expect(v7.head().versionId).toBe('head-0');
    expect(await slotPosition()).toBe(slotLsn);

    // V8 export through the explicit installed-domain selector.
    const source: SuppressionSourceBindingV8 = binding('suppression-physical-v8');
    const initial = encodeSuppressionHeadV8(
      {
        formatVersion: 3,
        source,
        clusterId,
        fromLsn: slotLsn,
        throughLsn: slotLsn,
        previousHash: null,
        finalLocalHash: null,
        segments: [],
      },
      authenticationKey,
    );
    const v8 = memoryStore(initial);
    const exported = await exportAuthenticatedSuppressionSegmentForInstalledDomain({
      ...v7Input,
      source,
      store: v8.store,
      expectedHeadSha256: sha(initial),
    });
    expect(exported).toMatchObject({ slotName: slot, fromLsn: slotLsn, source });
    expect(await slotPosition()).toBe(exported.throughLsn);
    const published = v8.head();
    const head = decodeSuppressionHeadV8(published.bytes, authenticationKey);
    expect(head).toMatchObject({
      formatVersion: 3,
      throughLsn: exported.throughLsn,
      finalLocalHash: exported.localHash,
    });
    expect(head.segments).toHaveLength(1);
    const segment = await v8.store.readSegment(
      head.segments[0]?.segmentId ?? '',
      head.segments[0]?.versionId ?? '',
    );
    expect(segment?.bytes.subarray(0, 8).toString()).toBe('WMLEDG03');
    const envelope = decryptReplaySegmentV8({
      bytes: segment?.bytes ?? Buffer.alloc(0),
      key: encryptionKey,
      expectedKeyId: keyId,
    });
    expect(
      envelope.transactions
        .flatMap((tx) => tx.records)
        .map((r) => (r.schemaVersion === 8 ? [r.targetId, r.galleryAccessRevision] : r)),
    ).toEqual(deleted.map((a) => [a.id, a.revision]));
    // Nothing new: a second V8 export refuses an empty segment and leaves the head alone.
    await expect(
      exportAuthenticatedSuppressionSegmentV8({
        ...v7Input,
        source,
        store: v8.store,
        expectedHeadVersionId: published.versionId,
        expectedHeadSha256: sha(published.bytes),
      }),
    ).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
    expect(v8.head().versionId).toBe(published.versionId);

    // Verify the published chain and replay it into the restored target.
    const verifier = createSuppressionReplayVerifierV8({
      witness: {
        source,
        clusterId,
        fromLsn: head.fromLsn,
        throughLsn: head.throughLsn,
        previousHash: null,
        finalLocalHash: exported.localHash,
        headVersionId: published.versionId,
        headSha256: sha(published.bytes),
      },
      encryptionKey,
      keyId,
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
    const prepared = await verifier.prepareVerifiedSuppressionChainV8(v8.store);
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
    expect(await events(targetControl)).toEqual(await events(control));
    expect(
      (
        await targetControl.query(
          `SELECT album_id::text,outcome FROM public.restore_gallery_album_replay_receipt WHERE athlete_id=$1 ORDER BY album_id`,
          [athlete],
        )
      ).rows,
    ).toEqual(
      [
        { album_id: first.id, outcome: 'deleted' },
        { album_id: second.id, outcome: 'recorded_absent' },
      ].sort((a, b) => a.album_id.localeCompare(b.album_id)),
    );
  });
});
