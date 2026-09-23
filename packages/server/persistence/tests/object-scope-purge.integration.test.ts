import { createHash, randomUUID } from 'node:crypto';
import { renameSync, symlinkSync } from 'node:fs';
import { cp, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';
import {
  createActivityTrackFinalObjectKey,
  createActivityTrackTemporaryObjectKey,
  createCourseThumbnailFinalObjectKey,
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

import { renderCourseThumbnail } from '@workout/server-courses/thumbnail';

import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import {
  createActivityTrackRepository,
  type ActivityTrackRepository,
} from '../src/activity-tracks.js';
import {
  createCourseThumbnailWorkerRepository,
  type CourseThumbnailWorkerRepository,
} from '../src/course-thumbnails.js';
import {
  createCourseRepository,
  type CourseRepository,
  type PreparedCourseContent,
} from '../src/courses.js';
import { createDatabase, type Database } from '../src/database.js';
import {
  grantActivityTracks,
  grantCourses,
  grantCourseThumbnailWorker,
  grantOperations,
  grantResourceObjectCleanupWorker,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';
import {
  createResourceObjectCleanupRepository,
  processObjectScopePurges,
  processOneObjectScopePurge,
  processOneResourceObjectCleanup,
  processOneTenantObjectPurge,
  reconcileActivityTrackObjects,
  reconcileCourseThumbnailObjects,
  type ResourceObjectCleanupRepository,
  type ScopePurgedStorage,
} from '../src/resource-object-cleanup.js';

/**
 * M2-01y: a deleted activity's object prefix — and the prefix of every course that deletion
 * reclaims — is purged independently of any database row, on a LIVE tenant.
 *
 * The hole this closes is M2-01x's, one level lower. Every other deletion of a deleted
 * activity's objects starts from a row: the tombstone trigger queues the keys the track rows
 * name, the course reclamation queues the keys the picture rows name, the sweeps read their
 * indexes. An object no row names survives all of them, and the tenant is alive, so the tenant
 * purge is never armed. A backup whose object archive is copied after its database dump makes
 * such objects for anything stored in between (the drill has the end-to-end version); here they
 * are written straight into the store, which is the same thing as far as the restored database
 * can tell.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
type Store = ObjectStorage & StoreReachability & TenantObjectEnumeration & ObjectScopeEnumeration;
let database: Database;
let activities: ActivityRepository;
let tracks: ActivityTrackRepository;
let courses: CourseRepository;
let operations: OperationsRepository;
let cleanup: ResourceObjectCleanupRepository;
let renderer: CourseThumbnailWorkerRepository;
let storage: Store;
let objectRoot: string;
const cleanupRole = `scope_purge_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const renderRole = `scope_render_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
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
  await admin.query(`CREATE ROLE "${renderRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${renderRole}"`);
  await grantCourseThumbnailWorker(adminUrl, renderRole);
  renderer = createCourseThumbnailWorkerRepository({ connectionString: roleUrl(renderRole) });
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  activities = createActivityRepository(database);
  tracks = createActivityTrackRepository(database);
  courses = createCourseRepository(database);
  operations = createOperationsRepository(database);
  cleanup = createResourceObjectCleanupRepository({
    connectionString: roleUrl(cleanupRole),
    max: 4,
  });
  objectRoot = await mkdtemp(join(tmpdir(), 'scope-purge-'));
  storage = await createLocalFilesystemObjectStorage(objectRoot);
});

afterAll(async () => {
  await renderer?.close();
  await cleanup?.close();
  await database?.close();
  await admin.end();
  if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

/** The worker's adapter, as `runResourceCleanupWorker` builds it. */
function scopeStorage(store: Store): ScopePurgedStorage {
  return {
    listScopeObjects: (scope, limit) => store.listScopeObjects(scope, limit),
    delete: (key) => store.delete(validateObjectKey(key)),
    stat: (key) => store.stat(validateObjectKey(key)),
  };
}

/** Run scope purges until none is due. Earlier files' deletions share the table; they pass. */
async function drainScopePurges(store = storage): Promise<string[]> {
  const outcomes: string[] = [];
  for (let run = 0; run < 1000; run += 1) {
    const outcome = await processOneObjectScopePurge(cleanup, scopeStorage(store));
    if (outcome === 'empty') return outcomes;
    outcomes.push(outcome);
  }
  throw new Error('scope purges did not drain');
}

/** Everything row-based deletion relies on, run to exhaustion — and the tenant purge too. */
async function drainEveryOtherPath(): Promise<void> {
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
  for (let run = 0; run < 500; run += 1) {
    const outcome = await processOneTenantObjectPurge(cleanup, {
      listTenantObjects: (tenantId, limit) => storage.listTenantObjects(tenantId, limit),
      delete: (key) => storage.delete(validateObjectKey(key)),
      stat: (key) => storage.stat(validateObjectKey(key)),
    });
    if (outcome === 'empty') break;
  }
}

function importInput(): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Scope purge run',
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
 * An activity with a recorded track uploaded through the real lifecycle, its three objects
 * really written. `finalize: false` stops after `prepareObjects`, so the upload holds an open
 * publication fence — a writer that could still publish when the activity is deleted.
 */
async function trackedActivity(
  athleteId: string,
  options: { finalize: boolean } = { finalize: true },
) {
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
    activityId: imported.activityId,
    trackId: reservation.trackId,
    uploadId: reservation.uploadId,
    keys: [raw, normalized, mapPath].map((item) => validateObjectKey(item.storageRef)),
  };
}

/**
 * Objects of one activity that no database row names: a second upload of its track that the
 * restored database never heard of — what a late archive copy brings back. One temporary
 * object and one published final object.
 */
async function rowlessTrackObjects(
  tenantId: string,
  activityId: string,
  store: Store = storage,
): Promise<ObjectKey[]> {
  const parts = { tenantId, activityId, trackId: randomUUID(), uploadId: randomUUID() };
  const pending = createActivityTrackTemporaryObjectKey({ ...parts, artifactKind: 'raw' });
  await store.writeTemporary(pending, bytesOf(`rowless ${pending}`));
  const body = `rowless ${parts.uploadId}`;
  const temporary = createActivityTrackTemporaryObjectKey({ ...parts, artifactKind: 'normalized' });
  const published = createActivityTrackFinalObjectKey({
    ...parts,
    artifactKind: 'normalized',
    sha256: hashOf(body),
    extension: 'json',
  });
  await store.writeTemporary(temporary, bytesOf(body));
  await store.publishTemporary(temporary, published, {
    sha256: hashOf(body),
    sizeBytes: Buffer.byteLength(body),
  });
  return [pending, published];
}

/** Pictures of one course that no database row names: a render the restore never heard of. */
async function rowlessPictures(tenantId: string, courseId: string): Promise<ObjectKey[]> {
  const pending = createCourseThumbnailTemporaryObjectKey({
    tenantId,
    courseId,
    jobId: randomUUID(),
  });
  await storage.writeTemporary(pending, bytesOf(`rowless ${pending}`));
  const body = `<svg>${randomUUID()}</svg>`;
  const temporary = createCourseThumbnailTemporaryObjectKey({
    tenantId,
    courseId,
    jobId: randomUUID(),
  });
  const published = createCourseThumbnailFinalObjectKey({
    tenantId,
    courseId,
    revisionId: randomUUID(),
    sha256: hashOf(body),
  });
  await storage.writeTemporary(temporary, bytesOf(body));
  await storage.publishTemporary(temporary, published, {
    sha256: hashOf(body),
    sizeBytes: Buffer.byteLength(body),
  });
  return [pending, published];
}

async function deleteActivity(athleteId: string, activityId: string): Promise<void> {
  const revision = await admin.query<{ revision: number }>(
    'SELECT revision FROM activity_canonical WHERE athlete_id=$1 AND id=$2',
    [athleteId, activityId],
  );
  await activities.deleteActivity(athleteId, activityId, {
    expectedRevision: revision.rows[0]?.revision ?? 0,
  });
}

/** A replayed deletion onto a restored row, as the drill replays it: admin, straight SQL. */
async function replayTombstone(athleteId: string, activityId: string): Promise<void> {
  await asTenant(athleteId, (client) =>
    client.query(
      'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
      [athleteId, activityId],
    ),
  );
}

/**
 * Arm (or re-arm) one activity's purge through the internal arming function, as its triggers
 * do. Used where a test is about the purge row itself, not about how a deletion reaches it.
 */
async function arm(athleteId: string, activityId: string) {
  return admin.query<{ armed: boolean }>(
    "SELECT public.arm_object_scope_purge($1,'activity',$2) AS armed",
    [athleteId, activityId],
  );
}

/** A tenant the restored cluster knows: it has an identity account. */
async function knownTenant(): Promise<string> {
  const account = await admin.query<{ athlete_id: string }>(
    `INSERT INTO identity_private.account(issuer,subject) VALUES('https://issuer.test',$1)
     RETURNING athlete_id::text`,
    [randomUUID()],
  );
  const athleteId = account.rows[0]?.athlete_id;
  if (!athleteId) throw new Error('account was not created');
  return athleteId;
}

type LedgerEntry = {
  athleteId: string;
  activityId: string;
  kind: string | null;
  sourceId: string | null;
  sourceRevision: number | null;
  revision: number | null;
  contentHash: string | null;
};

function ledgerEntry(athleteId: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    athleteId,
    activityId: randomUUID(),
    kind: 'fit',
    sourceId: randomUUID(),
    sourceRevision: 1,
    revision: 2,
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

/**
 * Replaying a deletion-ledger entry whose activity the restored cluster does not hold, as the
 * restore does: the admin connection, the tenant's session, one transaction.
 */
async function replayAbsent(entry: LedgerEntry, session = entry.athleteId) {
  return asTenant(session, (client) => replayAbsentIn(client, entry));
}

function replayAbsentIn(client: PoolClient, entry: LedgerEntry) {
  return client.query<{ replayed: boolean }>(
    'SELECT public.replay_absent_activity_deletion($1,$2,$3,$4,$5,$6,$7) AS replayed',
    [
      entry.athleteId,
      entry.activityId,
      entry.kind,
      entry.sourceId,
      entry.sourceRevision,
      entry.revision,
      entry.contentHash,
    ],
  );
}

/** A device re-sync of the ledger entry's source after the restore. */
async function reimport(entry: LedgerEntry) {
  return activities.importActivity(entry.athleteId, {
    ...importInput(),
    source: {
      kind: 'fit',
      sourceId: entry.sourceId ?? '',
      revision: entry.sourceRevision ?? 1,
      contentHash: entry.contentHash ?? '',
    },
  });
}

async function activityRows(athleteId: string): Promise<number> {
  const rows = await admin.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM activity_canonical WHERE athlete_id=$1',
    [athleteId],
  );
  return rows.rows[0]?.count ?? -1;
}

async function asTenant<T>(session: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [session]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function courseContent(activityId: string, trackId: string, name: string): PreparedCourseContent {
  const line: [number, number][] = [
    [126.9779, 37.5665],
    [126.9789, 37.5668],
    [126.9799, 37.5671],
  ];
  const lineage = [{ activityId, trackId, trackRevision: 1 }];
  return {
    name,
    coordinates: line,
    waypoints: [
      {
        role: 'start',
        position: line[0] as [number, number],
        name: null,
        sourceSampleId: '0:0',
        locked: false,
      },
      {
        role: 'finish',
        position: line[2] as [number, number],
        name: null,
        sourceSampleId: '0:2',
        locked: false,
      },
    ],
    generation: {
      kind: 'recorded-segment',
      activityId,
      trackId,
      trackRevision: 1,
      lineIndex: 0,
      segmentIndex: 0,
      startSampleId: '0:0',
      endSampleId: '0:2',
      vertexCount: line.length,
      mapPathContentSha256: 'a'.repeat(64),
      simplificationVersion: 1,
      toleranceMeters: 2.5,
    },
    edit: { kind: 'created' },
    lineage,
    distanceMeters: 180.25,
    contentDigest: hashOf(JSON.stringify([name, line, lineage])),
  };
}

async function courseOf(athleteId: string, activityId: string, trackId: string): Promise<string> {
  const created = await courses.create(
    athleteId,
    courseContent(activityId, trackId, `Course ${randomUUID()}`),
    `course-${randomUUID()}`,
  );
  if (created.status !== 'available') throw new Error('course was not created');
  return created.course.courseId;
}

type ScopeRow = {
  armed_at: Date;
  available_at: Date;
  passes: number;
  objects_purged: string;
  completed_at: Date | null;
  last_error_code: string | null;
  attempts: number;
};

async function scopeRow(
  athleteId: string,
  kind: 'activity' | 'course',
  id: string,
): Promise<ScopeRow | undefined> {
  const rows = await admin.query<ScopeRow>(
    `SELECT armed_at,available_at,passes,objects_purged,completed_at,last_error_code,attempts
     FROM object_scope_purge WHERE athlete_id=$1 AND scope_kind=$2 AND scope_id::text=$3`,
    [athleteId, kind, id],
  );
  return rows.rows[0];
}

const statAll = async (keys: readonly ObjectKey[], store: Store = storage) =>
  Promise.all(keys.map(async (key) => (await store.stat(key)) !== null));

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe('deleted activity and reclaimed course object-prefix purge (M2-01y)', () => {
  it('purges what no row names under a deleted activity, and nothing of anyone else', async () => {
    const tenant = randomUUID();
    const neighbour = randomUUID();
    const doomed = await trackedActivity(tenant);
    const live = await trackedActivity(tenant);
    const doomedRowless = await rowlessTrackObjects(tenant, doomed.activityId);
    const liveRowless = await rowlessTrackObjects(tenant, live.activityId);
    // The same activity id under another tenant, and the tenant's own objects of another
    // family whose owner id is the activity's.
    const neighbourRowless = await rowlessTrackObjects(neighbour, doomed.activityId);
    const otherFamily = createTemporaryObjectKey({
      tenantId: tenant,
      resourceId: doomed.activityId,
      uploadId: randomUUID(),
    });
    await storage.writeTemporary(otherFamily, bytesOf('another family'));
    const tenantPicture = await rowlessPictures(tenant, doomed.activityId);

    await deleteActivity(tenant, doomed.activityId);
    await drainEveryOtherPath();
    // The hole, on the real store and the real database: the rows' own keys are gone, and
    // the keys no row named are still there after the queue, both sweeps and the tenant purge
    // (which is not armed: the tenant is alive).
    expect(await statAll(doomed.keys)).toEqual([false, false, false]);
    expect(await statAll(doomedRowless)).toEqual([true, true]);

    expect(await drainScopePurges()).toContain('passed');
    expect(await statAll(doomedRowless)).toEqual([false, false]);
    // Nothing else moved: the tenant's live activity (rows and no rows), the neighbour's
    // same-id directory, the tenant's other families under the same owner id.
    expect(await statAll(live.keys)).toEqual([true, true, true]);
    expect(await statAll(liveRowless)).toEqual([true, true]);
    expect(await statAll(neighbourRowless)).toEqual([true, true]);
    expect(await statAll([otherFamily, ...tenantPicture])).toEqual([true, true, true]);
    // The directories siblings share survive: the tenant's and its `activities` directory.
    expect(await present(join(objectRoot, 'private', 'v1', 'tenants', tenant, 'activities'))).toBe(
      true,
    );
    const row = await scopeRow(tenant, 'activity', doomed.activityId);
    expect(row).toMatchObject({ passes: 1, last_error_code: null, attempts: 0 });
    expect(row?.completed_at).not.toBeNull();
    expect(Number(row?.objects_purged)).toBe(2);
    expect(await scopeRow(tenant, 'activity', live.activityId)).toBeUndefined();
  });

  it('is armed by a replayed tombstone, and rebuilt and suppressed for an activity the restore does not hold', async () => {
    const tenant = await knownTenant();
    // (a) In the restored cluster, live and trackless; its track came back only as objects.
    const restored = await activities.importActivity(tenant, importInput());
    const restoredRowless = await rowlessTrackObjects(tenant, restored.activityId);
    // (b) Not in the restored cluster at all: only the ledger knows it.
    const absent = ledgerEntry(tenant);
    const absentRowless = await rowlessTrackObjects(tenant, absent.activityId);

    await replayTombstone(tenant, restored.activityId);
    expect((await replayAbsent(absent)).rows).toEqual([{ replayed: true }]);
    await drainEveryOtherPath();
    expect(await statAll([...restoredRowless, ...absentRowless])).toEqual([true, true, true, true]);
    await drainScopePurges();
    expect(await statAll([...restoredRowless, ...absentRowless])).toEqual([
      false,
      false,
      false,
      false,
    ]);
    for (const id of [restored.activityId, absent.activityId])
      expect(await scopeRow(tenant, 'activity', id)).toMatchObject({ passes: 1 });

    // The source of (b) stays suppressed: a re-sync after the restore answers `suppressed`
    // for the same activity and creates no activity row. What was rebuilt carries no activity
    // values — only what suppression needs.
    const before = await activityRows(tenant);
    const again = await reimport(absent);
    expect(again).toMatchObject({ outcome: 'suppressed', activityId: absent.activityId });
    expect(await activityRows(tenant)).toBe(before);
    expect(await activities.getActivity(tenant, absent.activityId)).toBeNull();
    const rebuilt = await admin.query(
      `SELECT c.revision,c.original,c.deleted,s.source_revision,s.content_hash,
         EXISTS(SELECT 1 FROM activity_suppression d WHERE d.athlete_id=s.athlete_id
           AND d.kind=s.kind AND d.source_id=s.source_id) AS suppressed
       FROM activity_canonical c JOIN activity_source_head s
         ON s.athlete_id=c.athlete_id AND s.activity_id=c.id
       WHERE c.athlete_id=$1 AND c.id=$2`,
      [tenant, absent.activityId],
    );
    expect(rebuilt.rows).toEqual([
      {
        revision: 2,
        original: {},
        deleted: true,
        source_revision: 1,
        content_hash: 'a'.repeat(64),
        suppressed: true,
      },
    ]);
  });

  describe('refuses a ledger entry it cannot verify, and writes nothing', () => {
    async function refused(entry: LedgerEntry, code: RegExp, session?: string) {
      await expect(replayAbsent(entry, session)).rejects.toThrow(code);
      // Rolled back whole: no source head for the entry's activity, no purge.
      const written = await admin.query(
        `SELECT 1 FROM activity_source_head WHERE athlete_id=$1 AND source_id=$2
           AND activity_id::text=$3
         UNION ALL SELECT 1 FROM object_scope_purge WHERE athlete_id=$1 AND scope_id::text=$3`,
        [entry.athleteId, entry.sourceId, entry.activityId],
      );
      expect(written.rowCount).toBe(0);
    }

    it('another tenant’s session', async () => {
      const tenant = await knownTenant();
      await refused(ledgerEntry(tenant), /ACTIVITY_REPLAY_TENANT_MISMATCH/, await knownTenant());
    });

    it('a tenant or activity id that is not canonical', async () => {
      const tenant = await knownTenant();
      await refused(
        ledgerEntry(tenant.toUpperCase()),
        /ACTIVITY_REPLAY_INVALID_ID/,
        tenant.toUpperCase(),
      );
      await refused(
        ledgerEntry(tenant, { activityId: '00000000-0000-0000-0000-000000000000' }),
        /ACTIVITY_REPLAY_INVALID_ID/,
      );
    });

    it('a malformed entry', async () => {
      const tenant = await knownTenant();
      const malformed: Partial<LedgerEntry>[] = [
        { kind: 'manual' },
        { kind: null },
        { sourceId: '' },
        { sourceId: 'x'.repeat(201) },
        { sourceRevision: 0 },
        { sourceRevision: null },
        { revision: 0 },
        { contentHash: 'A'.repeat(64) },
        { contentHash: null },
      ];
      for (const overrides of malformed)
        await refused(ledgerEntry(tenant, overrides), /ACTIVITY_REPLAY_INVALID_ENTRY/);
    });

    it('an erased tenant, and a tenant the restored cluster does not know', async () => {
      const erased = await knownTenant();
      await operations.eraseAccount(erased);
      await refused(ledgerEntry(erased), /ACTIVITY_REPLAY_TENANT_ERASED/);
      await refused(ledgerEntry(randomUUID()), /ACTIVITY_REPLAY_TENANT_UNKNOWN/);
    });

    it('an activity the restored cluster holds — this tenant’s or another’s', async () => {
      const tenant = await knownTenant();
      const live = await trackedActivity(tenant);
      const liveRowless = await rowlessTrackObjects(tenant, live.activityId);
      await refused(
        ledgerEntry(tenant, { activityId: live.activityId }),
        /ACTIVITY_REPLAY_ACTIVITY_PRESENT/,
      );
      const other = await knownTenant();
      await refused(
        ledgerEntry(other, { activityId: live.activityId }),
        /ACTIVITY_REPLAY_FOREIGN_ACTIVITY/,
      );
      await drainScopePurges();
      expect(await statAll([...live.keys, ...liveRowless])).toEqual([true, true, true, true, true]);
      expect(await scopeRow(tenant, 'activity', live.activityId)).toBeUndefined();
    });

    it('a source the restored cluster already knows under another activity', async () => {
      const tenant = await knownTenant();
      const known = importInput();
      await activities.importActivity(tenant, known);
      await refused(
        ledgerEntry(tenant, { sourceId: known.source.sourceId }),
        /ACTIVITY_REPLAY_SOURCE_CONFLICT/,
      );
    });

    it('one refused entry rolls back the whole replay', async () => {
      const tenant = await knownTenant();
      const good = ledgerEntry(tenant);
      const bad = ledgerEntry(tenant, { contentHash: 'nope' });
      await expect(
        asTenant(tenant, async (client) => {
          await replayAbsentIn(client, good);
          await replayAbsentIn(client, bad);
        }),
      ).rejects.toThrow(/ACTIVITY_REPLAY_INVALID_ENTRY/);
      expect(await activityRows(tenant)).toBe(0);
      expect(await scopeRow(tenant, 'activity', good.activityId)).toBeUndefined();
    });
  });

  it('waits for a render still publishing when the deletion reclaims its course', async () => {
    const tenant = randomUUID();
    const activity = await trackedActivity(tenant);
    const course = await courseOf(tenant, activity.activityId, activity.trackId);
    // The course's render, leased and prepared: its publication window is open when the
    // activity is deleted, so the picture may still appear after the reclamation.
    let lease: Awaited<ReturnType<CourseThumbnailWorkerRepository['lease']>> = null;
    for (let attempt = 0; attempt < 200 && lease === null; attempt += 1) {
      const next = await renderer.lease(60);
      if (next === null) break;
      if (next.courseId === course) lease = next;
    }
    if (lease === null) throw new Error('the course render was not leased');
    const drawn = renderCourseThumbnail(lease.coordinates);
    expect(
      await renderer.prepare(lease, {
        storageRef: createCourseThumbnailFinalObjectKey({
          tenantId: tenant,
          courseId: course,
          revisionId: lease.revisionId,
          sha256: drawn.sha256,
        }),
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).toBe(true);
    const fence = await admin.query<{ fence: Date }>(
      `SELECT greatest(publication_lease_until+interval '1 hour',lease_until+interval '1 hour')
         AS fence FROM course_thumbnail WHERE job_id=$1`,
      [lease.jobId],
    );
    const renderFence = fence.rows[0]?.fence;
    if (!renderFence) throw new Error('the render holds no fence');
    expect(renderFence.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);

    await deleteActivity(tenant, activity.activityId);
    const row = await scopeRow(tenant, 'course', course);
    expect(row?.available_at.getTime()).toBeGreaterThanOrEqual(renderFence.getTime());
    await drainScopePurges();
    expect(await scopeRow(tenant, 'course', course)).toMatchObject({
      passes: 0,
      completed_at: null,
    });
  });

  it('purges the pictures of every course the deletion reclaims, and no live course’s', async () => {
    const tenant = randomUUID();
    const doomed = await trackedActivity(tenant);
    const kept = await trackedActivity(tenant);
    const doomedCourse = await courseOf(tenant, doomed.activityId, doomed.trackId);
    const keptCourse = await courseOf(tenant, kept.activityId, kept.trackId);
    const doomedPictures = await rowlessPictures(tenant, doomedCourse);
    const keptPictures = await rowlessPictures(tenant, keptCourse);

    await deleteActivity(tenant, doomed.activityId);
    await drainEveryOtherPath();
    expect(await statAll(doomedPictures)).toEqual([true, true]);
    await drainScopePurges();
    expect(await statAll(doomedPictures)).toEqual([false, false]);
    expect(await statAll(keptPictures)).toEqual([true, true]);
    expect(await statAll(kept.keys)).toEqual([true, true, true]);
    expect(await scopeRow(tenant, 'course', doomedCourse)).toMatchObject({ passes: 1 });
    expect(await scopeRow(tenant, 'course', keptCourse)).toBeUndefined();
  });

  describe('never deletes under a live owner', () => {
    it('does not lease an activity that is present and not deleted, whatever armed it', async () => {
      const tenant = randomUUID();
      const live = await trackedActivity(tenant);
      const liveRowless = await rowlessTrackObjects(tenant, live.activityId);
      await admin.query(
        `INSERT INTO object_scope_purge(athlete_id,scope_kind,scope_id,armed_at,available_at)
         VALUES($1,'activity',$2,clock_timestamp(),clock_timestamp())`,
        [tenant, live.activityId],
      );
      await drainScopePurges();
      expect(await statAll([...live.keys, ...liveRowless])).toEqual([true, true, true, true, true]);
      // Refused, and labelled once as the inconsistent ledger it is (N5): not charged.
      expect(await scopeRow(tenant, 'activity', live.activityId)).toMatchObject({
        passes: 0,
        attempts: 0,
        completed_at: null,
        last_error_code: 'INCONSISTENT_LEDGER:ACTIVITY_LIVE',
      });
      // The same row, once the activity is deleted, is re-armed by the tombstone (the label
      // cleared) and purged: the refusal was the activity.
      await deleteActivity(tenant, live.activityId);
      expect(await scopeRow(tenant, 'activity', live.activityId)).toMatchObject({
        last_error_code: null,
      });
      await drainEveryOtherPath();
      await drainScopePurges();
      expect(await statAll(liveRowless)).toEqual([false, false]);
    });

    it('does not lease a course that is present and available, whatever armed it', async () => {
      const tenant = randomUUID();
      const activity = await trackedActivity(tenant);
      const course = await courseOf(tenant, activity.activityId, activity.trackId);
      const pictures = await rowlessPictures(tenant, course);
      await admin.query(
        `INSERT INTO object_scope_purge(athlete_id,scope_kind,scope_id,armed_at,available_at)
         VALUES($1,'course',$2,clock_timestamp(),clock_timestamp())`,
        [tenant, course],
      );
      await drainScopePurges();
      expect(await statAll(pictures)).toEqual([true, true]);
      expect(await scopeRow(tenant, 'course', course)).toMatchObject({
        passes: 0,
        attempts: 0,
        last_error_code: 'INCONSISTENT_LEDGER:COURSE_AVAILABLE',
      });
    });

    it('never un-deletes an activity, so a leased scope cannot come back to life', async () => {
      const tenant = randomUUID();
      const activity = await trackedActivity(tenant);
      await deleteActivity(tenant, activity.activityId);
      await expect(
        admin.query('UPDATE activity_canonical SET deleted=false WHERE athlete_id=$1 AND id=$2', [
          tenant,
          activity.activityId,
        ]),
      ).rejects.toThrow(/ACTIVITY_TOMBSTONE_TERMINAL/);
    });

    it('arms nothing for a tenant or owner id that is not canonical', async () => {
      const legacy = 'legacy-scope-tenant';
      const imported = await activities.importActivity(legacy, importInput());
      await deleteActivity(legacy, imported.activityId);
      expect(await scopeRow(legacy, 'activity', imported.activityId)).toBeUndefined();
      const tenant = randomUUID();
      const nil = '00000000-0000-0000-0000-000000000000';
      expect((await arm(tenant, nil)).rows).toEqual([{ armed: false }]);
      expect(await scopeRow(tenant, 'activity', nil)).toBeUndefined();
      for (const [athlete, id] of [
        [tenant.toUpperCase(), randomUUID()],
        [tenant, nil],
      ])
        await expect(
          admin.query(
            `INSERT INTO object_scope_purge(athlete_id,scope_kind,scope_id,armed_at,available_at)
             VALUES($1,'activity',$2,clock_timestamp(),clock_timestamp())`,
            [athlete, id],
          ),
        ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('waits for an in-flight writer’s publication fence before its pass', async () => {
    const tenant = randomUUID();
    const upload = await trackedActivity(tenant, { finalize: false });
    const fence = await admin.query<{ fence: Date }>(
      `SELECT publication_lease_until+interval '1 hour' AS fence
       FROM activity_track_upload_intent WHERE athlete_id=$1 AND upload_id=$2`,
      [tenant, upload.uploadId],
    );
    await deleteActivity(tenant, upload.activityId);
    const row = await scopeRow(tenant, 'activity', upload.activityId);
    expect(row?.available_at.getTime()).toBeGreaterThanOrEqual(
      (fence.rows[0]?.fence ?? new Date(8.64e15)).getTime(),
    );
    await drainScopePurges();
    expect(await scopeRow(tenant, 'activity', upload.activityId)).toMatchObject({ passes: 0 });
  });

  it('re-arming reopens a closed purge now and never pulls an open one earlier', async () => {
    const tenant = randomUUID();
    const closed = randomUUID();
    const open = randomUUID();
    await arm(tenant, closed);
    await drainScopePurges();
    expect((await scopeRow(tenant, 'activity', closed))?.completed_at).not.toBeNull();
    await arm(tenant, open);
    await admin.query(
      `UPDATE object_scope_purge SET available_at=clock_timestamp()+interval '2 hours'
       WHERE athlete_id=$1 AND scope_id=$2`,
      [tenant, open],
    );
    const openBefore = await scopeRow(tenant, 'activity', open);

    const late = await rowlessTrackObjects(tenant, closed);
    await arm(tenant, closed);
    await arm(tenant, open);
    expect(await scopeRow(tenant, 'activity', closed)).toMatchObject({
      completed_at: null,
      passes: 0,
    });
    expect((await scopeRow(tenant, 'activity', open))?.available_at.getTime()).toBe(
      openBefore?.available_at.getTime(),
    );
    await drainScopePurges();
    expect(await statAll(late)).toEqual([false, false]);
  });

  describe('a run that outlives its lease (N5)', () => {
    /**
     * A store whose listing takes longer than the lease: the lease is made to run out (on the
     * database clock, as two minutes would) while the listing is in progress, so the run's
     * `finish` is refused exactly as a real slow run's would be.
     */
    function outlivingStorage(tenant: string, activityId: string): ScopePurgedStorage {
      return {
        ...scopeStorage(storage),
        listScopeObjects: async (scope, limit) => {
          await admin.query(
            `UPDATE object_scope_purge SET lease_until=clock_timestamp()-interval '1 second'
             WHERE athlete_id=$1 AND scope_id::text=$2 AND lease_owner IS NOT NULL`,
            [tenant, activityId],
          );
          return storage.listScopeObjects(scope, limit);
        },
      };
    }

    /** Makes this scope's purge the first due one, at the given attempt count. */
    async function dueFirst(tenant: string, activityId: string, attempts: number): Promise<void> {
      await admin.query(
        `UPDATE object_scope_purge SET available_at=clock_timestamp()+interval '1 day'
         WHERE athlete_id=$1 AND scope_id::text=$2`,
        [tenant, activityId],
      );
      await drainScopePurges();
      await admin.query(
        `UPDATE object_scope_purge SET attempts=$3,
           available_at=clock_timestamp()-interval '10 years'
         WHERE athlete_id=$1 AND scope_id::text=$2`,
        [tenant, activityId, attempts],
      );
    }

    type LeaseState = ScopeRow & { lease_owner: string | null };
    async function leaseState(tenant: string, activityId: string): Promise<LeaseState | undefined> {
      const rows = await admin.query<LeaseState>(
        `SELECT armed_at,available_at,passes,objects_purged,completed_at,last_error_code,attempts,
           lease_owner FROM object_scope_purge
         WHERE athlete_id=$1 AND scope_kind='activity' AND scope_id::text=$2`,
        [tenant, activityId],
      );
      return rows.rows[0];
    }

    /** A deleted activity with objects no row names, armed and due. */
    async function armedScope() {
      const tenant = randomUUID();
      const activityId = randomUUID();
      const objects = await rowlessTrackObjects(tenant, activityId);
      await arm(tenant, activityId);
      return { tenant, activityId, objects };
    }

    it('labels the lost attempt when its lease is taken over, and a finished run clears it', async () => {
      const { tenant, activityId, objects } = await armedScope();
      await dueFirst(tenant, activityId, 0);
      expect(await processOneObjectScopePurge(cleanup, outlivingStorage(tenant, activityId))).toBe(
        'lease_lost',
      );
      expect(await leaseState(tenant, activityId)).toMatchObject({
        attempts: 1,
        last_error_code: null,
      });
      const taken = await cleanup.leaseObjectScopePurge(new Date(), new Date(Date.now() + 1000));
      expect(taken).toEqual({
        scope: { kind: 'activity', tenantId: tenant, activityId },
        attempts: 2,
      });
      expect(await leaseState(tenant, activityId)).toMatchObject({
        last_error_code: 'LEASE_EXPIRED',
      });
      await admin.query(
        `UPDATE object_scope_purge SET lease_until=clock_timestamp()-interval '1 second'
         WHERE athlete_id=$1 AND scope_id::text=$2`,
        [tenant, activityId],
      );
      await drainScopePurges();
      expect(await statAll(objects)).toEqual([false, false]);
      expect(await leaseState(tenant, activityId)).toMatchObject({
        attempts: 0,
        passes: 1,
        last_error_code: null,
        lease_owner: null,
      });
    });

    it('dead-letters a purge whose 100th attempt lost its lease, labelled, never NULL', async () => {
      const { tenant, activityId } = await armedScope();
      await dueFirst(tenant, activityId, 99);
      expect(await processOneObjectScopePurge(cleanup, outlivingStorage(tenant, activityId))).toBe(
        'lease_lost',
      );
      const lost = await leaseState(tenant, activityId);
      expect(lost).toMatchObject({ attempts: 100 });
      expect(lost?.lease_owner).not.toBeNull();
      // Any later lease call dead-letters it, labelled, and clears the stale lease.
      await drainScopePurges();
      expect(await leaseState(tenant, activityId)).toMatchObject({
        attempts: 100,
        completed_at: null,
        passes: 0,
        last_error_code: 'DEAD_LETTER:LEASE_EXPIRED',
        lease_owner: null,
      });
      // Out of rotation: never leased again.
      await admin.query(
        'UPDATE object_scope_purge SET available_at=clock_timestamp() WHERE athlete_id=$1',
        [tenant],
      );
      expect(await drainScopePurges()).not.toContain('lease_lost');
      expect(await leaseState(tenant, activityId)).toMatchObject({ attempts: 100 });
      // The table refuses the silent state: out of attempts, unleased, unlabelled.
      for (const code of [null, 'LEASE_EXPIRED'])
        await expect(
          admin.query('UPDATE object_scope_purge SET last_error_code=$2 WHERE athlete_id=$1', [
            tenant,
            code,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
      // Re-arming (a replayed deletion) puts it back in rotation from scratch.
      const restored = await rowlessTrackObjects(tenant, activityId);
      await arm(tenant, activityId);
      expect(await leaseState(tenant, activityId)).toMatchObject({
        attempts: 0,
        last_error_code: null,
      });
      await drainScopePurges();
      expect(await statAll(restored)).toEqual([false, false]);
    });

    it('never dead-letters a 100th attempt whose lease is still running', async () => {
      const { tenant, activityId } = await armedScope();
      await dueFirst(tenant, activityId, 99);
      const now = new Date();
      const last = await cleanup.leaseObjectScopePurge(now, new Date(now.getTime() + 60_000));
      expect(last).toMatchObject({ attempts: 100 });
      await drainScopePurges();
      expect(await leaseState(tenant, activityId)).toMatchObject({
        attempts: 100,
        last_error_code: null,
      });
      expect((await leaseState(tenant, activityId))?.lease_owner).not.toBeNull();
      if (!last) throw new Error('not leased');
      expect(
        await cleanup.finishObjectScopePurge(last, {
          ok: true,
          purged: 0,
          unrecognized: 0,
          more: false,
        }),
      ).toBe(true);
      expect(await leaseState(tenant, activityId)).toMatchObject({ attempts: 0, passes: 1 });
    });

    it('still dead-letters a failed 100th attempt with its own code', async () => {
      const { tenant, activityId } = await armedScope();
      await dueFirst(tenant, activityId, 99);
      const unsafe = Object.assign(new Error('root swapped'), { code: 'UNSAFE_STORAGE_PATH' });
      const failing: ScopePurgedStorage = {
        ...scopeStorage(storage),
        delete: async () => Promise.reject(unsafe),
      };
      expect(await processOneObjectScopePurge(cleanup, failing)).toBe('retry_scheduled');
      expect(await leaseState(tenant, activityId)).toMatchObject({
        attempts: 100,
        last_error_code: 'DEAD_LETTER:UNSAFE_STORAGE_PATH',
        lease_owner: null,
      });
    });
  });

  it('runs up to twenty scope purges in one invocation, one lease at a time, and stops at a failure (N4)', async () => {
    await drainScopePurges();
    const tenant = randomUUID();
    const scopes = Array.from({ length: 25 }, () => randomUUID());
    const objects = new Map<string, ObjectKey[]>();
    for (const activityId of scopes) {
      objects.set(activityId, await rowlessTrackObjects(tenant, activityId));
      await arm(tenant, activityId);
    }
    const outcomes = await processObjectScopePurges(cleanup, scopeStorage(storage));
    expect(outcomes).toEqual(Array.from({ length: 20 }, () => 'passed'));
    const gone = await Promise.all(
      scopes.map(async (id) => (await statAll(objects.get(id) ?? [])).every((x) => !x)),
    );
    expect(gone.filter(Boolean)).toHaveLength(20);
    expect(await processObjectScopePurges(cleanup, scopeStorage(storage))).toEqual([
      ...Array.from({ length: 5 }, () => 'passed'),
      'empty',
    ]);
    for (const id of scopes) expect(await statAll(objects.get(id) ?? [])).toEqual([false, false]);

    // A failing run ends the batch: the second scope is not leased in this invocation.
    const first = randomUUID();
    const second = randomUUID();
    await rowlessTrackObjects(tenant, first);
    await rowlessTrackObjects(tenant, second);
    await arm(tenant, first);
    await arm(tenant, second);
    const unsafe = Object.assign(new Error('root swapped'), { code: 'UNSAFE_STORAGE_PATH' });
    const failing: ScopePurgedStorage = {
      ...scopeStorage(storage),
      delete: async () => Promise.reject(unsafe),
    };
    expect(await processObjectScopePurges(cleanup, failing)).toEqual(['retry_scheduled']);
    const attempts = await admin.query<{ attempts: number }>(
      'SELECT attempts FROM object_scope_purge WHERE athlete_id=$1 AND scope_id=ANY($2::uuid[])',
      [tenant, [first, second]],
    );
    expect(attempts.rows.map((row) => row.attempts).sort()).toEqual([0, 1]);
    await drainScopePurges();
  });

  it('stops at a root swapped mid-purge, records why, and deletes nothing outside the root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'scope-purge-swap-'));
    scratch.push(base);
    const root = join(base, 'store');
    const copy = join(base, 'copy');
    const store = await createLocalFilesystemObjectStorage(root);
    const tenant = randomUUID();
    const absent = randomUUID();
    const objects = [
      ...(await rowlessTrackObjects(tenant, absent, store)),
      ...(await rowlessTrackObjects(tenant, absent, store)),
    ];
    await arm(tenant, absent);
    await cp(root, copy, { recursive: true });
    let deletes = 0;
    // The swap lands right after the first delete: one-way, as in M2-01o's measurements.
    const swapping: ScopePurgedStorage = {
      ...scopeStorage(store),
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
    for (let run = 0; run < 1000; run += 1) {
      const outcome = await processOneObjectScopePurge(cleanup, swapping);
      if (outcome === 'empty') break;
      outcomes.push(outcome);
    }
    expect(outcomes).toContain('retry_scheduled');
    expect(deletes).toBe(1);
    const inCopy = await Promise.all(
      objects.map((key) => present(join(copy, ...String(key).split('/')))),
    );
    expect(inCopy).toEqual([true, true, true, true]);
    const row = await scopeRow(tenant, 'activity', absent);
    expect(row).toMatchObject({ passes: 0, completed_at: null });
    expect(row?.last_error_code).toBe('UNSAFE_STORAGE_PATH');
    expect(Number(row?.objects_purged)).toBe(1);
  });

  it('adds no lock-order inversion: deletions, replays, erasures, uploads and every purge together', async () => {
    const tenants: string[] = [];
    for (let index = 0; index < 8; index += 1) tenants.push(await knownTenant());
    const plans = [];
    for (const tenant of tenants) {
      const deleted = await trackedActivity(tenant);
      const replayed = await trackedActivity(tenant);
      const course = await courseOf(tenant, deleted.activityId, deleted.trackId);
      await rowlessTrackObjects(tenant, deleted.activityId);
      await rowlessTrackObjects(tenant, replayed.activityId);
      await rowlessPictures(tenant, course);
      plans.push({ tenant, deleted, replayed });
    }
    const failures: string[] = [];
    const record = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Losing to an erasure, or to the other deletion of the same activity, is legitimate;
      // a deadlock is not.
      if (!/ACCOUNT_ERASED|TENANT_ERASED|ACTIVITY_NOT_FOUND|REVISION_CONFLICT/.test(message))
        failures.push(message);
    };
    const attempt = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        record(error);
      }
    };
    // The restore replays before any runtime access, so its straight SQL takes no command
    // lock; running it here AGAINST live writers needs the lock the repository takes first,
    // or it deadlocks with them on 016's evidence trigger whatever this migration does (seen
    // while writing this test: `purge_core_evidence_source` waits for lock 0 while an erasure
    // or an import holding it waits for the tombstoned row).
    const lockedReplay = (tenant: string, activityId: string) =>
      asTenant(tenant, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenant]);
        await client.query(
          'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [tenant, activityId],
        );
      });
    const writers = plans.flatMap(({ tenant, deleted, replayed }, index) => {
      // Re-armed three times each, concurrently with the workers leasing and finishing them:
      // the one place two writers meet on the same purge row.
      const rearmed = [randomUUID(), randomUUID()];
      return [
        attempt(() => deleteActivity(tenant, deleted.activityId)),
        attempt(() => lockedReplay(tenant, replayed.activityId)),
        ...rearmed.flatMap((id) => [1, 2, 3].map(() => attempt(() => arm(tenant, id)))),
        attempt(() => trackedActivity(tenant)),
        // A restore-style rebuild of an absent activity, under the tenant's command lock.
        attempt(() => replayAbsent(ledgerEntry(tenant))),
        // Half the tenants are erased in the middle of it all.
        index % 2 === 0 ? attempt(() => operations.eraseAccount(tenant)) : Promise.resolve(),
      ];
    });
    const workers = Array.from({ length: 6 }, async () => {
      for (let round = 0; round < 15; round += 1)
        await attempt(async () => {
          await processOneObjectScopePurge(cleanup, scopeStorage(storage));
          await processOneTenantObjectPurge(cleanup, {
            listTenantObjects: (tenantId, limit) => storage.listTenantObjects(tenantId, limit),
            delete: (key) => storage.delete(validateObjectKey(key)),
            stat: (key) => storage.stat(validateObjectKey(key)),
          });
          await processOneResourceObjectCleanup(cleanup, (ref) =>
            storage.delete(validateObjectKey(ref)),
          );
        });
    });
    await Promise.all([...writers, ...workers]);
    expect(failures.filter((message) => /40P01|deadlock/i.test(message))).toEqual([]);
    expect(failures).toEqual([]);
  }, 60_000);
});
