import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';

import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import {
  createActivityTrackRepository,
  type ActivityTrackRepository,
} from '../src/activity-tracks.js';
import {
  createCourseThumbnailWorkerRepository,
  type CourseThumbnailLease,
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
  grantResourceRetrieval,
  grantResources,
  grantResourceUrlIngestionWorker,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';
import {
  createResourceDerivedCleanupRepository,
  type ResourceDerivedCleanupRepository,
} from '../src/resource-derived-cleanup.js';
import { createResourceFileUploadRepository } from '../src/resource-file-uploads.js';
import {
  createResourceObjectCleanupRepository,
  type ResourceObjectCleanupRepository,
} from '../src/resource-object-cleanup.js';
import {
  createResourceUrlIngestionRepository,
  createResourceUrlIngestionWorkerRepository,
  type ResourceUrlIngestionLease,
} from '../src/resource-url-ingestions.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * M2-01av: the worker paths M2-01au left (its progress §6) on a database whose migration owner
 * is neither superuser nor BYPASSRLS.
 *
 * The whole schema is built by such an owner, which also runs the grant helpers. Runtime, the
 * cleanup worker, the render worker and the URL worker are the usual plain roles, each through
 * its real repository. The superuser connection only looks at rows, and moves a row's clock
 * back where a test needs work to be due (with the table's transition guard off for that one
 * statement, so the tenant-work index's own trigger still sees the change, as in production).
 *
 * What must hold on that owner, for each path that scans for due work across tenants:
 *   * it finds the due work of every tenant and does it — renders are leased and published,
 *     URLs fetched and finalized, expired work reaped, old history pruned, windows swept;
 *   * whatever it acts on it reads under that row's own tenant: an index entry that names the
 *     wrong tenant, or more than one, makes it do nothing — never act on a row it cannot see;
 *   * a caller's tenant setting survives every call.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `plain_work_${suffix}`;
const ownerRole = `plain_work_owner_${suffix}`;
const runtimeRole = `plain_work_rt_${suffix}`;
const workerRole = `plain_work_worker_${suffix}`;
const renderRole = `plain_work_render_${suffix}`;
const urlRole = `plain_work_url_${suffix}`;

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
let tracks: ActivityTrackRepository;
let courses: CourseRepository;
let operations: OperationsRepository;
let worker: ResourceObjectCleanupRepository;
let derived: ResourceDerivedCleanupRepository;
let renderer: CourseThumbnailWorkerRepository;
let fetcher: ReturnType<typeof createResourceUrlIngestionWorkerRepository>;

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, workerRole, renderRole, urlRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE ${database} OWNER "${ownerRole}"`);
  inspect = new Pool({ connectionString: urlFor(null) });
  // Deployment, done by the plain owner: every migration, then the grant helpers.
  const ownerUrl = urlFor(ownerRole);
  await migrate(ownerUrl);
  const owner = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await owner.query(
      `GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${workerRole}","${renderRole}","${urlRole}"`,
    );
    await owner.query(`GRANT USAGE ON SCHEMA identity_private TO "${runtimeRole}"`);
    await owner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
       activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,
       activity_import_receipt TO "${runtimeRole}"`,
    );
  } finally {
    await owner.end();
  }
  await grantOperations(ownerUrl, runtimeRole);
  await grantActivityTracks(ownerUrl, runtimeRole);
  await grantCourses(ownerUrl, runtimeRole);
  await grantResources(ownerUrl, runtimeRole);
  await grantResourceRetrieval(ownerUrl, runtimeRole);
  await grantGalleryMedia(ownerUrl, runtimeRole);
  await grantResourceObjectCleanupWorker(ownerUrl, workerRole);
  await grantCourseThumbnailWorker(ownerUrl, renderRole);
  await grantResourceUrlIngestionWorker(ownerUrl, urlRole);
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
  fetcher = createResourceUrlIngestionWorkerRepository({ connectionString: urlFor(urlRole) });
});

afterAll(async () => {
  await fetcher?.close();
  await renderer?.close();
  await derived?.close();
  await worker?.close();
  await runtime?.close();
  await inspect?.end();
  await dropIsolatedDatabase(admin, database);
  for (const role of [urlRole, renderRole, workerRole, runtimeRole, ownerRole])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
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

/** Reserve, record the objects, and — unless told not to — stage and finalize. */
async function storeTrack(
  athleteId: string,
  activityId: string,
  expectedActivityRevision: number,
  finalize = true,
) {
  const content = `recording-${randomUUID()}`;
  const reservation = await tracks.reserve(
    athleteId,
    activityId,
    { expectedActivityRevision, recordedTrackIndex: 0 },
    `track-${randomUUID()}`,
  );
  if (!finalize) return { reservation };
  const shared = {
    athleteId,
    activityId,
    trackId: reservation.trackId,
    uploadId: reservation.uploadId,
  };
  const rawSha = hashOf(`raw-${content}`);
  const normalizedSha = hashOf(`normalized-${content}`);
  const mapPathSha = hashOf(`map-${content}`);
  await tracks.prepareObjects(athleteId, reservation.uploadId, {
    raw: {
      storageRef: trackRef({ ...shared, artifactKind: 'raw', sha256: rawSha, extension: 'gpx' }),
      sizeBytes: 2048,
      sha256: rawSha,
      format: 'gpx',
      originalFileName: 'run.gpx',
    },
    normalized: {
      storageRef: trackRef({
        ...shared,
        artifactKind: 'normalized',
        sha256: normalizedSha,
        extension: 'json',
      }),
      sizeBytes: 4096,
      sha256: normalizedSha,
    },
    mapPath: {
      storageRef: trackRef({
        ...shared,
        artifactKind: 'map_path',
        sha256: mapPathSha,
        extension: 'json',
      }),
      sizeBytes: 1024,
      sha256: mapPathSha,
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
  await tracks.markStaged(athleteId, reservation.uploadId);
  await tracks.finalize(athleteId, reservation.uploadId);
  return { reservation };
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

/** A tenant with a course: its revision's render is queued. */
async function tenantWithCourse(): Promise<{ tenant: string; courseId: string }> {
  const tenant = randomUUID();
  const imported = await activities.importActivity(tenant, importInput());
  const stored = await storeTrack(tenant, imported.activityId, imported.revision);
  const created = await courses.create(
    tenant,
    courseContent(imported.activityId, stored.reservation.trackId),
    `course-${randomUUID()}`,
  );
  if (created.status !== 'available') throw new Error('course was not created');
  return { tenant, courseId: created.course.courseId };
}

type RenderRow = {
  job_id: string;
  state: string;
  attempt_count: number;
  failure_code: string | null;
  storage_ref: string | null;
  temporary_ref: string;
};

async function renders(tenant: string): Promise<RenderRow[]> {
  const rows = await inspect.query<RenderRow>(
    `SELECT job_id,state,attempt_count,failure_code,storage_ref,temporary_ref
     FROM course_thumbnail WHERE athlete_id=$1 ORDER BY course_revision`,
    [tenant],
  );
  return rows.rows;
}

/**
 * The render queue is one queue for every tenant, and the tests share it: lease until this
 * tenant's render comes up, and hand every other lease straight back (release spends nothing).
 */
async function leaseRenderFor(tenant: string): Promise<CourseThumbnailLease> {
  const others: CourseThumbnailLease[] = [];
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const lease = await renderer.lease(60);
      if (lease === null) break;
      if (lease.athleteId === tenant) return lease;
      others.push(lease);
    }
    throw new Error(`no render was leased for ${tenant}`);
  } finally {
    for (const other of others) await renderer.release(other);
  }
}

function finalThumbnailKey(lease: CourseThumbnailLease, sha256: string): string {
  return `private/v1/tenants/${lease.athleteId}/courses/${lease.courseId}/thumbnails/revisions/${lease.revisionId}/sha256/${sha256}.svg`;
}

/** One statement as the superuser with the named transition guards off for it only. */
async function withGuardsOff(
  table: string,
  guards: readonly string[],
  statement: string,
  values: unknown[],
): Promise<void> {
  const client = await inspect.connect();
  try {
    await client.query('BEGIN');
    for (const guard of guards) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${guard}`);
    await client.query(statement, values);
    for (const guard of guards) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${guard}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type CleanupRow = { storage_ref: string; reason: string; completed_at: Date | null };

async function cleanupRows(refs: readonly string[]): Promise<CleanupRow[]> {
  const rows = await inspect.query<CleanupRow>(
    `SELECT storage_ref,reason,completed_at FROM resource_object_cleanup
     WHERE storage_ref=ANY($1::text[]) ORDER BY array_position($1::text[],storage_ref)`,
    [refs],
  );
  return rows.rows;
}

async function withSession<T>(
  role: string,
  callerTenant: string,
  work: (session: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: urlFor(role), max: 1 });
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

const urlInput = {
  title: 'Fetched training paper',
  category: 'paper' as const,
  metadata: { author: 'Public author' },
  tags: ['url'],
  favorite: false,
  url: 'https://example.com/paper?tracking=server-only',
};

function rawKey(lease: ResourceUrlIngestionLease, hash: string) {
  return `private/v1/tenants/${lease.athleteId}/resources/${lease.resourceId}/url-ingestions/${lease.requestId}/raw/sha256/${hash}.html`;
}

function parsedKey(lease: ResourceUrlIngestionLease, hash: string) {
  return `private/v1/tenants/${lease.athleteId}/resources/${lease.resourceId}/url-ingestions/${lease.requestId}/parsed/sha256/${hash}.json`;
}

async function fetchRaw(lease: ResourceUrlIngestionLease): Promise<string> {
  expect(
    await fetcher.recordHop(lease, {
      index: 0,
      displayUrl: 'https://example.com/paper',
      urlDigest: hashOf(urlInput.url),
      responseStatus: 200,
      resolvedAddresses: ['93.184.216.34'],
      policyVersion: 'ssrf-v1',
    }),
  ).toBe(true);
  const rawHash = hashOf(`raw:${lease.requestId}`);
  const storageRef = rawKey(lease, rawHash);
  expect(
    await fetcher.prepareRaw(lease, {
      storageRef,
      sha256: rawHash,
      sizeBytes: 100,
      mediaType: 'text/html',
    }),
  ).toBe(true);
  expect(await fetcher.markRawPublished(lease)).toBe(true);
  return storageRef;
}

async function urlState(tenant: string, requestId: string) {
  const rows = await inspect.query<{ state: string; failure_code: string | null }>(
    'SELECT state,failure_code FROM resource_url_ingestion WHERE athlete_id=$1 AND request_id=$2',
    [tenant, requestId],
  );
  return rows.rows[0];
}

describe('worker paths on a migration owner that is neither superuser nor BYPASSRLS', () => {
  it('is really such an owner, and keeps the tenant-work index to itself', async () => {
    const role = await inspect.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1',
      [ownerRole],
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const index = await inspect.query<{ owner: string; force: boolean }>(
      `SELECT pg_get_userbyid(relowner) AS owner,relforcerowsecurity AS force FROM pg_class
       WHERE oid='public.tenant_work_index'::regclass`,
    );
    expect(index.rows).toEqual([{ owner: ownerRole, force: true }]);
    for (const role of [runtimeRole, workerRole, renderRole, urlRole]) {
      const access = await inspect.query<{ any: boolean }>(
        `SELECT has_table_privilege($1,'public.tenant_work_index',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS any`,
        [role],
      );
      expect(access.rows, role).toEqual([{ any: false }]);
    }
  });

  it('refuses what the bodies refuse, even with nothing due', async () => {
    // Nothing is due in this database yet, so no body runs: the wrappers refuse by themselves.
    const due = await inspect.query('SELECT 1 FROM tenant_work_index WHERE due_at IS NOT NULL');
    expect(due.rowCount).toBe(0);
    for (const [role, statement, code] of [
      [
        renderRole,
        "SELECT * FROM public.lease_course_thumbnail_render($1,interval '0 seconds')",
        'INVALID_COURSE_THUMBNAIL_LEASE',
      ],
      [
        urlRole,
        "SELECT * FROM public.lease_resource_url_ingestion($1,interval '10 minutes')",
        'INVALID_URL_LEASE',
      ],
      [workerRole, 'SELECT public.reap_course_thumbnail_renders(0)', 'INVALID_REAP_LIMIT'],
      [urlRole, 'SELECT public.reap_resource_url_ingestions(101)', 'INVALID_REAP_LIMIT'],
      [workerRole, 'SELECT public.reap_expired_resource_uploads(now(),0)', 'INVALID_REAP_LIMIT'],
      [workerRole, 'SELECT public.prune_course_thumbnail_history(0)', 'INVALID_PRUNE_LIMIT'],
      [workerRole, 'SELECT public.prune_resource_upload_history(101)', 'INVALID_PRUNE_LIMIT'],
      [workerRole, 'SELECT public.prune_resource_retrieval_cache(1001)', 'INVALID_PRUNE_LIMIT'],
    ] as const) {
      const pool = new Pool({ connectionString: urlFor(role), max: 1 });
      try {
        await expect(
          pool.query(statement, statement.includes('$1') ? [randomUUID()] : []),
          statement,
        ).rejects.toThrow(code);
      } finally {
        await pool.end();
      }
    }
  });

  it('leases, prepares, fences and publishes each tenant’s render', async () => {
    const first = await tenantWithCourse();
    const second = await tenantWithCourse();
    for (const { tenant } of [first, second]) {
      const lease = await leaseRenderFor(tenant);
      expect(lease.courseId).toBe(tenant === first.tenant ? first.courseId : second.courseId);
      expect(lease.coordinates).toEqual(baseLine);
      const sha256 = hashOf(`svg-${lease.jobId}`);
      const storageRef = finalThumbnailKey(lease, sha256);
      expect(
        await renderer.prepare(lease, { storageRef, sha256, byteSize: 512, vertexCount: 3 }),
      ).toBe(true);
      expect(await renderer.publicationFenceOpen(lease)).toBe(true);
      expect(await renderer.finalize(lease)).toBe('ready');
      expect(await renders(tenant)).toMatchObject([{ state: 'ready', storage_ref: storageRef }]);
    }
  });

  it('never hands one render to two workers at once', async () => {
    await tenantWithCourse();
    await tenantWithCourse();
    const pools = [0, 1].map(() => new Pool({ connectionString: urlFor(renderRole), max: 1 }));
    const sessions = await Promise.all(pools.map((pool) => pool.connect()));
    try {
      for (const session of sessions) await session.query('BEGIN');
      const jobs: string[] = [];
      // The first lease holds its row until it ends; the second, meanwhile, takes another.
      for (const session of sessions) {
        const leased = await session.query<{ job_id: string }>(
          "SELECT job_id FROM public.lease_course_thumbnail_render($1,interval '60 seconds')",
          [randomUUID()],
        );
        expect(leased.rowCount).toBe(1);
        jobs.push(leased.rows[0]?.job_id ?? '');
      }
      expect(new Set(jobs).size).toBe(2);
    } finally {
      for (const session of sessions) {
        await session.query('ROLLBACK');
        session.release();
      }
      for (const pool of pools) await pool.end();
    }
  });

  it('gives a render back, fails one, refuses one and requeues its refs by job id', async () => {
    const released = await tenantWithCourse();
    const releasedLease = await leaseRenderFor(released.tenant);
    expect(await renderer.release(releasedLease)).toBe(true);
    expect(await renders(released.tenant)).toMatchObject([{ state: 'queued', attempt_count: 0 }]);

    // A prepared render that then fails for good queues both its refs.
    const failedLease = await leaseRenderFor(released.tenant);
    const sha256 = hashOf(`svg-${failedLease.jobId}`);
    const storageRef = finalThumbnailKey(failedLease, sha256);
    expect(
      await renderer.prepare(failedLease, { storageRef, sha256, byteSize: 512, vertexCount: 3 }),
    ).toBe(true);
    expect(await renderer.fail(failedLease, 'TEST_RENDER_FAILED')).toBe(true);
    const [failed] = await renders(released.tenant);
    expect(failed).toMatchObject({ state: 'failed', failure_code: 'TEST_RENDER_FAILED' });
    expect(
      (await cleanupRows([failed?.temporary_ref ?? '', storageRef])).map((row) => row.reason),
    ).toEqual(['upload_abandoned', 'upload_abandoned']);

    // A refusal closes the render and queues its temporary ref; requeueing reopens that receipt.
    const refused = await tenantWithCourse();
    const refusedLease = await leaseRenderFor(refused.tenant);
    expect(await renderer.markUnavailable(refusedLease, 'line_too_short_to_draw')).toBe(true);
    const [unavailable] = await renders(refused.tenant);
    expect(unavailable?.state).toBe('unavailable');
    const temporaryRef = unavailable?.temporary_ref ?? '';
    await inspect.query(
      'UPDATE resource_object_cleanup SET completed_at=now() WHERE storage_ref=$1',
      [temporaryRef],
    );
    expect(await renderer.requeueRefs(refusedLease)).toBe(true);
    expect(await cleanupRows([temporaryRef])).toMatchObject([
      { reason: 'upload_abandoned', completed_at: null },
    ]);
    const requeued = await inspect.query<{ queued: number }>(
      `SELECT count(*)::int AS queued FROM resource_object_cleanup
       WHERE storage_ref=$1 AND completed_at IS NULL`,
      [temporaryRef],
    );
    expect(requeued.rows).toEqual([{ queued: 1 }]);
  });

  it('reaps a render whose lease ran out and one past its own deadline', async () => {
    const leased = await tenantWithCourse();
    const lease = await leaseRenderFor(leased.tenant);
    await withGuardsOff(
      'course_thumbnail',
      ['course_thumbnail_writer'],
      `UPDATE course_thumbnail SET lease_until=clock_timestamp()-interval '1 second'
       WHERE athlete_id=$1 AND job_id=$2`,
      [leased.tenant, lease.jobId],
    );
    const expired = await tenantWithCourse();
    await withGuardsOff(
      'course_thumbnail',
      ['course_thumbnail_writer'],
      `UPDATE course_thumbnail SET created_at=clock_timestamp()-interval '2 hours',
         updated_at=clock_timestamp()-interval '2 hours',
         expires_at=clock_timestamp()-interval '1 hour'
       WHERE athlete_id=$1`,
      [expired.tenant],
    );
    let reaped = 0;
    for (let run = 0; run < 5; run += 1) reaped += await worker.reapCourseThumbnailRenders(100);
    expect(reaped).toBeGreaterThanOrEqual(2);
    expect(await renders(leased.tenant)).toMatchObject([
      { state: 'failed', failure_code: 'RENDER_LEASE_EXPIRED' },
    ]);
    expect(await renders(expired.tenant)).toMatchObject([
      { state: 'failed', failure_code: 'RENDER_EXPIRED' },
    ]);
    const [expiredRow] = await renders(expired.tenant);
    expect(await cleanupRows([expiredRow?.temporary_ref ?? ''])).toMatchObject([
      { reason: 'upload_abandoned', completed_at: null },
    ]);
  });

  it('prunes renders closed a week ago, but not one a cleanup receipt still waits on', async () => {
    const closeAWeekAgo = (tenant: string) =>
      withGuardsOff(
        'course_thumbnail',
        ['course_thumbnail_writer'],
        `UPDATE course_thumbnail SET state='failed',failure_code='TEST_CLOSED',
           failure_retryable=false,retry_at=NULL,failed_at=clock_timestamp()-interval '8 days',
           created_at=clock_timestamp()-interval '9 days',
           updated_at=clock_timestamp()-interval '8 days',
           expires_at=clock_timestamp()-interval '9 days'+interval '1 hour',
           lease_owner=NULL,lease_token=NULL,lease_until=NULL,publication_lease_until=NULL
         WHERE athlete_id=$1`,
        [tenant],
      );
    const prunable = await tenantWithCourse();
    const waiting = await tenantWithCourse();
    await closeAWeekAgo(prunable.tenant);
    await closeAWeekAgo(waiting.tenant);
    const [waitingRow] = await renders(waiting.tenant);
    await inspect.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
       VALUES($1,$2,'upload_abandoned',clock_timestamp()+interval '1 day',clock_timestamp())`,
      [randomUUID(), waitingRow?.temporary_ref],
    );
    let pruned = 0;
    for (let run = 0; run < 5; run += 1) pruned += await worker.pruneCourseThumbnailHistory(100);
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(await renders(prunable.tenant)).toEqual([]);
    expect(await renders(waiting.tenant)).toHaveLength(1);
    // The one that waits is looked at again in an hour, not on every run.
    const deferred = await inspect.query<{ later: boolean }>(
      `SELECT due_at>clock_timestamp()+interval '50 minutes' AS later FROM tenant_work_index
       WHERE kind='course_thumbnail:prune' AND athlete_id=$1`,
      [waiting.tenant],
    );
    expect(deferred.rows).toEqual([{ later: true }]);
  });

  it('fetches, parses and finalizes a URL, and fails, bookmarks and reaps others', async () => {
    const tenant = randomUUID();
    const repo = createResourceUrlIngestionRepository(runtime);
    // Finalized through both phases.
    const finalized = await repo.reserveCreate(tenant, urlInput, randomUUID());
    const fetchLease = await fetcher.lease();
    expect(fetchLease).toMatchObject({ requestId: finalized.requestId, phase: 'fetch' });
    if (!fetchLease) throw new Error('expected a fetch lease');
    await fetchRaw(fetchLease);
    const parseLease = await fetcher.lease();
    expect(parseLease).toMatchObject({ requestId: finalized.requestId, phase: 'parse' });
    if (!parseLease) throw new Error('expected a parse lease');
    const text = 'First paragraph.';
    const parsedHash = hashOf(text);
    expect(
      await fetcher.prepareParsed(parseLease, {
        storageRef: parsedKey(parseLease, parsedHash),
        sha256: parsedHash,
        sizeBytes: 200,
        text,
        fragments: [
          {
            ordinal: 0,
            kind: 'html_block',
            headingPath: ['Introduction'],
            text,
            startOffset: 0,
            endOffset: 16,
            pageNumber: 1,
          },
        ],
        parserName: 'bounded-html',
        parserVersion: '1',
      }),
    ).toBe(true);
    expect(await fetcher.markParsedPublished(parseLease)).toBe(true);
    expect(await fetcher.finalize(parseLease)).toEqual({
      resource_id: finalized.resourceId,
      version_id: finalized.versionId,
    });
    expect(await urlState(tenant, finalized.requestId)).toEqual({
      state: 'finalized',
      failure_code: null,
    });
    const resource = await inspect.query('SELECT 1 FROM resource WHERE athlete_id=$1 AND id=$2', [
      tenant,
      finalized.resourceId,
    ]);
    expect(resource.rowCount).toBe(1);

    // Kept as a bookmark after the raw page, with the object the parse left behind queued.
    const bookmarked = await repo.reserveCreate(tenant, urlInput, randomUUID());
    const bookmarkFetch = await fetcher.lease();
    if (!bookmarkFetch) throw new Error('expected a fetch lease');
    await fetchRaw(bookmarkFetch);
    const bookmarkParse = await fetcher.lease();
    if (!bookmarkParse) throw new Error('expected a parse lease');
    const abandonedRef = parsedKey(bookmarkParse, hashOf(`abandoned-${randomUUID()}`));
    await inspect.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at,completed_at)
       VALUES($1,$2,'upload_abandoned',now(),now(),now())`,
      [randomUUID(), abandonedRef],
    );
    expect(await fetcher.abandonPublishedObject(bookmarkParse, abandonedRef)).toBe(false);
    expect(await fetcher.bookmarkOnly(bookmarkParse, { name: 'bounded-html', version: '1' })).toBe(
      true,
    );
    expect(await urlState(tenant, bookmarked.requestId)).toEqual({
      state: 'bookmark_only',
      failure_code: null,
    });

    // Failed for good: its refs are queued.
    const failing = await repo.reserveCreate(tenant, urlInput, randomUUID());
    const failLease = await fetcher.lease();
    expect(failLease?.requestId).toBe(failing.requestId);
    if (!failLease) throw new Error('expected a fetch lease');
    expect(await fetcher.fail(failLease, 'TEST_FETCH_FAILED')).toBe(true);
    expect(await urlState(tenant, failing.requestId)).toEqual({
      state: 'failed',
      failure_code: 'TEST_FETCH_FAILED',
    });
    expect(await cleanupRows([failLease.rawTemporaryRef])).toMatchObject([
      { reason: 'upload_abandoned', completed_at: null },
    ]);

    // Past its deadline: reaped.
    const expiring = await repo.reserveCreate(tenant, urlInput, randomUUID());
    await inspect.query(
      `UPDATE resource_url_ingestion SET created_at=clock_timestamp()-interval '20 minutes',
         updated_at=clock_timestamp()-interval '20 minutes',
         expires_at=clock_timestamp()-interval '1 minute'
       WHERE athlete_id=$1 AND request_id=$2`,
      [tenant, expiring.requestId],
    );
    expect(await fetcher.reap(100)).toBeGreaterThanOrEqual(1);
    expect(await urlState(tenant, expiring.requestId)).toEqual({
      state: 'failed',
      failure_code: 'INGESTION_EXPIRED',
    });
  });

  it('re-arms the cleanup of an object a URL request abandoned, under the tenant it names', async () => {
    const tenant = randomUUID();
    const repo = createResourceUrlIngestionRepository(runtime);
    const reserved = await repo.reserveCreate(tenant, urlInput, randomUUID());
    const lease = await fetcher.lease();
    expect(lease?.requestId).toBe(reserved.requestId);
    if (!lease) throw new Error('expected a fetch lease');
    const storageRef = await fetchRaw(lease);
    await inspect.query(
      'UPDATE resource_object_cleanup SET completed_at=now() WHERE storage_ref=$1',
      [storageRef],
    );
    // The request is the tenant's and names this very object: the receipt reopens.
    expect(await fetcher.abandonPublishedObject(lease, storageRef)).toBe(true);
    expect(await cleanupRows([storageRef])).toMatchObject([{ completed_at: null }]);
    // The same request claimed for a stranger, with a receipt already there for the stranger's
    // key: refused, as a superuser owner refuses it — the request is looked at under the tenant
    // that holds it, and it is not the stranger's.
    const stranger = randomUUID();
    const strangerRef = storageRef.replace(`/tenants/${tenant}/`, `/tenants/${stranger}/`);
    await inspect.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at,completed_at)
       VALUES($1,$2,'upload_abandoned',now(),now(),now())`,
      [randomUUID(), strangerRef],
    );
    expect(
      await fetcher.abandonPublishedObject({ ...lease, athleteId: stranger }, strangerRef),
    ).toBe(false);
    expect(await cleanupRows([strangerRef])).toMatchObject([{ completed_at: expect.any(Date) }]);
    const parse = await fetcher.lease();
    if (parse) await fetcher.fail(parse, 'TEST_DONE');
  });

  it('reaps expired uploads of all three kinds, and prunes them a week after they closed', async () => {
    const tenant = randomUUID();
    const files = createResourceFileUploadRepository(runtime);
    const file = await files.reserveCreate(
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
    const gallery = await createGalleryMediaRepository(runtime).reserveCreate(
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
    const imported = await activities.importActivity(tenant, importInput());
    const track = await storeTrack(tenant, imported.activityId, imported.revision, false);
    const intents = [
      ['resource_upload_intent', 'resource_upload_intent_transition', file.uploadId],
      ['gallery_upload_intent', 'gallery_upload_intent_transition', gallery.uploadId],
      [
        'activity_track_upload_intent',
        'activity_track_upload_transition',
        track.reservation.uploadId,
      ],
    ] as const;
    for (const [table, guard, uploadId] of intents)
      await withGuardsOff(
        table,
        [guard],
        `UPDATE ${table} SET created_at=clock_timestamp()-interval '2 hours',
           updated_at=clock_timestamp()-interval '2 hours',
           expires_at=clock_timestamp()-interval '1 hour'
         WHERE athlete_id=$1 AND upload_id=$2`,
        [tenant, uploadId],
      );
    let reaped = 0;
    for (let run = 0; run < 5; run += 1) reaped += await worker.reapExpired(new Date(), 100);
    expect(reaped).toBeGreaterThanOrEqual(3);
    for (const [table, , uploadId] of intents) {
      const row = await inspect.query<{ state: string; failure_code: string }>(
        `SELECT state,failure_code FROM ${table} WHERE athlete_id=$1 AND upload_id=$2`,
        [tenant, uploadId],
      );
      expect(row.rows, table).toEqual([{ state: 'failed', failure_code: 'UPLOAD_EXPIRED' }]);
    }
    const queued = await inspect.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM resource_object_cleanup
       WHERE storage_ref LIKE $1 AND completed_at IS NULL`,
      [`private/v1/tenants/${tenant}/%`],
    );
    expect(queued.rows[0]?.total).toBeGreaterThanOrEqual(3);

    // A week later, with the receipts closed, the history goes.
    await inspect.query(
      `UPDATE resource_object_cleanup SET completed_at=now() WHERE storage_ref LIKE $1`,
      [`private/v1/tenants/${tenant}/%`],
    );
    for (const [table, guard, uploadId] of intents)
      await withGuardsOff(
        table,
        [guard],
        `UPDATE ${table} SET created_at=clock_timestamp()-interval '9 days',
           updated_at=clock_timestamp()-interval '8 days',
           expires_at=clock_timestamp()-interval '9 days'+interval '1 hour'
         WHERE athlete_id=$1 AND upload_id=$2`,
        [tenant, uploadId],
      );
    // Another tenant's closed upload whose receipt is still open is kept, and waits an hour.
    const waiting = randomUUID();
    const held = await createGalleryMediaRepository(runtime).reserveCreate(
      waiting,
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
    await withGuardsOff(
      'gallery_upload_intent',
      ['gallery_upload_intent_transition'],
      `UPDATE gallery_upload_intent SET state='failed',failure_code='TEST_CLOSED',
         created_at=clock_timestamp()-interval '9 days',
         updated_at=clock_timestamp()-interval '8 days',
         expires_at=clock_timestamp()-interval '9 days'+interval '1 hour'
       WHERE athlete_id=$1 AND upload_id=$2 RETURNING temporary_ref`,
      [waiting, held.uploadId],
    );
    await inspect.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
       SELECT $1,temporary_ref,'upload_abandoned',clock_timestamp()+interval '1 day',
         clock_timestamp() FROM gallery_upload_intent WHERE athlete_id=$2 AND upload_id=$3`,
      [randomUUID(), waiting, held.uploadId],
    );
    let pruned = 0;
    for (let run = 0; run < 5; run += 1) pruned += await worker.pruneUploadHistory(100);
    expect(pruned).toBeGreaterThanOrEqual(3);
    const kept = await inspect.query(
      'SELECT 1 FROM gallery_upload_intent WHERE athlete_id=$1 AND upload_id=$2',
      [waiting, held.uploadId],
    );
    expect(kept.rowCount).toBe(1);
    const deferred = await inspect.query<{ later: boolean }>(
      `SELECT due_at>clock_timestamp()+interval '50 minutes' AS later FROM tenant_work_index
       WHERE kind='gallery_upload_intent:prune' AND athlete_id=$1`,
      [waiting],
    );
    expect(deferred.rows).toEqual([{ later: true }]);
    for (const [table, , uploadId] of intents) {
      const row = await inspect.query(
        `SELECT 1 FROM ${table} WHERE athlete_id=$1 AND upload_id=$2`,
        [tenant, uploadId],
      );
      expect(row.rowCount, table).toBe(0);
    }
  });

  it('prunes every tenant’s expired search cache and keeps what has not expired', async () => {
    const tenants = [randomUUID(), randomUUID()];
    for (const tenant of tenants)
      for (const [label, expiresIn] of [
        ['old', "-interval '1 minute'"],
        ['new', "+interval '1 hour'"],
      ] as const)
        await inspect.query(
          `INSERT INTO resource_retrieval_cache(athlete_id,cache_key,corpus_version,
             authorization_digest,passage_ids,created_at,expires_at)
           VALUES($1,$2,1,$3,'[]'::jsonb,now()-interval '2 hours',now()${expiresIn})`,
          [tenant, hashOf(`${label}-${tenant}`), 'b'.repeat(64)],
        );
    expect(await derived.pruneRetrievalCache(500)).toBeGreaterThanOrEqual(2);
    const left = await inspect.query<{ athlete_id: string; cache_key: string }>(
      `SELECT athlete_id,cache_key FROM resource_retrieval_cache WHERE athlete_id=ANY($1)
       ORDER BY athlete_id`,
      [tenants],
    );
    expect(left.rows).toEqual(
      [...tenants].sort().map((tenant) => ({
        athlete_id: tenant,
        cache_key: hashOf(`new-${tenant}`),
      })),
    );
  });

  it('sweeps the same windows the whole table holds, in key order, across tenants', async () => {
    const tenants = [randomUUID(), randomUUID(), randomUUID()];
    for (const tenant of tenants)
      for (let index = 0; index < 3; index += 1) {
        await inspect.query(
          `INSERT INTO activity_track_object_ref(storage_ref,athlete_id,recorded_at)
           VALUES($1,$2,now())`,
          [`private/v1/tenants/${tenant}/activities/${randomUUID()}/sweep-${index}`, tenant],
        );
        await inspect.query(
          `INSERT INTO course_thumbnail_object_ref(storage_ref,athlete_id,recorded_at)
           VALUES($1,$2,now())`,
          [`private/v1/tenants/${tenant}/courses/${randomUUID()}/sweep-${index}`, tenant],
        );
      }
    // Keys that do not sort by tenant — the window's order is the key's, not the tenant's —
    // and one settled reference that no window may return.
    const scattered = `zz-sweep/${randomUUID()}/`;
    const [left, right] = [randomUUID(), randomUUID()];
    for (const table of ['activity_track_object_ref', 'course_thumbnail_object_ref'])
      for (const [key, athlete, settled] of [
        ['0', left, true],
        ['1', right, false],
        ['2', left, false],
        ['3', right, false],
      ] as const)
        await inspect.query(
          `INSERT INTO ${table}(storage_ref,athlete_id,recorded_at,settled_at)
           VALUES($1,$2,now()-interval '1 minute',CASE WHEN $3 THEN now() END)`,
          [scattered + key, athlete, settled],
        );
    const truth = async (table: string, cursor: string, limit: number) => {
      const rows = await inspect.query<{ storage_ref: string }>(
        `SELECT storage_ref FROM ${table} WHERE settled_at IS NULL AND storage_ref>$1
         ORDER BY storage_ref LIMIT $2`,
        [cursor, limit],
      );
      return rows.rows.map((row) => row.storage_ref);
    };
    const cursor = `private/v1/tenants/${[...tenants].sort()[0]}`;
    for (const [table, window] of [
      ['activity_track_object_ref', worker.reconcileWindow.bind(worker)],
      ['course_thumbnail_object_ref', worker.thumbnailReconcileWindow.bind(worker)],
    ] as const) {
      for (const [from, limit] of [
        ['', 1000],
        [cursor, 4],
        [cursor, 1000],
        [scattered, 1],
        [scattered, 2],
        [scattered, 1000],
      ] as const) {
        const expected = await truth(table, from, limit);
        expect(expected.length, table).toBeGreaterThan(0);
        const seen = await window(from, limit);
        expect(
          seen.map((candidate) => candidate.storageRef),
          `${table} ${from} ${limit}`,
        ).toEqual(expected);
      }
    }

    // A fault is recorded against the reference and cleared again, under its tenant.
    const [faulty] = await truth('activity_track_object_ref', cursor, 1);
    if (!faulty) throw new Error('expected a watched reference');
    expect(await worker.recordTrackSweepFault(faulty, 'EACCES')).toBe(1);
    const [deferred] = (await worker.reconcileWindow(cursor, 1)).filter(
      (candidate) => candidate.storageRef === faulty,
    );
    expect(deferred).toMatchObject({ sweepAttempts: 1, deferred: true });
    expect(await worker.clearTrackSweepFault(faulty)).toBe(true);
    const [thumbnailFaulty] = await truth('course_thumbnail_object_ref', cursor, 1);
    if (!thumbnailFaulty) throw new Error('expected a watched reference');
    expect(await worker.recordThumbnailSweepFault(thumbnailFaulty, 'EACCES')).toBe(1);
    expect(await worker.clearThumbnailSweepFault(thumbnailFaulty)).toBe(true);
    // A key that names no tenant is recorded and cleared under the watched row's own tenant.
    expect(await worker.recordTrackSweepFault(`${scattered}1`, 'EACCES')).toBe(1);
    expect(await worker.recordThumbnailSweepFault(`${scattered}1`, 'EACCES')).toBe(1);
    expect(await worker.clearTrackSweepFault(`${scattered}1`)).toBe(true);
    expect(await worker.clearThumbnailSweepFault(`${scattered}1`)).toBe(true);
    // A fault on a reference that has since settled is still cleared, under its key's tenant.
    for (const [table, record, clear] of [
      [
        'activity_track_object_ref',
        worker.recordTrackSweepFault.bind(worker),
        worker.clearTrackSweepFault.bind(worker),
      ],
      [
        'course_thumbnail_object_ref',
        worker.recordThumbnailSweepFault.bind(worker),
        worker.clearThumbnailSweepFault.bind(worker),
      ],
    ] as const) {
      const [settling] = await truth(table, cursor, 1);
      if (!settling) throw new Error('expected a watched reference');
      expect(await record(settling, 'EACCES')).toBe(1);
      await inspect.query(`UPDATE ${table} SET settled_at=now() WHERE storage_ref=$1`, [settling]);
      expect(await clear(settling), table).toBe(true);
    }
  });

  it('does nothing when an index entry names a tenant the row does not belong to', async () => {
    const holder = await tenantWithCourse();
    // Sorts after every tenant: a lookup that took the least of two tenants would name the holder.
    const stranger = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const [row] = await renders(holder.tenant);
    if (!row) throw new Error('expected a queued render');
    // The job id is also claimed for a stranger: two tenants, so no tenant is named.
    await inspect.query(
      `INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
       VALUES('course_thumbnail:job',$1,$2,NULL)`,
      [row.job_id, stranger],
    );
    const lease = await leaseRenderFor(holder.tenant);
    const sha256 = hashOf(`svg-${lease.jobId}`);
    const storageRef = finalThumbnailKey(lease, sha256);
    expect(
      await renderer.prepare(lease, { storageRef, sha256, byteSize: 512, vertexCount: 3 }),
    ).toBe(false);
    expect(await renderer.fail(lease, 'TEST_NEVER')).toBe(false);
    // Only the stranger is named now: the body looks under the stranger and finds nothing.
    await inspect.query(
      `DELETE FROM tenant_work_index WHERE kind='course_thumbnail:job' AND item=$1
       AND athlete_id=$2`,
      [row.job_id, holder.tenant],
    );
    expect(
      await renderer.prepare(lease, { storageRef, sha256, byteSize: 512, vertexCount: 3 }),
    ).toBe(false);
    expect(await renderer.finalize(lease)).toBe('lease_lost');
    expect(await renderer.release(lease)).toBe(false);
    expect(await renders(holder.tenant)).toMatchObject([
      { state: 'rendering', storage_ref: null, failure_code: null },
    ]);
    // Due work claimed for a stranger that holds none is not found under the stranger.
    await inspect.query(
      `INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
       VALUES('course_thumbnail:prune',$1,$2,now()-interval '1 day'),
         ('course_thumbnail:reap',$1,$2,now()-interval '1 day')`,
      [row.job_id, stranger],
    );
    await worker.pruneCourseThumbnailHistory(100);
    await worker.reapCourseThumbnailRenders(100);
    expect(await renders(holder.tenant)).toMatchObject([{ state: 'rendering' }]);
  });

  it('keeps the index to the rows, and erasing an account leaves no entry of it', async () => {
    const { tenant } = await tenantWithCourse();
    await inspect.query(
      `INSERT INTO resource_retrieval_cache(athlete_id,cache_key,corpus_version,
         authorization_digest,passage_ids,created_at,expires_at)
       VALUES($1,$2,1,$3,'[]'::jsonb,now(),now()+interval '1 hour')`,
      [tenant, hashOf(`erase-${tenant}`), 'b'.repeat(64)],
    );
    const kinds = async () => {
      const rows = await inspect.query<{ kind: string }>(
        'SELECT DISTINCT kind FROM tenant_work_index WHERE athlete_id=$1 ORDER BY kind',
        [tenant],
      );
      return rows.rows.map((row) => row.kind);
    };
    expect(await kinds()).toEqual([
      'activity_track_object_ref:window',
      'course_thumbnail:job',
      'course_thumbnail:lease',
      'course_thumbnail:reap',
      'course_thumbnail_object_ref:window',
      'resource_retrieval_cache:prune',
    ]);
    const lease = await leaseRenderFor(tenant);
    const sha256 = hashOf(`svg-${lease.jobId}`);
    await renderer.prepare(lease, {
      storageRef: finalThumbnailKey(lease, sha256),
      sha256,
      byteSize: 512,
      vertexCount: 3,
    });
    expect(await renderer.finalize(lease)).toBe('ready');
    // A published picture is no render's work any more; its id stays known.
    expect(await kinds()).toEqual([
      'activity_track_object_ref:window',
      'course_thumbnail:job',
      'course_thumbnail_object_ref:window',
      'resource_retrieval_cache:prune',
    ]);
    await expect(operations.eraseAccount(tenant)).resolves.toEqual({ erased: true });
    expect(await kinds()).toEqual([]);
  });

  it('leaves the caller’s tenant setting as it was', async () => {
    const { tenant } = await tenantWithCourse();
    const callerTenant = randomUUID();
    // Work of every kind due for a tenant that holds none: each scan names that tenant, finds
    // nothing under it, and must still put the caller's setting back.
    const nobody = randomUUID();
    await inspect.query(
      `INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
       SELECT kind,$2,$1,now()-interval '1 day' FROM unnest(ARRAY['course_thumbnail:lease',
         'course_thumbnail:reap','course_thumbnail:prune','resource_url_ingestion:lease',
         'resource_url_ingestion:reap','resource_upload_intent:reap','gallery_upload_intent:reap',
         'activity_track_upload_intent:reap','resource_upload_intent:prune',
         'gallery_upload_intent:prune','activity_track_upload_intent:prune',
         'resource_retrieval_cache:prune']) kind
       UNION ALL SELECT kind,$2,$1,NULL FROM unnest(ARRAY['activity_track_object_ref:window',
         'course_thumbnail_object_ref:window']) kind`,
      [nobody, randomUUID()],
    );
    await withSession(renderRole, callerTenant, async (session) => {
      const leased = await session.query<{ job_id: string; lease_token: string }>(
        "SELECT * FROM public.lease_course_thumbnail_render($1,interval '60 seconds')",
        [randomUUID()],
      );
      expect(await tenantSetting(session)).toBe(callerTenant);
      const job = leased.rows[0];
      if (!job) throw new Error('expected a render');
      for (const statement of [
        'SELECT public.course_thumbnail_publication_fence_open($1,$2)',
        'SELECT public.release_course_thumbnail_render($1,$2)',
        'SELECT * FROM public.finalize_course_thumbnail($1,$2)',
      ]) {
        await session.query(statement, [job.job_id, job.lease_token]);
        expect(await tenantSetting(session), statement).toBe(callerTenant);
      }
      await session.query('SELECT public.requeue_course_thumbnail_refs($1)', [job.job_id]);
      expect(await tenantSetting(session)).toBe(callerTenant);
      const unknown = [randomUUID(), randomUUID()];
      for (const [statement, values] of [
        [
          "SELECT public.prepare_course_thumbnail($1,$2,'private/v1/none',$3,512,3)",
          [...unknown, 'c'.repeat(64)],
        ],
        [
          "SELECT public.mark_course_thumbnail_unavailable($1,$2,'line_too_short_to_draw')",
          unknown,
        ],
        ["SELECT public.fail_course_thumbnail($1,$2,'X',false,interval '0 seconds')", unknown],
      ] as const) {
        await session.query(statement, [...values]);
        expect(await tenantSetting(session), statement).toBe(callerTenant);
      }
    });
    await withSession(workerRole, callerTenant, async (session) => {
      for (const statement of [
        'SELECT public.reap_course_thumbnail_renders(100)',
        'SELECT public.prune_course_thumbnail_history(100)',
        'SELECT public.reap_expired_resource_uploads(now(),100)',
        'SELECT public.prune_resource_upload_history(100)',
        'SELECT public.prune_resource_retrieval_cache(100)',
        "SELECT * FROM public.activity_track_reconcile_window('',1000)",
        "SELECT * FROM public.course_thumbnail_reconcile_window('',1000)",
      ]) {
        await session.query(statement);
        expect(await tenantSetting(session), statement).toBe(callerTenant);
      }
      const ref = `private/v1/tenants/${tenant}/sweep/${randomUUID()}`;
      for (const statement of [
        "SELECT public.record_activity_track_sweep_fault($1,'EACCES')",
        'SELECT public.clear_activity_track_sweep_fault($1)',
        "SELECT public.record_course_thumbnail_sweep_fault($1,'EACCES')",
        'SELECT public.clear_course_thumbnail_sweep_fault($1)',
      ]) {
        await session.query(statement, [ref]);
        expect(await tenantSetting(session), statement).toBe(callerTenant);
      }
    });
    await withSession(urlRole, callerTenant, async (session) => {
      await session.query("SELECT * FROM public.lease_resource_url_ingestion($1,interval '1 s')", [
        randomUUID(),
      ]);
      expect(await tenantSetting(session)).toBe(callerTenant);
      await session.query('SELECT public.reap_resource_url_ingestions(100)');
      expect(await tenantSetting(session)).toBe(callerTenant);
      const request = randomUUID();
      const token = randomUUID();
      for (const [statement, values] of [
        [
          "SELECT public.record_resource_url_hop($1,$2,0,'https://example.com',$3,200,ARRAY['93.184.216.34']::inet[],'ssrf-v1')",
          [request, token, 'c'.repeat(64)],
        ],
        [
          "SELECT public.prepare_resource_url_raw($1,$2,'private/v1/none',$3,100,'text/html')",
          [request, token, 'c'.repeat(64)],
        ],
        ['SELECT public.mark_resource_url_raw_published($1,$2)', [request, token]],
        [
          `SELECT public.prepare_resource_url_parsed($1,$2,'private/v1/none',$3,100,'text',
             '[]'::jsonb,'p','1')`,
          [request, token, 'c'.repeat(64)],
        ],
        ['SELECT public.mark_resource_url_parsed_published($1,$2)', [request, token]],
        ['SELECT * FROM public.finalize_resource_url_ingestion($1,$2)', [request, token]],
        ["SELECT public.mark_resource_url_bookmark_only($1,$2,'p','1')", [request, token]],
        [
          "SELECT public.fail_resource_url_ingestion($1,$2,'X',false,interval '0 seconds')",
          [request, token],
        ],
        [
          'SELECT public.enqueue_abandoned_resource_url_object($1,$2,$3,$4)',
          [tenant, request, randomUUID(), 'private/v1/none'],
        ],
      ] as const) {
        await session.query(statement, [...values]);
        expect(await tenantSetting(session), statement).toBe(callerTenant);
      }
    });
  });
});
