import { createHash, randomUUID } from 'node:crypto';
import { renameSync, symlinkSync } from 'node:fs';
import { cp, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';
import {
  createActivityTrackFinalObjectKey,
  createActivityTrackTemporaryObjectKey,
  createCourseThumbnailTemporaryObjectKey,
  createGalleryTemporaryObjectKey,
  createTemporaryObjectKey,
  createLocalFilesystemObjectStorage,
  validateObjectKey,
  type ObjectKey,
  type ObjectStorage,
  type StoreReachability,
  type TenantObjectEnumeration,
} from '@workout/server-media';

import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import {
  createActivityTrackRepository,
  type ActivityTrackRepository,
} from '../src/activity-tracks.js';
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
  processOneResourceObjectCleanup,
  processOneTenantObjectPurge,
  processTenantObjectPurges,
  reconcileActivityTrackObjects,
  reconcileCourseThumbnailObjects,
  type PurgedStorage,
  type ResourceObjectCleanupRepository,
} from '../src/resource-object-cleanup.js';

/**
 * M2-01x: an erased tenant's object prefix is purged independently of any database row.
 *
 * The hole this closes: every other deletion of an erased tenant's objects starts from a row —
 * the ledger stages queue the keys their rows name, 042 queues what the reference indexes
 * watch, the sweeps read those indexes. An object no row names survives all of them. A
 * backup whose object archive is copied after its database dump produces exactly that object
 * (the drill has the end-to-end version); here it is written straight into the store, which
 * is the same thing as far as the restored database can tell.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let activities: ActivityRepository;
let tracks: ActivityTrackRepository;
let operations: OperationsRepository;
let cleanup: ResourceObjectCleanupRepository;
let storage: ObjectStorage & StoreReachability & TenantObjectEnumeration;
let objectRoot: string;
const cleanupRole = `tenant_purge_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const scratch: string[] = [];

function roleUrl(role: string): string {
  const parsed = new URL(runtimeUrl as string);
  parsed.username = role;
  return parsed.href;
}

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantActivityTracks(adminUrl, 'workout_runtime');
  await grantCourses(adminUrl, 'workout_runtime');
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
     activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,
     activity_import_receipt TO workout_runtime`,
  );
  await admin.query(`CREATE ROLE "${cleanupRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${cleanupRole}"`);
  await grantResourceObjectCleanupWorker(adminUrl, cleanupRole);
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  activities = createActivityRepository(database);
  tracks = createActivityTrackRepository(database);
  operations = createOperationsRepository(database);
  cleanup = createResourceObjectCleanupRepository({
    connectionString: roleUrl(cleanupRole),
    max: 4,
  });
  objectRoot = await mkdtemp(join(tmpdir(), 'tenant-purge-'));
  storage = await createLocalFilesystemObjectStorage(objectRoot);
});

afterAll(async () => {
  await cleanup?.close();
  await database?.close();
  await admin.end();
  if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

/** The worker's adapter, as `runResourceCleanupWorker` builds it. */
function purgeStorage(store: ObjectStorage & TenantObjectEnumeration): PurgedStorage {
  return {
    listTenantObjects: (tenantId, limit) => store.listTenantObjects(tenantId, limit),
    delete: (key) => store.delete(validateObjectKey(key)),
    stat: (key) => store.stat(validateObjectKey(key)),
  };
}

/** Run purges until none is due. Other files' erasures share the table; they pass harmlessly. */
async function drainPurges(store = storage): Promise<string[]> {
  const outcomes: string[] = [];
  for (let run = 0; run < 500; run += 1) {
    const outcome = await processOneTenantObjectPurge(cleanup, purgeStorage(store));
    if (outcome === 'empty') return outcomes;
    outcomes.push(outcome);
  }
  throw new Error('purges did not drain');
}

/** Everything row-based erasure relies on, run to exhaustion. */
async function drainRowBasedPaths(): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const outcome = await processOneResourceObjectCleanup(cleanup, (ref) =>
      storage.delete(validateObjectKey(ref)),
    );
    if (outcome === 'empty') break;
  }
  for (let window = 0; window < 20; window += 1) {
    const tracksSwept = await reconcileActivityTrackObjects(cleanup, storage, 1000);
    const thumbnailsSwept = await reconcileCourseThumbnailObjects(cleanup, storage, 1000);
    if (tracksSwept.wrapped && thumbnailsSwept.wrapped) break;
  }
}

function importInput(): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Purge run',
      kind: 'running',
      startedAt: '2026-09-16T08:00:00+09:00',
      durationSeconds: 600,
      durationKind: 'timer',
      timezone: 'Asia/Seoul',
      distanceMeters: 1000,
    },
  };
}

async function* bytesOf(value: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(value);
}

/**
 * A recorded track uploaded through the real lifecycle, its three objects really written.
 * `finalize: false` stops after `prepareObjects`, so the upload holds an open publication
 * fence — a writer that could still publish when the account is erased.
 */
async function uploadTrack(athleteId: string, options: { finalize: boolean } = { finalize: true }) {
  const imported = await activities.importActivity(athleteId, importInput());
  const reservation = await tracks.reserve(
    athleteId,
    imported.activityId,
    { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
    `track-${randomUUID()}`,
  );
  const parts = {
    tenantId: athleteId,
    activityId: imported.activityId,
    trackId: reservation.trackId,
    uploadId: reservation.uploadId,
  };
  const publish = async (
    artifactKind: 'raw' | 'normalized' | 'map_path',
    extension: 'gpx' | 'json',
  ) => {
    const body = `${artifactKind}-${reservation.uploadId}`;
    const sha256 = hashOf(body);
    const temporary = createActivityTrackTemporaryObjectKey({ ...parts, artifactKind });
    const finalKey = createActivityTrackFinalObjectKey({
      ...parts,
      artifactKind,
      sha256,
      extension,
    });
    await storage.writeTemporary(temporary, bytesOf(body));
    await storage.publishTemporary(temporary, finalKey, {
      sha256,
      sizeBytes: Buffer.byteLength(body),
    });
    return { storageRef: finalKey, sha256, sizeBytes: Buffer.byteLength(body) };
  };
  const raw = await publish('raw', 'gpx');
  const normalized = await publish('normalized', 'json');
  const mapPath = await publish('map_path', 'json');
  await tracks.prepareObjects(athleteId, reservation.uploadId, {
    raw: { ...raw, format: 'gpx', originalFileName: 'run.gpx' },
    normalized,
    mapPath,
    parse: {
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      recordedSourceKind: 'gpx-trk',
      correspondenceDigest: hashOf(`correspondence-${reservation.uploadId}`),
      sampleCount: 5,
      positionedSampleCount: 4,
      segmentCount: 1,
      segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
      distances: { deviceReportedMeters: 1000, recomputedFromPositionsMeters: 998 },
    },
  });
  if (options.finalize) {
    await tracks.markStaged(athleteId, reservation.uploadId);
    await tracks.finalize(athleteId, reservation.uploadId);
  }
  return {
    uploadId: reservation.uploadId,
    keys: [raw, normalized, mapPath].map((item) => validateObjectKey(item.storageRef)),
  };
}

/** Objects of a tenant that no database row names: what a late archive copy brings back. */
async function rowlessObjects(tenantId: string, store = storage): Promise<ObjectKey[]> {
  const keys: ObjectKey[] = [
    createTemporaryObjectKey({ tenantId, resourceId: randomUUID(), uploadId: randomUUID() }),
    createGalleryTemporaryObjectKey({
      tenantId,
      mediaItemId: randomUUID(),
      uploadId: randomUUID(),
    }),
    createCourseThumbnailTemporaryObjectKey({
      tenantId,
      courseId: randomUUID(),
      jobId: randomUUID(),
    }),
    createActivityTrackTemporaryObjectKey({
      tenantId,
      activityId: randomUUID(),
      trackId: randomUUID(),
      uploadId: randomUUID(),
      artifactKind: 'raw',
    }),
  ];
  for (const key of keys) await store.writeTemporary(key as never, bytesOf(`rowless ${key}`));
  return keys;
}

type PurgeRow = {
  armed_at: Date;
  available_at: Date;
  passes: number;
  objects_purged: string;
  completed_at: Date | null;
  last_error_code: string | null;
  attempts: number;
};

async function purgeRow(tenantId: string): Promise<PurgeRow | undefined> {
  const rows = await admin.query<PurgeRow>(
    `SELECT armed_at,available_at,passes,objects_purged,completed_at,last_error_code,attempts
     FROM tenant_object_purge WHERE athlete_id=$1`,
    [tenantId],
  );
  return rows.rows[0];
}

/** The purge row, which the test at hand has just made sure exists. */
async function existingPurgeRow(tenantId: string): Promise<PurgeRow> {
  const row = await purgeRow(tenantId);
  if (!row) throw new Error(`no purge row for ${tenantId}`);
  return row;
}

/** Erasure as the restore replays it: the admin connection, straight into the function. */
async function replayErasure(tenantId: string): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenantId]);
    await client.query('SELECT public.erase_account($1)', [tenantId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const statAll = async (keys: readonly ObjectKey[], store = storage) =>
  Promise.all(keys.map(async (key) => (await store.stat(key)) !== null));

describe('erased tenant object-prefix purge (M2-01x)', () => {
  it('purges an object no row names, which every row-based path leaves behind', async () => {
    const erased = randomUUID();
    const live = randomUUID();
    const erasedTrack = await uploadTrack(erased);
    const liveTrack = await uploadTrack(live);
    const erasedRowless = await rowlessObjects(erased);
    const liveRowless = await rowlessObjects(live);

    await operations.eraseAccount(erased);
    await drainRowBasedPaths();
    // The hole, on the real store and the real database: the rows' own keys are gone, and
    // the keys no row named are still there after the queue and both sweeps ran dry.
    expect(await statAll(erasedTrack.keys)).toEqual([false, false, false]);
    expect(await statAll(erasedRowless)).toEqual([true, true, true, true]);

    const outcomes = await drainPurges();
    expect(outcomes).toContain('passed');
    expect(await statAll(erasedRowless)).toEqual([false, false, false, false]);
    // A live tenant is never touched, rows or no rows.
    expect(await statAll(liveTrack.keys)).toEqual([true, true, true]);
    expect(await statAll(liveRowless)).toEqual([true, true, true, true]);
    const row = await purgeRow(erased);
    expect(row).toMatchObject({ passes: 1, completed_at: null, last_error_code: null });
    expect(Number(row?.objects_purged)).toBe(4);
  });

  it('re-arms hourly for thirty days after the erasure, then closes', async () => {
    const erased = randomUUID();
    await operations.eraseAccount(erased);
    const armed = await existingPurgeRow(erased);
    expect(armed).toMatchObject({ passes: 0, completed_at: null });
    expect(armed.available_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    await drainPurges();
    const passed = await existingPurgeRow(erased);
    expect(passed).toMatchObject({ passes: 1, completed_at: null });
    const hour = passed.available_at.getTime() - Date.now();
    expect(hour).toBeGreaterThan(55 * 60_000);
    expect(hour).toBeLessThanOrEqual(60 * 60_000);

    // A late publication inside the window is caught by the next pass.
    const late = await rowlessObjects(erased);
    await admin.query(
      'UPDATE tenant_object_purge SET available_at=clock_timestamp() WHERE athlete_id=$1',
      [erased],
    );
    await drainPurges();
    expect(await statAll(late)).toEqual([false, false, false, false]);
    expect(await purgeRow(erased)).toMatchObject({ passes: 2, completed_at: null });

    // Thirty days on, the first complete pass closes it.
    await admin.query(
      `UPDATE tenant_object_purge SET armed_at=clock_timestamp()-interval '30 days 1 minute',
         available_at=clock_timestamp() WHERE athlete_id=$1`,
      [erased],
    );
    await drainPurges();
    const closed = await purgeRow(erased);
    expect(closed?.passes).toBe(3);
    expect(closed?.completed_at).not.toBeNull();
  });

  it('waits for an in-flight writer’s publication fence before the first pass', async () => {
    const erased = randomUUID();
    const upload = await uploadTrack(erased, { finalize: false });
    const fence = await admin.query<{ fence: Date }>(
      `SELECT publication_lease_until+interval '1 hour' AS fence
       FROM activity_track_upload_intent WHERE athlete_id=$1 AND upload_id=$2`,
      [erased, upload.uploadId],
    );
    expect(fence.rows[0]?.fence).toBeInstanceOf(Date);
    await operations.eraseAccount(erased);
    const row = await existingPurgeRow(erased);
    expect(row.available_at.getTime()).toBeGreaterThanOrEqual(
      (fence.rows[0]?.fence ?? new Date(8.64e15)).getTime(),
    );
    await drainPurges();
    expect(await purgeRow(erased)).toMatchObject({ passes: 0 });
  });

  it('is re-armed by a replayed erasure: a closed purge reopens now, an open one is never pulled earlier', async () => {
    const closedTenant = randomUUID();
    const openTenant = randomUUID();
    await operations.eraseAccount(closedTenant);
    await operations.eraseAccount(openTenant);
    await drainPurges();
    await admin.query(
      `UPDATE tenant_object_purge SET completed_at=clock_timestamp(),
         armed_at=clock_timestamp()-interval '40 days' WHERE athlete_id=$1`,
      [closedTenant],
    );
    const openBefore = await existingPurgeRow(openTenant);

    // The restore brings objects back for both; the replay re-arms both.
    const restoredForClosed = await rowlessObjects(closedTenant);
    const restoredForOpen = await rowlessObjects(openTenant);
    await replayErasure(closedTenant);
    await replayErasure(openTenant);

    const reopened = await existingPurgeRow(closedTenant);
    expect(reopened).toMatchObject({ completed_at: null, passes: 0 });
    expect(reopened.armed_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(reopened.available_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const rearmed = await existingPurgeRow(openTenant);
    expect(rearmed.available_at.getTime()).toBe(openBefore.available_at.getTime());
    expect(rearmed.armed_at.getTime()).toBeGreaterThan(openBefore.armed_at.getTime());

    await drainPurges();
    expect(await statAll(restoredForClosed)).toEqual([false, false, false, false]);
    // Due within the hour it already had.
    expect(await statAll(restoredForOpen)).toEqual([true, true, true, true]);
    await admin.query(
      'UPDATE tenant_object_purge SET available_at=clock_timestamp() WHERE athlete_id=$1',
      [openTenant],
    );
    await drainPurges();
    expect(await statAll(restoredForOpen)).toEqual([false, false, false, false]);
  });

  describe('never deletes a live tenant’s objects', () => {
    it('cannot hold a purge row for a tenant that was not erased', async () => {
      const live = randomUUID();
      await expect(
        admin.query(
          `INSERT INTO tenant_object_purge(athlete_id,armed_at,available_at)
           VALUES($1,clock_timestamp(),clock_timestamp())`,
          [live],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('does not lease a tenant that still has an identity account', async () => {
      // An inconsistent ledger — an erasure entry and a purge row for an id that still has an
      // account — is refused at the lease: nothing under that prefix is touched.
      const account = await admin.query<{ athlete_id: string }>(
        `INSERT INTO identity_private.account(issuer,subject) VALUES('https://issuer.test',$1)
         RETURNING athlete_id::text`,
        [randomUUID()],
      );
      const live = account.rows[0]?.athlete_id;
      if (!live) throw new Error('account was not created');
      const objects = await rowlessObjects(live);
      await admin.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [live]);
      await admin.query(
        `INSERT INTO tenant_object_purge(athlete_id,armed_at,available_at)
         VALUES($1,clock_timestamp(),clock_timestamp())`,
        [live],
      );
      const armed = await existingPurgeRow(live);
      await drainPurges();
      expect(await statAll(objects)).toEqual([true, true, true, true]);
      // Refused, and no longer silently (M2-01z): the row says why, and nothing was charged —
      // no lease, no attempt, no pass, its due time untouched.
      const refused = await existingPurgeRow(live);
      expect(refused).toMatchObject({
        passes: 0,
        attempts: 0,
        completed_at: null,
        last_error_code: 'INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT',
      });
      expect(refused.available_at.getTime()).toBe(armed.available_at.getTime());
      const leaseState = await admin.query(
        'SELECT lease_owner,lease_until FROM tenant_object_purge WHERE athlete_id=$1',
        [live],
      );
      expect(leaseState.rows).toEqual([{ lease_owner: null, lease_until: null }]);
      // One query finds it with every other kind of stuck purge.
      const stuck = await admin.query<{ athlete_id: string }>(
        `SELECT athlete_id FROM tenant_object_purge WHERE completed_at IS NULL
           AND (last_error_code LIKE 'INCONSISTENT_LEDGER:%' OR last_error_code LIKE 'DEAD_LETTER:%')`,
      );
      expect(stuck.rows.map((row) => row.athlete_id)).toContain(live);
      // Stamped once: another refusal does not write the row again.
      const version = async () =>
        (
          await admin.query<{ xmin: string }>(
            'SELECT xmin::text FROM tenant_object_purge WHERE athlete_id=$1',
            [live],
          )
        ).rows[0]?.xmin;
      const stampedVersion = await version();
      await drainPurges();
      expect(await version()).toBe(stampedVersion);

      // The same row, once the account is gone, is purged: the refusal above was the account,
      // and a finished pass clears the label.
      await admin.query('DELETE FROM identity_private.account WHERE athlete_id::text=$1', [live]);
      await drainPurges();
      expect(await statAll(objects)).toEqual([false, false, false, false]);
      expect(await purgeRow(live)).toMatchObject({ passes: 1, last_error_code: null });
    });

    it('arms nothing for an id that is not canonical, even when it spells a live tenant’s', async () => {
      const live = randomUUID();
      const liveObjects = await rowlessObjects(live);
      const liveTrack = await uploadTrack(live);
      for (const spelling of [live.toUpperCase(), 'not-a-uuid-tenant']) {
        await replayErasure(spelling);
        expect(await purgeRow(spelling)).toBeUndefined();
      }
      await drainPurges();
      expect(await statAll(liveObjects)).toEqual([true, true, true, true]);
      expect(await statAll(liveTrack.keys)).toEqual([true, true, true]);
      await expect(
        admin.query(
          `INSERT INTO tenant_object_purge(athlete_id,armed_at,available_at)
           VALUES($1,clock_timestamp(),clock_timestamp())`,
          [live.toUpperCase()],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('a run that outlives its lease (M2-01z)', () => {
    /**
     * A store whose listing takes longer than the lease: the lease is made to run out (on the
     * database clock, as two minutes would) while the listing is in progress, so the run's
     * `finish` is refused exactly as a real slow run's would be.
     */
    function outlivingStorage(tenantId: string): PurgedStorage {
      return {
        ...purgeStorage(storage),
        listTenantObjects: async (listed, limit) => {
          await admin.query(
            `UPDATE tenant_object_purge SET lease_until=clock_timestamp()-interval '1 second'
             WHERE athlete_id=$1 AND lease_owner IS NOT NULL`,
            [tenantId],
          );
          return storage.listTenantObjects(listed, limit);
        },
      };
    }

    /** Makes this tenant's purge the first due one, at the given attempt count. */
    async function dueFirst(tenantId: string, attempts: number): Promise<void> {
      // Everything else that is due runs first; this one is held back meanwhile.
      await admin.query(
        `UPDATE tenant_object_purge SET available_at=clock_timestamp()+interval '1 day'
         WHERE athlete_id=$1`,
        [tenantId],
      );
      await drainPurges();
      await admin.query(
        `UPDATE tenant_object_purge SET attempts=$2,
           available_at=clock_timestamp()-interval '10 years' WHERE athlete_id=$1`,
        [tenantId, attempts],
      );
    }

    type LeaseState = PurgeRow & { lease_owner: string | null; lease_until: Date | null };
    async function leaseState(tenantId: string): Promise<LeaseState | undefined> {
      const rows = await admin.query<LeaseState>(
        `SELECT armed_at,available_at,passes,objects_purged,completed_at,last_error_code,attempts,
           lease_owner,lease_until FROM tenant_object_purge WHERE athlete_id=$1`,
        [tenantId],
      );
      return rows.rows[0];
    }

    it('labels the lost attempt when its lease is taken over, and keeps retrying below 100', async () => {
      const erased = randomUUID();
      const objects = await rowlessObjects(erased);
      await operations.eraseAccount(erased);
      await dueFirst(erased, 0);
      expect(await processOneTenantObjectPurge(cleanup, outlivingStorage(erased))).toBe(
        'lease_lost',
      );
      // The lost run could not finish: charged, still carrying its stale lease, no label yet.
      expect(await leaseState(erased)).toMatchObject({ attempts: 1, last_error_code: null });
      expect((await leaseState(erased))?.lease_owner).not.toBeNull();

      // The next run takes the row over, and the takeover says what happened to the last one.
      const taken = await cleanup.leaseTenantObjectPurge(new Date(), new Date(Date.now() + 1000));
      expect(taken).toEqual({ tenantId: erased, attempts: 2 });
      expect(await leaseState(erased)).toMatchObject({ last_error_code: 'LEASE_EXPIRED' });
      await admin.query(
        `UPDATE tenant_object_purge SET lease_until=clock_timestamp()-interval '1 second'
         WHERE athlete_id=$1`,
        [erased],
      );
      // A run that does finish clears it; the objects go.
      await drainPurges();
      expect(await statAll(objects)).toEqual([false, false, false, false]);
      expect(await leaseState(erased)).toMatchObject({
        attempts: 0,
        passes: 1,
        last_error_code: null,
        lease_owner: null,
      });
    });

    it('dead-letters a purge whose 100th attempt lost its lease, labelled, never NULL', async () => {
      const erased = randomUUID();
      const objects = await rowlessObjects(erased);
      await operations.eraseAccount(erased);

      // The 99th attempt lost: still in rotation, labelled as a lost lease, not a dead letter.
      await dueFirst(erased, 98);
      expect(await processOneTenantObjectPurge(cleanup, outlivingStorage(erased))).toBe(
        'lease_lost',
      );
      expect(await leaseState(erased)).toMatchObject({ attempts: 99, last_error_code: null });
      // The 100th is leased (taking over the 99th) and loses its lease too.
      expect(await processOneTenantObjectPurge(cleanup, outlivingStorage(erased))).toBe(
        'lease_lost',
      );
      const lost = await leaseState(erased);
      expect(lost).toMatchObject({ attempts: 100, last_error_code: 'LEASE_EXPIRED' });
      expect(lost?.lease_owner).not.toBeNull();

      // Any later lease call dead-letters it, labelled, and clears the stale lease.
      await drainPurges();
      const dead = await leaseState(erased);
      expect(dead).toMatchObject({
        attempts: 100,
        completed_at: null,
        passes: 0,
        last_error_code: 'DEAD_LETTER:LEASE_EXPIRED',
        lease_owner: null,
        lease_until: null,
      });
      // (The two lost runs did delete what they listed — a slow run is still a run; only its
      // bookkeeping was refused.) Out of rotation: it is never leased again.
      expect(await statAll(objects)).toEqual([false, false, false, false]);
      await admin.query(
        'UPDATE tenant_object_purge SET available_at=clock_timestamp() WHERE athlete_id=$1',
        [erased],
      );
      expect(await drainPurges()).not.toContain('lease_lost');
      expect(await leaseState(erased)).toMatchObject({ attempts: 100 });

      // The table itself refuses the silent state: out of attempts, unleased, unlabelled.
      await expect(
        admin.query('UPDATE tenant_object_purge SET last_error_code=NULL WHERE athlete_id=$1', [
          erased,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        admin.query(
          "UPDATE tenant_object_purge SET last_error_code='LEASE_EXPIRED' WHERE athlete_id=$1",
          [erased],
        ),
      ).rejects.toMatchObject({ code: '23514' });

      // An erasure replay re-arms it from scratch (the operator's recovery path), and it runs.
      const restored = await rowlessObjects(erased);
      await replayErasure(erased);
      expect(await leaseState(erased)).toMatchObject({ attempts: 0, last_error_code: null });
      await drainPurges();
      expect(await statAll(restored)).toEqual([false, false, false, false]);
      expect(await leaseState(erased)).toMatchObject({ passes: 1, last_error_code: null });
    });

    it('never dead-letters a 100th attempt whose lease is still running', async () => {
      const erased = randomUUID();
      const objects = await rowlessObjects(erased);
      await operations.eraseAccount(erased);
      await dueFirst(erased, 99);
      const now = new Date();
      const last = await cleanup.leaseTenantObjectPurge(now, new Date(now.getTime() + 60_000));
      expect(last).toEqual({ tenantId: erased, attempts: 100 });
      // Another worker's lease call meanwhile: the running last attempt keeps its lease.
      await drainPurges();
      expect(await leaseState(erased)).toMatchObject({ attempts: 100, last_error_code: null });
      expect((await leaseState(erased))?.lease_owner).not.toBeNull();
      // So it can still finish, and a finished pass puts it back in rotation.
      for (const key of objects) await storage.delete(key);
      expect(
        await cleanup.finishTenantObjectPurge(last ?? { tenantId: erased, attempts: 100 }, {
          ok: true,
          purged: 4,
          unrecognized: 0,
          more: false,
        }),
      ).toBe(true);
      expect(await leaseState(erased)).toMatchObject({ attempts: 0, passes: 1 });
    });

    it('still dead-letters a failed 100th attempt with its own code', async () => {
      const erased = randomUUID();
      await rowlessObjects(erased);
      await operations.eraseAccount(erased);
      await dueFirst(erased, 99);
      const unsafe = Object.assign(new Error('root swapped'), { code: 'UNSAFE_STORAGE_PATH' });
      const failing: PurgedStorage = {
        ...purgeStorage(storage),
        delete: async () => Promise.reject(unsafe),
      };
      expect(await processOneTenantObjectPurge(cleanup, failing)).toBe('retry_scheduled');
      expect(await leaseState(erased)).toMatchObject({
        attempts: 100,
        last_error_code: 'DEAD_LETTER:UNSAFE_STORAGE_PATH',
        lease_owner: null,
      });
    });
  });

  it('runs up to ten purges in one invocation, one lease at a time, and stops at a failure (M2-01z)', async () => {
    await drainPurges();
    const tenants = Array.from({ length: 12 }, () => randomUUID());
    const objects = new Map<string, ObjectKey[]>();
    for (const tenant of tenants) {
      objects.set(tenant, await rowlessObjects(tenant));
      await operations.eraseAccount(tenant);
    }
    const outcomes = await processTenantObjectPurges(cleanup, purgeStorage(storage));
    expect(outcomes).toEqual(Array.from({ length: 10 }, () => 'passed'));
    const gone = await Promise.all(
      tenants.map(async (tenant) => (await statAll(objects.get(tenant) ?? [])).every((x) => !x)),
    );
    expect(gone.filter(Boolean)).toHaveLength(10);
    // The next invocation takes the other two and stops at "nothing due".
    expect(await processTenantObjectPurges(cleanup, purgeStorage(storage))).toEqual([
      'passed',
      'passed',
      'empty',
    ]);
    for (const tenant of tenants)
      expect(await statAll(objects.get(tenant) ?? [])).toEqual([false, false, false, false]);

    // A failing run ends the batch: the second tenant is not leased in this invocation.
    const first = randomUUID();
    const second = randomUUID();
    await rowlessObjects(first);
    await rowlessObjects(second);
    await operations.eraseAccount(first);
    await operations.eraseAccount(second);
    const unsafe = Object.assign(new Error('root swapped'), { code: 'UNSAFE_STORAGE_PATH' });
    const failing: PurgedStorage = {
      ...purgeStorage(storage),
      delete: async () => Promise.reject(unsafe),
    };
    expect(await processTenantObjectPurges(cleanup, failing)).toEqual(['retry_scheduled']);
    const attempts = await admin.query<{ athlete_id: string; attempts: number }>(
      'SELECT athlete_id,attempts FROM tenant_object_purge WHERE athlete_id IN ($1,$2)',
      [first, second],
    );
    expect(attempts.rows.map((row) => row.attempts).sort()).toEqual([0, 1]);
    await drainPurges();
  });

  it('stops at a root swapped mid-purge, records why, and deletes nothing outside the root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'tenant-purge-swap-'));
    scratch.push(base);
    const root = join(base, 'store');
    const copy = join(base, 'copy');
    const store = await createLocalFilesystemObjectStorage(root);
    const erased = randomUUID();
    const objects = await rowlessObjects(erased, store);
    await operations.eraseAccount(erased);
    await cp(root, copy, { recursive: true });
    let deletes = 0;
    // The swap lands right after the first delete: one-way, as in M2-01o's measurements.
    const swapping: PurgedStorage = {
      ...purgeStorage(store),
      delete: async (key) => {
        await store.delete(validateObjectKey(key));
        deletes += 1;
        if (deletes === 1) {
          renameSync(root, `${root}.moved`);
          symlinkSync(copy, root);
        }
      },
    };
    const outcomes: string[] = [];
    for (let run = 0; run < 500; run += 1) {
      const outcome = await processOneTenantObjectPurge(cleanup, swapping);
      if (outcome === 'empty') break;
      outcomes.push(outcome);
    }
    expect(outcomes).toContain('retry_scheduled');
    expect(deletes).toBe(1);
    // Every object of the copy — the link's target — is still there.
    const inCopy = await Promise.all(
      objects.map((key) =>
        lstat(join(copy, ...String(key).split('/'))).then(
          () => true,
          () => false,
        ),
      ),
    );
    expect(inCopy).toEqual([true, true, true, true]);
    const row = await purgeRow(erased);
    expect(row).toMatchObject({ passes: 0, completed_at: null });
    expect(row?.last_error_code).toBe('UNSAFE_STORAGE_PATH');
    expect(Number(row?.objects_purged)).toBe(1);
  });

  it('adds no lock-order inversion: erasures, replays, purges and the queue together', async () => {
    // A third of the tenants start with an identity account and an (inconsistent) purge row
    // already due, so the lease's refusal label (M2-01z) is written while erasures and replays
    // upsert those same rows. The ledger entry already exists, so erasure never removes
    // those accounts and the rows stay refused: this covers stamping under contention, not a refused
    // row becoming leasable (that path is covered serially by the refusal test).
    const tenants: string[] = [];
    const accountHeld: ObjectKey[] = [];
    for (let index = 0; index < 12; index += 1) {
      if (index % 3 !== 1) {
        tenants.push(randomUUID());
        continue;
      }
      const account = await admin.query<{ athlete_id: string }>(
        `INSERT INTO identity_private.account(issuer,subject) VALUES('https://issuer.test',$1)
         RETURNING athlete_id::text`,
        [randomUUID()],
      );
      const tenant = account.rows[0]?.athlete_id;
      if (!tenant) throw new Error('account was not created');
      tenants.push(tenant);
    }
    for (const [index, tenant] of tenants.entries()) {
      await uploadTrack(tenant);
      // A third hold an open publication fence, so their erasure reads one; the rest are due
      // at once and their purges run inside the contention.
      if (index % 3 === 0) await uploadTrack(tenant, { finalize: false });
      const rowless = await rowlessObjects(tenant);
      if (index % 3 === 1) accountHeld.push(...rowless);
    }
    for (const tenant of tenants.filter((_, index) => index % 3 === 1)) {
      await admin.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [tenant]);
      await admin.query(
        `INSERT INTO tenant_object_purge(athlete_id,armed_at,available_at)
         VALUES($1,clock_timestamp(),clock_timestamp())`,
        [tenant],
      );
    }
    const failures: string[] = [];
    const record = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Losing to an erasure is legitimate; a deadlock is not.
      if (!/ACCOUNT_ERASED|TENANT_ERASED/.test(message)) failures.push(message);
    };
    const erasures = tenants.map(async (tenant, index) => {
      try {
        await operations.eraseAccount(tenant);
        // Half are replayed at once, as a restore would, while the others are still erasing.
        if (index % 2 === 0) await replayErasure(tenant);
      } catch (error) {
        record(error);
      }
    });
    const writers = tenants.map(async (tenant) => {
      try {
        await uploadTrack(tenant);
      } catch (error) {
        record(error);
      }
    });
    const workers = Array.from({ length: 6 }, async () => {
      for (let round = 0; round < 15; round += 1) {
        try {
          // The worker's batch (M2-01z): several leased runs, one at a time.
          await processTenantObjectPurges(cleanup, purgeStorage(storage));
          await processOneResourceObjectCleanup(cleanup, (ref) =>
            storage.delete(validateObjectKey(ref)),
          );
        } catch (error) {
          record(error);
        }
      }
    });
    await Promise.all([...erasures, ...writers, ...workers]);
    expect(failures.filter((message) => /40P01|deadlock/i.test(message))).toEqual([]);
    expect(failures).toEqual([]);
    // The ledger entry already existed, so their erasure never reached the account: still
    // refused, labelled (a replay's re-arm clears the label; the next lease call restores it),
    // and every object of theirs is still there.
    await drainPurges();
    expect((await statAll(accountHeld)).every(Boolean)).toBe(true);
    const refused = await admin.query<{ code: string | null }>(
      'SELECT last_error_code AS code FROM tenant_object_purge WHERE athlete_id=ANY($1)',
      [tenants.filter((_, index) => index % 3 === 1)],
    );
    expect(refused.rows.map((row) => row.code)).toEqual(
      Array.from({ length: 4 }, () => 'INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT'),
    );
  }, 60_000);
});
