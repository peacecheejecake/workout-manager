import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import {
  createGalleryMediaRepository,
  GalleryMediaNotFoundError,
  type GalleryMediaRepository,
} from '../src/gallery-media.js';
import { grantGalleryMedia, grantOperations, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const runtime = new Pool({ connectionString: runtimeUrl });
let database: Database;

type GalleryEvent = {
  event_id: string;
  athlete_id: string;
  target_id: string;
  occurred_at: Date;
  gallery_access_revision: number;
  activity_revision: number | null;
  resource_access_revision: number | null;
  source_kind: string | null;
  source_id: string | null;
  source_revision: number | null;
  source_content_hash: string | null;
};

async function events(tenant: string): Promise<GalleryEvent[]> {
  const rows = await admin.query<GalleryEvent>(
    `SELECT event_id,athlete_id,target_id::text,occurred_at,gallery_access_revision,
       activity_revision,resource_access_revision,source_kind,source_id,
       source_revision,source_content_hash FROM restore_suppression_event
     WHERE athlete_id=$1 AND kind='gallery_media_deleted' ORDER BY target_id`,
    [tenant],
  );
  return rows.rows;
}

async function storeImage(repository: GalleryMediaRepository, tenant: string) {
  const reservation = await repository.reserveCreate(
    tenant,
    {
      mediaKind: 'image',
      album: 'Private album',
      caption: 'sensitive-caption',
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    `gallery-${randomUUID()}`,
  );
  const hash = 'a'.repeat(64);
  const storageRef = `private/v1/tenants/${tenant}/gallery/${reservation.mediaItemId}/objects/uploads/${reservation.uploadId}/sha256/${hash}.png`;
  await repository.prepareObject(tenant, reservation.uploadId, {
    storageRef,
    file: {
      originalFileName: 'sensitive-filename.png',
      mediaType: 'image/png',
      byteSize: 2048,
      sha256: hash,
    },
  });
  await repository.markStaged(tenant, reservation.uploadId);
  const finalized = await repository.finalize(tenant, reservation.uploadId);
  if (finalized.status !== 'available') throw new Error('Expected available media item');
  return { item: finalized.item, storageRef, hash };
}

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantGalleryMedia(adminUrl, 'workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 5 });
});

afterAll(async () => {
  await database?.close();
  await runtime.end();
  await admin.end();
});

describe('transaction-local gallery media deletion event', () => {
  it('records one minimal event per item, preserves retry identity, and survives erasure', async () => {
    const tenant = randomUUID();
    const gallery = createGalleryMediaRepository(database);
    const first = await storeImage(gallery, tenant);
    const changed = await gallery.update(tenant, first.item.id, {
      album: 'Updated album',
      caption: 'sensitive-updated-caption',
      activityId: null,
      expectedAccessRevision: first.item.accessRevision,
      idempotencyKey: `gallery-${randomUUID()}`,
    });
    if (changed.status !== 'available') throw new Error('Expected available media item');
    const deletion = {
      expectedAccessRevision: changed.item.accessRevision,
      idempotencyKey: `gallery-${randomUUID()}`,
    };
    const deleted = await gallery.softDelete(tenant, first.item.id, deletion);
    const once = await events(tenant);
    expect(once).toEqual([
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        target_id: first.item.id,
        occurred_at: new Date(deleted.deletedAt),
        gallery_access_revision: deleted.accessRevision,
        activity_revision: null,
        resource_access_revision: null,
        source_kind: null,
        source_id: null,
        source_revision: null,
        source_content_hash: null,
      },
    ]);
    expect(deleted.accessRevision).toBe(3);
    expect(await gallery.softDelete(tenant, first.item.id, deletion)).toEqual(deleted);
    await expect(
      gallery.softDelete(tenant, first.item.id, {
        ...deletion,
        idempotencyKey: `gallery-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(GalleryMediaNotFoundError);
    expect(await events(tenant)).toEqual(once);
    const full = await admin.query(
      `SELECT to_jsonb(e) AS event FROM restore_suppression_event e
       WHERE athlete_id=$1 AND kind='gallery_media_deleted'`,
      [tenant],
    );
    expect(JSON.stringify(full.rows)).not.toMatch(/sensitive-|private\/v1|a{64}/);
    await expect(runtime.query('SELECT * FROM restore_suppression_event')).rejects.toMatchObject({
      code: '42501',
    });

    const second = await storeImage(gallery, tenant);
    await gallery.softDelete(tenant, second.item.id, {
      expectedAccessRevision: second.item.accessRevision,
      idempotencyKey: `gallery-${randomUUID()}`,
    });
    const both = await events(tenant);
    expect(both).toHaveLength(2);
    expect(both.find((row) => row.target_id === first.item.id)).toEqual(once[0]);
    await createOperationsRepository(database).eraseAccount(tenant);
    expect(await events(tenant)).toEqual(both);
    expect(
      (await admin.query('SELECT 1 FROM gallery_media_item WHERE athlete_id=$1', [tenant])).rows,
    ).toEqual([]);
  });

  it('rolls back the event, tombstone and cleanup when outbox insertion fails; denies foreign tenant', async () => {
    const owner = randomUUID();
    const foreign = randomUUID();
    const gallery = createGalleryMediaRepository(database);
    const stored = await storeImage(gallery, owner);
    const deletion = {
      expectedAccessRevision: stored.item.accessRevision,
      idempotencyKey: `gallery-${randomUUID()}`,
    };
    await expect(gallery.softDelete(foreign, stored.item.id, deletion)).rejects.toBeInstanceOf(
      GalleryMediaNotFoundError,
    );
    expect(await events(owner)).toEqual([]);
    expect(await events(foreign)).toEqual([]);

    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, values) => {
              if (sql.includes('INSERT INTO outbox')) throw new Error('injected outbox failure');
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await expect(
      createGalleryMediaRepository(broken).softDelete(owner, stored.item.id, deletion),
    ).rejects.toThrow('injected outbox failure');
    expect(await events(owner)).toEqual([]);
    expect((await gallery.read(owner, stored.item.id)).status).toBe('available');
    expect(
      (
        await admin.query('SELECT 1 FROM resource_object_cleanup WHERE storage_ref=$1', [
          stored.storageRef,
        ])
      ).rows,
    ).toEqual([]);
    await gallery.softDelete(owner, stored.item.id, deletion);
    expect(await events(owner)).toHaveLength(1);
    expect(await events(foreign)).toEqual([]);
  });

  it('rejects missing revision and unrelated resource fields', async () => {
    const tenant = randomUUID();
    const target = randomUUID();
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at)
         VALUES($1,'gallery_media_deleted',$2,now())`,
        [tenant, target],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at,
          gallery_access_revision,resource_access_revision)
         VALUES($1,'gallery_media_deleted',$2,now(),2,1)`,
        [tenant, target],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await events(tenant)).toEqual([]);
  });
});
