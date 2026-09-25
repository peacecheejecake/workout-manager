import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';
import {
  createActivityTrackFinalObjectKey,
  createActivityTrackTemporaryObjectKey,
  createLocalFilesystemObjectStorage,
  parseObjectKey,
  validateObjectKey,
  type ObjectStorage,
} from '@workout/server-media';

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
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import {
  grantActivityTracks,
  grantCourses,
  grantCourseThumbnailWorker,
  grantGalleryMedia,
  grantOperations,
  grantResourceObjectCleanupWorker,
  grantResources,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';
import {
  createResourceDerivedCleanupRepository,
  createResourceDerivedStorePurge,
  processOneResourceDerivedCleanup,
  type ResourceDerivedCleanupRepository,
} from '../src/resource-derived-cleanup.js';
import { createResourceFileUploadRepository } from '../src/resource-file-uploads.js';
import {
  createResourceObjectCleanupRepository,
  processOneResourceObjectCleanup,
  type ResourceObjectCleanupRepository,
} from '../src/resource-object-cleanup.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * M2-01au: the queue and state paths M2-01at left (its progress §5) on a database whose
 * migration owner is neither superuser nor BYPASSRLS.
 *
 * The whole schema is built by such an owner, which also runs the grant helpers. Runtime,
 * cleanup worker and render worker are the usual plain roles. The superuser connection only
 * looks at rows and plants the ones no path of the system writes.
 *
 * What must hold on that owner:
 *   * the user paths that write the object-cleanup and derived-cleanup queues go through —
 *     deleting an activity that has a track, an upload's protect and supersede, deleting a
 *     resource or a gallery item, and erasing an account whose tenant has track and
 *     thumbnail object references;
 *   * the cleanup worker leases, authorizes and finishes, and every refusal still holds:
 *     an object a live row references is not deleted, an open publication fence defers the
 *     deletion, a publication window keeps the receipt open — each read under the tenant the
 *     object key names, so making the queue visible never makes a guard fail open;
 *   * the derived purge deletes the leased tenant's rows (and no one else's) before the
 *     queue records it as done;
 *   * the restore replays still refuse another tenant's id;
 *   * a caller's tenant setting survives every function that names a row's tenant.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `plain_queue_${suffix}`;
const ownerRole = `plain_queue_owner_${suffix}`;
const runtimeRole = `plain_queue_rt_${suffix}`;
const workerRole = `plain_queue_worker_${suffix}`;
const renderRole = `plain_queue_render_${suffix}`;

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
let owner: Pool;
let runtime: Database;
let activities: ActivityRepository;
let tracks: ActivityTrackRepository;
let courses: CourseRepository;
let operations: OperationsRepository;
let worker: ResourceObjectCleanupRepository;
let derived: ResourceDerivedCleanupRepository;
let renderer: CourseThumbnailWorkerRepository;
let storage: ObjectStorage;
let objectRoot: string;

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, workerRole, renderRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE ${database} OWNER "${ownerRole}"`);
  inspect = new Pool({ connectionString: urlFor(null) });
  // Deployment, done by the plain owner: every migration, then the grant helpers.
  const ownerUrl = urlFor(ownerRole);
  await migrate(ownerUrl);
  owner = new Pool({ connectionString: ownerUrl, max: 2 });
  await owner.query(
    `GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${workerRole}","${renderRole}"`,
  );
  await owner.query(`GRANT USAGE ON SCHEMA identity_private TO "${runtimeRole}"`);
  await owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
     activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,
     activity_import_receipt TO "${runtimeRole}"`,
  );
  await grantOperations(ownerUrl, runtimeRole);
  await grantActivityTracks(ownerUrl, runtimeRole);
  await grantCourses(ownerUrl, runtimeRole);
  await grantResources(ownerUrl, runtimeRole);
  await grantGalleryMedia(ownerUrl, runtimeRole);
  await grantResourceObjectCleanupWorker(ownerUrl, workerRole);
  await grantCourseThumbnailWorker(ownerUrl, renderRole);
  runtime = createDatabase({ connectionString: urlFor(runtimeRole), max: 4 });
  activities = createActivityRepository(runtime);
  tracks = createActivityTrackRepository(runtime);
  courses = createCourseRepository(runtime);
  operations = createOperationsRepository(runtime);
  worker = createResourceObjectCleanupRepository({ connectionString: urlFor(workerRole), max: 2 });
  derived = createResourceDerivedCleanupRepository({
    connectionString: urlFor(workerRole),
    max: 2,
  });
  renderer = createCourseThumbnailWorkerRepository({ connectionString: urlFor(renderRole) });
  objectRoot = await mkdtemp(join(tmpdir(), 'plain-queue-'));
  storage = await createLocalFilesystemObjectStorage(objectRoot);
});

afterAll(async () => {
  await renderer?.close();
  await derived?.close();
  await worker?.close();
  await runtime?.close();
  await owner?.end();
  await inspect?.end();
  await dropIsolatedDatabase(admin, database);
  for (const role of [renderRole, workerRole, runtimeRole, ownerRole])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
  if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
});

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

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

type TrackKeys = { raw: string; normalized: string; mapPath: string };

/** The bytes each key of a track names by digest, so the store accepts them. */
const trackBytes = new Map<string, string>();

function trackRef(input: {
  athleteId: string;
  activityId: string;
  trackId: string;
  uploadId: string;
  artifactKind: 'raw' | 'normalized' | 'map_path';
  sha256: string;
  extension: 'gpx' | 'json';
}) {
  return `private/v1/tenants/${input.athleteId}/activities/${input.activityId}/tracks/${input.trackId}/${input.artifactKind}/uploads/${input.uploadId}/sha256/${input.sha256}.${input.extension}`;
}

/**
 * Reserve, record the objects (which protects them), stage and finalize. The same `content`
 * a second time is a duplicate recording: its finalize supersedes the upload.
 */
async function storeTrack(
  athleteId: string,
  activityId: string,
  expectedActivityRevision: number,
  content = `recording-${randomUUID()}`,
  finalize = true,
) {
  const reservation = await tracks.reserve(
    athleteId,
    activityId,
    { expectedActivityRevision, recordedTrackIndex: 0 },
    `track-${randomUUID()}`,
  );
  const shared = {
    athleteId,
    activityId,
    trackId: reservation.trackId,
    uploadId: reservation.uploadId,
  };
  const rawSha = hashOf(`raw-${content}`);
  const normalizedSha = hashOf(`normalized-${content}`);
  const mapPathSha = hashOf(`map-${content}`);
  const keys: TrackKeys = {
    raw: trackRef({ ...shared, artifactKind: 'raw', sha256: rawSha, extension: 'gpx' }),
    normalized: trackRef({
      ...shared,
      artifactKind: 'normalized',
      sha256: normalizedSha,
      extension: 'json',
    }),
    mapPath: trackRef({
      ...shared,
      artifactKind: 'map_path',
      sha256: mapPathSha,
      extension: 'json',
    }),
  };
  await tracks.prepareObjects(athleteId, reservation.uploadId, {
    raw: {
      storageRef: keys.raw,
      sizeBytes: 2048,
      sha256: rawSha,
      format: 'gpx',
      originalFileName: 'run.gpx',
    },
    normalized: { storageRef: keys.normalized, sizeBytes: 4096, sha256: normalizedSha },
    mapPath: { storageRef: keys.mapPath, sizeBytes: 1024, sha256: mapPathSha },
    parse: {
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      recordedSourceKind: 'gpx-trk',
      correspondenceDigest: hashOf(`correspondence-${content}`),
      sampleCount: 5,
      positionedSampleCount: 4,
      segmentCount: 1,
      segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
      distances: { deviceReportedMeters: 1000, recomputedFromPositionsMeters: 998 },
    },
  });
  trackBytes.set(keys.raw, `raw-${content}`);
  trackBytes.set(keys.normalized, `normalized-${content}`);
  trackBytes.set(keys.mapPath, `map-${content}`);
  if (!finalize) return { reservation, keys };
  await tracks.markStaged(athleteId, reservation.uploadId);
  await tracks.finalize(athleteId, reservation.uploadId);
  return { reservation, keys };
}

/** Real bytes behind a final track key, through the temporary-then-publish path. */
async function publishTrackObject(finalKey: string): Promise<void> {
  const parsed = parseObjectKey(finalKey);
  if (parsed.kind !== 'track_final') throw new Error('expected a track object key');
  const temporary = createActivityTrackTemporaryObjectKey(parsed);
  const content = trackBytes.get(finalKey);
  if (content === undefined) throw new Error('unknown track key');
  const bytes = new TextEncoder().encode(content);
  await storage.writeTemporary(
    temporary,
    (async function* () {
      yield bytes;
    })(),
  );
  await storage.publishTemporary(temporary, createActivityTrackFinalObjectKey(parsed), {
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

async function objectExists(key: string): Promise<boolean> {
  return (await storage.stat(validateObjectKey(key))) !== null;
}

const baseLine: [number, number][] = [
  [126.9779, 37.5665],
  [126.9789, 37.5668],
  [126.9799, 37.5671],
];

function courseContent(activityId: string, trackId: string): PreparedCourseContent {
  const [start] = baseLine;
  const finish = baseLine[baseLine.length - 1];
  if (start === undefined || finish === undefined) throw new Error('a line needs two vertices');
  const lineage = [{ activityId, trackId, trackRevision: 1 }];
  return {
    name: 'Plain loop',
    coordinates: baseLine,
    waypoints: [
      { role: 'start', position: start, name: null, sourceSampleId: '0:0', locked: false },
      { role: 'finish', position: finish, name: null, sourceSampleId: '0:2', locked: false },
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
      vertexCount: baseLine.length,
      mapPathContentSha256: 'a'.repeat(64),
      simplificationVersion: 1,
      toleranceMeters: 2.5,
    },
    edit: { kind: 'created' },
    lineage,
    distanceMeters: 180.25,
    contentDigest: hashOf(JSON.stringify(['Plain loop', baseLine, lineage])),
  };
}

type CleanupRow = {
  storage_ref: string;
  reason: string;
  attempts: number;
  completed_at: Date | null;
  delete_authorized_at: Date | null;
  last_error_code: string | null;
};

async function cleanupRows(refs: readonly string[]): Promise<CleanupRow[]> {
  const rows = await inspect.query<CleanupRow>(
    `SELECT storage_ref,reason,attempts,completed_at,delete_authorized_at,last_error_code
     FROM resource_object_cleanup WHERE storage_ref=ANY($1::text[])
     ORDER BY array_position($1::text[],storage_ref)`,
    [refs],
  );
  return rows.rows;
}

/** Everything due in the object-cleanup queue, through the real worker. */
async function drainObjectCleanup(): Promise<string[]> {
  const outcomes: string[] = [];
  for (let run = 0; run < 200; run += 1) {
    const outcome = await processOneResourceObjectCleanup(worker, (ref) =>
      storage.delete(validateObjectKey(ref)),
    );
    if (outcome === 'empty') return outcomes;
    outcomes.push(outcome);
  }
  throw new Error('object cleanup did not drain');
}

async function drainDerivedCleanup(): Promise<string[]> {
  const outcomes: string[] = [];
  const purge = createResourceDerivedStorePurge(derived);
  for (let run = 0; run < 100; run += 1) {
    const outcome = await processOneResourceDerivedCleanup(derived, purge);
    if (outcome === 'empty') return outcomes;
    outcomes.push(outcome);
  }
  throw new Error('derived cleanup did not drain');
}

/** A row no path of the system writes: planted by the superuser with triggers and keys off. */
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

/** A queue row no path writes for this ref: planted by the superuser, due now. */
async function plantCleanup(ref: string): Promise<void> {
  await inspect.query(
    `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
     VALUES($1,$2,'upload_abandoned',clock_timestamp(),clock_timestamp())`,
    [randomUUID(), ref],
  );
}

async function withWorkerSession<T>(
  callerTenant: string,
  work: (session: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: urlFor(workerRole), max: 1 });
  try {
    const session = await pool.connect();
    try {
      await session.query('BEGIN');
      await session.query("SELECT set_config('app.athlete_id',$1,true)", [callerTenant]);
      const result = await work(session);
      await session.query('COMMIT');
      return result;
    } catch (error) {
      await session.query('ROLLBACK');
      throw error;
    } finally {
      session.release();
    }
  } finally {
    await pool.end();
  }
}

async function tenantSetting(session: PoolClient): Promise<string | undefined> {
  const setting = await session.query<{ value: string }>(
    "SELECT current_setting('app.athlete_id',true) AS value",
  );
  return setting.rows[0]?.value;
}

describe('queue and state paths on a migration owner that is neither superuser nor BYPASSRLS', () => {
  it('is really such an owner, and owns the queue and state tables', async () => {
    const role = await inspect.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1',
      [ownerRole],
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const owners = await inspect.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class
       WHERE relname IN ('resource_object_cleanup','resource_derived_cleanup',
         'activity_track_reconcile_state','course_thumbnail_reconcile_state')`,
    );
    expect(owners.rows).toEqual([{ owner: ownerRole }]);
  });

  it('protects an upload’s objects against a queued deletion', async () => {
    const tenant = randomUUID();
    const imported = await activities.importActivity(tenant, importInput());
    // A deletion already queued for the very key the upload is about to record — what an
    // abandoned earlier attempt at the same bytes leaves. Protect must close it.
    const content = `protected-${randomUUID()}`;
    const reservation = await tracks.reserve(
      tenant,
      imported.activityId,
      { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
      `track-${randomUUID()}`,
    );
    const rawRef = trackRef({
      athleteId: tenant,
      activityId: imported.activityId,
      trackId: reservation.trackId,
      uploadId: reservation.uploadId,
      artifactKind: 'raw',
      sha256: hashOf(`raw-${content}`),
      extension: 'gpx',
    });
    await plantCleanup(rawRef);
    await tracks.prepareObjects(tenant, reservation.uploadId, {
      raw: {
        storageRef: rawRef,
        sizeBytes: 2048,
        sha256: hashOf(`raw-${content}`),
        format: 'gpx',
        originalFileName: 'run.gpx',
      },
      normalized: {
        storageRef: rawRef.replace('/raw/', '/normalized/').replace(/\.gpx$/, '.json'),
        sizeBytes: 4096,
        sha256: hashOf(`raw-${content}`),
      },
      mapPath: {
        storageRef: rawRef.replace('/raw/', '/map_path/').replace(/\.gpx$/, '.json'),
        sizeBytes: 1024,
        sha256: hashOf(`raw-${content}`),
      },
      parse: {
        parserId: 'gpx-track-v1',
        parserVersion: 1,
        recordedSourceKind: 'gpx-trk',
        correspondenceDigest: hashOf(`correspondence-${content}`),
        sampleCount: 5,
        positionedSampleCount: 4,
        segmentCount: 1,
        segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
        distances: { deviceReportedMeters: 1000, recomputedFromPositionsMeters: 998 },
      },
    });
    const [row] = await cleanupRows([rawRef]);
    expect(row?.last_error_code).toBe('REFERENCE_PRESENT');
    expect(row?.completed_at).not.toBeNull();
  });

  it('supersedes a duplicate upload, deletes an activity with a track, and deletes both', async () => {
    const tenant = randomUUID();
    const imported = await activities.importActivity(tenant, importInput());
    const recording = `recording-${randomUUID()}`;
    const first = await storeTrack(tenant, imported.activityId, imported.revision, recording);
    const current = await activities.getActivity(tenant, imported.activityId);
    const duplicate = await storeTrack(
      tenant,
      imported.activityId,
      current?.revision ?? imported.revision,
      recording,
    );
    const duplicateRefs = [duplicate.keys.raw, duplicate.keys.normalized, duplicate.keys.mapPath];
    expect((await cleanupRows(duplicateRefs)).map((row) => row.reason)).toEqual([
      'track_superseded',
      'track_superseded',
      'track_superseded',
    ]);

    const liveRefs = [first.keys.raw, first.keys.normalized, first.keys.mapPath];
    for (const ref of [...liveRefs, ...duplicateRefs]) await publishTrackObject(ref);
    const beforeDelete = await activities.getActivity(tenant, imported.activityId);
    await activities.deleteActivity(tenant, imported.activityId, {
      expectedRevision: beforeDelete?.revision ?? imported.revision,
    });
    expect((await cleanupRows(liveRefs)).map((row) => row.reason)).toEqual([
      'activity_deleted',
      'activity_deleted',
      'activity_deleted',
    ]);

    await drainObjectCleanup();
    for (const ref of [...liveRefs, ...duplicateRefs]) expect(await objectExists(ref)).toBe(false);
    for (const row of await cleanupRows([...liveRefs, ...duplicateRefs])) {
      expect(row.completed_at).not.toBeNull();
      expect(row.last_error_code).toBeNull();
    }
  });

  it('never deletes an object a live track still references', async () => {
    const tenant = randomUUID();
    const imported = await activities.importActivity(tenant, importInput());
    const stored = await storeTrack(tenant, imported.activityId, imported.revision);
    await publishTrackObject(stored.keys.raw);
    // Whatever queued it, the worker must find the live revision under the key's tenant.
    await plantCleanup(stored.keys.raw);
    await drainObjectCleanup();
    expect(await objectExists(stored.keys.raw)).toBe(true);
    expect(await cleanupRows([stored.keys.raw])).toMatchObject([
      { last_error_code: 'REFERENCE_PRESENT', delete_authorized_at: null },
    ]);
  });

  it('defers a deletion while the key’s writer holds an open publication fence', async () => {
    const tenant = randomUUID();
    const imported = await activities.importActivity(tenant, importInput());
    const prepared = await storeTrack(
      tenant,
      imported.activityId,
      imported.revision,
      undefined,
      false,
    );
    await plant(
      `UPDATE activity_track_upload_intent SET publication_lease_until=clock_timestamp()+interval '1 minute'
       WHERE athlete_id=$1 AND upload_id=$2`,
      [tenant, prepared.reservation.uploadId],
    );
    await plantCleanup(prepared.keys.raw);
    await drainObjectCleanup();
    expect(await cleanupRows([prepared.keys.raw])).toMatchObject([
      { attempts: 0, completed_at: null, last_error_code: 'PUBLICATION_IN_PROGRESS' },
    ]);
  });

  it('keeps a finished deletion open while a failed writer’s publication window lasts', async () => {
    const tenant = randomUUID();
    const imported = await activities.importActivity(tenant, importInput());
    const failed = await storeTrack(
      tenant,
      imported.activityId,
      imported.revision,
      undefined,
      false,
    );
    // The writer failed a minute after its fence ran out: no fence to wait on, nothing live,
    // so the deletion is authorized — but a publish could still land within the hour.
    await plant(
      `UPDATE activity_track_upload_intent SET state='failed',failure_code='TEST_FAILED',
         publication_lease_until=clock_timestamp()-interval '1 minute'
       WHERE athlete_id=$1 AND upload_id=$2`,
      [tenant, failed.reservation.uploadId],
    );
    await plantCleanup(failed.keys.raw);
    await drainObjectCleanup();
    expect(await cleanupRows([failed.keys.raw])).toMatchObject([
      { completed_at: null, last_error_code: 'PUBLICATION_WINDOW_OPEN' },
    ]);
  });

  it('refuses a queued key that names no tenant, deleting nothing', async () => {
    const ref = `not/a/tenant/key/${randomUUID()}`;
    await plantCleanup(ref);
    await drainObjectCleanup();
    expect(await cleanupRows([ref])).toMatchObject([
      { last_error_code: 'INCONSISTENT_LEDGER:OBJECT_KEY_TENANT', delete_authorized_at: null },
    ]);
    const [row] = await cleanupRows([ref]);
    expect(row?.completed_at).not.toBeNull();
  });

  it('erases an account whose tenant has track and thumbnail object references', async () => {
    const tenant = randomUUID();
    const imported = await activities.importActivity(tenant, importInput());
    const stored = await storeTrack(tenant, imported.activityId, imported.revision);
    const created = await courses.create(
      tenant,
      courseContent(imported.activityId, stored.reservation.trackId),
      `course-${randomUUID()}`,
    );
    expect(created.status).toBe('available');
    const thumbnailRefs = await inspect.query<{ storage_ref: string }>(
      'SELECT storage_ref FROM course_thumbnail_object_ref WHERE athlete_id=$1',
      [tenant],
    );
    expect(thumbnailRefs.rowCount).toBeGreaterThan(0);

    await expect(operations.eraseAccount(tenant)).resolves.toEqual({ erased: true });
    const trackRefs = [stored.keys.raw, stored.keys.normalized, stored.keys.mapPath];
    const refs = [...trackRefs, ...thumbnailRefs.rows.map((row) => row.storage_ref)];
    const queued = await cleanupRows(refs);
    expect(queued.map((row) => row.storage_ref)).toEqual(refs);
    for (const row of queued) expect(row.completed_at).toBeNull();
    const erased = await inspect.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [
      tenant,
    ]);
    expect(erased.rowCount).toBe(1);
  });

  it('deletes a file resource, queues its object and derived cleanup, and purges that tenant only', async () => {
    const tenant = randomUUID();
    const bystander = randomUUID();
    const uploads = createResourceFileUploadRepository(runtime);
    const reserved = await uploads.reserveCreate(
      tenant,
      {
        sourceKind: 'file',
        title: 'Plain owner file',
        category: 'race_material',
        metadata: { author: 'Owner', year: 2026 },
        tags: [],
        favorite: false,
      },
      randomUUID(),
    );
    const sha256 = hashOf(`file-${reserved.uploadId}`);
    const storageRef = `private/v1/tenants/${tenant}/resources/${reserved.resourceId}/objects/uploads/${reserved.uploadId}/sha256/${sha256}.pdf`;
    await uploads.prepareObject(tenant, reserved.uploadId, {
      storageRef,
      file: {
        originalFileName: 'race.pdf',
        extension: 'pdf',
        mediaType: 'application/pdf',
        byteSize: 1024,
        sha256,
      },
    });
    await uploads.markStaged(tenant, reserved.uploadId);
    const finalized = await uploads.finalize(tenant, reserved.uploadId);
    if (finalized.status !== 'available') throw new Error('expected an available file');
    for (const athlete of [tenant, bystander])
      await inspect.query(
        `INSERT INTO resource_retrieval_cache(athlete_id,cache_key,corpus_version,
           authorization_digest,passage_ids,created_at,expires_at)
         VALUES($1,$2,1,$3,'[]'::jsonb,now(),now()+interval '1 hour')`,
        [athlete, hashOf(`cache-${athlete}`), 'b'.repeat(64)],
      );

    await createPrivateTextResourceRepository(runtime).softDelete(tenant, reserved.resourceId, {
      expectedAccessRevision: finalized.resource.accessRevision,
      expectedCurrentVersionId: finalized.version.id,
      idempotencyKey: randomUUID(),
    });
    expect(await cleanupRows([storageRef])).toMatchObject([{ reason: 'resource_deleted' }]);
    const manifest = await inspect.query(
      `SELECT reason,completed_at FROM resource_derived_cleanup
       WHERE athlete_id=$1 AND resource_id=$2`,
      [tenant, reserved.resourceId],
    );
    expect(manifest.rows).toEqual([{ reason: 'resource_deleted', completed_at: null }]);

    expect(await drainDerivedCleanup()).toContain('completed');
    const cache = await inspect.query<{ athlete_id: string }>(
      'SELECT athlete_id FROM resource_retrieval_cache WHERE athlete_id=ANY($1::text[])',
      [[tenant, bystander]],
    );
    expect(cache.rows).toEqual([{ athlete_id: bystander }]);
    const done = await inspect.query(
      `SELECT completed_at IS NOT NULL AS done FROM resource_derived_cleanup
       WHERE athlete_id=$1 AND resource_id=$2`,
      [tenant, reserved.resourceId],
    );
    expect(done.rows).toEqual([{ done: true }]);
  });

  it('deletes a gallery item and queues its object', async () => {
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
    const sha256 = hashOf(`gallery-${reservation.uploadId}`);
    const storageRef = `private/v1/tenants/${tenant}/gallery/${reservation.mediaItemId}/objects/uploads/${reservation.uploadId}/sha256/${sha256}.png`;
    await gallery.prepareObject(tenant, reservation.uploadId, {
      storageRef,
      file: { originalFileName: 'finish.png', mediaType: 'image/png', byteSize: 2048, sha256 },
    });
    await gallery.markStaged(tenant, reservation.uploadId);
    const finalized = await gallery.finalize(tenant, reservation.uploadId);
    if (finalized.status !== 'available') throw new Error('expected an available item');
    await expect(
      gallery.softDelete(tenant, finalized.item.id, {
        expectedAccessRevision: finalized.item.accessRevision,
        idempotencyKey: `gallery-${randomUUID()}`,
      }),
    ).resolves.toMatchObject({ status: 'deleted' });
    expect(await cleanupRows([storageRef])).toMatchObject([{ reason: 'resource_deleted' }]);
  });

  it('keeps the sweep’s reclaim and settle refusals for a live track', async () => {
    const tenant = randomUUID();
    const imported = await activities.importActivity(tenant, importInput());
    const stored = await storeTrack(tenant, imported.activityId, imported.revision);
    await inspect.query(
      `UPDATE activity_track_object_ref SET recorded_at=recorded_at-interval '8 days'
       WHERE storage_ref=$1`,
      [stored.keys.raw],
    );
    expect(await worker.reclaimUnreferencedTrackObject(stored.keys.raw)).toBe(false);
    expect(await worker.settleTrackObjectRef(stored.keys.raw)).toBe(false);
    expect(await cleanupRows([stored.keys.raw])).toEqual([]);

    // Once the activity is gone and its deletion is done, the same ref settles.
    const current = await activities.getActivity(tenant, imported.activityId);
    await activities.deleteActivity(tenant, imported.activityId, {
      expectedRevision: current?.revision ?? imported.revision,
    });
    await drainObjectCleanup();
    // …and once its upload's publication window has closed too (moved back, triggers off).
    await plant(
      `UPDATE activity_track_upload_intent SET publication_lease_until=NULL,
         created_at=created_at-interval '2 days',
         expires_at=created_at-interval '2 days'+interval '1 hour'
       WHERE athlete_id=$1 AND upload_id=$2`,
      [tenant, stored.reservation.uploadId],
    );
    expect(await worker.settleTrackObjectRef(stored.keys.raw)).toBe(true);
  });

  it('keeps the sweep’s reclaim refusal for a render that can still publish', async () => {
    const tenant = randomUUID();
    const imported = await activities.importActivity(tenant, importInput());
    const stored = await storeTrack(tenant, imported.activityId, imported.revision);
    await courses.create(
      tenant,
      courseContent(imported.activityId, stored.reservation.trackId),
      `course-${randomUUID()}`,
    );
    const queued = await inspect.query<{ temporary_ref: string }>(
      `SELECT temporary_ref FROM course_thumbnail WHERE athlete_id=$1 AND state='queued'`,
      [tenant],
    );
    const temporaryRef = queued.rows[0]?.temporary_ref;
    if (!temporaryRef) throw new Error('expected a queued render');
    expect(await worker.reclaimUnreferencedThumbnailObject(temporaryRef)).toBe(false);
    expect(await worker.settleThumbnailObjectRef(temporaryRef)).toBe(false);

    // A watched reference no render holds any more settles — under its key's tenant.
    const orphan = `private/v1/tenants/${tenant}/courses/${randomUUID()}/thumbnails/temporary/${randomUUID()}`;
    await plant(
      `INSERT INTO course_thumbnail_object_ref(storage_ref,athlete_id,recorded_at)
       VALUES($1,$2,clock_timestamp()-interval '8 days')`,
      [orphan, tenant],
    );
    expect(await worker.settleThumbnailObjectRef(orphan)).toBe(true);
  });

  it('keeps the reconcile cursors', async () => {
    const cursor = `private/v1/tenants/${randomUUID()}`;
    await worker.advanceReconcileCursor(cursor);
    expect(await worker.reconcileCursor()).toBe(cursor);
    await worker.advanceThumbnailReconcileCursor(cursor);
    expect(await worker.thumbnailReconcileCursor()).toBe(cursor);
  });

  it('prunes old finished cleanup history', async () => {
    const ref = `private/v1/tenants/${randomUUID()}/resources/${randomUUID()}/temporary/${randomUUID()}`;
    await inspect.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at,completed_at)
       VALUES($1,$2,'upload_abandoned',now()-interval '40 days',now()-interval '40 days',
         now()-interval '31 days')`,
      [randomUUID(), ref],
    );
    let pruned = 0;
    for (let run = 0; run < 20 && (await cleanupRows([ref])).length > 0; run += 1)
      pruned += await worker.pruneCleanupHistory(100);
    expect(pruned).toBeGreaterThan(0);
    expect(await cleanupRows([ref])).toEqual([]);
  });

  it('refuses to replay another tenant’s activity or course id', async () => {
    const holder = randomUUID();
    const replayer = randomUUID();
    for (const athlete of [holder, replayer])
      await inspect.query(
        `INSERT INTO identity_private.account(athlete_id,issuer,subject)
         VALUES($1,'https://issuer.test',$2)`,
        [athlete, randomUUID()],
      );
    const held = await activities.importActivity(holder, importInput());
    const course = randomUUID();
    await plant(
      `INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,revision_id,
         created_at,updated_at)
       VALUES($1,$2,'Held','private','available',1,$3,now(),now())`,
      [holder, course, randomUUID()],
    );
    // The restore replays run as the migration owner, the tenant named for the transaction.
    async function replay(statement: string, values: unknown[]): Promise<unknown> {
      const session = await owner.connect();
      try {
        await session.query('BEGIN');
        await session.query("SELECT set_config('app.athlete_id',$1,true)", [replayer]);
        return await session.query(statement, values);
      } finally {
        await session.query('ROLLBACK');
        session.release();
      }
    }
    await expect(
      replay('SELECT public.replay_absent_activity_deletion($1,$2,$3,$4,$5,$6,$7)', [
        replayer,
        held.activityId,
        'fit',
        randomUUID(),
        1,
        1,
        'c'.repeat(64),
      ]),
    ).rejects.toThrow('ACTIVITY_REPLAY_FOREIGN_ACTIVITY');
    await expect(
      replay('SELECT public.replay_course_deletion($1,$2,$3)', [
        replayer,
        course,
        new Date(Date.now() - 60_000),
      ]),
    ).rejects.toThrow('COURSE_REPLAY_FOREIGN_COURSE');

    // An id no tenant holds replays, and the replayer's own tenant stays named throughout.
    await expect(
      replay('SELECT public.replay_absent_activity_deletion($1,$2,$3,$4,$5,$6,$7) AS done', [
        replayer,
        randomUUID(),
        'fit',
        randomUUID(),
        1,
        1,
        'c'.repeat(64),
      ]),
    ).resolves.toMatchObject({ rows: [{ done: true }] });
    await expect(
      replay('SELECT public.replay_course_deletion($1,$2,$3) AS outcome', [
        replayer,
        randomUUID(),
        new Date(Date.now() - 60_000),
      ]),
    ).resolves.toMatchObject({ rows: [{ outcome: 'absent' }] });
  });

  it('leaves the caller’s tenant setting as it was', async () => {
    const tenant = randomUUID();
    const imported = await activities.importActivity(tenant, importInput());
    const stored = await storeTrack(tenant, imported.activityId, imported.revision);
    await plantCleanup(stored.keys.normalized);
    const callerTenant = randomUUID();
    await withWorkerSession(callerTenant, async (session) => {
      const leasedAt = new Date();
      const until = new Date(leasedAt.getTime() + 60_000);
      const owner = randomUUID();
      const leased = await session.query<{ id: string }>(
        'SELECT * FROM public.lease_resource_object_cleanup($1,$2,$3)',
        [owner, leasedAt, until],
      );
      const id = leased.rows[0]?.id;
      if (!id) throw new Error('expected a leased cleanup');
      await session.query('SELECT * FROM public.authorize_resource_object_cleanup($1,$2,$3)', [
        id,
        owner,
        new Date(),
      ]);
      expect(await tenantSetting(session)).toBe(callerTenant);
      await session.query('SELECT public.finish_resource_object_cleanup($1,$2,true,NULL,$3)', [
        id,
        owner,
        new Date(),
      ]);
      expect(await tenantSetting(session)).toBe(callerTenant);
      await session.query('SELECT public.reclaim_unreferenced_activity_track_object($1)', [
        stored.keys.mapPath,
      ]);
      expect(await tenantSetting(session)).toBe(callerTenant);
      await session.query('SELECT public.settle_activity_track_object_ref($1)', [
        stored.keys.mapPath,
      ]);
      expect(await tenantSetting(session)).toBe(callerTenant);
      await session.query('SELECT public.settle_course_thumbnail_object_ref($1)', [
        stored.keys.mapPath,
      ]);
      expect(await tenantSetting(session)).toBe(callerTenant);
    });
  });

  it('leaves the caller’s tenant setting as it was across a derived purge', async () => {
    const tenant = randomUUID();
    const created = await createPrivateTextResourceRepository(runtime).create(tenant, {
      sourceKind: 'text',
      title: 'Plain owner note',
      category: 'note',
      metadata: {},
      tags: [],
      favorite: false,
      text: 'A note.',
      idempotencyKey: randomUUID(),
    });
    if (created.status !== 'available') throw new Error('expected an available note');
    await createPrivateTextResourceRepository(runtime).softDelete(tenant, created.resource.id, {
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });
    const callerTenant = randomUUID();
    await withWorkerSession(callerTenant, async (session) => {
      const leasedAt = new Date();
      const owner = randomUUID();
      const leased = await session.query<{ id: string }>(
        'SELECT * FROM public.lease_resource_derived_cleanup($1,$2,$3)',
        [owner, leasedAt, new Date(leasedAt.getTime() + 60_000)],
      );
      const id = leased.rows[0]?.id;
      if (!id) throw new Error('expected a leased manifest');
      await session.query("SELECT public.purge_resource_derived_store($1,$2,'cache')", [id, owner]);
      expect(await tenantSetting(session)).toBe(callerTenant);
    });
  });

  it('asks whether a scope’s owner is live for the head of the due order only', async () => {
    // 300 due scopes whose owners are gone. 051 asked the liveness helper for every one of
    // them on every lease; now a lease asks at most the 100 at the head, plus the one it takes.
    const tenant = randomUUID();
    await inspect.query(
      `INSERT INTO object_scope_purge(athlete_id,scope_kind,scope_id,armed_at,available_at)
       SELECT $1,'activity',gen_random_uuid(),clock_timestamp(),
         clock_timestamp()-interval '1 day'-make_interval(secs=>value)
       FROM generate_series(1,300) value`,
      [tenant],
    );
    const client = await inspect.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL track_functions='pl'");
      await client.query(`SET LOCAL ROLE "${ownerRole}"`);
      const leased = await client.query(
        "SELECT * FROM public.lease_object_scope_purge($1,now(),now()+interval '1 minute')",
        [randomUUID()],
      );
      expect(leased.rowCount).toBe(1);
      await client.query('RESET ROLE');
      const calls = await client.query<{ calls: string }>(
        `SELECT calls FROM pg_stat_xact_user_functions WHERE funcname='object_purge_scope_live'`,
      );
      expect(Number(calls.rows[0]?.calls)).toBeGreaterThan(0);
      expect(Number(calls.rows[0]?.calls)).toBeLessThanOrEqual(101);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

// The paths M2-01au left closed — the render queue, the reapers, the prunes and the sweep
// windows — run on such an owner since M2-01av: worker-tenant-source-plain-owner.integration.test.ts.
