import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate, grantOperations, grantGalleryMedia, grantCorePlanning } from '../src/migrate.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { createConsentRepository } from '../src/repositories.js';
import { readRaceMediaCleanupSource } from '../src/race-media-cleanup-source.js';
import {
  captureMediaRetainedReadFacts,
  validateMediaRetainedReadFacts,
} from '../src/race-plan-impact-media-read-facts.js';
import { RaceImpactDependencyError } from '../src/race-plan-impact-dependencies.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// DB metadata acceptance only: no provider/object-store upload or deletion ran.
// Public107 plus explicit unregistered113; registry/retarget/fullprivacy is separate.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `media_read_sources_${suffix}`,
  ownerRole = `media_read_sources_owner_${suffix}`,
  runtimeRole = `media_read_sources_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 }),
  roles: string[] = [];
let without113: Awaited<ReturnType<typeof captureMediaRetainedReadFacts>>;
let db: Database,
  owner: Pool,
  created = false;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
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
  await grantOperations(url(ownerRole), runtimeRole);
  await grantCorePlanning(url(ownerRole), runtimeRole);
  await grantGalleryMedia(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 2 });
  const initialAthlete = await tenant();
  const initialMedia = await image(initialAthlete);
  without113 = (await capture(initialAthlete, [initialMedia.item.id])).result;
  await owner.query(
    await readFile(
      new URL('../migrations/113_race_media_cleanup_source.sql', import.meta.url),
      'utf8',
    ),
  );
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await owner.query(
    `GRANT EXECUTE ON FUNCTION public.read_race_media_cleanup(uuid,integer) TO "${runtimeRole}"`,
  );
  await grantOperations(url(ownerRole), runtimeRole);
  await grantGalleryMedia(url(ownerRole), runtimeRole);
  await grantCorePlanning(url(ownerRole), runtimeRole);
});
afterAll(async () => {
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
  // Named synthetic purpose grant; no implicit account admission or AI/media consent.
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
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

const budget = () => ({ sources: 0, bytes: 0n });
async function capture(athlete: string, ids: readonly string[], sourceBudget = budget()) {
  const queries: string[] = [];
  const result = await db.tenant(athlete, (tx) => {
    const traced: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        queries.push(sql);
        return tx.query(sql, values);
      },
    };
    return captureMediaRetainedReadFacts(traced, ids, sourceBudget);
  });
  return { result, queries };
}
it('preserves explicit SQL113-unavailable observations on normal107 without an aborted transaction', () => {
  expect(without113.facts[0]?.record).not.toBeNull();
  expect(without113.facts[0]?.cleanup).toMatchObject({ status: 'unavailable' });
  expect(validateMediaRetainedReadFacts(without113).status).toBe('blocked');
});
it('captures exact current public descriptor and immutable original ledger with complete absent cleanup', async () => {
  const athlete = await tenant(),
    stored = await image(athlete);
  const { result } = await capture(athlete, [stored.item.id]);
  expect(result).toMatchObject({
    authority: 'none',
    freshness: 'not_checked',
    sourceScope: 'db_recorded_descriptor_only',
  });
  expect(result.facts[0]).toMatchObject({
    requestedId: stored.item.id,
    state: 'owned',
    reason: null,
    record: stored.item,
    current: { mediaItemId: stored.item.id, accessRevision: 1, deleted: false },
    originalLedger: { sha256: stored.item.file.sha256, byteSize: 2, mediaType: 'image/png' },
    previewLedger: null,
    cleanup: { status: 'available', source: { state: 'absent', inventoryComplete: true } },
  });
  expect(validateMediaRetainedReadFacts(result).status).toBe('validated_read_sources');
  expect(JSON.stringify(result)).not.toContain(stored.storageRef);
  expect(JSON.stringify(result)).not.toContain('private/v1/tenants');
});
it('tracks public preview attachment and metadata revision without re-pinning original bytes', async () => {
  const athlete = await tenant(),
    stored = await image(athlete);
  await preview(athlete, stored.item.id, 1);
  const previewItem = await stored.gallery.read(athlete, stored.item.id);
  if (previewItem.status !== 'available') throw Error('Missing preview item');
  expect(previewItem.item.accessRevision).toBe(2);
  const updated = await stored.gallery.update(athlete, stored.item.id, {
    album: null,
    caption: 'Synthetic updated',
    activityId: null,
    expectedAccessRevision: 2,
    idempotencyKey: randomUUID(),
  });
  if (updated.status !== 'available') throw Error('Missing updated item');
  const { result } = await capture(athlete, [stored.item.id]);
  expect(result.facts[0]?.record).toEqual(updated.item);
  expect(result.facts[0]?.record?.file).toEqual(stored.item.file);
  expect(result.facts[0]?.previewLedger).toEqual({
    sha256: 'b'.repeat(64),
    byteSize: 2,
    mediaType: 'image/jpeg',
  });
  expect(result.facts[0]?.current?.accessRevision).toBe(3);
  expect(validateMediaRetainedReadFacts(result).status).toBe('validated_read_sources');
  expect(
    await db.tenant(athlete, (tx) =>
      readRaceMediaCleanupSource(tx, { mediaItemId: stored.item.id, expectedAccessRevision: 1 }),
    ),
  ).toMatchObject({
    status: 'available',
    source: { state: 'unavailable', reason: 'ACCESS_REVISION_STALE' },
  });
});
it('keeps populated foreign, missing and opaque IDs bodyless without manual ownership fallback', async () => {
  const athlete = await tenant(),
    foreign = await tenant(),
    stored = await image(foreign);
  const absent = randomUUID();
  const { result } = await capture(athlete, [stored.item.id, absent, 'opaque:unmapped']);
  expect(result.facts).toHaveLength(3);
  for (const fact of result.facts)
    expect(fact).toMatchObject({
      state: 'unavailable',
      reason: 'owned_media_unavailable',
      record: null,
      current: null,
      originalLedger: null,
      previewLedger: null,
      cleanup: null,
    });
  expect(await stored.gallery.read(athlete, stored.item.id)).toEqual({
    status: 'unavailable',
    mediaItemId: stored.item.id,
  });
  await db.tenant(athlete, async (tx) => {
    expect(
      (await tx.query('SELECT id FROM gallery_media_item WHERE id=$1', [stored.item.id])).rowCount,
    ).toBe(0);
  });
  expect(validateMediaRetainedReadFacts(result).status).toBe('blocked');
});
it('retains own descriptor reads after public app withdrawal with AI/media processing permission absent', async () => {
  const athlete = await tenant(),
    stored = await image(athlete);
  const previous = await capture(athlete, [stored.item.id]);
  const consent = createConsentRepository(db);
  expect(await consent.getConsent(athlete, 'ai')).toEqual({
    kind: 'ai',
    granted: false,
    revision: 0,
  });
  await consent.setConsent(athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const current = await capture(athlete, [stored.item.id]);
  expect(current.result).toEqual(previous.result);
  expect(current.result.facts[0]?.record?.includeForCoach).toBe(false);
  expect(validateMediaRetainedReadFacts(current.result).status).toBe('validated_read_sources');
});
it('observes public soft deletion as metadata-free tombstone and pending DB cleanup, not external deletion', async () => {
  const athlete = await tenant(),
    stored = await image(athlete);
  await preview(athlete, stored.item.id, 1);
  const command = { expectedAccessRevision: 2, idempotencyKey: randomUUID() };
  const removed = await stored.gallery.softDelete(athlete, stored.item.id, command);
  expect(await stored.gallery.softDelete(athlete, stored.item.id, command)).toEqual(removed);
  const { result } = await capture(athlete, [stored.item.id]);
  expect(result.facts[0]).toMatchObject({
    state: 'deleted',
    record: null,
    current: { accessRevision: removed.accessRevision, deleted: true },
    originalLedger: null,
    previewLedger: null,
    cleanup: { status: 'available', source: { state: 'pending', inventoryComplete: true } },
  });
  expect(JSON.stringify(result)).not.toContain('synthetic.png');
  expect(JSON.stringify(result)).not.toContain('Synthetic metadata');
  expect(validateMediaRetainedReadFacts(result).status).toBe('blocked');
  await expect(
    db.tenant(athlete, (tx) => tx.query('SELECT id FROM resource_object_cleanup LIMIT 1')),
  ).rejects.toMatchObject({ code: '42501' });
});
it('keeps own in-flight preview inventory unavailable without blocking unrelated media', async () => {
  const athlete = await tenant(),
    stored = await image(athlete),
    separate = await image(athlete);
  await stored.gallery.reservePreview(
    athlete,
    stored.item.id,
    { expectedAccessRevision: 1 },
    randomUUID(),
  );
  const affected = (await capture(athlete, [stored.item.id])).result;
  expect(validateMediaRetainedReadFacts(affected).status).toBe('blocked');
  expect(affected.facts[0]?.cleanup).toMatchObject({
    status: 'available',
    source: { state: 'unavailable', inventoryComplete: false },
  });
  const unrelated = (await capture(athlete, [separate.item.id])).result;
  expect(validateMediaRetainedReadFacts(unrelated).status).toBe('validated_read_sources');
});
it('bounds visited IDs and bytes before transporting media bodies, with case-normalized deduplication', async () => {
  const athlete = await tenant(),
    stored = await image(athlete),
    shared = budget();
  const dedup = await capture(athlete, [stored.item.id, stored.item.id.toUpperCase()], shared);
  expect(dedup.result.facts).toHaveLength(1);
  expect(shared.sources).toBeGreaterThanOrEqual(2);
  await expect(
    capture(
      athlete,
      Array.from({ length: 5001 }, () => stored.item.id),
    ),
  ).rejects.toBeInstanceOf(RaceImpactDependencyError);
  await expect(
    capture(athlete, [stored.item.id], { sources: 5000, bytes: 0n }),
  ).rejects.toBeInstanceOf(RaceImpactDependencyError);
  const queries: string[] = [];
  await expect(
    db.tenant(athlete, (tx) => {
      const traced: Transaction = {
        athleteId: tx.athleteId,
        query: async (sql, values) => {
          queries.push(sql);
          return tx.query(sql, values);
        },
      };
      return captureMediaRetainedReadFacts(traced, [stored.item.id], {
        sources: 0,
        bytes: 4194304n - 4096n,
      });
    }),
  ).rejects.toBeInstanceOf(RaceImpactDependencyError);
  expect(queries.some((sql) => sql.includes('octet_length'))).toBe(true);
  expect(queries.some((sql) => sql.includes(' AS record,'))).toBe(false);
});
