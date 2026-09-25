import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';
import {
  createActivityTrackTemporaryObjectKey,
  createCourseThumbnailTemporaryObjectKey,
  createLocalFilesystemObjectStorage,
  createTemporaryObjectKey,
  validateObjectKey,
  type ObjectKey,
  type ObjectScopeEnumeration,
  type ObjectStorage,
  type StoreReachability,
  type TenantObjectEnumeration,
} from '@workout/server-media';

import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import { createDatabase, type Database } from '../src/database.js';
import {
  grantActivityTracks,
  grantCourses,
  grantOperations,
  grantResourceObjectCleanupWorker,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';
import {
  createResourceObjectCleanupRepository,
  processOneObjectScopePurge,
  processOneTenantObjectPurge,
  type ResourceObjectCleanupRepository,
} from '../src/resource-object-cleanup.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * M2-01at: the object-prefix purges (044–046) on a database whose migration owner is neither
 * superuser nor BYPASSRLS — the owner every other integration test does not have, because the
 * test cluster's migration role (`workout_admin`) is a superuser and sees through every policy.
 *
 * Here the whole schema is built by a plain owner, the way a deployment that follows the
 * least-privilege advice would build it: that role creates the database objects, owns every
 * definer function and table, and runs the grant helpers. The runtime and the cleanup worker
 * are the usual plain roles. The superuser connection is used only to look at rows and to
 * plant the inconsistent-ledger rows no path of the system writes.
 *
 * What must hold, on that owner, for both purges:
 *   * erasure (`erase_account`) and activity deletion arm their purge — the arming INSERT is
 *     not refused by RLS;
 *   * the worker's lease finds the due row, its run deletes the prefix, and `finish` records
 *     the pass;
 *   * every refusal the lease makes still holds: a purge row whose tenant has no erasure entry,
 *     or still has an identity account, is not leased; a scope whose activity is live or whose
 *     course is available is not leased — so fixing visibility never makes a guard fail open;
 *   * a caller's tenant setting survives the lease.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `plain_purge_${suffix}`;
const ownerRole = `plain_purge_owner_${suffix}`;
const runtimeRole = `plain_purge_rt_${suffix}`;
const workerRole = `plain_purge_worker_${suffix}`;
type Store = ObjectStorage & StoreReachability & TenantObjectEnumeration & ObjectScopeEnumeration;

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
let activities: ActivityRepository;
let operations: OperationsRepository;
let worker: ResourceObjectCleanupRepository;
let storage: Store;
let objectRoot: string;

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, workerRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE ${database} OWNER "${ownerRole}"`);
  inspect = new Pool({ connectionString: urlFor(null) });
  // Deployment, done by the plain owner: every migration, then the grant helpers.
  const owner = urlFor(ownerRole);
  await migrate(owner);
  const ownerPool = new Pool({ connectionString: owner, max: 1 });
  try {
    await ownerPool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${workerRole}"`);
    await ownerPool.query(`GRANT USAGE ON SCHEMA identity_private TO "${runtimeRole}"`);
    await ownerPool.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
       activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,
       activity_import_receipt TO "${runtimeRole}"`,
    );
  } finally {
    await ownerPool.end();
  }
  await grantOperations(owner, runtimeRole);
  await grantActivityTracks(owner, runtimeRole);
  await grantCourses(owner, runtimeRole);
  await grantResourceObjectCleanupWorker(owner, workerRole);
  runtime = createDatabase({ connectionString: urlFor(runtimeRole), max: 4 });
  activities = createActivityRepository(runtime);
  operations = createOperationsRepository(runtime);
  worker = createResourceObjectCleanupRepository({
    connectionString: urlFor(workerRole),
    max: 2,
  });
  objectRoot = await mkdtemp(join(tmpdir(), 'plain-purge-'));
  storage = await createLocalFilesystemObjectStorage(objectRoot);
});

afterAll(async () => {
  await worker?.close();
  await runtime?.close();
  await inspect?.end();
  await dropIsolatedDatabase(admin, database);
  for (const role of [workerRole, runtimeRole, ownerRole])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
  if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
});

async function* bytesOf(value: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(value);
}

async function exists(keys: readonly ObjectKey[]): Promise<boolean[]> {
  return Promise.all(keys.map(async (key) => (await storage.stat(key)) !== null));
}

/** Objects under a tenant's prefix that no row names — what a late archive copy brings back. */
async function tenantObjects(tenantId: string): Promise<ObjectKey[]> {
  const keys: ObjectKey[] = [
    createTemporaryObjectKey({ tenantId, resourceId: randomUUID(), uploadId: randomUUID() }),
    createCourseThumbnailTemporaryObjectKey({
      tenantId,
      courseId: randomUUID(),
      jobId: randomUUID(),
    }),
  ];
  for (const key of keys) await storage.writeTemporary(key as never, bytesOf(`rowless ${key}`));
  return keys;
}

async function activityObjects(tenantId: string, activityId: string): Promise<ObjectKey[]> {
  const key = createActivityTrackTemporaryObjectKey({
    tenantId,
    activityId,
    trackId: randomUUID(),
    uploadId: randomUUID(),
    artifactKind: 'raw',
  });
  await storage.writeTemporary(key, bytesOf(`rowless ${key}`));
  return [key];
}

async function courseObjects(tenantId: string, courseId: string): Promise<ObjectKey[]> {
  const key = createCourseThumbnailTemporaryObjectKey({ tenantId, courseId, jobId: randomUUID() });
  await storage.writeTemporary(key, bytesOf(`rowless ${key}`));
  return [key];
}

async function drainTenantPurges(): Promise<string[]> {
  const outcomes: string[] = [];
  for (let run = 0; run < 100; run += 1) {
    const outcome = await processOneTenantObjectPurge(worker, {
      listTenantObjects: (tenantId, limit) => storage.listTenantObjects(tenantId, limit),
      delete: (key) => storage.delete(validateObjectKey(key)),
      stat: (key) => storage.stat(validateObjectKey(key)),
    });
    if (outcome === 'empty') return outcomes;
    outcomes.push(outcome);
  }
  throw new Error('tenant purges did not drain');
}

async function drainScopePurges(): Promise<string[]> {
  const outcomes: string[] = [];
  for (let run = 0; run < 100; run += 1) {
    const outcome = await processOneObjectScopePurge(worker, {
      listScopeObjects: (scope, limit) => storage.listScopeObjects(scope, limit),
      delete: (key) => storage.delete(validateObjectKey(key)),
      stat: (key) => storage.stat(validateObjectKey(key)),
    });
    if (outcome === 'empty') return outcomes;
    outcomes.push(outcome);
  }
  throw new Error('scope purges did not drain');
}

function importInput(): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Plain owner run',
      kind: 'running',
      startedAt: '2026-09-16T08:00:00+09:00',
      durationSeconds: 600,
      durationKind: 'timer',
      timezone: 'Asia/Seoul',
      distanceMeters: 1000,
    },
  };
}

type PurgeRow = {
  attempts: number;
  passes: number;
  objects_purged: string;
  completed_at: Date | null;
  lease_owner: string | null;
  last_error_code: string | null;
};

async function tenantPurgeRow(tenantId: string): Promise<PurgeRow | undefined> {
  const rows = await inspect.query<PurgeRow>(
    `SELECT attempts,passes,objects_purged,completed_at,lease_owner,last_error_code
     FROM tenant_object_purge WHERE athlete_id=$1`,
    [tenantId],
  );
  return rows.rows[0];
}

async function scopePurgeRow(
  tenantId: string,
  kind: 'activity' | 'course',
  scopeId: string,
): Promise<PurgeRow | undefined> {
  const rows = await inspect.query<PurgeRow>(
    `SELECT attempts,passes,objects_purged,completed_at,lease_owner,last_error_code
     FROM object_scope_purge WHERE athlete_id=$1 AND scope_kind=$2 AND scope_id=$3`,
    [tenantId, kind, scopeId],
  );
  return rows.rows[0];
}

/** A row no path of the system writes: planted by the superuser with foreign keys off. */
async function plant(statement: string, values: unknown[]): Promise<void> {
  const client = await inspect.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(statement, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('object-prefix purges on a migration owner that is neither superuser nor BYPASSRLS', () => {
  it('is really such an owner, and owns the purge tables and functions', async () => {
    const role = await inspect.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1',
      [ownerRole],
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const owners = await inspect.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class
       WHERE relname IN ('tenant_object_purge','object_scope_purge','tenant_erasure')
       UNION SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc
       WHERE proname IN ('erase_account','lease_tenant_object_purge','finish_tenant_object_purge',
         'lease_object_scope_purge','finish_object_scope_purge','arm_object_scope_purge')`,
    );
    expect(owners.rows).toEqual([{ owner: ownerRole }]);
  });

  it('erases an account, arms its purge, and purges the prefix', async () => {
    const erased = randomUUID();
    const live = randomUUID();
    const erasedObjects = await tenantObjects(erased);
    const liveObjects = await tenantObjects(live);

    await expect(operations.eraseAccount(erased)).resolves.toEqual({ erased: true });
    const erasures = await inspect.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [
      erased,
    ]);
    expect(erasures.rowCount).toBe(1);
    expect(await tenantPurgeRow(erased)).toMatchObject({ passes: 0, completed_at: null });

    const outcomes = await drainTenantPurges();
    expect(outcomes).toContain('passed');
    expect(await exists(erasedObjects)).toEqual([false, false]);
    expect(await exists(liveObjects)).toEqual([true, true]);
    const row = await tenantPurgeRow(erased);
    expect(row).toMatchObject({ passes: 1, attempts: 0, lease_owner: null, last_error_code: null });
    expect(Number(row?.objects_purged)).toBe(2);
  });

  it('leases and finishes a due purge row, whoever armed it', async () => {
    // The lease and the finish on their own, apart from how `erase_account` arms: an erasure
    // entry and its purge row, written by the superuser as an earlier erasure would have.
    const erased = randomUUID();
    const objects = await tenantObjects(erased);
    await inspect.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [erased]);
    await inspect.query(
      `INSERT INTO tenant_object_purge(athlete_id,armed_at,available_at)
       VALUES($1,clock_timestamp(),clock_timestamp())`,
      [erased],
    );
    expect(await drainTenantPurges()).toContain('passed');
    expect(await exists(objects)).toEqual([false, false]);
    expect(await tenantPurgeRow(erased)).toMatchObject({ passes: 1, lease_owner: null });
  });

  it('does not lease a purge row whose tenant has no erasure entry', async () => {
    const notErased = randomUUID();
    const objects = await tenantObjects(notErased);
    await plant(
      `INSERT INTO tenant_object_purge(athlete_id,armed_at,available_at)
       VALUES($1,clock_timestamp(),clock_timestamp())`,
      [notErased],
    );
    try {
      await drainTenantPurges();
      expect(await exists(objects)).toEqual([true, true]);
      expect(await tenantPurgeRow(notErased)).toMatchObject({
        attempts: 0,
        passes: 0,
        lease_owner: null,
      });
    } finally {
      await inspect.query('DELETE FROM tenant_object_purge WHERE athlete_id=$1', [notErased]);
    }
  });

  it('does not lease an erased tenant that still has an identity account, and says so', async () => {
    const tenant = randomUUID();
    const objects = await tenantObjects(tenant);
    await operations.eraseAccount(tenant);
    await inspect.query(
      `INSERT INTO identity_private.account(athlete_id,issuer,subject)
       VALUES($1,'https://issuer.test',$2)`,
      [tenant, randomUUID()],
    );
    try {
      await drainTenantPurges();
      expect(await exists(objects)).toEqual([true, true]);
      expect(await tenantPurgeRow(tenant)).toMatchObject({
        attempts: 0,
        passes: 0,
        lease_owner: null,
        last_error_code: 'INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT',
      });
    } finally {
      await inspect.query('DELETE FROM identity_private.account WHERE athlete_id=$1', [tenant]);
    }
    await drainTenantPurges();
    expect(await exists(objects)).toEqual([false, false]);
  });

  it('arms a deleted activity’s purge and purges it, never a live activity’s', async () => {
    const tenant = randomUUID();
    const doomed = await activities.importActivity(tenant, importInput());
    const kept = await activities.importActivity(tenant, importInput());
    const doomedObjects = await activityObjects(tenant, doomed.activityId);
    const keptObjects = await activityObjects(tenant, kept.activityId);

    await activities.deleteActivity(tenant, doomed.activityId, {
      expectedRevision: doomed.revision,
    });
    expect(await scopePurgeRow(tenant, 'activity', doomed.activityId)).toMatchObject({
      passes: 0,
      completed_at: null,
    });
    // Whatever armed it, a live activity's scope is refused and labelled, not leased.
    await plant(
      `INSERT INTO object_scope_purge(athlete_id,scope_kind,scope_id,armed_at,available_at)
       VALUES($1,'activity',$2,clock_timestamp(),clock_timestamp())`,
      [tenant, kept.activityId],
    );

    const outcomes = await drainScopePurges();
    expect(outcomes).toContain('passed');
    expect(await exists(doomedObjects)).toEqual([false]);
    expect(await exists(keptObjects)).toEqual([true]);
    const doomedRow = await scopePurgeRow(tenant, 'activity', doomed.activityId);
    expect(doomedRow).toMatchObject({ passes: 1, lease_owner: null, last_error_code: null });
    expect(doomedRow?.completed_at).not.toBeNull();
    expect(await scopePurgeRow(tenant, 'activity', kept.activityId)).toMatchObject({
      attempts: 0,
      passes: 0,
      lease_owner: null,
      last_error_code: 'INCONSISTENT_LEDGER:ACTIVITY_LIVE',
    });
  });

  it('never leases an available course’s scope, and leases an absent one', async () => {
    const tenant = randomUUID();
    const available = randomUUID();
    const absent = randomUUID();
    await plant(
      `INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,revision_id,
         created_at,updated_at)
       VALUES($1,$2,'Kept','private','available',1,$3,now(),now())`,
      [tenant, available, randomUUID()],
    );
    const availableObjects = await courseObjects(tenant, available);
    const absentObjects = await courseObjects(tenant, absent);
    for (const course of [available, absent])
      await plant(
        `INSERT INTO object_scope_purge(athlete_id,scope_kind,scope_id,armed_at,available_at)
         VALUES($1,'course',$2,clock_timestamp(),clock_timestamp())`,
        [tenant, course],
      );

    await drainScopePurges();
    expect(await exists(availableObjects)).toEqual([true]);
    expect(await exists(absentObjects)).toEqual([false]);
    expect(await scopePurgeRow(tenant, 'course', available)).toMatchObject({
      attempts: 0,
      lease_owner: null,
      last_error_code: 'INCONSISTENT_LEDGER:COURSE_AVAILABLE',
    });
    expect(await scopePurgeRow(tenant, 'course', absent)).toMatchObject({ passes: 1 });
  });

  it('deletes a course, arms its purge and purges it', async () => {
    const tenant = randomUUID();
    const course = randomUUID();
    await plant(
      `INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,revision_id,
         created_at,updated_at)
       VALUES($1,$2,'Doomed','private','available',1,$3,now(),now())`,
      [tenant, course, randomUUID()],
    );
    const objects = await courseObjects(tenant, course);
    const deleted = await runtime.tenant(tenant, (tx) =>
      tx.query('SELECT public.delete_course($1,1) AS deleted', [course]),
    );
    expect(deleted.rows[0]).toEqual({ deleted: true });
    expect(await scopePurgeRow(tenant, 'course', course)).toMatchObject({ passes: 0 });
    await drainScopePurges();
    expect(await exists(objects)).toEqual([false]);
    expect(await scopePurgeRow(tenant, 'course', course)).toMatchObject({ passes: 1 });
  });

  it('leaves the caller’s tenant setting as it was', async () => {
    // One due row in each queue: an erased tenant, and a live tenant's deleted activity.
    await operations.eraseAccount(randomUUID());
    const liveTenant = randomUUID();
    const scoped = await activities.importActivity(liveTenant, importInput());
    await activities.deleteActivity(liveTenant, scoped.activityId, {
      expectedRevision: scoped.revision,
    });
    // A caller tenant that is none of the rows' tenants, so any setting left behind shows.
    const callerTenant = randomUUID();
    const client = new Pool({ connectionString: urlFor(workerRole), max: 1 });
    try {
      const session = await client.connect();
      try {
        await session.query('BEGIN');
        await session.query("SELECT set_config('app.athlete_id',$1,true)", [callerTenant]);
        const leasedAt = new Date();
        const until = new Date(leasedAt.getTime() + 60_000);
        const tenantLease = await session.query(
          'SELECT * FROM public.lease_tenant_object_purge($1,$2,$3)',
          [randomUUID(), leasedAt, until],
        );
        const scopeLease = await session.query(
          'SELECT * FROM public.lease_object_scope_purge($1,$2,$3)',
          [randomUUID(), leasedAt, until],
        );
        expect(tenantLease.rowCount).toBe(1);
        expect(scopeLease.rowCount).toBe(1);
        const setting = await session.query<{ value: string }>(
          "SELECT current_setting('app.athlete_id',true) AS value",
        );
        expect(setting.rows[0]?.value).toBe(callerTenant);
        await session.query('ROLLBACK');
      } finally {
        session.release();
      }
    } finally {
      await client.end();
    }
  });
});
