import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  grantOperations,
  grantGalleryMedia,
  grantGarminUnofficial,
  grantResourceObjectCleanupWorker,
} from '../src/migrate.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { createResourceObjectCleanupRepository } from '../src/resource-object-cleanup.js';
import { readRaceMediaCleanupSource } from '../src/race-media-cleanup-source.js';
import { captureActivityAndMediaPermissions } from '../src/race-plan-impact-nested-sources.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// DB metadata acceptance only: no provider/object-store upload or deletion ran.
// Public107 plus explicit unregistered113; registry/retarget/fullprivacy is separate.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `race_media_reader_${suffix}`,
  ownerRole = `race_media_owner_${suffix}`,
  runtimeRole = `race_media_app_${suffix}`,
  workerRole = `race_media_worker_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 }),
  roles: string[] = [];
let db: Database,
  owner: Pool,
  worker: ReturnType<typeof createResourceObjectCleanupRepository>,
  created = false;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, workerRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  const state = await owner.query('SELECT max(version)::int AS version FROM schema_migrations');
  expect(state.rows[0]?.['version']).toBe(107);
  await owner.query(
    await readFile(
      new URL('../migrations/113_race_media_cleanup_source.sql', import.meta.url),
      'utf8',
    ),
  );
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${workerRole}"`);
  await owner.query(
    `GRANT EXECUTE ON FUNCTION public.read_race_media_cleanup(uuid,integer) TO "${runtimeRole}"`,
  );
  await grantOperations(url(ownerRole), runtimeRole);
  await grantGalleryMedia(url(ownerRole), runtimeRole);
  await grantGarminUnofficial(url(ownerRole), runtimeRole);
  await grantResourceObjectCleanupWorker(url(ownerRole), workerRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 2 });
  worker = createResourceObjectCleanupRepository({ connectionString: url(workerRole), max: 1 });
});
afterAll(async () => {
  await worker?.close();
  await db?.close();
  await owner?.end();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function tenant() {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  return athlete;
}
function key(athlete: string, media: string, upload: string, hash: string, extension: string) {
  return `private/v1/tenants/${athlete}/gallery/${media}/objects/uploads/${upload}/sha256/${hash}.${extension}`;
}
async function image(athlete: string) {
  const gallery = createGalleryMediaRepository(db),
    hash = 'a'.repeat(64);
  const reservation = await gallery.reserveCreate(
    athlete,
    {
      mediaKind: 'image',
      album: null,
      caption: 'Synthetic metadata',
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    `media-${randomUUID()}`,
  );
  const storageRef = key(athlete, reservation.mediaItemId, reservation.uploadId, hash, 'png');
  await gallery.prepareObject(athlete, reservation.uploadId, {
    storageRef,
    file: { originalFileName: 'synthetic.png', mediaType: 'image/png', byteSize: 2, sha256: hash },
  });
  await gallery.markStaged(athlete, reservation.uploadId);
  const stored = await gallery.finalize(athlete, reservation.uploadId);
  if (stored.status !== 'available') throw Error('synthetic media unavailable');
  return { gallery, item: stored.item, storageRef };
}
async function preview(athlete: string, media: string, revision: number) {
  const gallery = createGalleryMediaRepository(db),
    hash = 'b'.repeat(64);
  const reservation = await gallery.reservePreview(
    athlete,
    media,
    { expectedAccessRevision: revision },
    `preview-${randomUUID()}`,
  );
  const storageRef = key(athlete, media, reservation.uploadId, hash, 'jpg');
  await gallery.prepareObject(athlete, reservation.uploadId, {
    storageRef,
    file: {
      originalFileName: 'synthetic-preview.jpg',
      mediaType: 'image/jpeg',
      byteSize: 2,
      sha256: hash,
    },
  });
  await gallery.markStaged(athlete, reservation.uploadId);
  await gallery.finalize(athlete, reservation.uploadId);
  return storageRef;
}
async function read(athlete: string, mediaItemId: string, expectedAccessRevision: number) {
  return db.tenant(athlete, (tx) =>
    readRaceMediaCleanupSource(tx, { mediaItemId, expectedAccessRevision }),
  );
}
async function deleted(athlete: string, withPreview = false) {
  const stored = await image(athlete);
  const refs = [stored.storageRef];
  if (withPreview) refs.push(await preview(athlete, stored.item.id, 1));
  const result = await stored.gallery.softDelete(athlete, stored.item.id, {
    expectedAccessRevision: withPreview ? 2 : 1,
    idempotencyKey: `delete-${randomUUID()}`,
  });
  return { ...stored, refs, revision: result.accessRevision };
}
it('reports live owned media absent with exact accounted immutable object/upload inventory', async () => {
  const athlete = await tenant(),
    stored = await image(athlete);
  const result = await read(athlete, stored.item.id, 1);
  expect(result.status).toBe('available');
  if (result.status === 'available') {
    expect(result.source).toMatchObject({
      authority: 'db_cleanup_status_only',
      state: 'absent',
      deleted: false,
      inventoryComplete: true,
    });
    expect(result.source.refs).toHaveLength(1);
    expect(JSON.stringify(result.source)).not.toContain('private/v1/tenants');
  }
  expect(await read(athlete, stored.item.id, 1)).toEqual(result);
});
it('observes original+preview pending then DB-worker completed without claiming external deletion', async () => {
  const athlete = await tenant(),
    stored = await deleted(athlete, true);
  const pending = await read(athlete, stored.item.id, stored.revision);
  expect(pending.status).toBe('available');
  if (pending.status === 'available') {
    expect(pending.source.state).toBe('pending');
    expect(pending.source.refs).toHaveLength(2);
  }
  // Synthetic worker completion STUB: no object-store delete call or bytes exist.
  // This isolated DB has only these two due queue refs at this point; never parks
  // unrelated queue entries or alters another process/tenant's schedule.
  for (let i = 0; i < 2; i++) {
    const lease = await worker.lease(new Date(), new Date(Date.now() + 30000));
    if (!lease) throw Error('missing synthetic cleanup lease');
    expect(stored.refs).toContain(lease.storageRef);
    const authorized = await worker.authorize(lease, new Date());
    if (!authorized) throw Error('synthetic cleanup not authorized');
    expect(await worker.finish(authorized, { ok: true }, new Date())).toBe(true);
  }
  const completed = await read(athlete, stored.item.id, stored.revision);
  expect(completed.status).toBe('available');
  if (completed.status === 'available') {
    expect(completed.source).toMatchObject({
      state: 'completed',
      inventoryComplete: true,
      authority: 'db_cleanup_status_only',
    });
    expect(
      completed.source.refs.every(
        (ref) => ref.state === 'completed' && ref.reason === 'resource_deleted',
      ),
    ).toBe(true);
  }
  expect(completed).not.toEqual(pending);
});
it('denies private queue SELECT/DML and table-owner caller even with a tenant GUC', async () => {
  const athlete = await tenant(),
    stored = await image(athlete);
  await expect(
    db.tenant(athlete, (tx) => tx.query('SELECT id FROM public.resource_object_cleanup LIMIT 1')),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    db.tenant(athlete, (tx) =>
      tx.query("UPDATE public.resource_object_cleanup SET reason='resource_deleted' WHERE false"),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await owner.query('BEGIN');
  try {
    await owner.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await expect(
      owner.query('SELECT * FROM public.read_race_media_cleanup($1,1)', [stored.item.id]),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await owner.query('ROLLBACK');
  }
});
it('returns unavailable for foreign, missing and stale revision without borrowing a latest head', async () => {
  const athlete = await tenant(),
    foreign = await tenant(),
    stored = await image(athlete);
  for (const [who, id, revision] of [
    [foreign, stored.item.id, 1],
    [athlete, randomUUID(), 1],
    [athlete, stored.item.id, 2],
  ] as const) {
    const result = await read(who, id, revision);
    expect(result.status).toBe('available');
    if (result.status === 'available')
      expect(result.source).toMatchObject({ state: 'unavailable', inventoryComplete: false });
  }
});
it('treats a deleted missing/pruned queue tuple as unavailable, never completed', async () => {
  const athlete = await tenant(),
    stored = await deleted(athlete);
  await owner.query('DELETE FROM public.resource_object_cleanup WHERE storage_ref=$1', [
    stored.storageRef,
  ]);
  const result = await read(athlete, stored.item.id, stored.revision);
  expect(result.status).toBe('available');
  if (result.status === 'available')
    expect(result.source).toMatchObject({
      state: 'unavailable',
      reason: 'QUEUE_TUPLE_UNAVAILABLE',
      inventoryComplete: false,
    });
});
it('rejects mismatched queue reason and REFERENCE_PRESENT worker status', async () => {
  for (const patch of ['reason', 'reference'] as const) {
    const athlete = await tenant(),
      stored = await deleted(athlete);
    if (patch === 'reason')
      await owner.query(
        "UPDATE public.resource_object_cleanup SET reason='upload_abandoned' WHERE storage_ref=$1",
        [stored.storageRef],
      );
    else
      await owner.query(
        "UPDATE public.resource_object_cleanup SET last_error_code='REFERENCE_PRESENT' WHERE storage_ref=$1",
        [stored.storageRef],
      );
    const result = await read(athlete, stored.item.id, stored.revision);
    expect(result.status).toBe('available');
    if (result.status === 'available')
      expect(result.source).toMatchObject({
        state: 'unavailable',
        inventoryComplete: false,
        reason: patch === 'reason' ? 'QUEUE_TUPLE_UNAVAILABLE' : 'REFERENCE_PRESENT',
      });
  }
});
it('does not claim full inventory when an unfinished public preview upload exists', async () => {
  const athlete = await tenant(),
    stored = await image(athlete);
  await stored.gallery.reservePreview(
    athlete,
    stored.item.id,
    { expectedAccessRevision: 1 },
    `unfinished-${randomUUID()}`,
  );
  const result = await read(athlete, stored.item.id, 1);
  expect(result.status).toBe('available');
  if (result.status === 'available')
    expect(result.source).toMatchObject({
      state: 'unavailable',
      inventoryComplete: false,
      reason: 'INVENTORY_UNAVAILABLE',
    });
});
it('rejects an unaccounted historical object in the exact media namespace', async () => {
  const athlete = await tenant(),
    stored = await image(athlete),
    unknown = `private/v1/tenants/${athlete}/gallery/${stored.item.id}/legacy/raw-v0.png`;
  await owner.query('BEGIN');
  try {
    await owner.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await owner.query(
      "INSERT INTO public.gallery_media_object(athlete_id,storage_ref,content_hash,size_bytes,media_type,created_at) VALUES($1,$2,$3,2,'image/png',clock_timestamp())",
      [athlete, unknown, 'c'.repeat(64)],
    );
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
  const result = await read(athlete, stored.item.id, 1);
  expect(result.status).toBe('available');
  if (result.status === 'available')
    expect(result.source).toMatchObject({
      state: 'unavailable',
      inventoryComplete: false,
      reason: 'INVENTORY_UNAVAILABLE',
    });
});
it('preserves caller/fence failures as actual transaction rollback', async () => {
  const athlete = await tenant(),
    stored = await image(athlete),
    raw = new Pool({ connectionString: url(runtimeRole), max: 1 });
  try {
    await raw.query('BEGIN');
    await raw.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await expect(
      raw.query('SELECT * FROM public.read_race_media_cleanup($1,1)', [stored.item.id]),
    ).rejects.toThrow();
    await raw.query('ROLLBACK');
  } finally {
    await raw.end();
  }
  expect((await read(athlete, stored.item.id, 1)).status).toBe('available');
});

it('matches the actual consumed-media capture cleanup source and reserves bounded budget', async () => {
  const athlete = await tenant(),
    stored = await image(athlete);
  const direct = await read(athlete, stored.item.id, 1);
  if (direct.status !== 'available') throw Error('reader unavailable');
  await db.tenant(athlete, async (tx) => {
    const budget = { bytes: 0n, sources: 0 };
    const manifest = await captureActivityAndMediaPermissions(tx, [stored.item.id], budget);
    const media = manifest.media.find((row) => row.requestedId === stored.item.id);
    expect(media?.cleanup).toEqual(direct.source);
    expect(budget.bytes).toBeGreaterThanOrEqual(16384n);
    expect(budget.bytes).toBeLessThanOrEqual(4194304n);
    expect(budget.sources).toBeGreaterThanOrEqual(1);
  });
});
it('observes INT_MAX expected read revision as stale rather than rejected write input', async () => {
  const athlete = await tenant(),
    stored = await image(athlete);
  const result = await read(athlete, stored.item.id, 2147483647);
  expect(result.status).toBe('available');
  if (result.status === 'available')
    expect(result.source).toMatchObject({
      state: 'unavailable',
      reason: 'ACCESS_REVISION_STALE',
      observedAccessRevision: 1,
    });
});
