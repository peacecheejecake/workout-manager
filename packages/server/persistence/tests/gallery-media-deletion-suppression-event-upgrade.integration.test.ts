import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { createGalleryMediaRepository, type GalleryMediaRepository } from '../src/gallery-media.js';
import { grantGalleryMedia, grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `gallery_event_upgrade_${suffix}`;
const ownerRole = `gallery_event_owner_${suffix}`;
const runtimeRole = `gallery_event_rt_${suffix}`;
const migrationIndex = migrationFileNames.findIndex((file) =>
  /^\d+_gallery_media_deletion_suppression_event\.sql$/.test(file),
);
if (migrationIndex < 0) throw new Error('Gallery deletion event migration is missing');

let owner: Pool;
let database: Database;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

async function storeImage(repository: GalleryMediaRepository, tenant: string) {
  const reservation = await repository.reserveCreate(
    tenant,
    {
      mediaKind: 'image',
      album: null,
      caption: 'Synthetic upgrade image',
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    `gallery-${randomUUID()}`,
  );
  const hash = 'b'.repeat(64);
  const storageRef = `private/v1/tenants/${tenant}/gallery/${reservation.mediaItemId}/objects/uploads/${reservation.uploadId}/sha256/${hash}.png`;
  await repository.prepareObject(tenant, reservation.uploadId, {
    storageRef,
    file: {
      originalFileName: 'upgrade.png',
      mediaType: 'image/png',
      byteSize: 2048,
      sha256: hash,
    },
  });
  await repository.markStaged(tenant, reservation.uploadId);
  const finalized = await repository.finalize(tenant, reservation.uploadId);
  if (finalized.status !== 'available') throw new Error('Expected available gallery item');
  return finalized.item;
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  await migrate(urlFor(ownerRole), migrationIndex);
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await grantGalleryMedia(urlFor(ownerRole), runtimeRole);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 2 });
});

afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('gallery deletion event upgrade under a plain PostgreSQL owner', () => {
  it('leaves older tombstones unchanged and records later deletion through FORCE RLS', async () => {
    const tenant = randomUUID();
    const gallery = createGalleryMediaRepository(database);
    const old = await storeImage(gallery, tenant);
    const live = await storeImage(gallery, tenant);
    await gallery.softDelete(tenant, old.id, {
      expectedAccessRevision: old.accessRevision,
      idempotencyKey: `gallery-${randomUUID()}`,
    });

    // The changed CHECK must accept a committed event from the previous schema.
    const erasedTenant = randomUUID();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [erasedTenant]);
      await client.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [erasedTenant]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const olderEvent = (
      await owner.query(
        `SELECT event_id,kind,occurred_at FROM restore_suppression_event
         WHERE athlete_id=$1`,
        [erasedTenant],
      )
    ).rows;

    await migrate(urlFor(ownerRole));
    expect(
      (
        await owner.query(
          `SELECT event_id,kind,occurred_at FROM restore_suppression_event
           WHERE athlete_id=$1`,
          [erasedTenant],
        )
      ).rows,
    ).toEqual(olderEvent);
    expect(
      (
        await owner.query(
          `SELECT target_id::text FROM restore_suppression_event
           WHERE athlete_id=$1 AND kind='gallery_media_deleted'`,
          [tenant],
        )
      ).rows,
    ).toEqual([]);
    const deleted = await gallery.softDelete(tenant, live.id, {
      expectedAccessRevision: live.accessRevision,
      idempotencyKey: `gallery-${randomUUID()}`,
    });
    expect(
      (
        await owner.query(
          `SELECT target_id::text,gallery_access_revision,occurred_at
           FROM restore_suppression_event WHERE athlete_id=$1 AND kind='gallery_media_deleted'`,
          [tenant],
        )
      ).rows,
    ).toEqual([
      {
        target_id: live.id,
        gallery_access_revision: deleted.accessRevision,
        occurred_at: new Date(deleted.deletedAt),
      },
    ]);
    const policy = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.restore_suppression_event'::regclass",
    );
    expect(policy.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
