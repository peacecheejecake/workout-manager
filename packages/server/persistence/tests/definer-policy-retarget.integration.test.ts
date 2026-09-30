import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import {
  grantCourses,
  grantGalleryMedia,
  grantOperations,
  grantResources,
  grantResourceObjectCleanupWorker,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createConsentRepository } from '../src/repositories.js';
import {
  createResourceObjectCleanupRepository,
  processOneResourceObjectCleanup,
  type ResourceObjectCleanupRepository,
} from '../src/resource-object-cleanup.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * M2-01au: the `*_definer` policies (047, 049, 050, 051, the queue-state migration and — M2-01av —
 * the tenant-work index and 066's suppression event) name the role that applied them. When ownership moves — `REASSIGN OWNED`, or a `--no-owner`
 * restore by another role — the new owner's definer functions have no policy: on an owner
 * that is neither superuser nor BYPASSRLS, erasure fails with 42501 and the workers see
 * nothing. `retarget_definer_policies()`, run by the new owner, points every one of them at it
 * and recreates any a `DROP OWNED` removed. Nobody else can run it.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `retarget_${suffix}`;
const firstOwner = `retarget_first_${suffix}`;
const nextOwner = `retarget_next_${suffix}`;
const runtimeRole = `retarget_rt_${suffix}`;
const workerRole = `retarget_worker_${suffix}`;

const definerPolicies = [
  'activity_track_reconcile_state:activity_track_reconcile_state_definer',
  'course_deletion:course_deletion_definer',
  'course_share:course_share_definer',
  'course_share_rate:course_share_rate_definer',
  'course_thumbnail_reconcile_state:course_thumbnail_reconcile_state_definer',
  'object_scope_purge:object_scope_purge_definer',
  'resource_derived_cleanup:resource_derived_cleanup_definer',
  'resource_object_cleanup:resource_object_cleanup_definer',
  'restore_suppression_event:restore_suppression_event_definer',
  'routing_admission:routing_admission_definer',
  'tenant_object_purge:tenant_object_purge_definer',
  'tenant_work_index:tenant_work_index_definer',
];

function urlFor(role: string | null): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  if (role !== null) {
    url.username = role;
    url.password = 'plain';
  }
  return url.toString();
}

let inspect: Pool;
let runtime: Database;
let operations: OperationsRepository;
let worker: ResourceObjectCleanupRepository;

beforeAll(async () => {
  for (const role of [firstOwner, nextOwner, runtimeRole, workerRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE ${database} OWNER "${firstOwner}"`);
  inspect = new Pool({ connectionString: urlFor(null) });
  const ownerUrl = urlFor(firstOwner);
  await migrate(ownerUrl);
  const owner = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${workerRole}"`);
    await owner.query(`GRANT USAGE ON SCHEMA identity_private TO "${runtimeRole}"`);
  } finally {
    await owner.end();
  }
  await grantOperations(ownerUrl, runtimeRole);
  await grantResources(ownerUrl, runtimeRole);
  await grantGalleryMedia(ownerUrl, runtimeRole);
  const consentOwner = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await consentOwner.query(`GRANT SELECT,INSERT,UPDATE ON consent TO "${runtimeRole}"`);
    await consentOwner.query(`GRANT SELECT,INSERT ON command_receipt,outbox TO "${runtimeRole}"`);
  } finally {
    await consentOwner.end();
  }
  await grantCourses(ownerUrl, runtimeRole);
  await grantResourceObjectCleanupWorker(ownerUrl, workerRole);
  runtime = createDatabase({ connectionString: urlFor(runtimeRole), max: 2 });
  operations = createOperationsRepository(runtime);
  worker = createResourceObjectCleanupRepository({ connectionString: urlFor(workerRole), max: 1 });
});

afterAll(async () => {
  await worker?.close();
  await runtime?.close();
  await inspect?.end();
  await dropIsolatedDatabase(admin, database);
  for (const role of [workerRole, runtimeRole, nextOwner, firstOwner]) {
    await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
  }
  await admin.end();
});

async function policyTargets(): Promise<string[]> {
  const rows = await inspect.query<{ entry: string }>(
    `SELECT tablename||':'||policyname||':'||array_to_string(roles,',')||':'||cmd||':'||
       coalesce(qual,'')||':'||coalesce(with_check,'') AS entry
     FROM pg_policies WHERE schemaname='public' AND policyname LIKE '%\\_definer' ORDER BY 1`,
  );
  return rows.rows.map((row) => row.entry);
}

async function retargetAs(role: string): Promise<number> {
  const pool = new Pool({ connectionString: urlFor(role), max: 1 });
  try {
    const result = await pool.query<{ touched: number }>(
      'SELECT public.retarget_definer_policies() AS touched',
    );
    return Number(result.rows[0]?.touched);
  } finally {
    await pool.end();
  }
}

async function erasureEventCount(tenant: string): Promise<number> {
  const result = await inspect.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM restore_suppression_event
       WHERE athlete_id=$1 AND kind='tenant_erased'`,
    [tenant],
  );
  return result.rows[0]?.total ?? 0;
}

async function liveCourseDeletionEventCount(): Promise<number> {
  const tenant = randomUUID();
  const courseId = randomUUID();
  await inspect.query(
    `INSERT INTO course(athlete_id,course_id,name,visibility,status,unavailable_reason,
       reclaimed_at,created_at,updated_at)
     VALUES($1,$2,'Removed source','private','unavailable','source_activity_deleted',
       now(),now(),now())`,
    [tenant, courseId],
  );
  const deleted = await runtime.tenant(tenant, (tx) =>
    tx.query('SELECT public.delete_course($1,1) AS deleted', [courseId]),
  );
  expect(deleted.rows[0]?.['deleted']).toBe(true);
  return erasureEventCountForCourse(tenant, courseId);
}

async function erasureEventCountForCourse(tenant: string, courseId: string): Promise<number> {
  const result = await inspect.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM restore_suppression_event
       WHERE athlete_id=$1 AND kind='course_deleted' AND target_id=$2`,
    [tenant, courseId],
  );
  return result.rows[0]?.total ?? 0;
}

async function liveActivityDeletionEventCount(): Promise<number> {
  const tenant = randomUUID();
  const activityId = randomUUID();
  const client = await inspect.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    await client.query(
      "INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,'{}'::jsonb)",
      [tenant, activityId],
    );
    await client.query(
      `INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,
         content_hash,activity_id) VALUES($1,'fixture',$2,1,repeat('a',64),$3)`,
      [tenant, randomUUID(), activityId],
    );
    await client.query(
      'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
      [tenant, activityId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const result = await inspect.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM restore_suppression_event
       WHERE athlete_id=$1 AND kind='activity_deleted' AND target_id=$2`,
    [tenant, activityId],
  );
  return result.rows[0]?.total ?? 0;
}

async function liveResourceDeletionEventCount(): Promise<number> {
  const tenant = randomUUID();
  const resources = createPrivateTextResourceRepository(runtime);
  const created = await resources.create(tenant, {
    sourceKind: 'text',
    title: 'Synthetic note',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic content.',
    idempotencyKey: randomUUID(),
  });
  if (created.status !== 'available') throw new Error('Expected available resource');
  await resources.softDelete(tenant, created.resource.id, {
    expectedAccessRevision: created.resource.accessRevision,
    expectedCurrentVersionId: created.version.id,
    idempotencyKey: randomUUID(),
  });
  const result = await inspect.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM restore_suppression_event
     WHERE athlete_id=$1 AND kind='resource_deleted' AND target_id=$2`,
    [tenant, created.resource.id],
  );
  return result.rows[0]?.total ?? 0;
}

async function liveGalleryDeletionEventCount(): Promise<number> {
  const tenant = randomUUID();
  const gallery = createGalleryMediaRepository(runtime);
  const reservation = await gallery.reserveCreate(
    tenant,
    {
      mediaKind: 'image',
      album: null,
      caption: null,
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    `gallery-${randomUUID()}`,
  );
  const hash = 'c'.repeat(64);
  const storageRef = `private/v1/tenants/${tenant}/gallery/${reservation.mediaItemId}/objects/uploads/${reservation.uploadId}/sha256/${hash}.png`;
  await gallery.prepareObject(tenant, reservation.uploadId, {
    storageRef,
    file: {
      originalFileName: 'synthetic.png',
      mediaType: 'image/png',
      byteSize: 2048,
      sha256: hash,
    },
  });
  await gallery.markStaged(tenant, reservation.uploadId);
  const finalized = await gallery.finalize(tenant, reservation.uploadId);
  if (finalized.status !== 'available') throw new Error('Expected available media item');
  await gallery.softDelete(tenant, finalized.item.id, {
    expectedAccessRevision: finalized.item.accessRevision,
    idempotencyKey: `gallery-${randomUUID()}`,
  });
  const result = await inspect.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM restore_suppression_event
     WHERE athlete_id=$1 AND kind='gallery_media_deleted' AND target_id=$2`,
    [tenant, finalized.item.id],
  );
  return result.rows[0]?.total ?? 0;
}

async function liveHealthKitConsentEventCount(): Promise<number> {
  const tenant = randomUUID();
  const consents = createConsentRepository(runtime);
  await consents.setConsent(tenant, {
    kind: 'healthkit',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  await consents.setConsent(tenant, {
    kind: 'healthkit',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const result = await inspect.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM restore_suppression_event
     WHERE athlete_id=$1 AND kind='healthkit_consent_transition'`,
    [tenant],
  );
  return result.rows[0]?.total ?? 0;
}

/** One due deletion of a key nothing references, and whether the worker can finish it. */
async function workerFinishesADeletion(): Promise<boolean> {
  const ref = `private/v1/tenants/${randomUUID()}/resources/${randomUUID()}/temporary/${randomUUID()}`;
  await inspect.query(
    `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
     VALUES($1,$2,'upload_abandoned',clock_timestamp(),clock_timestamp())`,
    [randomUUID(), ref],
  );
  const deleted: string[] = [];
  for (let run = 0; run < 20; run += 1) {
    const outcome = await processOneResourceObjectCleanup(worker, async (key) => {
      deleted.push(key);
    });
    if (outcome === 'empty') break;
  }
  await inspect.query('DELETE FROM resource_object_cleanup WHERE storage_ref=$1', [ref]);
  return deleted.includes(ref);
}

/**
 * An expired search-cache entry of a fresh tenant, and whether the worker's prune — which finds
 * it through the tenant-work index (M2-01av) — removes it. Writing the entry itself goes through
 * the index's trigger, so it is refused while the index's policy names another owner.
 */
async function workerPrunesAnExpiredCacheEntry(): Promise<boolean> {
  const tenant = randomUUID();
  await inspect.query(
    `INSERT INTO resource_retrieval_cache(athlete_id,cache_key,corpus_version,
       authorization_digest,passage_ids,created_at,expires_at)
     VALUES($1,$2,1,$3,'[]'::jsonb,now()-interval '1 hour',now()-interval '1 minute')`,
    [tenant, 'd'.repeat(64), 'b'.repeat(64)],
  );
  const pool = new Pool({ connectionString: urlFor(workerRole), max: 1 });
  try {
    await pool.query('SELECT public.prune_resource_retrieval_cache(1000)');
  } finally {
    await pool.end();
  }
  const left = await inspect.query('SELECT 1 FROM resource_retrieval_cache WHERE athlete_id=$1', [
    tenant,
  ]);
  await inspect.query('DELETE FROM resource_retrieval_cache WHERE athlete_id=$1', [tenant]);
  return left.rowCount === 0;
}

describe('definer policies follow the owner through retarget_definer_policies()', () => {
  it('names the applying owner, and the paths work', async () => {
    expect(await policyTargets()).toEqual(
      definerPolicies.map((entry) => `${entry}:${firstOwner}:ALL:true:true`),
    );
    const tenant = randomUUID();
    await expect(operations.eraseAccount(tenant)).resolves.toEqual({ erased: true });
    expect(await erasureEventCount(tenant)).toBe(1);
    expect(await liveCourseDeletionEventCount()).toBe(1);
    expect(await liveActivityDeletionEventCount()).toBe(1);
    expect(await liveResourceDeletionEventCount()).toBe(1);
    expect(await liveGalleryDeletionEventCount()).toBe(1);
    expect(await liveHealthKitConsentEventCount()).toBe(2);
    expect(await workerFinishesADeletion()).toBe(true);
    expect(await workerPrunesAnExpiredCacheEntry()).toBe(true);
  });

  it('fails closed after REASSIGN OWNED, until the new owner retargets', async () => {
    await admin.query(`ALTER DATABASE ${database} OWNER TO "${nextOwner}"`);
    await inspect.query(`REASSIGN OWNED BY "${firstOwner}" TO "${nextOwner}"`);
    // The functions are the new owner's; the policies still name the old one.
    expect(await policyTargets()).toEqual(
      definerPolicies.map((entry) => `${entry}:${firstOwner}:ALL:true:true`),
    );
    const tenant = randomUUID();
    await expect(operations.eraseAccount(tenant)).rejects.toMatchObject({ code: '42501' });
    expect(await erasureEventCount(tenant)).toBe(0);
    expect(await workerFinishesADeletion()).toBe(false);
    // A write to a table the index follows is refused too: its trigger cannot write the index.
    await expect(workerPrunesAnExpiredCacheEntry()).rejects.toMatchObject({ code: '42501' });

    // Only the owner of the tables may retarget: the old owner may not even call it, and a
    // superuser that owns none of them is refused.
    await expect(retargetAs(firstOwner)).rejects.toMatchObject({ code: '42501' });
    await expect(inspect.query('SELECT public.retarget_definer_policies()')).rejects.toThrow(
      'DEFINER_POLICY_OWNER_MISMATCH',
    );

    expect(await retargetAs(nextOwner)).toBe(definerPolicies.length);
    expect(await policyTargets()).toEqual(
      definerPolicies.map((entry) => `${entry}:${nextOwner}:ALL:true:true`),
    );
    await expect(operations.eraseAccount(tenant)).resolves.toEqual({ erased: true });
    expect(await erasureEventCount(tenant)).toBe(1);
    expect(await liveCourseDeletionEventCount()).toBe(1);
    expect(await liveActivityDeletionEventCount()).toBe(1);
    expect(await liveResourceDeletionEventCount()).toBe(1);
    expect(await liveGalleryDeletionEventCount()).toBe(1);
    expect(await liveHealthKitConsentEventCount()).toBe(2);
    expect(await workerFinishesADeletion()).toBe(true);
    expect(await workerPrunesAnExpiredCacheEntry()).toBe(true);
    // Running it again changes nothing.
    expect(await retargetAs(nextOwner)).toBe(definerPolicies.length);
    expect(await policyTargets()).toEqual(
      definerPolicies.map((entry) => `${entry}:${nextOwner}:ALL:true:true`),
    );
  });

  it('recreates the policies a DROP OWNED removed', async () => {
    // Pointing them back at the old owner, then dropping everything it owned, removes the
    // policies whose only role it was — what retiring the old role does.
    await inspect.query(`REASSIGN OWNED BY "${nextOwner}" TO "${firstOwner}"`);
    await admin.query(`ALTER DATABASE ${database} OWNER TO "${firstOwner}"`);
    expect(await retargetAs(firstOwner)).toBe(definerPolicies.length);
    await admin.query(`ALTER DATABASE ${database} OWNER TO "${nextOwner}"`);
    await inspect.query(`REASSIGN OWNED BY "${firstOwner}" TO "${nextOwner}"`);
    await inspect.query(`DROP OWNED BY "${firstOwner}"`);
    expect(await policyTargets()).toEqual([]);
    expect(await workerFinishesADeletion()).toBe(false);

    expect(await retargetAs(nextOwner)).toBe(definerPolicies.length);
    expect(await policyTargets()).toEqual(
      definerPolicies.map((entry) => `${entry}:${nextOwner}:ALL:true:true`),
    );
    const tenant = randomUUID();
    await expect(operations.eraseAccount(tenant)).resolves.toEqual({ erased: true });
    expect(await erasureEventCount(tenant)).toBe(1);
    expect(await liveCourseDeletionEventCount()).toBe(1);
    expect(await liveActivityDeletionEventCount()).toBe(1);
    expect(await liveResourceDeletionEventCount()).toBe(1);
    expect(await liveGalleryDeletionEventCount()).toBe(1);
    expect(await liveHealthKitConsentEventCount()).toBe(2);
    expect(await workerFinishesADeletion()).toBe(true);
    expect(await workerPrunesAnExpiredCacheEntry()).toBe(true);
  });
});
