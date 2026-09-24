import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';

import { createActivityRepository } from '../src/activities.js';
import { createDatabase, type Database } from '../src/database.js';
import { createGalleryMediaRepository, GalleryMediaNotFoundError } from '../src/gallery-media.js';
import { grantGalleryMedia, grantOperations, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';

/**
 * M2-01k-l: the S09 media tab links the owner's existing gallery media to an activity.
 *
 * The link is `gallery_media_item.activity_id` (migration 031), not a second table, so it
 * carries the media item's own policy: FORCE row level security, the composite foreign key
 * `(athlete_id, activity_id) → activity_canonical`, the revisioned update, soft delete,
 * account erasure and the account export. These tests assert each of those for the link
 * itself on real PostgreSQL, and that a deleted item's thumbnail and original stop resolving.
 */
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
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,outbox,command_receipt,plan_snapshot,plan_head,plan_history TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 6 });
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

function activityInput(): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'c'.repeat(64) },
    activity: {
      title: '미디어 연결 활동',
      kind: 'running',
      startedAt: '2026-09-16T08:00:00+09:00',
      durationSeconds: null,
      durationKind: 'unknown',
      timezone: 'Asia/Seoul',
      distanceMeters: 0,
    },
  };
}

async function importActivity(athleteId: string) {
  const imported = await createActivityRepository(database).importActivity(
    athleteId,
    activityInput(),
  );
  return imported.activityId;
}

function sha() {
  return randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64);
}

function galleryKey(tenantId: string, mediaItemId: string, uploadId: string, hash: string) {
  return `private/v1/tenants/${tenantId}/gallery/${mediaItemId}/objects/uploads/${uploadId}/sha256/${hash}`;
}

/** A finalized gallery image with a preview derivative (the thumbnail the tab shows). */
async function storeImageWithPreview(athleteId: string) {
  const repository = createGalleryMediaRepository(database);
  const reservation = await repository.reserveCreate(
    athleteId,
    {
      mediaKind: 'image',
      album: '대회',
      caption: '결승선',
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    `gallery-${randomUUID()}`,
  );
  const hash = sha();
  const storageRef = `${galleryKey(athleteId, reservation.mediaItemId, reservation.uploadId, hash)}.png`;
  await repository.prepareObject(athleteId, reservation.uploadId, {
    storageRef,
    file: { originalFileName: 'finish.png', mediaType: 'image/png', byteSize: 2048, sha256: hash },
  });
  await repository.markStaged(athleteId, reservation.uploadId);
  const created = await repository.finalize(athleteId, reservation.uploadId);
  if (created.status !== 'available') throw new Error('expected an available media item');

  const preview = await repository.reservePreview(
    athleteId,
    reservation.mediaItemId,
    { expectedAccessRevision: created.item.accessRevision },
    `gallery-${randomUUID()}`,
  );
  const previewHash = sha();
  const previewRef = `${galleryKey(athleteId, reservation.mediaItemId, preview.uploadId, previewHash)}.jpg`;
  await repository.prepareObject(athleteId, preview.uploadId, {
    storageRef: previewRef,
    file: {
      originalFileName: 'finish-preview.jpg',
      mediaType: 'image/jpeg',
      byteSize: 512,
      sha256: previewHash,
    },
  });
  await repository.markStaged(athleteId, preview.uploadId);
  const withPreview = await repository.finalize(athleteId, preview.uploadId);
  if (withPreview.status !== 'available') throw new Error('expected an available media item');
  return { item: withPreview.item, storageRef, previewRef };
}

async function link(athleteId: string, mediaItemId: string, activityId: string | null) {
  const repository = createGalleryMediaRepository(database);
  const current = await repository.read(athleteId, mediaItemId);
  if (current.status !== 'available') throw new Error('expected an available media item');
  return repository.update(athleteId, mediaItemId, {
    album: current.item.album,
    caption: current.item.caption,
    activityId,
    expectedAccessRevision: current.item.accessRevision,
    idempotencyKey: `link-${randomUUID()}`,
  });
}

describe('activity media link on real PostgreSQL (M2-01k-l)', () => {
  it('stores, lists by activity and clears the link as a revisioned media update', async () => {
    const athleteId = randomUUID();
    const activityId = await importActivity(athleteId);
    const { item } = await storeImageWithPreview(athleteId);
    const repository = createGalleryMediaRepository(database);

    const linked = await link(athleteId, item.id, activityId);
    expect(linked).toMatchObject({
      status: 'available',
      item: { id: item.id, activityId, album: '대회', caption: '결승선' },
    });
    if (linked.status !== 'available') throw new Error('expected available');
    expect(linked.item.accessRevision).toBe(item.accessRevision + 1);
    const stored = await admin.query(
      'SELECT activity_id FROM gallery_media_item WHERE athlete_id=$1 AND id=$2',
      [athleteId, item.id],
    );
    expect(stored.rows).toEqual([{ activity_id: activityId }]);
    const byActivity = await repository.list(athleteId, { activityId, limit: 50, offset: 0 });
    expect(byActivity.items.map((entry) => entry.id)).toEqual([item.id]);
    const event = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE athlete_id=$1 AND topic='gallery.media_updated'`,
      [athleteId],
    );
    expect(event.rows[0]?.['n']).toBe(1);

    const unlinked = await link(athleteId, item.id, null);
    expect(unlinked).toMatchObject({ status: 'available', item: { activityId: null } });
    expect((await repository.list(athleteId, { activityId, limit: 50, offset: 0 })).total).toBe(0);
    expect((await repository.list(athleteId, { limit: 50, offset: 0 })).total).toBe(1);
  });

  it('isolates the link between tenants through FORCE row level security and the composite key', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const aliceActivity = await importActivity(alice);
    const bobActivity = await importActivity(bob);
    const { item } = await storeImageWithPreview(alice);
    await link(alice, item.id, aliceActivity);
    const repository = createGalleryMediaRepository(database);

    const force = await admin.query(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.gallery_media_item'::regclass`,
    );
    expect(force.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    // Bob reads nothing of Alice's link, through the repository or raw SQL in his tenant.
    expect(
      (await repository.list(bob, { activityId: aliceActivity, limit: 50, offset: 0 })).total,
    ).toBe(0);
    await expect(repository.read(bob, item.id)).resolves.toEqual({
      status: 'unavailable',
      mediaItemId: item.id,
    });
    const seen = await database.tenant(bob, (tx) =>
      tx.query('SELECT activity_id FROM gallery_media_item WHERE id=$1', [item.id]),
    );
    expect(seen.rowCount).toBe(0);
    // Bob can neither move Alice's media onto his activity nor clear her link.
    await expect(
      repository.update(bob, item.id, {
        album: null,
        caption: null,
        activityId: bobActivity,
        expectedAccessRevision: 3,
        idempotencyKey: `link-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(GalleryMediaNotFoundError);
    const cleared = await database.tenant(bob, (tx) =>
      tx.query(
        'UPDATE gallery_media_item SET activity_id=NULL,access_revision=access_revision+1 WHERE id=$1',
        [item.id],
      ),
    );
    expect(cleared.rowCount).toBe(0);

    // Alice cannot link her media to Bob's activity: the repository refuses it as unknown,
    // and even a direct write in her tenant is stopped by the (athlete_id, activity_id) key.
    await expect(link(alice, item.id, bobActivity)).rejects.toBeInstanceOf(
      GalleryMediaNotFoundError,
    );
    await expect(
      database.tenant(alice, (tx) =>
        tx.query(
          'UPDATE gallery_media_item SET activity_id=$2,access_revision=access_revision+1 WHERE id=$1',
          [item.id, bobActivity],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const still = await admin.query('SELECT activity_id FROM gallery_media_item WHERE id=$1', [
      item.id,
    ]);
    expect(still.rows).toEqual([{ activity_id: aliceActivity }]);
  });

  it('refuses a link to a deleted activity and a stale revision', async () => {
    const athleteId = randomUUID();
    const activityId = await importActivity(athleteId);
    const { item } = await storeImageWithPreview(athleteId);
    await createActivityRepository(database).deleteActivity(athleteId, activityId, {
      expectedRevision: 1,
    });
    await expect(link(athleteId, item.id, activityId)).rejects.toBeInstanceOf(
      GalleryMediaNotFoundError,
    );
    const live = await importActivity(athleteId);
    await expect(
      createGalleryMediaRepository(database).update(athleteId, item.id, {
        album: item.album,
        caption: item.caption,
        activityId: live,
        expectedAccessRevision: item.accessRevision - 1,
        idempotencyKey: `link-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('drops a deleted item from the activity and stops resolving its thumbnail and original', async () => {
    const athleteId = randomUUID();
    const activityId = await importActivity(athleteId);
    const { item, storageRef, previewRef } = await storeImageWithPreview(athleteId);
    const linked = await link(athleteId, item.id, activityId);
    if (linked.status !== 'available') throw new Error('expected available');
    const repository = createGalleryMediaRepository(database);
    await expect(repository.resolveObject(athleteId, item.id, 'preview')).resolves.toMatchObject({
      storageRef: previewRef,
    });

    await repository.softDelete(athleteId, item.id, {
      expectedAccessRevision: linked.item.accessRevision,
      idempotencyKey: `delete-${randomUUID()}`,
    });

    expect((await repository.list(athleteId, { activityId, limit: 50, offset: 0 })).total).toBe(0);
    await expect(repository.resolveObject(athleteId, item.id, 'preview')).resolves.toBeNull();
    await expect(repository.resolveObject(athleteId, item.id, 'original')).resolves.toBeNull();
    // A deleted item cannot be linked again, and both of its objects are queued for removal.
    await expect(link(athleteId, item.id, activityId)).rejects.toThrow();
    const queued = await admin.query(
      'SELECT storage_ref FROM resource_object_cleanup WHERE storage_ref=ANY($1)',
      [[storageRef, previewRef]],
    );
    expect(queued.rowCount).toBe(2);
    const exported = await createOperationsRepository(database).exportAccount(athleteId);
    const data = exported.data as Record<string, Record<string, unknown>[]>;
    expect(data['galleryMediaItems']).toEqual([]);
  });

  it('exports the link with the media item and never a storage reference', async () => {
    const athleteId = randomUUID();
    const activityId = await importActivity(athleteId);
    const { item } = await storeImageWithPreview(athleteId);
    await link(athleteId, item.id, activityId);
    const exported = await createOperationsRepository(database).exportAccount(athleteId);
    const data = exported.data as Record<string, Record<string, unknown>[]>;
    expect(data['galleryMediaItems']).toEqual([
      expect.objectContaining({ id: item.id, activity_id: activityId }),
    ]);
    expect(data['galleryMediaDerivatives']).toEqual([
      expect.objectContaining({ media_item_id: item.id, kind: 'preview' }),
    ]);
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain('storage_ref');
    expect(serialized).not.toContain('private/v1/tenants');
  });

  it('erases the link with the account and leaves another tenant link untouched', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const aliceActivity = await importActivity(alice);
    const bobActivity = await importActivity(bob);
    const aliceMedia = await storeImageWithPreview(alice);
    const bobMedia = await storeImageWithPreview(bob);
    await link(alice, aliceMedia.item.id, aliceActivity);
    await link(bob, bobMedia.item.id, bobActivity);

    await createOperationsRepository(database).eraseAccount(alice);

    const aliceRows = await admin.query(
      'SELECT count(*)::int AS n FROM gallery_media_item WHERE athlete_id=$1 OR activity_id=$2',
      [alice, aliceActivity],
    );
    expect(aliceRows.rows[0]?.['n']).toBe(0);
    const aliceActivities = await admin.query(
      'SELECT count(*)::int AS n FROM activity_canonical WHERE athlete_id=$1',
      [alice],
    );
    expect(aliceActivities.rows[0]?.['n']).toBe(0);
    const queued = await admin.query(
      `SELECT reason FROM resource_object_cleanup WHERE storage_ref=ANY($1)`,
      [[aliceMedia.storageRef, aliceMedia.previewRef]],
    );
    expect(queued.rows).toEqual([{ reason: 'account_erased' }, { reason: 'account_erased' }]);
    const bobLink = await admin.query(
      'SELECT activity_id FROM gallery_media_item WHERE athlete_id=$1 AND id=$2',
      [bob, bobMedia.item.id],
    );
    expect(bobLink.rows).toEqual([{ activity_id: bobActivity }]);
  });
});
