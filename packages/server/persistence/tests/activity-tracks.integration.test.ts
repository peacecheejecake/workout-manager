import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';
import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
import {
  createActivityTrackFinalObjectKey,
  createActivityTrackTemporaryObjectKey,
  parseObjectKey,
  validateObjectKey,
} from '@workout/server-media/keys';
import type { ObjectStorage } from '@workout/server-media/object-storage';

import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import {
  ActivityTrackNotFoundError,
  ActivityTrackUploadStateError,
  createActivityTrackRepository,
  type ActivityTrackRepository,
} from '../src/activity-tracks.js';
import { createDatabase, type Database } from '../src/database.js';
import {
  grantActivityTracks,
  grantOperations,
  grantResourceObjectCleanupWorker,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { PersistenceConflict } from '../src/outbox.js';
import {
  createResourceObjectCleanupRepository,
  processOneResourceObjectCleanup,
  reconcileActivityTrackObjects,
} from '../src/resource-object-cleanup.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let tracks: ActivityTrackRepository;
let activities: ActivityRepository;
let objectRoot: string;
// The cleanup worker gets its own least-privilege role: granting the queue functions to
// the runtime role would be both wrong and a privilege that leaks into every other test.
const workerRole = `track_cleanup_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
let workerUrl: string;

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantActivityTracks(adminUrl, 'workout_runtime');
  await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
  await grantResourceObjectCleanupWorker(adminUrl, workerRole);
  const parsedWorkerUrl = new URL(runtimeUrl);
  parsedWorkerUrl.username = workerRole;
  workerUrl = parsedWorkerUrl.href;
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
     activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,
     activity_import_receipt TO workout_runtime`,
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  tracks = createActivityTrackRepository(database);
  activities = createActivityRepository(database);
  objectRoot = await mkdtemp(join(tmpdir(), 'track-objects-'));
});

afterAll(async () => {
  await database?.close();
  await admin.end();
  if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
});

function importInput(sourceId = randomUUID()): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId, revision: 1, contentHash: 'a'.repeat(64) },
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

function hashOf(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function finalRef(input: {
  athleteId: string;
  activityId: string;
  trackId: string;
  uploadId: string;
  artifactKind: 'raw' | 'normalized' | 'map_path';
  sha256: string;
  extension: 'fit' | 'gpx' | 'json';
}) {
  return `private/v1/tenants/${input.athleteId}/activities/${input.activityId}/tracks/${input.trackId}/${input.artifactKind}/uploads/${input.uploadId}/sha256/${input.sha256}.${input.extension}`;
}

interface StoreOptions {
  readonly correspondence?: string;
  readonly rawContent?: string;
  readonly normalizedContent?: string;
  readonly segmentCount?: number;
  readonly finalize?: boolean;
  /** Declared object sizes, for the byte-quota cases. */
  readonly sizes?: { readonly raw: number; readonly normalized: number; readonly mapPath: number };
}

/**
 * The lifecycle the API drives: reserve, record every object reference, stage, finalize.
 * The test supplies the parse facts the bounded worker would produce.
 */
async function storeTrack(
  athleteId: string,
  activityId: string,
  expectedActivityRevision: number,
  options: StoreOptions = {},
) {
  const reservation = await tracks.reserve(
    athleteId,
    activityId,
    { expectedActivityRevision, recordedTrackIndex: 0 },
    `track-${randomUUID()}`,
  );
  const rawSha = hashOf(options.rawContent ?? 'synthetic-gpx');
  const normalizedSha = hashOf(options.normalizedContent ?? options.rawContent ?? 'normalized');
  const mapPathSha = hashOf(
    `${options.normalizedContent ?? options.rawContent ?? 'normalized'}:path`,
  );
  const keys = {
    raw: finalRef({
      athleteId,
      activityId,
      trackId: reservation.trackId,
      uploadId: reservation.uploadId,
      artifactKind: 'raw',
      sha256: rawSha,
      extension: 'gpx',
    }),
    normalized: finalRef({
      athleteId,
      activityId,
      trackId: reservation.trackId,
      uploadId: reservation.uploadId,
      artifactKind: 'normalized',
      sha256: normalizedSha,
      extension: 'json',
    }),
    mapPath: finalRef({
      athleteId,
      activityId,
      trackId: reservation.trackId,
      uploadId: reservation.uploadId,
      artifactKind: 'map_path',
      sha256: mapPathSha,
      extension: 'json',
    }),
  };
  const sizes = options.sizes ?? { raw: 2048, normalized: 4096, mapPath: 1024 };
  await tracks.prepareObjects(athleteId, reservation.uploadId, {
    raw: {
      storageRef: keys.raw,
      sizeBytes: sizes.raw,
      sha256: rawSha,
      format: 'gpx',
      originalFileName: 'run.gpx',
    },
    normalized: { storageRef: keys.normalized, sizeBytes: sizes.normalized, sha256: normalizedSha },
    mapPath: { storageRef: keys.mapPath, sizeBytes: sizes.mapPath, sha256: mapPathSha },
    parse: {
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      recordedSourceKind: 'gpx-trk',
      correspondenceDigest: options.correspondence ?? hashOf('correspondence-one'),
      sampleCount: 5,
      positionedSampleCount: 4,
      segmentCount: options.segmentCount ?? 1,
      segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
      distances: { deviceReportedMeters: 1000, recomputedFromPositionsMeters: 998 },
    },
  });
  await tracks.markStaged(athleteId, reservation.uploadId);
  const result =
    options.finalize === false ? null : await tracks.finalize(athleteId, reservation.uploadId);
  return { reservation, keys, result };
}

/**
 * Drive the sweep deterministically: the cursor is parked immediately before the reference
 * under test, so one bounded window examines exactly that reference regardless of what any
 * other test left in the global ledger.
 */
async function sweepReference(
  worker: ReturnType<typeof createResourceObjectCleanupRepository>,
  storage: Awaited<ReturnType<typeof createLocalFilesystemObjectStorage>>,
  reference: string,
) {
  await worker.advanceReconcileCursor(reference.slice(0, -1));
  const outcome = await reconcileActivityTrackObjects(worker, storage, 1);
  expect(outcome.inspected).toBe(1);
  return outcome;
}

async function pendingCleanupBytes(athleteId: string) {
  return database.tenant(athleteId, async (tx) => {
    const result = await tx.query('SELECT public.activity_track_pending_cleanup_bytes() AS bytes');
    return Number(result.rows[0]?.['bytes']);
  });
}

/**
 * Put real bytes behind a final key, through the same temporary-then-publish path the API
 * uses. The content must hash to the digest the key names, exactly as in production.
 */
async function publishObject(storage: ObjectStorage, finalKey: string, content: string) {
  const parsed = parseObjectKey(finalKey);
  if (parsed.kind !== 'track_final') throw new Error('expected a track object key');
  const temporary = createActivityTrackTemporaryObjectKey(parsed);
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

describe('M2-01c private track storage', () => {
  it('stores one track per activity and exposes only server-derived facts', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    const stored = await storeTrack(athlete, imported.activityId, imported.revision);
    expect(stored.result?.status).toBe('available');
    const read = await tracks.read(athlete, imported.activityId);
    if (read.status !== 'available') throw new Error('track missing');
    expect(read.track.trackRevision).toBe(1);
    expect(read.track.activityId).toBe(imported.activityId);
    expect(read.track.sourceKind).toBe('fit');
    expect(read.track.file.format).toBe('gpx');
    expect(read.track.derivatives.map((item) => item.kind)).toEqual(['normalized', 'map_path']);
    expect(read.track.correspondence.algorithm).toBe('track-correspondence-v1');
    // No storage reference and no coordinate ever appears in the read contract.
    expect(JSON.stringify(read)).not.toContain('private/v1/tenants');
    for (const variant of ['raw', 'normalized', 'map_path'] as const) {
      const resolved = await tracks.resolveObject(athlete, imported.activityId, variant);
      expect(resolved?.artifactKind).toBe(variant);
      expect(resolved?.storageRef).toContain(`/tracks/${stored.reservation.trackId}/${variant}/`);
    }
  });

  it('keeps one tenant out of another tenant track, through RLS and through the repository', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const imported = await activities.importActivity(owner, importInput());
    await storeTrack(owner, imported.activityId, imported.revision);
    expect(await tracks.read(other, imported.activityId)).toEqual({
      status: 'unavailable',
      activityId: imported.activityId,
    });
    expect(await tracks.resolveObject(other, imported.activityId, 'raw')).toBeNull();
    const leaked = await database.tenant(other, (tx) =>
      tx.query('SELECT count(*)::int AS count FROM activity_track_revision'),
    );
    expect(leaked.rows[0]?.['count']).toBe(0);
  });

  it('appends a revision when a re-parse changes sample correspondence and never rewrites the first', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    const first = await storeTrack(athlete, imported.activityId, imported.revision, {
      correspondence: hashOf('correspondence-one'),
      rawContent: 'bytes-one',
    });
    const second = await storeTrack(athlete, imported.activityId, imported.revision, {
      // The same activity and the same file name, but the samples now denote other
      // observations: that is a new revision, not an overwrite.
      correspondence: hashOf('correspondence-two'),
      rawContent: 'bytes-two',
      segmentCount: 3,
    });
    if (second.result?.status !== 'available') throw new Error('track missing');
    expect(second.result.track.trackRevision).toBe(2);
    expect(second.result.track.segmentCount).toBe(3);
    const revisions = await database.tenant(athlete, (tx) =>
      tx.query(
        `SELECT track_revision,correspondence_digest,raw_storage_ref,segment_count
         FROM activity_track_revision WHERE activity_id=$1 ORDER BY track_revision`,
        [imported.activityId],
      ),
    );
    expect(revisions.rows).toHaveLength(2);
    expect(revisions.rows[0]?.['correspondence_digest']).toBe(hashOf('correspondence-one'));
    expect(revisions.rows[0]?.['raw_storage_ref']).toBe(first.keys.raw);
    expect(revisions.rows[0]?.['segment_count']).toBe(1);
    // The first revision's objects stay live: an appended revision reclaims nothing.
    const queued = await admin.query(
      'SELECT count(*)::int AS count FROM resource_object_cleanup WHERE storage_ref=$1',
      [first.keys.raw],
    );
    expect(queued.rows[0]?.['count']).toBe(0);
  });

  it('refuses to rewrite a stored revision, at the grant and at the trigger', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    await storeTrack(athlete, imported.activityId, imported.revision);
    // The runtime role has no UPDATE at all on a stored revision.
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          'UPDATE activity_track_revision SET correspondence_digest=$2 WHERE activity_id=$1',
          [imported.activityId, 'b'.repeat(64)],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    // And the owner, who has every privilege, is refused by the append-only trigger.
    await expect(
      admin.query(
        'UPDATE activity_track_revision SET correspondence_digest=$2 WHERE activity_id=$1',
        [imported.activityId, 'b'.repeat(64)],
      ),
    ).rejects.toThrow(/IMMUTABLE_ACTIVITY_TRACK_REVISION/);
  });

  it('treats a repeated upload of the same recording as a duplicate, not as a second revision', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    await storeTrack(athlete, imported.activityId, imported.revision, {
      correspondence: hashOf('same'),
      rawContent: 'same-bytes',
    });
    const duplicate = await storeTrack(athlete, imported.activityId, imported.revision, {
      correspondence: hashOf('same'),
      rawContent: 'same-bytes',
    });
    if (duplicate.result?.status !== 'available') throw new Error('track missing');
    expect(duplicate.result.track.trackRevision).toBe(1);
    const revisions = await database.tenant(athlete, (tx) =>
      tx.query('SELECT count(*)::int AS count FROM activity_track_revision WHERE activity_id=$1', [
        imported.activityId,
      ]),
    );
    expect(revisions.rows[0]?.['count']).toBe(1);
    // The duplicate's own objects are queued, and the live revision's are untouched.
    const queued = await admin.query(
      'SELECT storage_ref,reason FROM resource_object_cleanup WHERE storage_ref=ANY($1)',
      [[duplicate.keys.raw, duplicate.keys.normalized, duplicate.keys.mapPath]],
    );
    expect(queued.rows).toHaveLength(3);
    expect(new Set(queued.rows.map((row) => row['reason']))).toEqual(new Set(['track_superseded']));
  });

  it('counts a duplicate upload objects in the cleanup backlog', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    await storeTrack(athlete, imported.activityId, imported.revision, {
      correspondence: hashOf('same'),
      rawContent: 'same-bytes',
    });
    const before = await pendingCleanupBytes(athlete);
    const duplicate = await storeTrack(athlete, imported.activityId, imported.revision, {
      correspondence: hashOf('same'),
      rawContent: 'same-bytes',
    });
    expect(duplicate.result?.status).toBe('available');
    // The duplicate published three objects and scheduled them for cleanup. They are real
    // unreclaimed bytes and must be inside the budget, even though no revision references
    // them and nothing registered them in the object ledger.
    expect(await pendingCleanupBytes(athlete)).toBe(before + 2048 + 4096 + 1024);
  });

  it('stops a duplicate upload loop once its abandoned objects fill the backlog', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    const sizes = { raw: 33_554_432, normalized: 8_388_608, mapPath: 8_388_608 };
    const same = {
      sizes,
      rawContent: 'duplicate-loop',
      correspondence: hashOf('duplicate-loop'),
    } as const;
    await storeTrack(athlete, imported.activityId, imported.revision, same);
    // Every repeat is a duplicate: it adds no revision, leaves no pending intent and trips
    // no count quota, so only the byte backlog can stop it.
    for (let index = 0; index < 11; index += 1)
      await storeTrack(athlete, imported.activityId, imported.revision, same);
    const counts = await database.tenant(athlete, (tx) =>
      tx.query(
        `SELECT (SELECT count(*)::int FROM activity_track_revision) AS revisions,
                (SELECT count(*)::int FROM activity_track_upload_intent
                   WHERE state IN ('reserved','prepared','staged')) AS pending`,
      ),
    );
    expect(counts.rows[0]).toEqual({ revisions: 1, pending: 0 });
    await expect(
      tracks.reserve(
        athlete,
        imported.activityId,
        { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
        `track-${randomUUID()}`,
      ),
    ).rejects.toThrow(ActivityTrackUploadStateError);
  });

  it('lets only one of two concurrent uploads claim the next revision', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    const first = await storeTrack(athlete, imported.activityId, imported.revision, {
      finalize: false,
      correspondence: hashOf('first'),
      rawContent: 'first',
    });
    const second = await storeTrack(athlete, imported.activityId, imported.revision, {
      finalize: false,
      correspondence: hashOf('second'),
      rawContent: 'second',
    });
    await tracks.finalize(athlete, first.reservation.uploadId);
    await expect(tracks.finalize(athlete, second.reservation.uploadId)).rejects.toThrow(
      PersistenceConflict,
    );
    const revisions = await database.tenant(athlete, (tx) =>
      tx.query('SELECT count(*)::int AS count FROM activity_track_revision WHERE activity_id=$1', [
        imported.activityId,
      ]),
    );
    expect(revisions.rows[0]?.['count']).toBe(1);
  });

  it('replays a reservation for the same key and refuses a different request under it', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    const key = `track-${randomUUID()}`;
    const first = await tracks.reserve(
      athlete,
      imported.activityId,
      { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
      key,
    );
    const replay = await tracks.reserve(
      athlete,
      imported.activityId,
      { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
      key,
    );
    expect(replay.uploadId).toBe(first.uploadId);
    await expect(
      tracks.reserve(
        athlete,
        imported.activityId,
        { expectedActivityRevision: imported.revision, recordedTrackIndex: 1 },
        key,
      ),
    ).rejects.toThrow(PersistenceConflict);
  });

  it('refuses a storage reference that does not name this tenant, upload and digest', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    const reservation = await tracks.reserve(
      athlete,
      imported.activityId,
      { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
      `track-${randomUUID()}`,
    );
    const sha = hashOf('bytes');
    const base = {
      athleteId: athlete,
      activityId: imported.activityId,
      trackId: reservation.trackId,
      uploadId: reservation.uploadId,
    } as const;
    const prepared = (rawRef: string) => ({
      raw: {
        storageRef: rawRef,
        sizeBytes: 10,
        sha256: sha,
        format: 'gpx' as const,
        originalFileName: null,
      },
      normalized: {
        storageRef: finalRef({
          ...base,
          artifactKind: 'normalized',
          sha256: sha,
          extension: 'json',
        }),
        sizeBytes: 10,
        sha256: sha,
      },
      mapPath: {
        storageRef: finalRef({ ...base, artifactKind: 'map_path', sha256: sha, extension: 'json' }),
        sizeBytes: 10,
        sha256: sha,
      },
      parse: {
        parserId: 'gpx-track-v1' as const,
        parserVersion: 1 as const,
        recordedSourceKind: 'gpx-trk' as const,
        correspondenceDigest: sha,
        sampleCount: 2,
        positionedSampleCount: 2,
        segmentCount: 1,
        segmentPolicy: { version: 1 as const, maxGapSeconds: 60, maxGapMeters: 200 },
        distances: { deviceReportedMeters: null, recomputedFromPositionsMeters: null },
      },
    });
    const forgeries = [
      finalRef({
        ...base,
        athleteId: randomUUID(),
        artifactKind: 'raw',
        sha256: sha,
        extension: 'gpx',
      }),
      finalRef({
        ...base,
        uploadId: randomUUID(),
        artifactKind: 'raw',
        sha256: sha,
        extension: 'gpx',
      }),
      finalRef({ ...base, artifactKind: 'raw', sha256: hashOf('other'), extension: 'gpx' }),
      finalRef({ ...base, artifactKind: 'normalized', sha256: sha, extension: 'json' }),
    ];
    for (const forged of forgeries)
      await expect(
        tracks.prepareObjects(athlete, reservation.uploadId, prepared(forged)),
      ).rejects.toThrow(PersistenceConflict);
  });

  it('bounds the number of active uploads per tenant', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    for (let index = 0; index < 10; index += 1)
      await tracks.reserve(
        athlete,
        imported.activityId,
        { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
        `track-${randomUUID()}`,
      );
    await expect(
      tracks.reserve(
        athlete,
        imported.activityId,
        { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
        `track-${randomUUID()}`,
      ),
    ).rejects.toThrow(ActivityTrackUploadStateError);
  });

  it('returns stored capacity once the activity is deleted', async () => {
    const athlete = randomUUID();
    // 48 MiB of declared objects per track: ten fit inside the 512 MiB tenant cap, the
    // eleventh does not.
    const sizes = { raw: 33_554_432, normalized: 8_388_608, mapPath: 8_388_608 };
    const stored: { activityId: string; revision: number }[] = [];
    for (let index = 0; index < 10; index += 1) {
      const imported = await activities.importActivity(athlete, importInput());
      await storeTrack(athlete, imported.activityId, imported.revision, {
        sizes,
        rawContent: `quota-${index}`,
        correspondence: hashOf(`quota-${index}`),
      });
      stored.push({ activityId: imported.activityId, revision: imported.revision });
    }
    const overflow = await activities.importActivity(athlete, importInput());
    await expect(
      storeTrack(athlete, overflow.activityId, overflow.revision, {
        sizes,
        rawContent: 'quota-overflow',
        correspondence: hashOf('quota-overflow'),
      }),
    ).rejects.toThrow(ActivityTrackUploadStateError);
    // Deleting one activity frees its bytes even though its revision metadata is kept.
    const removed = stored[0];
    if (!removed) throw new Error('expected a stored track');
    await activities.deleteActivity(athlete, removed.activityId, {
      expectedRevision: removed.revision,
    });
    const retainedHistory = await database.tenant(athlete, (tx) =>
      tx.query('SELECT count(*)::int AS count FROM activity_track_revision WHERE activity_id=$1', [
        removed.activityId,
      ]),
    );
    expect(retainedHistory.rows[0]?.['count']).toBe(1);
    const afterDeletion = await activities.importActivity(athlete, importInput());
    const accepted = await storeTrack(athlete, afterDeletion.activityId, afterDeletion.revision, {
      sizes,
      rawContent: 'quota-after-deletion',
      correspondence: hashOf('quota-after-deletion'),
    });
    expect(accepted.result?.status).toBe('available');
  });

  it('bounds the bytes waiting for reclamation, and clears once cleanup catches up', async () => {
    const athlete = randomUUID();
    // 48 MiB of declared objects per track. Deleting an activity only *schedules* the
    // reclamation, so a store-then-delete loop with a lagging worker must be refused once
    // the backlog passes its own budget — the live quota alone would never notice.
    const sizes = { raw: 33_554_432, normalized: 8_388_608, mapPath: 8_388_608 };
    // Each track is deleted immediately, so live bytes never approach their own cap and
    // only the backlog grows: exactly the loop the live quota cannot see.
    for (let index = 0; index < 11; index += 1) {
      const imported = await activities.importActivity(athlete, importInput());
      await storeTrack(athlete, imported.activityId, imported.revision, {
        sizes,
        rawContent: `backlog-${index}`,
        correspondence: hashOf(`backlog-${index}`),
      });
      await activities.deleteActivity(athlete, imported.activityId, {
        expectedRevision: imported.revision,
      });
    }
    const refused = await activities.importActivity(athlete, importInput());
    // The live quota is satisfied — every revision belongs to a deleted activity — but the
    // objects are all still there.
    await expect(
      tracks.reserve(
        athlete,
        refused.activityId,
        { expectedActivityRevision: refused.revision, recordedTrackIndex: 0 },
        `track-${randomUUID()}`,
      ),
    ).rejects.toThrow(ActivityTrackUploadStateError);
    const worker = createResourceObjectCleanupRepository({ connectionString: workerUrl, max: 1 });
    try {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const outcome = await processOneResourceObjectCleanup(worker, async () => undefined);
        if (outcome === 'empty') break;
      }
    } finally {
      await worker.close();
    }
    const accepted = await storeTrack(athlete, refused.activityId, refused.revision, {
      sizes,
      rawContent: 'backlog-drained',
      correspondence: hashOf('backlog-drained'),
    });
    expect(accepted.result?.status).toBe('available');
  });

  it('expires an abandoned upload by the database clock and queues its references', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    const reservation = await tracks.reserve(
      athlete,
      imported.activityId,
      { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
      `track-${randomUUID()}`,
    );
    // Expiry is judged by the database clock, so the fixture moves the deadline into the
    // past. The transition trigger treats expires_at as immutable, which is the point of
    // it, so the owner disables the trigger for this one fixture statement.
    await admin.query(
      'ALTER TABLE activity_track_upload_intent DISABLE TRIGGER activity_track_upload_transition',
    );
    await admin.query(
      `UPDATE activity_track_upload_intent
       SET created_at=clock_timestamp()-interval '2 hours',
           updated_at=clock_timestamp()-interval '2 hours',
           expires_at=clock_timestamp()-interval '90 minutes'
       WHERE upload_id=$1`,
      [reservation.uploadId],
    );
    await admin.query(
      'ALTER TABLE activity_track_upload_intent ENABLE TRIGGER activity_track_upload_transition',
    );
    const worker = createResourceObjectCleanupRepository({ connectionString: workerUrl, max: 1 });
    try {
      expect(await worker.reapExpired(new Date(), 100)).toBeGreaterThan(0);
    } finally {
      await worker.close();
    }
    const intent = await admin.query(
      'SELECT state,failure_code FROM activity_track_upload_intent WHERE upload_id=$1',
      [reservation.uploadId],
    );
    expect(intent.rows[0]).toEqual({ state: 'failed', failure_code: 'UPLOAD_EXPIRED' });
    const queued = await admin.query(
      `SELECT count(*)::int AS count FROM resource_object_cleanup
       WHERE storage_ref LIKE $1 AND reason='upload_abandoned'`,
      [`private/v1/tenants/${athlete}/%`],
    );
    expect(queued.rows[0]?.['count']).toBe(3);
  });

  it('reclaims the raw track, normalized data and map derivative when the activity is deleted', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    const stored = await storeTrack(athlete, imported.activityId, imported.revision);
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    const queued = await admin.query(
      `SELECT storage_ref FROM resource_object_cleanup
       WHERE storage_ref=ANY($1) AND reason='activity_deleted'`,
      [[stored.keys.raw, stored.keys.normalized, stored.keys.mapPath]],
    );
    expect(queued.rows).toHaveLength(3);
    // Suppression and the existing ledgers keep their meaning.
    const after = await database.tenant(athlete, (tx) =>
      tx.query(
        `SELECT (SELECT count(*)::int FROM activity_suppression) AS suppressed,
                (SELECT count(*)::int FROM activity_source_head) AS sources,
                (SELECT count(*)::int FROM activity_source_revision) AS revisions,
                (SELECT count(*)::int FROM activity_track_revision) AS tracks`,
      ),
    );
    expect(after.rows[0]).toEqual({ suppressed: 1, sources: 1, revisions: 1, tracks: 1 });
    expect(await tracks.read(athlete, imported.activityId)).toEqual({
      status: 'unavailable',
      activityId: imported.activityId,
    });
    expect(await tracks.resolveObject(athlete, imported.activityId, 'raw')).toBeNull();
  });

  it('refuses ingestion for a deleted activity and for a suppressed source', async () => {
    const athlete = randomUUID();
    const sourceId = randomUUID();
    const imported = await activities.importActivity(athlete, importInput(sourceId));
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    await expect(
      tracks.reserve(
        athlete,
        imported.activityId,
        { expectedActivityRevision: imported.revision + 1, recordedTrackIndex: 0 },
        `track-${randomUUID()}`,
      ),
    ).rejects.toThrow(ActivityTrackNotFoundError);
    // Re-importing the same source is suppressed, so a track for it is refused too, and
    // the database refuses it even when the application check is bypassed.
    const again = await activities.importActivity(athlete, importInput(sourceId));
    expect(again.outcome).toBe('suppressed');
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          `INSERT INTO activity_track
           (athlete_id,activity_id,track_id,source_kind,source_id,track_revision,revision_id,
            created_at,updated_at)
           VALUES($1,$2,$3,'fit',$4,1,$5,now(),now())`,
          [athlete, imported.activityId, randomUUID(), sourceId, randomUUID()],
        ),
      ),
    ).rejects.toThrow(/ACTIVITY_DELETED|ACTIVITY_SOURCE_SUPPRESSED/);
  });

  it('gives the cleanup worker bounded functions and no track table access', async () => {
    const privileges = await admin.query(
      `SELECT has_table_privilege($1,'activity_track_revision','SELECT') AS can_read_revisions,
       has_table_privilege($1,'activity_track_object','SELECT') AS can_read_objects,
       has_table_privilege($1,'resource_object_cleanup','SELECT') AS can_read_queue,
       has_function_privilege($1,'public.lease_resource_object_cleanup(uuid,timestamptz,timestamptz)','EXECUTE') AS can_lease,
       has_function_privilege('workout_runtime','public.lease_resource_object_cleanup(uuid,timestamptz,timestamptz)','EXECUTE') AS runtime_can_lease,
       has_table_privilege('workout_runtime','activity_track_revision','DELETE') AS runtime_can_delete_revisions`,
      [workerRole],
    );
    expect(privileges.rows[0]).toEqual({
      can_read_revisions: false,
      can_read_objects: false,
      can_read_queue: false,
      can_lease: true,
      runtime_can_lease: false,
      runtime_can_delete_revisions: false,
    });
  });

  it('deletes reclaimed objects through the shared worker and refuses to delete a live one', async () => {
    const athlete = randomUUID();
    const storage = await createLocalFilesystemObjectStorage(objectRoot);
    const liveActivity = await activities.importActivity(athlete, importInput());
    const live = await storeTrack(athlete, liveActivity.activityId, liveActivity.revision, {
      rawContent: `live-${athlete}`,
    });
    const deletedActivity = await activities.importActivity(athlete, importInput());
    const doomed = await storeTrack(athlete, deletedActivity.activityId, deletedActivity.revision, {
      rawContent: `doomed-${athlete}`,
    });
    await publishObject(storage, live.keys.raw, `live-${athlete}`);
    await publishObject(storage, doomed.keys.raw, `doomed-${athlete}`);
    await publishObject(storage, doomed.keys.normalized, `doomed-${athlete}`);
    await publishObject(storage, doomed.keys.mapPath, `doomed-${athlete}:path`);
    await activities.deleteActivity(athlete, deletedActivity.activityId, {
      expectedRevision: deletedActivity.revision,
    });
    // A live object is queued by hand to prove authorization re-verifies references.
    await admin.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
       VALUES(gen_random_uuid(),$1,'activity_deleted',clock_timestamp(),clock_timestamp())`,
      [live.keys.raw],
    );
    const worker = createResourceObjectCleanupRepository({ connectionString: workerUrl, max: 1 });
    try {
      // The queue is shared with every other private object, so it is drained to empty
      // under a bound rather than a fixed number of attempts.
      for (let index = 0; index < 200; index += 1) {
        const outcome = await processOneResourceObjectCleanup(worker, (ref) =>
          storage.delete(validateObjectKey(ref)),
        );
        if (outcome === 'empty') break;
      }
    } finally {
      await worker.close();
    }
    expect(await storage.stat(validateObjectKey(doomed.keys.raw))).toBeNull();
    expect(await storage.stat(validateObjectKey(doomed.keys.normalized))).toBeNull();
    expect(await storage.stat(validateObjectKey(doomed.keys.mapPath))).toBeNull();
    // The live revision's object survives, and its queue row records why.
    expect(await storage.stat(validateObjectKey(live.keys.raw))).not.toBeNull();
    const liveRow = await admin.query(
      'SELECT last_error_code FROM resource_object_cleanup WHERE storage_ref=$1',
      [live.keys.raw],
    );
    expect(liveRow.rows[0]?.['last_error_code']).toBe('REFERENCE_PRESENT');
  });

  it('keeps reclaiming a final object a dead writer published after its receipt closed', async () => {
    const athlete = randomUUID();
    const storage = await createLocalFilesystemObjectStorage(objectRoot);
    const imported = await activities.importActivity(athlete, importInput());
    // A writer that prepared and then died: the DB holds its final refs, and its objects
    // are published later by the part of the request that was still in flight.
    const prepared = await storeTrack(athlete, imported.activityId, imported.revision, {
      finalize: false,
      rawContent: `late-${athlete}`,
    });
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    // The fence passes while the writer is stalled.
    await admin.query(
      'ALTER TABLE activity_track_upload_intent DISABLE TRIGGER activity_track_upload_transition',
    );
    await admin.query(
      `UPDATE activity_track_upload_intent SET prepared_at=clock_timestamp()-interval '5 minutes',
       publication_lease_until=clock_timestamp()-interval '1 second' WHERE upload_id=$1`,
      [prepared.reservation.uploadId],
    );
    await admin.query(
      'ALTER TABLE activity_track_upload_intent ENABLE TRIGGER activity_track_upload_transition',
    );
    const worker = createResourceObjectCleanupRepository({ connectionString: workerUrl, max: 1 });
    const drain = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const outcome = await processOneResourceObjectCleanup(worker, (ref) =>
          storage.delete(validateObjectKey(ref)),
        );
        if (outcome === 'empty') break;
      }
    };
    try {
      // Cleanup runs against objects that do not exist yet.
      await drain();
      // The stalled writer then makes one visible and never comes back to compensate.
      await publishObject(storage, prepared.keys.raw, `late-${athlete}`);
      expect(await storage.stat(validateObjectKey(prepared.keys.raw))).not.toBeNull();
      // A later pass must still take it: the receipt cannot be closed while the upload that
      // could publish is unexpired.
      await admin.query(
        `UPDATE resource_object_cleanup SET available_at=clock_timestamp()
         WHERE storage_ref=$1 AND completed_at IS NULL`,
        [prepared.keys.raw],
      );
      await drain();
      expect(await storage.stat(validateObjectKey(prepared.keys.raw))).toBeNull();
    } finally {
      await worker.close();
    }
  });

  it('holds the receipt open past the upload expiry, for as long as a writer could resume', async () => {
    const athlete = randomUUID();
    const storage = await createLocalFilesystemObjectStorage(objectRoot);
    const imported = await activities.importActivity(athlete, importInput());
    const prepared = await storeTrack(athlete, imported.activityId, imported.revision, {
      finalize: false,
      rawContent: `grace-${athlete}`,
    });
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    // The upload's own expiry has passed, but the writer's fence passed only minutes ago:
    // inside the reclaim grace, so the receipt must not close. Ending the window at
    // `expires_at` — as an earlier version did — closes it here and strands a late object.
    await admin.query(
      'ALTER TABLE activity_track_upload_intent DISABLE TRIGGER activity_track_upload_transition',
    );
    await admin.query(
      `UPDATE activity_track_upload_intent
       SET created_at=clock_timestamp()-interval '31 minutes',
           updated_at=clock_timestamp()-interval '31 minutes',
           prepared_at=clock_timestamp()-interval '30 minutes',
           publication_lease_until=clock_timestamp()-interval '28 minutes',
           expires_at=clock_timestamp()-interval '1 minute'
       WHERE upload_id=$1`,
      [prepared.reservation.uploadId],
    );
    await admin.query(
      'ALTER TABLE activity_track_upload_intent ENABLE TRIGGER activity_track_upload_transition',
    );
    const worker = createResourceObjectCleanupRepository({ connectionString: workerUrl, max: 1 });
    const drain = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const outcome = await processOneResourceObjectCleanup(worker, (ref) =>
          storage.delete(validateObjectKey(ref)),
        );
        if (outcome === 'empty') break;
      }
    };
    try {
      await drain();
      const held = await admin.query(
        `SELECT count(*)::int AS count FROM resource_object_cleanup
         WHERE storage_ref=$1 AND completed_at IS NULL
           AND last_error_code='PUBLICATION_WINDOW_OPEN'`,
        [prepared.keys.raw],
      );
      expect(held.rows[0]?.['count']).toBe(1);
      await publishObject(storage, prepared.keys.raw, `grace-${athlete}`);
      await admin.query(
        `UPDATE resource_object_cleanup SET available_at=clock_timestamp()
         WHERE storage_ref=$1 AND completed_at IS NULL`,
        [prepared.keys.raw],
      );
      await drain();
      expect(await storage.stat(validateObjectKey(prepared.keys.raw))).toBeNull();
    } finally {
      await worker.close();
    }
  });

  it('reclaims a late publication even after the upload itself expired and the receipt closed', async () => {
    const athlete = randomUUID();
    const storage = await createLocalFilesystemObjectStorage(objectRoot);
    const imported = await activities.importActivity(athlete, importInput());
    const prepared = await storeTrack(athlete, imported.activityId, imported.revision, {
      finalize: false,
      rawContent: `expired-${athlete}`,
    });
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    // A live track of the same tenant, with its objects on the same store. Reconciliation
    // walks past it and must leave it alone: it is referenced.
    const liveActivity = await activities.importActivity(athlete, importInput());
    const live = await storeTrack(athlete, liveActivity.activityId, liveActivity.revision, {
      rawContent: `live-${athlete}`,
    });
    await publishObject(storage, live.keys.raw, `live-${athlete}`);
    // The writer stalls past its fence *and* past the upload's own expiry. Nothing in the
    // entry check reaches a storage call already in flight, so it can still resume.
    await admin.query(
      'ALTER TABLE activity_track_upload_intent DISABLE TRIGGER activity_track_upload_transition',
    );
    await admin.query(
      `UPDATE activity_track_upload_intent
       SET created_at=clock_timestamp()-interval '2 hours',
           updated_at=clock_timestamp()-interval '2 hours',
           prepared_at=clock_timestamp()-interval '2 hours',
           publication_lease_until=clock_timestamp()-interval '118 minutes',
           expires_at=clock_timestamp()-interval '90 minutes'
       WHERE upload_id=$1`,
      [prepared.reservation.uploadId],
    );
    await admin.query(
      'ALTER TABLE activity_track_upload_intent ENABLE TRIGGER activity_track_upload_transition',
    );
    const worker = createResourceObjectCleanupRepository({ connectionString: workerUrl, max: 1 });
    const drain = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const outcome = await processOneResourceObjectCleanup(worker, (ref) =>
          storage.delete(validateObjectKey(ref)),
        );
        if (outcome === 'empty') break;
      }
    };
    try {
      await drain();
      const closed = await admin.query(
        'SELECT completed_at IS NOT NULL AS completed FROM resource_object_cleanup WHERE storage_ref=$1',
        [prepared.keys.raw],
      );
      expect(closed.rows[0]?.['completed']).toBe(true);
      // The resumed writer publishes and dies without compensating. Every receipt for this
      // object is closed, so nothing receipt-based will look at it again.
      await publishObject(storage, prepared.keys.raw, `expired-${athlete}`);
      expect(await storage.stat(validateObjectKey(prepared.keys.raw))).not.toBeNull();
      // Reconciliation finds it by reading the reference index, not by walking the store.
      // The window is what bounds a run: one reference examined, one queued.
      expect(await sweepReference(worker, storage, prepared.keys.raw)).toMatchObject({
        inspected: 1,
        queued: 1,
      });
      await drain();
      expect(await storage.stat(validateObjectKey(prepared.keys.raw))).toBeNull();
      // The live track's object was never queued by the sweep and is still there.
      expect(await storage.stat(validateObjectKey(live.keys.raw))).not.toBeNull();
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS count FROM resource_object_cleanup WHERE storage_ref=$1',
            [live.keys.raw],
          )
        ).rows[0]?.['count'],
      ).toBe(0);
    } finally {
      await worker.close();
    }
  });

  it('reads exactly one index row per candidate and touches no ledger table', async () => {
    // The first shape of this sweep unioned the ledger tables and applied the limit last: a
    // window of one candidate read 498 rows on a real database. Here the work itself is
    // measured — rows the statement pulled out of each table inside one transaction — so the
    // claim is about what the database did, not about what the plan looked like.
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    await storeTrack(athlete, imported.activityId, imported.revision, {
      rawContent: `plan-${athlete}`,
    });
    const watched = await admin.query(
      'SELECT count(*)::int AS count FROM activity_track_object_ref WHERE settled_at IS NULL',
    );
    expect(watched.rows[0]?.['count']).toBeGreaterThan(20);
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const counters = async () =>
        (
          await client.query<{ intents: string; objects: string; refs: string }>(
            `SELECT
               pg_stat_get_xact_tuples_returned('activity_track_upload_intent'::regclass)
                 +pg_stat_get_xact_tuples_fetched('activity_track_upload_intent'::regclass) AS intents,
               pg_stat_get_xact_tuples_returned('activity_track_object'::regclass)
                 +pg_stat_get_xact_tuples_fetched('activity_track_object'::regclass) AS objects,
               pg_stat_get_xact_tuples_returned('activity_track_object_ref'::regclass)
                 +pg_stat_get_xact_tuples_fetched('activity_track_object_ref'::regclass) AS refs`,
          )
        ).rows[0];
      const before = await counters();
      const window = await client.query(
        'SELECT * FROM public.activity_track_reconcile_candidates($1,$2)',
        ['', 1],
      );
      const after = await counters();
      await client.query('ROLLBACK');
      expect(window.rows).toHaveLength(1);
      const read = (key: 'intents' | 'objects' | 'refs') =>
        Number(after?.[key] ?? 0) - Number(before?.[key] ?? 0);
      // Neither ledger table is touched at all, and the index gives up one row.
      expect(read('intents')).toBe(0);
      expect(read('objects')).toBe(0);
      expect(read('refs')).toBeLessThanOrEqual(1);
    } finally {
      client.release();
    }
  });

  it('still finds a late publication after the upload row itself was compacted away', async () => {
    const athlete = randomUUID();
    const storage = await createLocalFilesystemObjectStorage(objectRoot);
    const imported = await activities.importActivity(athlete, importInput());
    const prepared = await storeTrack(athlete, imported.activityId, imported.revision, {
      finalize: false,
      rawContent: `compacted-${athlete}`,
    });
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    const worker = createResourceObjectCleanupRepository({ connectionString: workerUrl, max: 1 });
    const drain = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const outcome = await processOneResourceObjectCleanup(worker, (ref) =>
          storage.delete(validateObjectKey(ref)),
        );
        if (outcome === 'empty') break;
      }
    };
    try {
      await admin.query(
        'ALTER TABLE activity_track_upload_intent DISABLE TRIGGER activity_track_upload_transition',
      );
      await admin.query(
        `UPDATE activity_track_upload_intent
         SET created_at=clock_timestamp()-interval '9 days',
             updated_at=clock_timestamp()-interval '9 days',
             prepared_at=clock_timestamp()-interval '9 days'+interval '1 minute',
             publication_lease_until=clock_timestamp()-interval '9 days'+interval '3 minutes',
             expires_at=clock_timestamp()-interval '9 days'+interval '30 minutes'
         WHERE upload_id=$1`,
        [prepared.reservation.uploadId],
      );
      await admin.query(
        'ALTER TABLE activity_track_upload_intent ENABLE TRIGGER activity_track_upload_transition',
      );
      await drain();
      // Seven days after failing, with its receipts closed, the intent row is compacted.
      // The upload never finalized, so nothing registered its objects anywhere else.
      expect(
        await database.tenant(athlete, async (tx) => {
          const result = await tx.query(
            'SELECT public.compact_activity_track_upload_history(100) AS removed',
          );
          return Number(result.rows[0]?.['removed']);
        }),
      ).toBeGreaterThan(0);
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS count FROM activity_track_upload_intent WHERE upload_id=$1',
            [prepared.reservation.uploadId],
          )
        ).rows[0]?.['count'],
      ).toBe(0);
      // A very late writer publishes now. The reference must still be discoverable.
      await publishObject(storage, prepared.keys.raw, `compacted-${athlete}`);
      expect((await sweepReference(worker, storage, prepared.keys.raw)).queued).toBe(1);
      await drain();
      expect(await storage.stat(validateObjectKey(prepared.keys.raw))).toBeNull();
    } finally {
      await worker.close();
    }
  });

  it('queues a late publication only the reference index still names when the account is erased', async () => {
    // M2-01s. The raw recording of the test above — published after its receipt closed,
    // its upload row compacted away — is named by nothing but the reference index. The
    // account is erased before the sweep reached it. Erasure deletes the index row, so
    // unless it queues the key first nothing ever names those GPS bytes again. A restore
    // of a backup taken while the index still watched the key hands the replayed erasure
    // exactly this state, even when the source had long since reclaimed the object.
    const athlete = randomUUID();
    const storage = await createLocalFilesystemObjectStorage(objectRoot);
    const imported = await activities.importActivity(athlete, importInput());
    const prepared = await storeTrack(athlete, imported.activityId, imported.revision, {
      finalize: false,
      rawContent: `erased-late-${athlete}`,
    });
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    const worker = createResourceObjectCleanupRepository({ connectionString: workerUrl, max: 1 });
    const drain = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const outcome = await processOneResourceObjectCleanup(worker, (ref) =>
          storage.delete(validateObjectKey(ref)),
        );
        if (outcome === 'empty') break;
      }
    };
    try {
      await admin.query(
        'ALTER TABLE activity_track_upload_intent DISABLE TRIGGER activity_track_upload_transition',
      );
      await admin.query(
        `UPDATE activity_track_upload_intent
         SET created_at=clock_timestamp()-interval '9 days',
             updated_at=clock_timestamp()-interval '9 days',
             prepared_at=clock_timestamp()-interval '9 days'+interval '1 minute',
             publication_lease_until=clock_timestamp()-interval '9 days'+interval '3 minutes',
             expires_at=clock_timestamp()-interval '9 days'+interval '30 minutes'
         WHERE upload_id=$1`,
        [prepared.reservation.uploadId],
      );
      await admin.query(
        'ALTER TABLE activity_track_upload_intent ENABLE TRIGGER activity_track_upload_transition',
      );
      await drain();
      await database.tenant(athlete, async (tx) => {
        await tx.query('SELECT public.compact_activity_track_upload_history(100)');
      });
      await publishObject(storage, prepared.keys.raw, `erased-late-${athlete}`);
      const watched = await admin.query(
        'SELECT athlete_id FROM activity_track_object_ref WHERE storage_ref=$1',
        [prepared.keys.raw],
      );
      expect(watched.rows).toEqual([{ athlete_id: athlete }]);
      const pending = async () =>
        Number(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM resource_object_cleanup
               WHERE storage_ref=$1 AND completed_at IS NULL`,
              [prepared.keys.raw],
            )
          ).rows[0]?.['count'],
        );
      expect(await pending()).toBe(0);

      await createOperationsRepository(database).eraseAccount(athlete);
      expect(
        (
          await admin.query('SELECT 1 FROM activity_track_object_ref WHERE storage_ref=$1', [
            prepared.keys.raw,
          ])
        ).rowCount,
      ).toBe(0);
      const queued = await admin.query(
        'SELECT reason FROM resource_object_cleanup WHERE storage_ref=$1 AND completed_at IS NULL',
        [prepared.keys.raw],
      );
      expect(queued.rows).toEqual([{ reason: 'account_erased' }]);
      await drain();
      expect(await storage.stat(validateObjectKey(prepared.keys.raw))).toBeNull();
    } finally {
      await worker.close();
    }
  });

  it('exports live tracks without a storage reference and drops the tracks of a deleted activity', async () => {
    const athlete = randomUUID();
    const kept = await activities.importActivity(athlete, importInput());
    const removed = await activities.importActivity(athlete, importInput());
    const keptTrack = await storeTrack(athlete, kept.activityId, kept.revision);
    await storeTrack(athlete, removed.activityId, removed.revision);
    await activities.deleteActivity(athlete, removed.activityId, {
      expectedRevision: removed.revision,
    });
    const artifact = await createOperationsRepository(database).exportAccount(athlete);
    expect(artifact.schemaVersion).toBe(22);
    if (artifact.schemaVersion !== 22) throw new Error('expected v22');
    expect(artifact.data.activityTracks).toHaveLength(1);
    expect(artifact.data.activityTracks[0]?.['activity_id']).toBe(kept.activityId);
    expect(artifact.data.activityTrackRevisions).toHaveLength(1);
    expect(artifact.data.activityTrackRevisions[0]?.['correspondence_digest']).toBe(
      hashOf('correspondence-one'),
    );
    const serialized = JSON.stringify({
      tracks: artifact.data.activityTracks,
      revisions: artifact.data.activityTrackRevisions,
    });
    expect(serialized).not.toContain('private/v1/tenants');
    expect(serialized).not.toContain(keptTrack.keys.raw);
  });

  it('takes the export snapshot against a concurrent deletion rather than a mixed view', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    await storeTrack(athlete, imported.activityId, imported.revision);
    const operations = createOperationsRepository(database);
    // The deletion is held open in its own transaction while the export runs. Both take
    // the tenant command lock, so the export sees one committed state, never half of one.
    const client = await new Pool({ connectionString: runtimeUrl, max: 1 }).connect();
    let exported;
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
      await client.query(
        'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
        [athlete, imported.activityId],
      );
      const pending = operations.exportAccount(athlete);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await client.query('COMMIT');
      exported = await pending;
    } finally {
      client.release();
    }
    if (exported.schemaVersion !== 22) throw new Error('expected v22');
    // The export waited for the deletion and reports the deleted activity's track nowhere.
    expect(exported.data.activityTracks).toHaveLength(0);
    expect(exported.data.activityTrackRevisions).toHaveLength(0);
  });

  it('erases every track row and keeps the cleanup queue, including failed upload references', async () => {
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    const stored = await storeTrack(athlete, imported.activityId, imported.revision);
    const abandoned = await tracks.reserve(
      athlete,
      imported.activityId,
      { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
      `track-${randomUUID()}`,
    );
    await tracks.fail(athlete, abandoned.uploadId, 'CLIENT_ABANDONED');
    await createOperationsRepository(database).eraseAccount(athlete);
    const rows = await admin.query(
      `SELECT (SELECT count(*)::int FROM activity_track WHERE athlete_id=$1) AS heads,
              (SELECT count(*)::int FROM activity_track_revision WHERE athlete_id=$1) AS revisions,
              (SELECT count(*)::int FROM activity_track_object WHERE athlete_id=$1) AS objects,
              (SELECT count(*)::int FROM activity_track_upload_intent WHERE athlete_id=$1) AS intents`,
      [athlete],
    );
    expect(rows.rows[0]).toEqual({ heads: 0, revisions: 0, objects: 0, intents: 0 });
    const queued = await admin.query(
      `SELECT count(*)::int AS count FROM resource_object_cleanup
       WHERE storage_ref LIKE $1 AND completed_at IS NULL`,
      [`private/v1/tenants/${athlete}/%`],
    );
    // Three live objects plus the abandoned upload's three temporary references.
    expect(queued.rows[0]?.['count']).toBeGreaterThanOrEqual(6);
    const live = await admin.query(
      'SELECT count(*)::int AS count FROM resource_object_cleanup WHERE storage_ref=$1',
      [stored.keys.raw],
    );
    expect(live.rows[0]?.['count']).toBe(1);
  });
});
