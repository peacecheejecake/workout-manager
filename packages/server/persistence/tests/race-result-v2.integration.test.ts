import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
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
// Acceptance preparation only. Public107 followed by explicit108/109 staging is
// NOT a public registry or authenticated restore admission proof. No DB run yet.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `result_v2_${suffix}`,
  ownerRole = `result_v2_owner_${suffix}`,
  runtimeRole = `result_v2_app_${suffix}`;
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
    if (state.rows[0]?.['version'] !== 107) throw Error('RESULT_V2_EXPECTED_PUBLIC_107');
    for (const file of [
      '108_nutrition_race_disconnection.sql',
      '109_race_result_proof_lifecycle.sql',
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
it('public finalized image/PDF refs produce server descriptors and exact relational V2 read, no verified truth', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const attachments = await sources(athlete),
    repo = createRaceResultV2Repository(db);
  const saved = await repo.create(athlete, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, proofs: { ...values.proofs, attachments } },
  });
  const read = await repo.read(athlete, { schemaVersion: 2, id: saved.id });
  expect(read).toMatchObject({
    schemaVersion: 2,
    ...saved,
    chipSeconds: 0,
    gunSeconds: null,
    proofs: {
      attachments: [
        { kind: 'gallery-image', status: 'available' },
        { kind: 'resource-pdf', status: 'available' },
      ],
    },
  });
  expect(read?.source).not.toHaveProperty('verifiedAt');
  expect(await counts(athlete)).toEqual([{ heads: 1, history: 1, receipts: 1, outbox: 1 }]);
});
it('revoked successful replay is receipt-first; new writes denied with unchanged artifacts and retained read', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const repo = createRaceResultV2Repository(db),
    command = { schemaVersion: 2, idempotencyKey: randomUUID(), values };
  const saved = await repo.create(athlete, command);
  await app(athlete, false);
  const before = await counts(athlete);
  expect(await repo.create(athlete, command)).toEqual(saved);
  await expect(
    repo.create(athlete, { ...command, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  expect(await repo.read(athlete, { schemaVersion: 2, id: saved.id })).not.toBeNull();
  expect(await counts(athlete)).toEqual(before);
});
it('foreign refs/CAS/collision reject without partial history or receipt; populated foreign result stays hidden', async () => {
  const alice = randomUUID(),
    bob = randomUUID();
  await app(alice, true);
  await app(bob, true);
  const repo = createRaceResultV2Repository(db),
    attachments = await sources(alice);
  await expect(
    repo.create(bob, {
      schemaVersion: 2,
      idempotencyKey: randomUUID(),
      values: { ...values, proofs: { ...values.proofs, attachments } },
    }),
  ).rejects.toMatchObject({ code: 'PROOF_UNAVAILABLE' });
  expect(await counts(bob)).toEqual([{ heads: 0, history: 0, receipts: 0, outbox: 0 }]);
  const command = { schemaVersion: 2, idempotencyKey: randomUUID(), values };
  const saved = await repo.create(alice, command);
  expect(await repo.read(bob, { schemaVersion: 2, id: saved.id })).toBeNull();
  await expect(
    repo.update(bob, saved.id, {
      schemaVersion: 2,
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values,
    }),
  ).rejects.toMatchObject({ code: 'RACE_NOT_FOUND' });
  const before = await counts(alice);
  await expect(
    repo.update(alice, saved.id, {
      schemaVersion: 2,
      idempotencyKey: randomUUID(),
      expectedRevision: 2,
      values,
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(
    repo.create(alice, { ...command, values: { ...values, chipSeconds: 1 } }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(await counts(alice)).toEqual(before);
});
it('mixed V1/V2 collection retains original record codecs and stale mutation cursor fails closed', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const { proofs: _proofs, ...legacy } = values;
  await createRaceRepository(db).createRaceResult(athlete, {
    idempotencyKey: randomUUID(),
    values: legacy,
  });
  const repo = createRaceResultV2Repository(db);
  await repo.create(athlete, { schemaVersion: 2, idempotencyKey: randomUUID(), values });
  const page = await repo.list(athlete, { schemaVersion: 2, limit: 100, cursor: null });
  expect(page.items).toHaveLength(2);
  expect(page.items.filter((item) => 'schemaVersion' in item)).toHaveLength(1);
  const first = await repo.list(athlete, { schemaVersion: 2, limit: 1, cursor: null });
  expect(first.nextCursor).not.toBeNull();
  await repo.create(athlete, { schemaVersion: 2, idempotencyKey: randomUUID(), values });
  await expect(
    repo.list(athlete, { schemaVersion: 2, limit: 1, cursor: first.nextCursor }),
  ).rejects.toMatchObject({ code: 'RACE_CURSOR_STALE' });
});

it('actual source deletion removes current/history descriptors, invalidates privacy cursor and never resurrects via receipt', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const attachments = await sources(athlete),
    repo = createRaceResultV2Repository(db);
  const command = {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, proofs: { ...values.proofs, attachments } },
  };
  const saved = await repo.create(athlete, command);
  await repo.create(athlete, { schemaVersion: 2, idempotencyKey: randomUUID(), values });
  const first = await repo.list(athlete, { schemaVersion: 2, limit: 1, cursor: null });
  const image = attachments.find((ref) => ref.kind === 'gallery-image'),
    pdf = attachments.find((ref) => ref.kind === 'resource-pdf');
  if (!image || !pdf) throw Error('missing synthetic proofs');
  await createGalleryMediaRepository(db).softDelete(athlete, image.mediaItemId, {
    expectedAccessRevision: image.expectedAccessRevision,
    idempotencyKey: randomUUID(),
  });
  await createPrivateTextResourceRepository(db).softDelete(athlete, pdf.resourceId, {
    expectedAccessRevision: pdf.expectedAccessRevision,
    expectedCurrentVersionId: pdf.versionId,
    idempotencyKey: randomUUID(),
  });
  const read = await repo.read(athlete, { schemaVersion: 2, id: saved.id });
  expect(read).toMatchObject({
    chipSeconds: 0,
    gunSeconds: null,
    proofs: {
      attachments: [
        { kind: 'gallery-image', status: 'unavailable' },
        { kind: 'resource-pdf', status: 'unavailable' },
      ],
    },
  });
  const history = await db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT values_json FROM race_result_revision WHERE athlete_id=$1 AND entity_id=$2',
          [athlete, saved.id],
        )
      ).rows,
  );
  for (const row of history) {
    expect(JSON.stringify(row)).not.toContain('byteSize');
    expect(JSON.stringify(row)).not.toContain('sha256');
    expect(JSON.stringify(row)).not.toContain('contentHash');
    expect(JSON.stringify(row)).not.toContain('accessRevision');
  }
  await expect(
    repo.list(athlete, { schemaVersion: 2, limit: 1, cursor: first.nextCursor }),
  ).rejects.toMatchObject({ code: 'RACE_CURSOR_STALE' });
  const before = await counts(athlete);
  expect(await repo.create(athlete, command)).toEqual(saved);
  expect(await counts(athlete)).toEqual(before);
});
it('stale access, absent app and malformed byte envelope produce no writes', async () => {
  const athlete = randomUUID(),
    repo = createRaceResultV2Repository(db);
  await expect(
    repo.create(athlete, { schemaVersion: 2, idempotencyKey: randomUUID(), values }),
  ).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  await app(athlete, true);
  const attachments = await sources(athlete),
    before = await counts(athlete);
  await expect(
    repo.create(athlete, {
      schemaVersion: 2,
      idempotencyKey: randomUUID(),
      values: {
        ...values,
        proofs: {
          ...values.proofs,
          attachments: attachments.map((ref) => ({ ...ref, expectedAccessRevision: 2 })),
        },
      },
    }),
  ).rejects.toMatchObject({ code: 'STALE_PROOF_ACCESS' });
  await expect(
    repo.create(athlete, {
      schemaVersion: 2,
      idempotencyKey: randomUUID(),
      values: { ...values, weatherNote: 'x'.repeat(20000) },
    }),
  ).rejects.toThrow();
  expect(await counts(athlete)).toEqual(before);
});
it('successful own update versions head/history atomically; unlink and result deletion preserve independent image/PDF originals', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const attachments = await sources(athlete),
    repo = createRaceResultV2Repository(db);
  const saved = await repo.create(athlete, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, proofs: { ...values.proofs, attachments } },
  });
  const updated = await repo.update(athlete, saved.id, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { ...values, chipSeconds: 1 },
  });
  expect(updated).toEqual({ id: saved.id, revision: 2 });
  expect(await counts(athlete)).toEqual([{ heads: 1, history: 2, receipts: 2, outbox: 2 }]);
  await createRaceRepository(db).deleteRaceResult(athlete, saved.id, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  expect(await repo.read(athlete, { schemaVersion: 2, id: saved.id })).toBeNull();
  const image = attachments.find((ref) => ref.kind === 'gallery-image'),
    pdf = attachments.find((ref) => ref.kind === 'resource-pdf');
  if (!image || !pdf) throw Error('missing proofs');
  expect(await createGalleryMediaRepository(db).read(athlete, image.mediaItemId)).toMatchObject({
    status: 'available',
  });
  expect(
    await createResourceFileUploadRepository(db).resolveObject(athlete, pdf.resourceId),
  ).not.toBeNull();
});
