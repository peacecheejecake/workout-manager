import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
import {
  createGalleryFinalObjectKey,
  createGalleryTemporaryObjectKey,
  parseObjectKey,
  validateObjectKey,
} from '@workout/server-media/keys';
import {
  createResourceObjectCleanupRepository,
  processOneResourceObjectCleanup,
} from '../src/resource-object-cleanup.js';

import { createDatabase, type Database } from '../src/database.js';
import {
  grantGalleryMedia,
  grantOperations,
  grantResourceObjectCleanupWorker,
  migrate,
} from '../src/migrate.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { createOperationsRepository } from '../src/operations.js';
import { PersistenceConflict } from '../src/outbox.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantGalleryMedia(adminUrl, 'workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

function galleryKey(input: {
  tenantId: string;
  mediaItemId: string;
  uploadId: string;
  sha256: string;
  extension: string;
}) {
  return `private/v1/tenants/${input.tenantId}/gallery/${input.mediaItemId}/objects/uploads/${input.uploadId}/sha256/${input.sha256}.${input.extension}`;
}

async function storeImage(
  repository: ReturnType<typeof createGalleryMediaRepository>,
  athleteId: string,
  overrides: { sha256?: string; album?: string | null } = {},
) {
  const sha256 = overrides.sha256 ?? randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64);
  const reservation = await repository.reserveCreate(
    athleteId,
    {
      mediaKind: 'image',
      album: overrides.album ?? '대회',
      caption: '결승선',
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    `gallery-${randomUUID()}`,
  );
  const storageRef = galleryKey({
    tenantId: athleteId,
    mediaItemId: reservation.mediaItemId,
    uploadId: reservation.uploadId,
    sha256,
    extension: 'png',
  });
  await repository.prepareObject(athleteId, reservation.uploadId, {
    storageRef,
    file: {
      originalFileName: 'finish.png',
      mediaType: 'image/png',
      byteSize: 2048,
      sha256,
    },
  });
  await repository.markStaged(athleteId, reservation.uploadId);
  const finalized = await repository.finalize(athleteId, reservation.uploadId);
  if (finalized.status !== 'available') throw new Error('expected an available media item');
  return { reservation, storageRef, item: finalized.item, sha256 };
}

async function attachPreview(
  repository: ReturnType<typeof createGalleryMediaRepository>,
  athleteId: string,
  mediaItemId: string,
  accessRevision: number,
  overrides: { sha256?: string } = {},
) {
  const sha256 = overrides.sha256 ?? randomUUID().replaceAll('-', '').padEnd(64, '1').slice(0, 64);
  const reservation = await repository.reservePreview(
    athleteId,
    mediaItemId,
    { expectedAccessRevision: accessRevision },
    `gallery-${randomUUID()}`,
  );
  const storageRef = galleryKey({
    tenantId: athleteId,
    mediaItemId,
    uploadId: reservation.uploadId,
    sha256,
    extension: 'jpg',
  });
  await repository.prepareObject(athleteId, reservation.uploadId, {
    storageRef,
    file: {
      originalFileName: 'finish-preview.jpg',
      mediaType: 'image/jpeg',
      byteSize: 512,
      sha256,
    },
  });
  await repository.markStaged(athleteId, reservation.uploadId);
  await repository.finalize(athleteId, reservation.uploadId);
  return { storageRef, uploadId: reservation.uploadId };
}

describe('gallery media lifecycle on real PostgreSQL', () => {
  it('stores an owned image through reserve, prepare, stage and finalize', async () => {
    const athleteId = randomUUID();
    const repository = createGalleryMediaRepository(database);
    const stored = await storeImage(repository, athleteId);
    expect(stored.item).toMatchObject({
      mediaKind: 'image',
      visibility: 'private',
      includeForCoach: false,
      album: '대회',
      accessRevision: 1,
    });
    expect(JSON.stringify(stored.item)).not.toContain('private/v1/tenants');

    const listed = await repository.list(athleteId, { limit: 50, offset: 0 });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.id).toBe(stored.item.id);

    const replayed = await repository.finalize(athleteId, stored.reservation.uploadId);
    expect(replayed).toEqual({ status: 'available', item: stored.item });
  });

  it('isolates media between tenants through row level security', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const repository = createGalleryMediaRepository(database);
    const stored = await storeImage(repository, owner);
    await expect(repository.read(other, stored.item.id)).resolves.toMatchObject({
      status: 'unavailable',
    });
    const otherList = await repository.list(other, { limit: 50, offset: 0 });
    expect(otherList.total).toBe(0);
  });

  it('rejects a prepared storage reference outside the upload scope', async () => {
    const athleteId = randomUUID();
    const repository = createGalleryMediaRepository(database);
    const reservation = await repository.reserveCreate(
      athleteId,
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
    const sha256 = 'b'.repeat(64);
    await expect(
      repository.prepareObject(athleteId, reservation.uploadId, {
        storageRef: galleryKey({
          tenantId: randomUUID(),
          mediaItemId: reservation.mediaItemId,
          uploadId: reservation.uploadId,
          sha256,
          extension: 'png',
        }),
        file: {
          originalFileName: 'finish.png',
          mediaType: 'image/png',
          byteSize: 10,
          sha256,
        },
      }),
    ).rejects.toBeInstanceOf(PersistenceConflict);
  });

  it('queues the raw object and every derivative for durable cleanup on delete', async () => {
    const athleteId = randomUUID();
    const repository = createGalleryMediaRepository(database);
    const stored = await storeImage(repository, athleteId);
    const preview = await attachPreview(repository, athleteId, stored.item.id, 1);
    // Attaching a derivative advances the item revision the reader observes.
    const afterPreview = await repository.read(athleteId, stored.item.id);
    if (afterPreview.status !== 'available') throw new Error('expected an available media item');
    expect(afterPreview.item.accessRevision).toBe(2);
    expect(afterPreview.item.preview).toMatchObject({ kind: 'preview', mediaType: 'image/jpeg' });

    const deleted = await repository.softDelete(athleteId, stored.item.id, {
      expectedAccessRevision: 2,
      idempotencyKey: `gallery-${randomUUID()}`,
    });
    expect(deleted).toMatchObject({ status: 'deleted', mediaItemId: stored.item.id });

    const queued = await admin.query(
      'SELECT storage_ref,reason,completed_at FROM resource_object_cleanup WHERE storage_ref=ANY($1)',
      [[stored.storageRef, preview.storageRef]],
    );
    expect(queued.rowCount).toBe(2);
    expect(queued.rows.every((row) => row['completed_at'] === null)).toBe(true);

    await expect(repository.read(athleteId, stored.item.id)).resolves.toMatchObject({
      status: 'unavailable',
    });
    await expect(
      repository.resolveObject(athleteId, stored.item.id, 'original'),
    ).resolves.toBeNull();
    await expect(
      repository.resolveObject(athleteId, stored.item.id, 'preview'),
    ).resolves.toBeNull();
  });

  it('keeps deletion suppression across a late finalize and a repeated delete', async () => {
    const athleteId = randomUUID();
    const repository = createGalleryMediaRepository(database);
    const stored = await storeImage(repository, athleteId);
    const sha256 = 'c'.repeat(64);
    const pending = await repository.reservePreview(
      athleteId,
      stored.item.id,
      { expectedAccessRevision: 1 },
      `gallery-${randomUUID()}`,
    );
    await repository.prepareObject(athleteId, pending.uploadId, {
      storageRef: galleryKey({
        tenantId: athleteId,
        mediaItemId: stored.item.id,
        uploadId: pending.uploadId,
        sha256,
        extension: 'jpg',
      }),
      file: {
        originalFileName: 'late.jpg',
        mediaType: 'image/jpeg',
        byteSize: 128,
        sha256,
      },
    });
    await repository.markStaged(athleteId, pending.uploadId);

    const deleteKey = `gallery-${randomUUID()}`;
    const deleted = await repository.softDelete(athleteId, stored.item.id, {
      expectedAccessRevision: 1,
      idempotencyKey: deleteKey,
    });
    // A staged upload for a deleted item can never resurrect it.
    await expect(repository.finalize(athleteId, pending.uploadId)).rejects.toMatchObject({
      code: 'UPLOAD_FAILED',
    });
    await expect(
      repository.softDelete(athleteId, stored.item.id, {
        expectedAccessRevision: 1,
        idempotencyKey: deleteKey,
      }),
    ).resolves.toEqual(deleted);
    await expect(
      repository.softDelete(athleteId, stored.item.id, {
        expectedAccessRevision: 1,
        idempotencyKey: `gallery-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
  });

  it('refuses a stale expected revision on update and delete', async () => {
    const athleteId = randomUUID();
    const repository = createGalleryMediaRepository(database);
    const stored = await storeImage(repository, athleteId);
    const updated = await repository.update(athleteId, stored.item.id, {
      album: '훈련',
      caption: null,
      activityId: null,
      expectedAccessRevision: 1,
      idempotencyKey: `gallery-${randomUUID()}`,
    });
    expect(updated).toMatchObject({ status: 'available' });
    if (updated.status !== 'available') throw new Error('expected an available media item');
    expect(updated.item).toMatchObject({ album: '훈련', caption: null, accessRevision: 2 });
    await expect(
      repository.update(athleteId, stored.item.id, {
        album: null,
        caption: null,
        activityId: null,
        expectedAccessRevision: 1,
        idempotencyKey: `gallery-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(PersistenceConflict);
  });

  it('refuses a preview finalize whose observed item revision went stale', async () => {
    const athleteId = randomUUID();
    const repository = createGalleryMediaRepository(database);
    const stored = await storeImage(repository, athleteId);
    const sha256 = 'd'.repeat(64);
    // Reserve against revision 1, then let a metadata write land first.
    const reservation = await repository.reservePreview(
      athleteId,
      stored.item.id,
      { expectedAccessRevision: 1 },
      `gallery-${randomUUID()}`,
    );
    const storageRef = galleryKey({
      tenantId: athleteId,
      mediaItemId: stored.item.id,
      uploadId: reservation.uploadId,
      sha256,
      extension: 'jpg',
    });
    await repository.prepareObject(athleteId, reservation.uploadId, {
      storageRef,
      file: {
        originalFileName: 'stale.jpg',
        mediaType: 'image/jpeg',
        byteSize: 256,
        sha256,
      },
    });
    await repository.markStaged(athleteId, reservation.uploadId);
    await repository.update(athleteId, stored.item.id, {
      album: '훈련',
      caption: null,
      activityId: null,
      expectedAccessRevision: 1,
      idempotencyKey: `gallery-${randomUUID()}`,
    });

    await expect(repository.finalize(athleteId, reservation.uploadId)).rejects.toBeInstanceOf(
      PersistenceConflict,
    );
    const afterConflict = await repository.read(athleteId, stored.item.id);
    if (afterConflict.status !== 'available') throw new Error('expected an available media item');
    expect(afterConflict.item.preview).toBeNull();
    expect(afterConflict.item.accessRevision).toBe(2);

    // A fresh reservation against the current revision succeeds.
    const fresh = await attachPreview(repository, athleteId, stored.item.id, 2);
    expect(fresh.storageRef).not.toBe(storageRef);
    const afterPreview = await repository.read(athleteId, stored.item.id);
    if (afterPreview.status !== 'available') throw new Error('expected an available media item');
    expect(afterPreview.item.accessRevision).toBe(3);
  });

  it('exports gallery facts at the current schema version without any storage reference', async () => {
    const athleteId = randomUUID();
    const repository = createGalleryMediaRepository(database);
    const stored = await storeImage(repository, athleteId);
    await attachPreview(repository, athleteId, stored.item.id, 1);
    const operations = createOperationsRepository(database);
    const exported = await operations.exportAccount(athleteId);
    expect(exported.schemaVersion).toBe(22);
    const data = exported.data as Record<string, Record<string, unknown>[]>;
    expect(data['galleryMediaItems']).toHaveLength(1);
    expect(data['galleryMediaItems']?.[0]).toMatchObject({
      media_kind: 'image',
      media_type: 'image/png',
      visibility: 'private',
      include_for_coach: false,
    });
    expect(data['galleryMediaDerivatives']).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain('storage_ref');
    expect(JSON.stringify(exported)).not.toContain('private/v1/tenants');
  });

  it('erases gallery rows and queues every object on account erasure', async () => {
    const athleteId = randomUUID();
    const repository = createGalleryMediaRepository(database);
    const stored = await storeImage(repository, athleteId);
    const preview = await attachPreview(repository, athleteId, stored.item.id, 1);
    const operations = createOperationsRepository(database);
    await operations.eraseAccount(athleteId);

    for (const table of [
      'gallery_media_item',
      'gallery_media_derivative',
      'gallery_media_object',
      'gallery_upload_intent',
    ]) {
      const rows = await admin.query(`SELECT 1 FROM ${table} WHERE athlete_id=$1`, [athleteId]);
      expect(rows.rowCount).toBe(0);
    }
    const queued = await admin.query(
      `SELECT reason FROM resource_object_cleanup WHERE storage_ref=ANY($1)`,
      [[stored.storageRef, preview.storageRef]],
    );
    expect(queued.rowCount).toBe(2);
    expect(queued.rows.every((row) => row['reason'] === 'account_erased')).toBe(true);
  });

  it('drains deleted gallery objects through the existing cleanup worker, including a retry', async () => {
    const athleteId = randomUUID();
    const repository = createGalleryMediaRepository(database);
    // Content addressed keys must match the bytes actually published.
    const rawBytes = Uint8Array.from([0x00, 0x01, 0x02, 0x03]);
    const previewBytes = Uint8Array.from([0x10, 0x11, 0x12]);
    const rawSha256 = createHash('sha256').update(rawBytes).digest('hex');
    const previewSha256 = createHash('sha256').update(previewBytes).digest('hex');
    const stored = await storeImage(repository, athleteId, { sha256: rawSha256 });
    const preview = await attachPreview(repository, athleteId, stored.item.id, 1, {
      sha256: previewSha256,
    });

    // Real objects on the same local filesystem adapter the API uses.
    const root = await mkdtemp(join(tmpdir(), 'gallery-cleanup-'));
    const storage = await createLocalFilesystemObjectStorage(root);
    for (const [ref, extension, bytes, sha256] of [
      [stored.storageRef, 'png', rawBytes, rawSha256],
      [preview.storageRef, 'jpg', previewBytes, previewSha256],
    ] as const) {
      const parsed = parseObjectKey(ref);
      assert.equal(parsed.kind, 'gallery_final');
      assert.equal(parsed.extension, extension);
      const temporary = createGalleryTemporaryObjectKey({
        tenantId: athleteId,
        mediaItemId: stored.item.id,
        uploadId: parsed.uploadId,
      });
      await storage.writeTemporary(
        temporary,
        (async function* () {
          yield bytes;
        })(),
      );
      const finalKey = createGalleryFinalObjectKey({
        tenantId: athleteId,
        mediaItemId: stored.item.id,
        uploadId: parsed.uploadId,
        sha256,
        extension,
      });
      expect(finalKey).toBe(ref);
      await storage.publishTemporary(temporary, finalKey, {
        sizeBytes: bytes.byteLength,
        sha256,
      });
      expect(await storage.stat(finalKey)).not.toBeNull();
    }

    await repository.softDelete(athleteId, stored.item.id, {
      expectedAccessRevision: 2,
      idempotencyKey: `gallery-${randomUUID()}`,
    });

    const ownRefs = [stored.storageRef, preview.storageRef];
    // The cleanup queue is deliberately tenant free and shared, so unrelated
    // pending entries are parked while this worker loop runs. Their original
    // schedule is captured BEFORE the update so the finally block restores the
    // previous value rather than the parked one.
    const parked = await admin.query(
      `SELECT id,available_at FROM resource_object_cleanup
       WHERE completed_at IS NULL AND NOT (storage_ref=ANY($1))`,
      [ownRefs],
    );
    const parkedIds = parked.rows.map((row) => row['id']);
    if (parkedIds.length > 0) {
      await admin.query(
        `UPDATE resource_object_cleanup SET available_at=clock_timestamp()+interval '1 hour'
         WHERE id=ANY($1)`,
        [parkedIds],
      );
    }
    const worker = createResourceObjectCleanupRepository({
      connectionString: adminUrl,
      workerId: randomUUID(),
    });
    try {
      // The first attempt fails, so the entry is rescheduled for retry rather
      // than recorded as completed.
      const failing = await processOneResourceObjectCleanup(worker, async () => {
        throw new Error('transient object store failure');
      });
      expect(failing).toBe('retry_scheduled');
      const retried = await admin.query(
        `SELECT attempts,last_error_code FROM resource_object_cleanup
         WHERE storage_ref=ANY($1) AND completed_at IS NULL AND attempts>0`,
        [ownRefs],
      );
      expect(retried.rowCount).toBe(1);
      expect(retried.rows[0]?.['last_error_code']).toBe('OBJECT_DELETE_FAILED');

      const outcomes: string[] = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await admin.query(
          `UPDATE resource_object_cleanup SET available_at=clock_timestamp()
           WHERE completed_at IS NULL AND storage_ref=ANY($1)`,
          [ownRefs],
        );
        const outcome = await processOneResourceObjectCleanup(worker, (ref) =>
          storage.delete(validateObjectKey(ref)),
        );
        outcomes.push(outcome);
        if (outcome === 'empty') break;
      }
      expect(outcomes.filter((outcome) => outcome === 'completed').length).toBeGreaterThanOrEqual(
        2,
      );
      expect(await storage.stat(validateObjectKey(stored.storageRef))).toBeNull();
      expect(await storage.stat(validateObjectKey(preview.storageRef))).toBeNull();
      const remaining = await admin.query(
        `SELECT 1 FROM resource_object_cleanup
         WHERE storage_ref=ANY($1) AND completed_at IS NULL`,
        [ownRefs],
      );
      expect(remaining.rowCount).toBe(0);
    } finally {
      await worker.close();
      await rm(root, { recursive: true, force: true });
      for (const row of parked.rows) {
        await admin.query('UPDATE resource_object_cleanup SET available_at=$2 WHERE id=$1', [
          row['id'],
          row['available_at'],
        ]);
      }
      // Every parked row must carry its original schedule again. An absolute
      // threshold would be wrong: other suites legitimately schedule entries
      // far in the future.
      for (const row of parked.rows) {
        const restored = await admin.query(
          'SELECT available_at FROM resource_object_cleanup WHERE id=$1',
          [row['id']],
        );
        if (restored.rowCount === 0) continue;
        expect(new Date(String(restored.rows[0]?.['available_at'])).getTime()).toBe(
          new Date(String(row['available_at'])).getTime(),
        );
      }
    }
  });

  it('refuses to authorize deleting an object a live media item still references', async () => {
    const athleteId = randomUUID();
    const workerRole = 'workout_cleanup_worker';
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${workerRole}')
       THEN CREATE ROLE ${workerRole} LOGIN PASSWORD 'cleanup'; END IF; END $$`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${workerRole}`);
    await grantResourceObjectCleanupWorker(adminUrl, workerRole);
    const repository = createGalleryMediaRepository(database);
    const stored = await storeImage(repository, athleteId);
    const queueId = randomUUID();
    const leaseOwner = randomUUID();
    await admin.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at,lease_owner,lease_until,attempts)
       VALUES($1,$2,'resource_deleted',clock_timestamp(),clock_timestamp(),$3,clock_timestamp()+interval '1 minute',1)`,
      [queueId, stored.storageRef, leaseOwner],
    );
    const authorized = await admin.query(
      'SELECT * FROM public.authorize_resource_object_cleanup($1,$2,clock_timestamp())',
      [queueId, leaseOwner],
    );
    expect(authorized.rowCount).toBe(0);
    const row = await admin.query(
      'SELECT last_error_code,completed_at FROM resource_object_cleanup WHERE id=$1',
      [queueId],
    );
    expect(row.rows[0]?.['last_error_code']).toBe('REFERENCE_PRESENT');
    expect(row.rows[0]?.['completed_at']).not.toBeNull();
  });
});
