import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { raceResultSchema } from '@workout/contracts/races';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  grantCorePlanning,
  grantRaces,
  grantOperations,
  grantGalleryMedia,
  grantResources,
} from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceResultV2Repository } from '../src/race-result-v2.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createResourceFileUploadRepository } from '../src/resource-file-uploads.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Actual acceptance preparation only: public107 + explicit108/109/110 staging.
// Root executes DB acceptance; no normal registry/archive readiness is claimed.
// Image/PDF metadata finalization is not actual uploaded-byte verification.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `legacy_read_${suffix}`,
  ownerRole = `legacy_read_owner_${suffix}`,
  runtimeRole = `legacy_read_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl }),
  createdRoles: string[] = [];
let created = false,
  db: Database;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${name}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole));
  const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    const state = await owner.query('SELECT max(version)::int AS version FROM schema_migrations');
    if (state.rows[0]?.['version'] !== 107) throw Error('LEGACY_READ_EXPECTED_PUBLIC_107');
    for (const file of [
      '108_nutrition_race_disconnection.sql',
      '109_race_result_proof_lifecycle.sql',
      '110_nutrition_disconnection_lineage.sql',
    ])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  } finally {
    await owner.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantRaces,
    grantOperations,
    grantGalleryMedia,
    grantResources,
  ])
    await grant(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
const values = {
  kind: 'race-result' as const,
  raceEventId: null,
  localDate: '2026-10-07',
  timezone: 'UTC',
  source: { kind: 'manual' as const },
  chipSeconds: 0,
  gunSeconds: null,
  officialDistanceMeters: null,
  deviceDistanceMeters: null,
  linkedActivityId: null,
  weatherNote: null,
  proofs: { link: 'https://example.test/result', attachments: [] },
};
async function app(athlete: string, granted: boolean) {
  const consent = createConsentRepository(db);
  const current = await consent.getConsent(athlete, 'app');
  await consent.setConsent(athlete, {
    kind: 'app',
    granted,
    expectedRevision: current?.revision ?? 0,
    idempotencyKey: randomUUID(),
  });
}
async function counts(athlete: string) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT (SELECT count(*) FROM race_result WHERE athlete_id=$1)::int AS heads,(SELECT count(*) FROM race_result_revision WHERE athlete_id=$1)::int AS history,(SELECT count(*) FROM race_command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1 AND topic='race.race-result_changed')::int AS outbox`,
          [athlete],
        )
      ).rows,
  );
}
async function sources(athlete: string) {
  const gallery = createGalleryMediaRepository(db),
    hash = 'a'.repeat(64);
  const image = await gallery.reserveCreate(
    athlete,
    {
      mediaKind: 'image',
      album: null,
      caption: null,
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    randomUUID(),
  );
  await gallery.prepareObject(athlete, image.uploadId, {
    storageRef: `private/v1/tenants/${athlete}/gallery/${image.mediaItemId}/objects/uploads/${image.uploadId}/sha256/${hash}.png`,
    file: {
      originalFileName: 'synthetic.png',
      mediaType: 'image/png',
      byteSize: 100,
      sha256: hash,
    },
  });
  await gallery.markStaged(athlete, image.uploadId);
  const imageDone = await gallery.finalize(athlete, image.uploadId);
  if (imageDone.status !== 'available') throw Error('image unavailable');
  const uploads = createResourceFileUploadRepository(db);
  const pdf = await uploads.reserveCreate(
    athlete,
    {
      sourceKind: 'file',
      title: 'Synthetic proof',
      category: 'race_material',
      metadata: {},
      tags: [],
      favorite: false,
    },
    randomUUID(),
  );
  await uploads.prepareObject(athlete, pdf.uploadId, {
    storageRef: `private/v1/tenants/${athlete}/resources/${pdf.resourceId}/objects/uploads/${pdf.uploadId}/sha256/${hash}.pdf`,
    file: {
      originalFileName: 'synthetic.pdf',
      extension: 'pdf',
      mediaType: 'application/pdf',
      byteSize: 100,
      sha256: hash,
    },
  });
  await uploads.markStaged(athlete, pdf.uploadId);
  const pdfDone = await uploads.finalize(athlete, pdf.uploadId);
  if (pdfDone.status !== 'available') throw Error('PDF unavailable');
  return [
    {
      kind: 'gallery-image' as const,
      mediaItemId: imageDone.item.id,
      expectedAccessRevision: imageDone.item.accessRevision,
    },
    {
      kind: 'resource-pdf' as const,
      resourceId: pdfDone.resource.id,
      versionId: pdfDone.version.id,
      expectedAccessRevision: pdfDone.resource.accessRevision,
    },
  ];
}
async function stored(athlete: string) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT id,revision,values_json FROM race_result WHERE athlete_id=$1 ORDER BY id`,
          [athlete],
        )
      ).rows,
  );
}
it('old public get/list preserve mixed V1/V2 actuals and storage bytes without attachment or certification leakage', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const legacy = createRaceRepository(db),
    modern = createRaceResultV2Repository(db);
  const { proofs: _proofs, ...v1Values } = values;
  const original = await legacy.createRaceResult(athlete, {
    idempotencyKey: randomUUID(),
    values: v1Values,
  });
  const attachments = await sources(athlete);
  const source = {
    kind: 'official' as const,
    authority: 'Synthetic reported source',
    resultUrl: 'https://example.test/result',
  };
  const result = await modern.create(athlete, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, source, proofs: { ...values.proofs, attachments } },
  });
  const before = await stored(athlete),
    artifacts = await counts(athlete);
  expect(await legacy.getRaceResult(athlete, original.id)).toEqual({ ...v1Values, ...original });
  expect(await legacy.getRaceResult(athlete, result.id)).toEqual({
    ...v1Values,
    source: { ...source, verifiedAt: null },
    ...result,
  });
  const page = await legacy.listRaceResults(athlete);
  expect(page.schemaVersion).toBe(1);
  expect(page.items).toHaveLength(2);
  expect(page.items.find((item) => item.id === result.id)).toEqual(
    await legacy.getRaceResult(athlete, result.id),
  );
  for (const forbidden of ['proofs', 'accessRevision', 'sha256', 'contentHash', 'byteSize'])
    expect(JSON.stringify(page)).not.toContain(forbidden);
  expect(await stored(athlete)).toEqual(before);
  expect(await counts(athlete)).toEqual(artifacts);
  expect(before.find((row) => row['id'] === result.id)?.['values_json']).toMatchObject({
    schemaVersion: 2,
    proofs: { attachments: [{ kind: 'gallery-image' }, { kind: 'resource-pdf' }] },
  });
});
it('old reads after actual image/PDF removal retain actuals and reject stale privacy cursors without resurrecting metadata', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const modern = createRaceResultV2Repository(db),
    legacy = createRaceRepository(db),
    attachments = await sources(athlete);
  const command = {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, proofs: { ...values.proofs, attachments } },
  };
  const saved = await modern.create(athlete, command);
  await modern.create(athlete, { schemaVersion: 2, idempotencyKey: randomUUID(), values });
  const old = await legacy.getRaceResult(athlete, saved.id),
    first = await legacy.listRaceResults(athlete, { limit: 1 });
  expect(first.nextCursor).not.toBeNull();
  const image = attachments.find((ref) => ref.kind === 'gallery-image'),
    pdf = attachments.find((ref) => ref.kind === 'resource-pdf');
  if (!image || !pdf) throw Error('missing synthetic sources');
  await createGalleryMediaRepository(db).softDelete(athlete, image.mediaItemId, {
    expectedAccessRevision: image.expectedAccessRevision,
    idempotencyKey: randomUUID(),
  });
  await createPrivateTextResourceRepository(db).softDelete(athlete, pdf.resourceId, {
    expectedAccessRevision: pdf.expectedAccessRevision,
    expectedCurrentVersionId: pdf.versionId,
    idempotencyKey: randomUUID(),
  });
  await app(athlete, false);
  expect(await legacy.getRaceResult(athlete, saved.id)).toEqual(old);
  await expect(
    legacy.listRaceResults(athlete, { limit: 1, cursor: first.nextCursor }),
  ).rejects.toMatchObject({ code: 'RACE_CURSOR_STALE' });
  const before = await stored(athlete),
    artifacts = await counts(athlete);
  expect(await legacy.listRaceResults(athlete)).toMatchObject({
    schemaVersion: 1,
    items: expect.arrayContaining([old]),
  });
  expect(await modern.create(athlete, command)).toEqual(saved);
  expect(await stored(athlete)).toEqual(before);
  expect(await counts(athlete)).toEqual(artifacts);
  expect(await modern.read(athlete, { schemaVersion: 2, id: saved.id })).toMatchObject({
    proofs: { attachments: [{ status: 'unavailable' }, { status: 'unavailable' }] },
  });
});
it('actual event deletion unlinks V2 source while the old wire preserves independent manual result', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const legacy = createRaceRepository(db),
    modern = createRaceResultV2Repository(db);
  const event = await legacy.createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic planned event',
      localDate: '2026-10-07',
      localStartTime: null,
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard', class: '5k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: null,
      planVersionId: null,
    },
  });
  const saved = await modern.create(athlete, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, raceEventId: event.id },
  });
  await legacy.deleteRaceEvent(athlete, event.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: event.revision,
  });
  const read = await modern.read(athlete, { schemaVersion: 2, id: saved.id });
  if (!read || !('schemaVersion' in read)) throw Error('missing owned V2 result');
  const { schemaVersion: _version, proofs: _proofs, ...expected } = read;
  expect(await legacy.getRaceResult(athlete, saved.id)).toEqual(expected);
  expect(expected.raceEventId).toBeNull();
  expect(expected.chipSeconds).toBe(0);
  expect((await stored(athlete))[0]?.['values_json']).toMatchObject({
    schemaVersion: 2,
    raceEventId: null,
  });
});
it('populated foreign rows stay invisible and cursor kind/limit remain strict', async () => {
  const alice = randomUUID(),
    bob = randomUUID();
  await app(alice, true);
  const modern = createRaceResultV2Repository(db),
    legacy = createRaceRepository(db);
  const saved = await modern.create(alice, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values,
  });
  expect(await legacy.getRaceResult(bob, saved.id)).toBeNull();
  expect((await legacy.listRaceResults(bob)).items).toEqual([]);
  await expect(legacy.listRaceResults(alice, { limit: 101 })).rejects.toThrow();
  await expect(
    legacy.listRaceResults(alice, {
      cursor: {
        kind: 'race-event',
        afterId: saved.id,
        collection: { revision: 1, privacyGeneration: '0' },
      },
    }),
  ).rejects.toMatchObject({ code: 'RACE_CURSOR_KIND_MISMATCH' });
});
// Plain-owner offline metadata fixtures are distinct from normal public producers.
// No guard is disabled; original head/history/FORCE RLS checks execute.
async function ownerFixture<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query('SELECT pg_advisory_xact_lock_shared(77206,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
}
it('actual DB byte limit rejects oversized owner fixture with no stored row', async () => {
  const athlete = randomUUID(),
    id = randomUUID();
  const { proofs: _proofs, ...legacyValues } = values;
  await expect(
    ownerFixture(athlete, (client) =>
      client.query(
        'INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())',
        [athlete, id, JSON.stringify({ ...legacyValues, weatherNote: 'x'.repeat(17000) })],
      ),
    ),
  ).rejects.toMatchObject({ code: '23514' });
  expect(await stored(athlete)).toEqual([]);
  expect(await createRaceRepository(db).getRaceResult(athlete, id)).toBeNull();
});
it('schema-valid historical V1 body at DB byte cap remains readable with finite identity overhead', async () => {
  const athlete = randomUUID(),
    id = randomUUID();
  const { proofs: _proofs, ...legacyValues } = values;
  const source = {
    kind: 'official' as const,
    authority: 'Synthetic offline historical stamp',
    resultUrl: 'https://example.test/historical-result',
    verifiedAt: '2026-10-07T00:00:00.0Z',
  };
  const saved = await ownerFixture(athlete, async (client) => {
    const first = await client.query('SELECT octet_length($1::jsonb::text)::int AS bytes', [
      JSON.stringify({ ...legacyValues, source }),
    ]);
    const baseline = z
      .strictObject({ bytes: z.number().int().positive().max(16384) })
      .parse(first.rows[0]);
    const body = {
      ...legacyValues,
      source: {
        ...source,
        verifiedAt: '2026-10-07T00:00:00.' + '0'.repeat(16384 - baseline.bytes + 1) + 'Z',
      },
    };
    // Valid long precision is preserved by instantSchema, not fabricated by the
    // normal runtime (SQL107 only permits this plain-owner historical stamp).
    const expected = raceResultSchema.parse({ ...body, id, revision: 1 });
    const bounded = await client.query('SELECT octet_length($1::jsonb::text)::int AS bytes', [
      JSON.stringify(body),
    ]);
    expect(bounded.rows).toEqual([{ bytes: 16384 }]);
    await client.query(
      'INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())',
      [athlete, id, JSON.stringify(body)],
    );
    await client.query(
      'INSERT INTO race_result_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,1,$3::jsonb,now())',
      [athlete, id, JSON.stringify(body)],
    );
    await client.query(
      "INSERT INTO race_collection_head(athlete_id,kind,revision) VALUES($1,'race-result',1)",
      [athlete],
    );
    return expected;
  });
  const before = await stored(athlete),
    artifacts = await counts(athlete);
  const observed: string[] = [];
  const recording: Database = {
    async tenant(who, operation) {
      return db.tenant(who, (tx) =>
        operation({
          athleteId: tx.athleteId,
          query: async (sql, args) => {
            observed.push(sql);
            return tx.query(sql, args);
          },
        }),
      );
    },
    async exclusiveTenant(who, operation) {
      return db.exclusiveTenant(who, operation);
    },
    async close() {},
  };
  const legacy = createRaceRepository(recording);
  expect(await legacy.getRaceResult(athlete, id)).toEqual(saved);
  expect((await legacy.listRaceResults(athlete)).items).toEqual([saved]);
  const preflight = observed.findIndex((sql) => sql.includes('sum(n)'));
  const fetch = observed.findIndex((sql) => sql.includes('SELECT id,revision,values_json'));
  expect(preflight).toBeGreaterThanOrEqual(0);
  expect(fetch).toBeGreaterThan(preflight);
  expect(await stored(athlete)).toEqual(before);
  expect(await counts(athlete)).toEqual(artifacts);
});
