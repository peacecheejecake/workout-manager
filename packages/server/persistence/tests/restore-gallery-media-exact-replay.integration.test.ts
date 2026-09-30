import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { grantGalleryMedia, grantOperations, migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `gallery_replay_${suffix}`;
const ownerRole = `gallery_owner_${suffix}`;
const runtimeRole = `gallery_app_${suffix}`;
let owner: Pool;
let runtime: Pool;
let database: Database;

type Entry = {
  athleteId: string;
  targetId: string;
  eventId: string;
  occurredAt: string;
  accessRevision: number;
  storageRef: string;
};

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

async function tenant<T>(
  pool: Pool,
  athleteId: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function account(): Promise<string> {
  const row = await owner.query<{ athlete_id: string }>(
    `INSERT INTO identity_private.account(issuer,subject)
     VALUES('https://issuer.test',$1) RETURNING athlete_id::text`,
    [randomUUID()],
  );
  const id = row.rows[0]?.athlete_id;
  if (!id) throw new Error('missing account');
  return id;
}

async function liveImage(athleteId: string): Promise<Entry> {
  const gallery = createGalleryMediaRepository(database);
  const reservation = await gallery.reserveCreate(
    athleteId,
    {
      mediaKind: 'image',
      album: null,
      caption: 'Synthetic image',
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    randomUUID(),
  );
  const hash = 'a'.repeat(64);
  const storageRef = `private/v1/tenants/${athleteId}/gallery/${reservation.mediaItemId}/objects/uploads/${reservation.uploadId}/sha256/${hash}.png`;
  await gallery.prepareObject(athleteId, reservation.uploadId, {
    storageRef,
    file: {
      originalFileName: 'synthetic.png',
      mediaType: 'image/png',
      byteSize: 1024,
      sha256: hash,
    },
  });
  await gallery.markStaged(athleteId, reservation.uploadId);
  const result = await gallery.finalize(athleteId, reservation.uploadId);
  if (result.status !== 'available') throw new Error('missing live image');
  return {
    athleteId,
    targetId: result.item.id,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    accessRevision: result.item.accessRevision + 1,
    storageRef,
  };
}

function args(item: Entry): unknown[] {
  return [item.athleteId, item.targetId, item.eventId, item.occurredAt, item.accessRevision];
}

async function replay(pool: Pool, item: Entry): Promise<string> {
  return tenant(pool, item.athleteId, async (client) => {
    const result = await client.query<{ replay_gallery_media_deletion_exact: string }>(
      'SELECT public.replay_gallery_media_deletion_exact($1,$2,$3,$4,$5)',
      args(item),
    );
    return result.rows[0]?.replay_gallery_media_deletion_exact ?? '';
  });
}

async function state(item: Entry) {
  return tenant(owner, item.athleteId, async (client) => {
    const result = await client.query<{
      revision: number | null;
      deleted_at: Date | null;
      event_count: string;
      receipt_count: string;
      cleanup_count: string;
      outbox_count: string;
    }>(
      `SELECT (SELECT access_revision FROM gallery_media_item WHERE athlete_id=$1 AND id=$2) revision,
       (SELECT deleted_at FROM gallery_media_item WHERE athlete_id=$1 AND id=$2) deleted_at,
       (SELECT count(*) FROM restore_suppression_event WHERE event_id=$3) event_count,
       (SELECT count(*) FROM restore_gallery_media_replay_receipt WHERE event_id=$3) receipt_count,
       (SELECT count(*) FROM resource_object_cleanup WHERE storage_ref=$4 AND completed_at IS NULL) cleanup_count,
       (SELECT count(*) FROM outbox WHERE athlete_id=$1 AND id=$3) outbox_count`,
      [item.athleteId, item.targetId, item.eventId, item.storageRef],
    );
    return result.rows[0];
  });
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  runtime = new Pool({ connectionString: urlFor(runtimeRole) });
  await migrate(urlFor(ownerRole));
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await grantGalleryMedia(urlFor(ownerRole), runtimeRole);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 3 });
});

afterAll(async () => {
  await database?.close();
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('exact gallery deletion replay under a plain PostgreSQL owner', () => {
  it('preserves event identity, advances the head, and keeps an immutable retry receipt', async () => {
    const item = await liveImage(await account());
    expect(await replay(owner, item)).toBe('deleted');
    expect(await state(item)).toMatchObject({
      revision: item.accessRevision,
      deleted_at: new Date(item.occurredAt),
      event_count: '1',
      receipt_count: '1',
      cleanup_count: '1',
      outbox_count: '1',
    });
    const event = await tenant(owner, item.athleteId, (client) =>
      client.query(
        `SELECT athlete_id,target_id::text,occurred_at,gallery_access_revision
         FROM restore_suppression_event WHERE event_id=$1`,
        [item.eventId],
      ),
    );
    expect(event.rows[0]).toEqual({
      athlete_id: item.athleteId,
      target_id: item.targetId,
      occurred_at: new Date(item.occurredAt),
      gallery_access_revision: item.accessRevision,
    });
    await tenant(owner, item.athleteId, (client) =>
      client.query('DELETE FROM outbox WHERE athlete_id=$1 AND id=$2', [
        item.athleteId,
        item.eventId,
      ]),
    );
    expect(await replay(owner, item)).toBe('already_applied');
    await expect(
      replay(owner, { ...item, accessRevision: item.accessRevision + 1 }),
    ).rejects.toThrow('RESTORE_GALLERY_EVENT_CONFLICT');
    await expect(
      tenant(owner, item.athleteId, (client) =>
        client.query('DELETE FROM restore_gallery_media_replay_receipt WHERE event_id=$1', [
          item.eventId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('refuses absent, skipped, foreign and normal deletion event heads', async () => {
    const item = await liveImage(await account());
    const absent = { ...item, targetId: randomUUID(), eventId: randomUUID() };
    await expect(replay(owner, absent)).rejects.toThrow('RESTORE_GALLERY_ABSENT_UNSUPPORTED');
    await expect(
      replay(owner, { ...item, accessRevision: item.accessRevision + 1 }),
    ).rejects.toThrow('RESTORE_GALLERY_STATE_CONFLICT');
    const foreign = await liveImage(await account());
    await expect(replay(owner, { ...foreign, athleteId: item.athleteId })).rejects.toThrow(
      'RESTORE_GALLERY_FOREIGN_MEDIA',
    );
    expect(await state(item)).toMatchObject({
      revision: item.accessRevision - 1,
      deleted_at: null,
      event_count: '0',
      receipt_count: '0',
    });
    await createGalleryMediaRepository(database).softDelete(item.athleteId, item.targetId, {
      expectedAccessRevision: item.accessRevision - 1,
      idempotencyKey: randomUUID(),
    });
    const normal = await tenant(owner, item.athleteId, (client) =>
      client.query<{ event_id: string; occurred_at: Date }>(
        `SELECT event_id,occurred_at FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='gallery_media_deleted' AND target_id=$2`,
        [item.athleteId, item.targetId],
      ),
    );
    const event = normal.rows[0];
    if (!event) throw new Error('missing normal event');
    await expect(
      replay(owner, {
        ...item,
        eventId: event.event_id,
        occurredAt: event.occurred_at.toISOString(),
      }),
    ).rejects.toThrow('RESTORE_GALLERY_RECEIPT_MISSING');
  });

  it('rolls back replay and denies runtime or spoofed event suppression', async () => {
    const first = await liveImage(await account());
    const foreign = await liveImage(await account());
    await expect(
      tenant(owner, first.athleteId, async (client) => {
        await client.query(
          'SELECT public.replay_gallery_media_deletion_exact($1,$2,$3,$4,$5)',
          args(first),
        );
        await client.query('SELECT public.replay_gallery_media_deletion_exact($1,$2,$3,$4,$5)', [
          first.athleteId,
          foreign.targetId,
          randomUUID(),
          foreign.occurredAt,
          foreign.accessRevision,
        ]);
      }),
    ).rejects.toThrow('RESTORE_GALLERY_FOREIGN_MEDIA');
    expect(await state(first)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      deleted_at: null,
    });
    await expect(replay(runtime, first)).rejects.toThrow(/permission denied/);
    await expect(
      tenant(runtime, first.athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_gallery_media_event_id',$1,true)", [
          first.eventId,
        ]);
        await client.query(
          `UPDATE gallery_media_item SET access_revision=$3,updated_at=$4,deleted_at=$4
           WHERE athlete_id=$1 AND id=$2`,
          [first.athleteId, first.targetId, first.accessRevision, first.occurredAt],
        );
      }),
    ).rejects.toThrow('RESTORE_GALLERY_OWNER_REQUIRED');
    expect(await state(first)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      deleted_at: null,
    });
  });
});
