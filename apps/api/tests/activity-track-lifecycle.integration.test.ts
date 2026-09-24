import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';
import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
import { validateObjectKey } from '@workout/server-media/keys';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import { createActivityRepository } from '@workout/server-persistence/activities';
import { createOperationsRepository } from '@workout/server-persistence/operations';
import { createActivityTrackRepository } from '@workout/server-persistence/activity-tracks';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import {
  grantActivityTracks,
  grantOperations,
  grantResourceObjectCleanupWorker,
  migrate,
} from '@workout/server-persistence/migrate';
import {
  createResourceObjectCleanupRepository,
  processOneResourceObjectCleanup,
} from '@workout/server-persistence/resource-object-cleanup';
import { createBoundedTrackParser } from '@workout/server-track-storage/parse-host';

import { createApi } from '../src/app.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Isolated real PostgreSQL required: run pnpm test:integration');

const admin = new Pool({ connectionString: adminUrl });
const workerRole = `track_publish_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
let database: Database;
let objectRoot: string;
let workerUrl: string;
let athleteId: string;

const csrfToken = 'c'.repeat(43);
const headers = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};

const gpxBytes = Buffer.from(
  `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>` +
    `<trkpt lat="37.5" lon="127.02"><time>2026-03-01T00:00:00Z</time></trkpt>` +
    `<trkpt lat="37.5001" lon="127.0201"><time>2026-03-01T00:00:10Z</time></trkpt>` +
    `<trkpt lat="37.5002" lon="127.0202"><time>2026-03-01T00:00:20Z</time></trkpt>` +
    `</trkseg></trk></gpx>`,
  'utf8',
);

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantActivityTracks(adminUrl, 'workout_runtime');
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
     activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,
     activity_import_receipt TO workout_runtime`,
  );
  await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
  await grantResourceObjectCleanupWorker(adminUrl, workerRole);
  const parsed = new URL(runtimeUrl);
  parsed.username = workerRole;
  workerUrl = parsed.href;
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  objectRoot = await mkdtemp(join(tmpdir(), 'track-lifecycle-'));
  athleteId = randomUUID();
});

afterAll(async () => {
  await database?.close();
  await admin.end();
  if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
});

function importInput(): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Track run',
      kind: 'running',
      startedAt: '2026-09-16T08:00:00+09:00',
      durationSeconds: 600,
      durationKind: 'timer',
      timezone: 'Asia/Seoul',
      distanceMeters: 1000,
    },
  };
}

/**
 * The product storage adapter with one seam in the test: a hook that runs once, just before
 * the first object of an upload becomes visible. That is the exact instant a deletion has to
 * be able to interleave with a writer, and nothing in the product code changes for it.
 */
function interceptFirstPublish(inner: ObjectStorage, hook: () => Promise<void>): ObjectStorage {
  let fired = false;
  return {
    writeTemporary: (key, body) => inner.writeTemporary(key, body),
    async publishTemporary(temporaryKey, finalKey, expectation) {
      if (!fired) {
        fired = true;
        await hook();
      }
      return inner.publishTemporary(temporaryKey, finalKey, expectation);
    },
    open: (key) => inner.open(key),
    stat: (key) => inner.stat(key),
    delete: (key) => inner.delete(key),
  };
}

async function drainCleanup(storage: ObjectStorage) {
  const worker = createResourceObjectCleanupRepository({ connectionString: workerUrl, max: 1 });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const outcome = await processOneResourceObjectCleanup(worker, (ref) =>
        storage.delete(validateObjectKey(ref)),
      );
      if (outcome === 'empty') break;
    }
  } finally {
    await worker.close();
  }
}

function setup(storage: ObjectStorage) {
  return createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () => ({
        athleteId,
        sessionId: 'current',
        csrfToken,
        method: 'cookie' as const,
      }),
    },
    consent: {
      getConsent: async () => ({ kind: 'ai' as const, granted: false, revision: 0 }),
      setConsent: async () => ({ kind: 'ai' as const, granted: false, revision: 0 }),
    },
    activityTracks: {
      tracks: createActivityTrackRepository(database),
      storage,
      parser: createBoundedTrackParser({
        execArgv: ['--import', 'tsx'],
        maxOldGenerationSizeMb: 256,
      }),
    },
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
}

async function refsOf(uploadId: string) {
  const rows = await admin.query<{
    raw_storage_ref: string | null;
    normalized_storage_ref: string | null;
    map_path_storage_ref: string | null;
  }>(
    `SELECT raw_storage_ref,normalized_storage_ref,map_path_storage_ref
     FROM activity_track_upload_intent WHERE upload_id=$1`,
    [uploadId],
  );
  const row = rows.rows[0];
  if (!row) throw new Error('upload intent missing');
  return [row.raw_storage_ref, row.normalized_storage_ref, row.map_path_storage_ref].filter(
    (value): value is string => value !== null,
  );
}

describe('a cancelled writer cannot leave objects behind', () => {
  it(
    'reclaims every object when the activity is deleted and cleaned up mid-publication',
    { timeout: 120_000 },
    async () => {
      const activities = createActivityRepository(database);
      const imported = await activities.importActivity(athleteId, importInput());
      const storage = await createLocalFilesystemObjectStorage(objectRoot);
      let deletionRan = false;
      // The deletion — and a full cleanup pass over its manifest — happens after the
      // upload has been prepared and before its first object is visible. This is the
      // sequence that used to leave raw, normalized and map_path objects on disk with
      // their queue rows already completed.
      const app = setup(
        interceptFirstPublish(storage, async () => {
          await activities.deleteActivity(athleteId, imported.activityId, {
            expectedRevision: imported.revision,
          });
          await drainCleanup(storage);
          deletionRan = true;
        }),
      );
      try {
        const reservation = await app.inject({
          method: 'POST',
          url: `/bff/v1/activities/${imported.activityId}/track-uploads`,
          headers: { ...headers, 'idempotency-key': `track-${randomUUID()}` },
          payload: { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
        });
        expect(reservation.statusCode).toBe(200);
        const uploadId = reservation.json().uploadId as string;
        const content = await app.inject({
          method: 'PUT',
          url: `/bff/v1/activity-track-uploads/${uploadId}/content`,
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          payload: gpxBytes,
        });
        expect(deletionRan).toBe(true);
        // The writer is refused: the upload was cancelled with its activity.
        expect(content.statusCode).toBeGreaterThanOrEqual(400);
        const refs = await refsOf(uploadId);
        expect(refs).toHaveLength(3);
        // Before the fix the objects were published after cleanup had finished, so they
        // survived this drain. Now the writer hands them back and the manifest takes them.
        await drainCleanup(storage);
        for (const ref of refs) expect(await storage.stat(validateObjectKey(ref))).toBeNull();
        // The receipts stay open on purpose until the cancelled upload expires: a request
        // that is still running could make one of these visible again, and a closed receipt
        // would never look. They are held, not stuck — the reason says so.
        const pending = await admin.query(
          `SELECT count(*)::int AS count FROM resource_object_cleanup
           WHERE storage_ref=ANY($1) AND completed_at IS NULL
             AND last_error_code='PUBLICATION_WINDOW_OPEN' AND attempts=0`,
          [refs],
        );
        expect(pending.rows[0]?.['count']).toBe(3);
        const temporaries = await admin.query(
          `SELECT raw_temporary_ref,normalized_temporary_ref,map_path_temporary_ref
           FROM activity_track_upload_intent WHERE upload_id=$1`,
          [uploadId],
        );
        for (const ref of Object.values(temporaries.rows[0] ?? {}))
          expect(await storage.stat(validateObjectKey(String(ref)))).toBeNull();
        // The deleted activity gained no track.
        expect(
          await createActivityTrackRepository(database).read(athleteId, imported.activityId),
        ).toEqual({ status: 'unavailable', activityId: imported.activityId });
      } finally {
        await app.close();
      }
    },
  );

  it(
    'keeps an erased account cleanup receipt open across a late publication',
    { timeout: 120_000 },
    async () => {
      // Account erasure deletes the upload intent, so the two-minute publication fence
      // cannot protect this window. What protects it is M2-04c's erasure fence: for thirty
      // days a successful delete does not close an `account_erased` receipt, it re-arms it
      // hourly. This test pins that the track refs really are queued under that reason
      // before the intent disappears, that cleanup therefore never records them as done,
      // and that a later pass removes whatever the writer published in the meantime.
      const erasedAthlete = randomUUID();
      const previousAthlete = athleteId;
      athleteId = erasedAthlete;
      let refs: string[] = [];
      try {
        const activities = createActivityRepository(database);
        const imported = await activities.importActivity(erasedAthlete, importInput());
        const storage = await createLocalFilesystemObjectStorage(objectRoot);
        let uploadId = '';
        const app = setup(
          interceptFirstPublish(storage, async () => {
            // The intent still exists here, with the final refs it recorded at prepare.
            refs = await refsOf(uploadId);
            await createOperationsRepository(database).eraseAccount(erasedAthlete);
            // Cleanup reaches the three final refs before the writer publishes them. The
            // temporary refs are held back so the interleaving is the one under test —
            // deleting a temporary object would block publication by accident and hide the
            // race instead of exercising it.
            await admin.query(
              `UPDATE resource_object_cleanup SET available_at=clock_timestamp()+interval '1 hour'
               WHERE storage_ref LIKE $1 AND storage_ref NOT LIKE $2`,
              [`private/v1/tenants/${erasedAthlete}/%`, '%/sha256/%'],
            );
            await drainCleanup(storage);
          }),
        );
        try {
          const reservation = await app.inject({
            method: 'POST',
            url: `/bff/v1/activities/${imported.activityId}/track-uploads`,
            headers: { ...headers, 'idempotency-key': `track-${randomUUID()}` },
            payload: { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
          });
          uploadId = reservation.json().uploadId as string;
          await app.inject({
            method: 'PUT',
            url: `/bff/v1/activity-track-uploads/${uploadId}/content`,
            headers: { ...headers, 'content-type': 'application/octet-stream' },
            payload: gpxBytes,
          });
        } finally {
          await app.close();
        }
        expect(refs).toHaveLength(3);
        expect(
          (
            await admin.query(
              'SELECT count(*)::int AS count FROM activity_track_upload_intent WHERE upload_id=$1',
              [uploadId],
            )
          ).rows[0]?.['count'],
        ).toBe(0);
        // Whatever the writer managed to publish, the receipts are still open — the drain
        // that ran against absent objects did not close them.
        const receipts = await admin.query(
          `SELECT count(*)::int AS count FROM resource_object_cleanup
           WHERE storage_ref=ANY($1) AND completed_at IS NULL AND reason='account_erased'
             AND last_error_code='ERASURE_FENCE_ACTIVE'`,
          [refs],
        );
        expect(receipts.rows[0]?.['count']).toBe(3);
        // An hour later the fence re-arms and the same worker removes them.
        await admin.query(
          `UPDATE resource_object_cleanup SET available_at=clock_timestamp()
           WHERE storage_ref=ANY($1)`,
          [refs],
        );
        await drainCleanup(storage);
        for (const ref of refs) expect(await storage.stat(validateObjectKey(ref))).toBeNull();
      } finally {
        athleteId = previousAthlete;
      }
    },
  );

  it(
    'stops publishing as soon as its own publication fence has passed',
    { timeout: 120_000 },
    async () => {
      const activities = createActivityRepository(database);
      const imported = await activities.importActivity(athleteId, importInput());
      const storage = await createLocalFilesystemObjectStorage(objectRoot);
      let uploadId = '';
      // A writer that stalls past its window mid-sequence. The fence is re-checked before
      // each object, so at most the one already in flight can become visible and the rest
      // are never created; the manifest then reclaims what slipped through.
      const app = setup(
        interceptFirstPublish(storage, async () => {
          await admin.query(
            'ALTER TABLE activity_track_upload_intent DISABLE TRIGGER activity_track_upload_transition',
          );
          await admin.query(
            `UPDATE activity_track_upload_intent
             SET prepared_at=clock_timestamp()-interval '5 minutes',
                 publication_lease_until=clock_timestamp()-interval '1 second'
             WHERE upload_id=$1`,
            [uploadId],
          );
          await admin.query(
            'ALTER TABLE activity_track_upload_intent ENABLE TRIGGER activity_track_upload_transition',
          );
        }),
      );
      try {
        const reservation = await app.inject({
          method: 'POST',
          url: `/bff/v1/activities/${imported.activityId}/track-uploads`,
          headers: { ...headers, 'idempotency-key': `track-${randomUUID()}` },
          payload: { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
        });
        uploadId = reservation.json().uploadId as string;
        const content = await app.inject({
          method: 'PUT',
          url: `/bff/v1/activity-track-uploads/${uploadId}/content`,
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          payload: gpxBytes,
        });
        expect(content.statusCode).toBe(409);
        expect(content.json()).toMatchObject({ error: { code: 'UPLOAD_RETRY_REQUIRED' } });
      } finally {
        await app.close();
      }
      const refs = await refsOf(uploadId);
      const present = await Promise.all(
        refs.map(async (ref) => (await storage.stat(validateObjectKey(ref))) !== null),
      );
      // The derivatives were never made visible: the fence closed before them.
      expect(present.filter(Boolean)).toHaveLength(1);
      // And the one that slipped through is reclaimed.
      await drainCleanup(storage);
      for (const ref of refs) expect(await storage.stat(validateObjectKey(ref))).toBeNull();
    },
  );

  it(
    'fails an upload whose store refuses a publication midway and reclaims every object it staged',
    { timeout: 120_000 },
    async () => {
      // M2-01k-h: the publication itself fails. The real store refuses the second object
      // (its bytes do not match what the request declares), after the first object is already
      // visible. Nothing else interferes: the activity is live and the fence is open, so only
      // the writer's own failure handling can hand the published and staged objects back.
      const activities = createActivityRepository(database);
      const imported = await activities.importActivity(athleteId, importInput());
      const storage = await createLocalFilesystemObjectStorage(objectRoot);
      let publications = 0;
      const refusing: ObjectStorage = {
        writeTemporary: (key, body) => storage.writeTemporary(key, body),
        publishTemporary: (temporaryKey, finalKey, expectation) => {
          publications += 1;
          return storage.publishTemporary(
            temporaryKey,
            finalKey,
            publications === 2 ? { ...expectation, sha256: '0'.repeat(64) } : expectation,
          );
        },
        open: (key) => storage.open(key),
        stat: (key) => storage.stat(key),
        delete: (key) => storage.delete(key),
      };
      const app = setup(refusing);
      let uploadId = '';
      try {
        const reservation = await app.inject({
          method: 'POST',
          url: `/bff/v1/activities/${imported.activityId}/track-uploads`,
          headers: { ...headers, 'idempotency-key': `track-${randomUUID()}` },
          payload: { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
        });
        expect(reservation.statusCode).toBe(200);
        uploadId = reservation.json().uploadId as string;
        const content = await app.inject({
          method: 'PUT',
          url: `/bff/v1/activity-track-uploads/${uploadId}/content`,
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          payload: gpxBytes,
        });
        expect(publications).toBe(2);
        expect(content.statusCode).toBe(409);
        expect(content.json()).toMatchObject({ error: { code: 'OBJECT_STORAGE_CONFLICT' } });
        // The failure is recorded against the upload, so it can never be finalized.
        const finalize = await app.inject({
          method: 'POST',
          url: `/bff/v1/activity-track-uploads/${uploadId}/finalize`,
          headers,
        });
        expect(finalize.statusCode).toBe(409);
        expect(finalize.json()).toMatchObject({ error: { code: 'UPLOAD_FAILED' } });
      } finally {
        await app.close();
      }
      const intent = await admin.query(
        `SELECT state,failure_code,raw_temporary_ref,normalized_temporary_ref,map_path_temporary_ref
         FROM activity_track_upload_intent WHERE upload_id=$1`,
        [uploadId],
      );
      expect(intent.rows[0]).toMatchObject({
        state: 'failed',
        failure_code: 'OBJECT_STORAGE_CONFLICT',
      });
      const refs = await refsOf(uploadId);
      expect(refs).toHaveLength(3);
      const [rawFinal] = refs;
      if (!rawFinal) throw new Error('raw final ref missing');
      // The first object really did become visible before the store refused the second.
      expect(await storage.stat(validateObjectKey(rawFinal))).not.toBeNull();
      const temporaries = [
        intent.rows[0]?.['raw_temporary_ref'],
        intent.rows[0]?.['normalized_temporary_ref'],
        intent.rows[0]?.['map_path_temporary_ref'],
      ].map((ref) => validateObjectKey(String(ref)));
      // Recording the failure queued every reference at once — the activity is alive and
      // nothing has expired, so no other path would. While the writer's fence is open the
      // worker holds the receipts rather than closing them.
      await drainCleanup(storage);
      const held = await admin.query(
        `SELECT count(DISTINCT storage_ref)::int AS count FROM resource_object_cleanup
         WHERE storage_ref=ANY($1) AND completed_at IS NULL
           AND last_error_code='PUBLICATION_IN_PROGRESS'`,
        [[...refs, ...temporaries]],
      );
      expect(held.rows[0]?.['count']).toBe(6);
      // Once the fence has passed, the same worker takes all of it.
      await admin.query(
        'ALTER TABLE activity_track_upload_intent DISABLE TRIGGER activity_track_upload_transition',
      );
      try {
        await admin.query(
          `UPDATE activity_track_upload_intent
           SET prepared_at=clock_timestamp()-interval '10 minutes',
               publication_lease_until=clock_timestamp()-interval '1 minute'
           WHERE upload_id=$1`,
          [uploadId],
        );
      } finally {
        // A failing statement must not leave the transition trigger off for later tests.
        await admin.query(
          'ALTER TABLE activity_track_upload_intent ENABLE TRIGGER activity_track_upload_transition',
        );
      }
      await admin.query(
        `UPDATE resource_object_cleanup SET available_at=clock_timestamp()
         WHERE storage_ref=ANY($1) AND completed_at IS NULL`,
        [[...refs, ...temporaries]],
      );
      await drainCleanup(storage);
      for (const ref of refs) expect(await storage.stat(validateObjectKey(ref))).toBeNull();
      for (const ref of temporaries) expect(await storage.stat(ref)).toBeNull();
      expect(
        await createActivityTrackRepository(database).read(athleteId, imported.activityId),
      ).toEqual({ status: 'unavailable', activityId: imported.activityId });
    },
  );

  it(
    'defers cleanup while a publication fence is open and deletes once it has passed',
    { timeout: 120_000 },
    async () => {
      const activities = createActivityRepository(database);
      const imported = await activities.importActivity(athleteId, importInput());
      const storage = await createLocalFilesystemObjectStorage(objectRoot);
      let uploadId = '';
      // This writer publishes and then vanishes without compensating, which is what a
      // crashed request looks like. Only the fence protects its objects.
      const app = setup(
        interceptFirstPublish(storage, async () => {
          await activities.deleteActivity(athleteId, imported.activityId, {
            expectedRevision: imported.revision,
          });
        }),
      );
      try {
        const reservation = await app.inject({
          method: 'POST',
          url: `/bff/v1/activities/${imported.activityId}/track-uploads`,
          headers: { ...headers, 'idempotency-key': `track-${randomUUID()}` },
          payload: { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
        });
        uploadId = reservation.json().uploadId as string;
        // The publication fence is still open here, so the objects it queued must not be
        // recorded as deleted. The request itself is allowed to fail.
        await app
          .inject({
            method: 'PUT',
            url: `/bff/v1/activity-track-uploads/${uploadId}/content`,
            headers: { ...headers, 'content-type': 'application/octet-stream' },
            payload: gpxBytes,
          })
          .catch(() => undefined);
      } finally {
        await app.close();
      }
      const refs = await refsOf(uploadId);
      // Undo the writer's own compensation so only the fence is under test: a crashed
      // request would have left its fence open and its queue rows untouched. The fence is
      // trigger-protected, so the fixture suspends the trigger for this one statement.
      await admin.query(
        'ALTER TABLE activity_track_upload_intent DISABLE TRIGGER activity_track_upload_transition',
      );
      await admin.query(
        `UPDATE activity_track_upload_intent
         SET prepared_at=clock_timestamp(),
             publication_lease_until=clock_timestamp()+interval '2 minutes'
         WHERE upload_id=$1`,
        [uploadId],
      );
      await admin.query(
        'ALTER TABLE activity_track_upload_intent ENABLE TRIGGER activity_track_upload_transition',
      );
      await admin.query(
        `UPDATE resource_object_cleanup SET completed_at=NULL,delete_authorized_at=NULL,
         lease_owner=NULL,lease_until=NULL,attempts=0,available_at=clock_timestamp(),
         last_error_code=NULL
         WHERE storage_ref=ANY($1)`,
        [refs],
      );
      await drainCleanup(storage);
      const deferred = await admin.query(
        `SELECT count(*)::int AS count FROM resource_object_cleanup
         WHERE storage_ref=ANY($1) AND completed_at IS NULL
           AND last_error_code='PUBLICATION_IN_PROGRESS' AND attempts=0`,
        [refs],
      );
      expect(deferred.rows[0]?.['count']).toBe(3);
      // The fence is what held the deletion back; once it has passed, the same worker
      // reclaims the objects the writer left behind.
      await admin.query(
        'ALTER TABLE activity_track_upload_intent DISABLE TRIGGER activity_track_upload_transition',
      );
      await admin.query(
        `UPDATE activity_track_upload_intent
         SET prepared_at=clock_timestamp()-interval '10 minutes',
             publication_lease_until=clock_timestamp()-interval '1 minute'
         WHERE upload_id=$1`,
        [uploadId],
      );
      await admin.query(
        'ALTER TABLE activity_track_upload_intent ENABLE TRIGGER activity_track_upload_transition',
      );
      await admin.query(
        `UPDATE resource_object_cleanup SET available_at=clock_timestamp()
         WHERE storage_ref=ANY($1) AND completed_at IS NULL`,
        [refs],
      );
      await drainCleanup(storage);
      for (const ref of refs) expect(await storage.stat(validateObjectKey(ref))).toBeNull();
    },
  );
});
