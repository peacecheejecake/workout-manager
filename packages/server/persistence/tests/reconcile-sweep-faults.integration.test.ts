import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createActivityTrackTemporaryObjectKey,
  createCourseThumbnailTemporaryObjectKey,
  createLocalFilesystemObjectStorage,
  type ObjectStorage,
  type StoreReachability,
} from '@workout/server-media';

import { grantActivityTracks, grantResourceObjectCleanupWorker, migrate } from '../src/migrate.js';
import {
  createResourceObjectCleanupRepository,
  reconcileActivityTrackObjects,
  reconcileCourseThumbnailObjects,
  type ResourceObjectCleanupRepository,
} from '../src/resource-object-cleanup.js';

/**
 * M2-01n: a reconciliation sweep isolates a reference whose `stat` always raises.
 *
 * Both sweeps used to end their whole run at such a reference, on every run, so the cursor
 * never moved past it and every reference behind it in the window was never examined again.
 * These tests build that situation for real — a symbolic link planted on a watched path, and a
 * directory the worker cannot read — against real PostgreSQL and a real filesystem, and pin
 * what happens now: the fault is recorded against that one reference, nothing is settled or
 * reclaimed on its strength, and the rest of the window and the cursor go on.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const workerRole = `sweep_fault_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
let cleanup: ResourceObjectCleanupRepository;
let storage: ObjectStorage & StoreReachability;
let objectRoot: string;
let outsideRoot: string;

function roleUrl(role: string): string {
  const parsed = new URL(runtimeUrl as string);
  parsed.username = role;
  return parsed.href;
}

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
  await grantResourceObjectCleanupWorker(adminUrl, workerRole);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantActivityTracks(adminUrl, 'workout_runtime');
  cleanup = createResourceObjectCleanupRepository({
    connectionString: roleUrl(workerRole),
    max: 2,
  });
  objectRoot = await mkdtemp(join(tmpdir(), 'sweep-faults-'));
  outsideRoot = await mkdtemp(join(tmpdir(), 'sweep-faults-outside-'));
  storage = await createLocalFilesystemObjectStorage(objectRoot);
});

afterAll(async () => {
  await cleanup?.close();
  await admin.query(`DROP OWNED BY "${workerRole}"`);
  await admin.query(`DROP ROLE IF EXISTS "${workerRole}"`);
  await admin.end();
  for (const root of [objectRoot, outsideRoot])
    if (root) await rm(root, { recursive: true, force: true });
});

type Namespace = 'activity_track' | 'course_thumbnail';

/**
 * Put a reference in a namespace's index as the server would have recorded it, eight days
 * ago — older than the seven-day settle floor, and named by no ledger row. So if a sweep ever
 * read a fault as "absent" it WOULD settle it, and if it read it as "present" it WOULD queue
 * it for deletion. Every assertion that neither happened is therefore a real one.
 */
async function watch(namespace: Namespace, storageRef: string, athleteId: string): Promise<void> {
  await admin.query(
    `INSERT INTO ${namespace}_object_ref(storage_ref,athlete_id,recorded_at)
     VALUES($1,$2,clock_timestamp()-interval '8 days')`,
    [storageRef, athleteId],
  );
}

async function indexRow(namespace: Namespace, storageRef: string) {
  const rows = await admin.query<{
    settled_at: Date | null;
    sweep_attempts: number;
    sweep_error_code: string | null;
    backoff_seconds: number | null;
  }>(
    `SELECT settled_at,sweep_attempts,sweep_error_code,
       extract(epoch FROM sweep_retry_at-sweep_failed_at)::int AS backoff_seconds
     FROM ${namespace}_object_ref WHERE storage_ref=$1`,
    [storageRef],
  );
  return rows.rows[0] ?? null;
}

async function openReceipts(storageRef: string): Promise<number> {
  const rows = await admin.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM resource_object_cleanup
     WHERE storage_ref=$1 AND completed_at IS NULL`,
    [storageRef],
  );
  return Number(rows.rows[0]?.total);
}

/** Let a recorded fault's backoff run out, as if the time had passed. */
async function makeDue(namespace: Namespace, storageRef: string): Promise<void> {
  await admin.query(
    `UPDATE ${namespace}_object_ref SET
       sweep_first_failed_at=sweep_first_failed_at-interval '2 days',
       sweep_failed_at=sweep_failed_at-interval '2 days',
       sweep_retry_at=clock_timestamp()-interval '1 second'
     WHERE storage_ref=$1`,
    [storageRef],
  );
}

/** One window of two, parked just before this tenant's references. */
async function sweepThumbnails(tenantId: string) {
  await cleanup.advanceThumbnailReconcileCursor(`private/v1/tenants/${tenantId}/`);
  return reconcileCourseThumbnailObjects(cleanup, storage, 2);
}

async function sweepTracks(tenantId: string) {
  await cleanup.advanceReconcileCursor(`private/v1/tenants/${tenantId}/`);
  return reconcileActivityTrackObjects(cleanup, storage, 2);
}

async function* body(): AsyncGenerator<Uint8Array> {
  yield Buffer.from('<svg/>');
}

describe('a thumbnail reference with a symbolic link planted on its path', () => {
  it('is recorded and backed off, never settled or reclaimed, and the window behind it goes on', async () => {
    const tenantId = randomUUID();
    const courseId = randomUUID();
    const poisoned = createCourseThumbnailTemporaryObjectKey({
      tenantId,
      courseId,
      jobId: '00000000-0000-4000-8000-000000000001',
    });
    const orphan = createCourseThumbnailTemporaryObjectKey({
      tenantId,
      courseId,
      jobId: '00000000-0000-4000-8000-000000000002',
    });
    // The orphan is a real object nothing references; the poisoned key is a link to a file
    // outside the store, which the symlink guard refuses to follow.
    await storage.writeTemporary(orphan, body());
    const outside = join(outsideRoot, `${randomUUID()}.svg`);
    await writeFile(outside, 'not the store');
    await symlink(outside, join(objectRoot, ...poisoned.split('/')));
    await watch('course_thumbnail', poisoned, tenantId);
    await watch('course_thumbnail', orphan, tenantId);

    const first = await sweepThumbnails(tenantId);

    expect(first).toEqual({ inspected: 2, queued: 1, faulted: 1, deferred: 0, wrapped: false });
    // The window finished: the cursor moved past both references.
    expect(await cleanup.thumbnailReconcileCursor()).toBe(orphan);
    expect(await openReceipts(orphan)).toBe(1);
    // The fault is on record, with the guard's own code and a one-minute first backoff.
    expect(await indexRow('course_thumbnail', poisoned)).toEqual({
      settled_at: null,
      sweep_attempts: 1,
      sweep_error_code: 'UNSAFE_STORAGE_PATH',
      backoff_seconds: 60,
    });
    expect(await openReceipts(poisoned)).toBe(0);

    // Inside the backoff it is skipped without a stat, and nothing about it changes.
    const second = await sweepThumbnails(tenantId);
    expect(second).toMatchObject({ inspected: 2, faulted: 0, deferred: 1 });
    expect(await indexRow('course_thumbnail', poisoned)).toMatchObject({ sweep_attempts: 1 });

    // Fail it again and again: the backoff doubles, the tenth failure is marked for an
    // operator, and the cap holds at a day. At no point is it settled or queued.
    for (let attempt = 2; attempt <= 12; attempt += 1) {
      await makeDue('course_thumbnail', poisoned);
      expect(await sweepThumbnails(tenantId)).toMatchObject({ faulted: 1 });
      const row = await indexRow('course_thumbnail', poisoned);
      expect(row).toMatchObject({ settled_at: null, sweep_attempts: attempt });
      expect(row?.backoff_seconds).toBe(Math.min(60 * 2 ** (attempt - 1), 86_400));
      expect(row?.sweep_error_code).toBe(
        attempt >= 10 ? 'DEAD_LETTER:UNSAFE_STORAGE_PATH' : 'UNSAFE_STORAGE_PATH',
      );
      expect(await openReceipts(poisoned)).toBe(0);
    }
    // Dead-lettered is not forgotten: it is still watched and still in the window.
    const window = await cleanup.thumbnailReconcileWindow(`private/v1/tenants/${tenantId}/`, 2);
    expect(window[0]).toEqual({ storageRef: poisoned, sweepAttempts: 12, deferred: true });
    // And the file the link pointed at was never touched.
    expect((await stat(outside)).isFile()).toBe(true);

    // Remove the link and put a real, unreferenced object there. The next due visit handles
    // it like any other reference — and only then is the fault cleared.
    await unlink(join(objectRoot, ...poisoned.split('/')));
    await storage.writeTemporary(poisoned, body());
    await makeDue('course_thumbnail', poisoned);
    expect(await sweepThumbnails(tenantId)).toMatchObject({ faulted: 0, deferred: 0 });
    expect(await openReceipts(poisoned)).toBe(1);
    expect(await indexRow('course_thumbnail', poisoned)).toEqual({
      settled_at: null,
      sweep_attempts: 0,
      sweep_error_code: null,
      backoff_seconds: null,
    });
  });
});

describe('a track reference behind a directory the worker cannot read', () => {
  it('is recorded under its errno and does not stop the track sweep', async () => {
    const tenantId = randomUUID();
    const activityId = randomUUID();
    const trackId = randomUUID();
    const key = (uploadId: string) =>
      createActivityTrackTemporaryObjectKey({
        tenantId,
        activityId,
        trackId,
        uploadId,
        artifactKind: 'raw',
      });
    const poisoned = key('00000000-0000-4000-8000-000000000001');
    const orphan = key('00000000-0000-4000-8000-000000000002');
    await storage.writeTemporary(poisoned, body());
    await storage.writeTemporary(orphan, body());
    const lockedDirectory = dirname(join(objectRoot, ...poisoned.split('/')));
    await watch('activity_track', poisoned, tenantId);
    await watch('activity_track', orphan, tenantId);
    await chmod(lockedDirectory, 0o000);
    try {
      const first = await sweepTracks(tenantId);
      expect(first).toEqual({ inspected: 2, queued: 1, faulted: 1, deferred: 0, wrapped: false });
      expect(await cleanup.reconcileCursor()).toBe(orphan);
      expect(await openReceipts(orphan)).toBe(1);
      expect(await indexRow('activity_track', poisoned)).toEqual({
        settled_at: null,
        sweep_attempts: 1,
        sweep_error_code: 'EACCES',
        backoff_seconds: 60,
      });
      expect(await openReceipts(poisoned)).toBe(0);
    } finally {
      await chmod(lockedDirectory, 0o700);
    }
    // Readable again: the object is there and unreferenced, so now — and only now — it is
    // queued, and the fault is cleared. (The orphan's receipt is already open, so it is not
    // queued twice.)
    await makeDue('activity_track', poisoned);
    expect(await sweepTracks(tenantId)).toMatchObject({ faulted: 0, queued: 1 });
    expect(await openReceipts(poisoned)).toBe(1);
    expect(await indexRow('activity_track', poisoned)).toMatchObject({ sweep_attempts: 0 });
  });
});

describe('a store that answers nothing at all', () => {
  async function twoThumbnails(root: string) {
    const deadStorage = await createLocalFilesystemObjectStorage(root);
    const tenantId = randomUUID();
    const courseId = randomUUID();
    const refs = ['1', '2'].map((n) =>
      createCourseThumbnailTemporaryObjectKey({
        tenantId,
        courseId,
        jobId: `00000000-0000-4000-8000-00000000000${n}`,
      }),
    );
    for (const ref of refs) {
      await deadStorage.writeTemporary(ref, body());
      await watch('course_thumbnail', ref, tenantId);
    }
    return { deadStorage, refs, parked: `private/v1/tenants/${tenantId}/` };
  }

  it('fails every run for as long as the store root is unreadable, and records no fault', async () => {
    // Every run, not just the first: the store's reachability is asked once per run and never
    // backed off, so the alarm keeps sounding for as long as the outage lasts. No reference
    // is at fault, so none gets a fault record — and none is delayed after the store is back.
    const deadRoot = await mkdtemp(join(tmpdir(), 'sweep-faults-dead-'));
    const { deadStorage, refs, parked } = await twoThumbnails(deadRoot);
    await cleanup.advanceThumbnailReconcileCursor(parked);
    await chmod(deadRoot, 0o000);
    try {
      for (let run = 1; run <= 3; run += 1) {
        await expect(
          reconcileCourseThumbnailObjects(cleanup, deadStorage, 2),
          `run ${run}`,
        ).rejects.toMatchObject({ code: 'EACCES' });
        expect(await cleanup.thumbnailReconcileCursor()).toBe(parked);
        for (const ref of refs)
          expect(await indexRow('course_thumbnail', ref)).toMatchObject({
            settled_at: null,
            sweep_attempts: 0,
          });
      }
    } finally {
      await chmod(deadRoot, 0o700);
    }
    // Back: the very next run examines both references and queues them, with no backoff to
    // wait out.
    await expect(reconcileCourseThumbnailObjects(cleanup, deadStorage, 2)).resolves.toMatchObject({
      inspected: 2,
      queued: 2,
      faulted: 0,
      deferred: 0,
    });
    for (const ref of refs) expect(await openReceipts(ref)).toBe(1);
    await rm(deadRoot, { recursive: true, force: true });
  });

  it('fails every run while the store root is missing — a missing store is not an empty one', async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), 'sweep-faults-missing-'));
    const { deadStorage, refs, parked } = await twoThumbnails(missingRoot);
    await cleanup.advanceThumbnailReconcileCursor(parked);
    await rm(missingRoot, { recursive: true, force: true });
    for (let run = 1; run <= 3; run += 1)
      await expect(
        reconcileCourseThumbnailObjects(cleanup, deadStorage, 2),
        `run ${run}`,
      ).rejects.toMatchObject({ code: 'ENOENT' });
    // Had the missing root been read as "absent", both references — eight days old, past the
    // seven-day settle floor, named by no ledger row — would have been settled. None was.
    for (const ref of refs)
      expect(await indexRow('course_thumbnail', ref)).toMatchObject({
        settled_at: null,
        sweep_attempts: 0,
      });
  });

  it('fails the run when the root answers but every reference below it raises', async () => {
    // The other outage: the store is up, but nothing under it can be read — here the
    // directory both references live in. Faults are recorded (these references really could
    // not be read), the run fails, and the next run defers them and passes the window.
    const root = await mkdtemp(join(tmpdir(), 'sweep-faults-blocked-'));
    const { deadStorage, refs, parked } = await twoThumbnails(root);
    const blocked = dirname(join(root, ...(refs[0] as string).split('/')));
    await cleanup.advanceThumbnailReconcileCursor(parked);
    await chmod(blocked, 0o000);
    try {
      await expect(reconcileCourseThumbnailObjects(cleanup, deadStorage, 2)).rejects.toMatchObject({
        code: 'EACCES',
      });
      expect(await cleanup.thumbnailReconcileCursor()).toBe(parked);
      for (const ref of refs)
        expect(await indexRow('course_thumbnail', ref)).toMatchObject({
          settled_at: null,
          sweep_attempts: 1,
          sweep_error_code: 'EACCES',
        });
      await expect(reconcileCourseThumbnailObjects(cleanup, deadStorage, 2)).resolves.toMatchObject(
        { inspected: 2, deferred: 2, faulted: 0 },
      );
      for (const ref of refs) expect(await openReceipts(ref)).toBe(0);
    } finally {
      await chmod(blocked, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('re-running the current grant helpers repairs what an older helper gave back', () => {
  it('takes whole-row INSERT on the track index and the superseded windows away again', async () => {
    // An older build's helpers, run after 040, would give back table-level INSERT on the
    // track reference index and EXECUTE on the two candidate functions. Running the current
    // helpers again must be enough to undo that.
    const role = `sweep_regrant_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      // What the pre-040 helpers granted.
      await admin.query(`GRANT SELECT,INSERT ON activity_track_object_ref TO "${role}"`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION public.activity_track_reconcile_candidates(text,integer),
         public.course_thumbnail_reconcile_candidates(text,integer) TO "${role}"`,
      );
      await grantActivityTracks(adminUrl as string, role);
      await grantResourceObjectCleanupWorker(adminUrl as string, role);
      const held = await admin.query<{
        table_insert: boolean;
        settled_insert: boolean;
        recorded_insert: boolean;
        track_candidates: boolean;
        thumbnail_candidates: boolean;
        track_window: boolean;
      }>(
        `SELECT
           has_table_privilege($1,'activity_track_object_ref','INSERT') AS table_insert,
           has_column_privilege($1,'activity_track_object_ref','settled_at','INSERT')
             AS settled_insert,
           has_column_privilege($1,'activity_track_object_ref','recorded_at','INSERT')
             AS recorded_insert,
           has_function_privilege($1,
             'public.activity_track_reconcile_candidates(text,integer)','EXECUTE')
             AS track_candidates,
           has_function_privilege($1,
             'public.course_thumbnail_reconcile_candidates(text,integer)','EXECUTE')
             AS thumbnail_candidates,
           has_function_privilege($1,
             'public.activity_track_reconcile_window(text,integer)','EXECUTE') AS track_window`,
        [role],
      );
      expect(held.rows[0]).toEqual({
        table_insert: false,
        settled_insert: false,
        recorded_insert: true,
        track_candidates: false,
        thumbnail_candidates: false,
        track_window: true,
      });
    } finally {
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  });
});

describe('the runtime role and the track reference index', () => {
  it('can record a reference but cannot write its settle or fault state', async () => {
    // The runtime records track references itself (M2-01c), so it holds INSERT on this table.
    // Since 040 that is INSERT on the three columns a recording needs, not the whole row: a
    // tenant can no longer insert a reference already settled, or already deferred for a
    // century, and so hide it from the sweep.
    const tenantId = randomUUID();
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
    const client = await runtime.connect();
    const reference = () =>
      createActivityTrackTemporaryObjectKey({
        tenantId,
        activityId: randomUUID(),
        trackId: randomUUID(),
        uploadId: randomUUID(),
        artifactKind: 'raw',
      });
    try {
      await client.query('SELECT set_config($1,$2,false)', ['app.athlete_id', tenantId]);
      // The recording path M2-01c uses, exactly.
      const recorded = reference();
      await client.query(
        `INSERT INTO activity_track_object_ref(storage_ref,athlete_id,recorded_at)
         SELECT unnest($2::text[]),$1,$3 ON CONFLICT(storage_ref) DO NOTHING`,
        [tenantId, [recorded], new Date().toISOString()],
      );
      expect(await indexRow('activity_track', recorded)).toMatchObject({
        settled_at: null,
        sweep_attempts: 0,
      });
      for (const [column, value] of [
        ['settled_at', 'clock_timestamp()'],
        ['sweep_retry_at', "clock_timestamp()+interval '100 years'"],
        ['sweep_attempts', '1'],
        ['sweep_error_code', "'EACCES'"],
      ] as const)
        await expect(
          client.query(
            `INSERT INTO activity_track_object_ref(storage_ref,athlete_id,recorded_at,${column})
             VALUES($1,$2,clock_timestamp(),${value})`,
            [reference(), tenantId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      await expect(
        client.query(
          `UPDATE activity_track_object_ref SET sweep_retry_at=clock_timestamp()
           WHERE storage_ref=$1`,
          [recorded],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // The thumbnail index is written only by its trigger: the runtime has no grant at all.
      await expect(
        client.query(
          `INSERT INTO course_thumbnail_object_ref(storage_ref,athlete_id,recorded_at)
           VALUES($1,$2,clock_timestamp())`,
          [reference(), tenantId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
      await runtime.end();
    }
  });
});

describe('recording a sweep fault', () => {
  // Both namespaces, each against its own copy of the function: the two bodies are the same
  // today, and a test on only one copy would let the other drift unseen (review of M2-01n).
  it.each(['activity_track', 'course_thumbnail'] as const)(
    'validates its input and records nothing for a %s reference that is not watched',
    async (namespace) => {
      const tenantId = randomUUID();
      const reference =
        namespace === 'course_thumbnail'
          ? createCourseThumbnailTemporaryObjectKey({
              tenantId,
              courseId: randomUUID(),
              jobId: randomUUID(),
            })
          : createActivityTrackTemporaryObjectKey({
              tenantId,
              activityId: randomUUID(),
              trackId: randomUUID(),
              uploadId: randomUUID(),
              artifactKind: 'raw',
            });
      const record = (code: string) =>
        namespace === 'course_thumbnail'
          ? cleanup.recordThumbnailSweepFault(reference, code)
          : cleanup.recordTrackSweepFault(reference, code);
      // Nothing to record against: the caller then re-raises the original error.
      expect(await record('EACCES')).toBeNull();
      await watch(namespace, reference, tenantId);
      // Only an identifier-shaped code is accepted — never a message or a path. Called raw,
      // past the repository's own check, so this is the database's guard alone.
      const raw = new Pool({ connectionString: roleUrl(workerRole), max: 1 });
      try {
        for (const code of ['eacces', 'EACCES: permission denied, lstat /x', '', 'A'.repeat(65)])
          await expect(
            raw.query(`SELECT public.record_${namespace}_sweep_fault($1,$2)`, [reference, code]),
          ).rejects.toThrow('INVALID_SWEEP_FAULT_CODE');
      } finally {
        await raw.end();
      }
      expect(await record('EACCES')).toBe(1);
      // A second record inside the backoff — a concurrent sweep — does not double the count.
      expect(await record('EACCES')).toBe(1);
      // A settled reference is not watched any more, so there is nothing to record against.
      await admin.query(
        `UPDATE ${namespace}_object_ref SET settled_at=clock_timestamp() WHERE storage_ref=$1`,
        [reference],
      );
      await makeDue(namespace, reference);
      expect(await record('EACCES')).toBeNull();
      expect(await indexRow(namespace, reference)).toMatchObject({ sweep_attempts: 1 });
    },
  );

  it('waits for a concurrent erasure of the row and then reports nothing recorded', async () => {
    // One statement on one row, no advisory lock: it waits once, holding nothing, so it cannot
    // be part of a cycle. Here the row is being deleted — as `erase_account` does — in a
    // transaction that is still open; the record waits for it and then finds no row.
    const tenantId = randomUUID();
    const reference = createCourseThumbnailTemporaryObjectKey({
      tenantId,
      courseId: randomUUID(),
      jobId: randomUUID(),
    });
    await watch('course_thumbnail', reference, tenantId);
    const eraser = await admin.connect();
    try {
      await eraser.query('BEGIN');
      await eraser.query('DELETE FROM course_thumbnail_object_ref WHERE storage_ref=$1', [
        reference,
      ]);
      const recording = cleanup.recordThumbnailSweepFault(reference, 'EACCES');
      const waited = await Promise.race([
        recording.then(() => 'finished'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
      ]);
      expect(waited).toBe('waiting');
      await eraser.query('COMMIT');
      await expect(recording).resolves.toBeNull();
    } finally {
      eraser.release();
    }
  });
});

describe('the fault-carrying window', () => {
  it('reads exactly the rows it returns, deferred ones included', async () => {
    // A deferred reference is returned, not filtered: filtering would let one window read
    // past any number of deferred rows to fill itself.
    for (const namespace of ['activity_track', 'course_thumbnail'] as const) {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE ${namespace}_object_ref SET sweep_attempts=1,sweep_error_code='EACCES',
             sweep_first_failed_at=clock_timestamp(),sweep_failed_at=clock_timestamp(),
             sweep_retry_at=clock_timestamp()+interval '1 hour'
           WHERE settled_at IS NULL`,
        );
        const counter = async () =>
          Number(
            (
              await client.query<{ read: string }>(
                `SELECT pg_stat_get_xact_tuples_returned('${namespace}_object_ref'::regclass)
                   +pg_stat_get_xact_tuples_fetched('${namespace}_object_ref'::regclass) AS read`,
              )
            ).rows[0]?.read,
          );
        const before = await counter();
        const window = await client.query<{ deferred: boolean }>(
          `SELECT * FROM public.${namespace}_reconcile_window($1,$2)`,
          ['', 1],
        );
        const after = await counter();
        await client.query('ROLLBACK');
        expect(window.rows).toHaveLength(1);
        expect(window.rows[0]?.deferred).toBe(true);
        expect(after - before).toBeLessThanOrEqual(1);
      } finally {
        client.release();
      }
      const clamped = await admin.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM public.${namespace}_reconcile_window($1,$2)`,
        ['', 100000],
      );
      expect(Number(clamped.rows[0]?.total)).toBeLessThanOrEqual(1000);
    }
  });

  it('is the only window the sweep role can read, and the role has no table access', async () => {
    const executable = await admin.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature
       FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE a.privilege_type='EXECUTE' AND pg_get_userbyid(a.grantee)=$1`,
      [workerRole],
    );
    const signatures = executable.rows.map((row) => row.signature);
    expect(signatures).toEqual(
      expect.arrayContaining([
        'activity_track_reconcile_window(text,integer)',
        'course_thumbnail_reconcile_window(text,integer)',
        'record_activity_track_sweep_fault(text,text)',
        'record_course_thumbnail_sweep_fault(text,text)',
        'clear_activity_track_sweep_fault(text)',
        'clear_course_thumbnail_sweep_fault(text)',
      ]),
    );
    expect(signatures).not.toContain('activity_track_reconcile_candidates(text,integer)');
    expect(signatures).not.toContain('course_thumbnail_reconcile_candidates(text,integer)');
    const tableGrants = await admin.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM information_schema.role_table_grants
       WHERE grantee=$1`,
      [workerRole],
    );
    expect(Number(tableGrants.rows[0]?.total)).toBe(0);
    // Nobody but the owner can run the new functions unless granted: PUBLIC holds nothing.
    const publicGrants = await admin.query<{ total: number }>(
      `SELECT count(*)::int AS total
       FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE a.grantee=0 AND p.proname IN ('activity_track_reconcile_window',
         'course_thumbnail_reconcile_window','record_activity_track_sweep_fault',
         'record_course_thumbnail_sweep_fault','clear_activity_track_sweep_fault',
         'clear_course_thumbnail_sweep_fault')`,
    );
    expect(Number(publicGrants.rows[0]?.total)).toBe(0);
    const definers = await admin.query<{ proname: string; config: string[] | null }>(
      `SELECT proname,proconfig AS config FROM pg_proc
       WHERE prosecdef AND proname IN ('activity_track_reconcile_window',
         'course_thumbnail_reconcile_window','record_activity_track_sweep_fault',
         'record_course_thumbnail_sweep_fault','clear_activity_track_sweep_fault',
         'clear_course_thumbnail_sweep_fault')`,
    );
    expect(definers.rows).toHaveLength(6);
    for (const row of definers.rows)
      expect(row.config, row.proname).toEqual(['search_path=pg_catalog']);
  });
});
