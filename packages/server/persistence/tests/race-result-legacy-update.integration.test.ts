import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { raceResultProofStorageLifecycleSchema } from '@workout/contracts/race-result-v2';
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
// Actual acceptance preparation only: public107 + explicit108/109/110/111 staging.
// Root executes DB acceptance; no normal registry/archive readiness is claimed.
// Image/PDF metadata finalization is not actual uploaded-byte verification.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `legacy_update_${suffix}`,
  ownerRole = `legacy_update_owner_${suffix}`,
  runtimeRole = `legacy_update_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl }),
  createdRoles: string[] = [];
let guardBefore: Record<string, unknown> | undefined,
  guardAfter: Record<string, unknown> | undefined;
const guardCatalog = `SELECT p.oid::text AS oid,p.proowner::text AS owner,p.prosecdef,p.proconfig,p.proacl::text AS acl,
 r.rolsuper,r.rolbypassrls,NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_revoked,
 (SELECT jsonb_agg(jsonb_build_object('table',c.relname,'function',t.tgfoid::text) ORDER BY c.relname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname IN ('race_result_proof_body','race_result_revision_proof_body')) AS triggers
 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.guard_race_result_proof_body()'::regprocedure`;
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
    if (state.rows[0]?.['version'] !== 107) throw Error('LEGACY_UPDATE_EXPECTED_PUBLIC_107');
    for (const file of [
      '108_nutrition_race_disconnection.sql',
      '109_race_result_proof_lifecycle.sql',
      '110_nutrition_disconnection_lineage.sql',
      '111_race_result_preserved_proof_updates.sql',
    ]) {
      if (file.startsWith('111_')) guardBefore = (await owner.query(guardCatalog)).rows[0];
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
      if (file.startsWith('111_')) guardAfter = (await owner.query(guardCatalog)).rows[0];
    }
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
async function head(athlete: string, id: string) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT revision,values_json FROM race_result WHERE athlete_id=$1 AND id=$2 AND NOT deleted',
          [athlete, id],
        )
      ).rows[0],
  );
}
const actualValues = () => {
  const { proofs: _proofs, ...actual } = values;
  return actual;
};
it('legacy PATCH preserves exact stored V2 available image/PDF proofs and atomically appends minimal artifacts', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const modern = createRaceResultV2Repository(db),
    legacy = createRaceRepository(db),
    attachments = await sources(athlete);
  const saved = await modern.create(athlete, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, proofs: { ...values.proofs, attachments } },
  });
  const before = await head(athlete, saved.id),
    previous = await counts(athlete);
  const source = {
    kind: 'official' as const,
    authority: 'Synthetic claim',
    resultUrl: 'https://example.test/result',
  };
  const nextValues = { ...actualValues(), source, chipSeconds: 1234, gunSeconds: 0 };
  const command = {
    idempotencyKey: randomUUID(),
    expectedRevision: saved.revision,
    values: nextValues,
  };
  const changed = await legacy.updateRaceResult(athlete, saved.id, command);
  expect(changed).toEqual({ id: saved.id, revision: 2 });
  const after = await head(athlete, saved.id);
  expect(after?.['values_json']).toMatchObject({
    schemaVersion: 2,
    source,
    chipSeconds: 1234,
    gunSeconds: 0,
  });
  const beforeBody = z.record(z.string(), z.unknown()).parse(before?.['values_json']),
    afterBody = z.record(z.string(), z.unknown()).parse(after?.['values_json']);
  expect(afterBody['proofs']).toEqual(beforeBody['proofs']);
  expect(afterBody['source']).not.toHaveProperty('verifiedAt');
  const history = await db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT revision,values_json FROM race_result_revision WHERE athlete_id=$1 AND entity_id=$2 ORDER BY revision',
          [athlete, saved.id],
        )
      ).rows,
  );
  expect(history).toHaveLength(2);
  expect(history[1]?.['values_json']).toEqual(afterBody);
  for (const row of history)
    expect(z.record(z.string(), z.unknown()).parse(row['values_json'])['proofs']).toEqual(
      beforeBody['proofs'],
    );
  // Plain owner only inspects the private deletion roster, not write authority.
  const inspector = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    await inspector.query('BEGIN');
    await inspector.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await inspector.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      athlete,
    ]);
    await inspector.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    await inspector.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const roster = await inspector.query(
      `SELECT result_revision,ordinal,source_kind,source_id::text,version_id::text,access_revision FROM race_result_proof_ref WHERE athlete_id=$1 AND result_id=$2 ORDER BY result_revision,ordinal`,
      [athlete, saved.id],
    );
    expect(roster.rows).toHaveLength(4);
    const first = roster.rows
      .filter((row) => row['result_revision'] === 1)
      .map(({ result_revision: _revision, ...ref }) => ref);
    const second = roster.rows
      .filter((row) => row['result_revision'] === 2)
      .map(({ result_revision: _revision, ...ref }) => ref);
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    await inspector.query('ROLLBACK');
  } finally {
    await inspector.end();
  }
  expect(await legacy.getRaceResult(athlete, saved.id)).toEqual({
    ...nextValues,
    source: { ...source, verifiedAt: null },
    ...changed,
  });
  expect(previous).toEqual([{ heads: 1, history: 1, receipts: 1, outbox: 1 }]);
  expect(await counts(athlete)).toEqual([{ heads: 1, history: 2, receipts: 2, outbox: 2 }]);
  await app(athlete, false);
  const snapshot = await head(athlete, saved.id),
    artifacts = await counts(athlete);
  expect(await legacy.updateRaceResult(athlete, saved.id, command)).toEqual(changed);
  expect(await head(athlete, saved.id)).toEqual(snapshot);
  expect(await counts(athlete)).toEqual(artifacts);
  await expect(
    legacy.updateRaceResult(athlete, saved.id, {
      ...command,
      idempotencyKey: randomUUID(),
      expectedRevision: changed.revision,
    }),
  ).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  await expect(
    legacy.updateRaceResult(athlete, saved.id, {
      ...command,
      values: { ...nextValues, chipSeconds: 999 },
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('source deletion before correction retains unavailable identities without descriptors or latest repinning', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const modern = createRaceResultV2Repository(db),
    legacy = createRaceRepository(db),
    attachments = await sources(athlete);
  const saved = await modern.create(athlete, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, proofs: { ...values.proofs, attachments } },
  });
  const image = attachments.find((ref) => ref.kind === 'gallery-image'),
    pdf = attachments.find((ref) => ref.kind === 'resource-pdf');
  if (!image || !pdf) throw Error('missing fixture proof');
  await createGalleryMediaRepository(db).softDelete(athlete, image.mediaItemId, {
    expectedAccessRevision: image.expectedAccessRevision,
    idempotencyKey: randomUUID(),
  });
  await createPrivateTextResourceRepository(db).softDelete(athlete, pdf.resourceId, {
    expectedAccessRevision: pdf.expectedAccessRevision,
    expectedCurrentVersionId: pdf.versionId,
    idempotencyKey: randomUUID(),
  });
  const before = await head(athlete, saved.id);
  const changed = await legacy.updateRaceResult(athlete, saved.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: saved.revision,
    values: { ...actualValues(), gunSeconds: 900 },
  });
  const prior = z.record(z.string(), z.unknown()).parse(before?.['values_json']),
    current = z
      .record(z.string(), z.unknown())
      .parse((await head(athlete, saved.id))?.['values_json']);
  expect(current['proofs']).toEqual(prior['proofs']);
  expect(JSON.stringify(current['proofs'])).not.toMatch(
    /sha256|contentHash|byteSize|mediaType|accessRevision/,
  );
  expect(await modern.read(athlete, { schemaVersion: 2, id: changed.id })).toMatchObject({
    gunSeconds: 900,
    proofs: { attachments: [{ status: 'unavailable' }, { status: 'unavailable' }] },
  });
});
it('correction before source deletion redacts both immutable histories and preserves actual fields', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const modern = createRaceResultV2Repository(db),
    legacy = createRaceRepository(db),
    attachments = await sources(athlete);
  const saved = await modern.create(athlete, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, proofs: { ...values.proofs, attachments } },
  });
  const changed = await legacy.updateRaceResult(athlete, saved.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { ...actualValues(), chipSeconds: 900 },
  });
  const image = attachments.find((ref) => ref.kind === 'gallery-image');
  if (!image) throw Error('missing image');
  await createGalleryMediaRepository(db).softDelete(athlete, image.mediaItemId, {
    expectedAccessRevision: image.expectedAccessRevision,
    idempotencyKey: randomUUID(),
  });
  const history = await db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT revision,values_json FROM race_result_revision WHERE athlete_id=$1 AND entity_id=$2 ORDER BY revision',
          [athlete, saved.id],
        )
      ).rows,
  );
  expect(history).toHaveLength(2);
  for (const row of history)
    expect(row['values_json']).toMatchObject({
      schemaVersion: 2,
      proofs: {
        attachments: [{ kind: 'gallery-image', status: 'unavailable' }, { kind: 'resource-pdf' }],
      },
    });
  expect(await legacy.getRaceResult(athlete, saved.id)).toMatchObject({
    ...changed,
    chipSeconds: 900,
  });
});
it('foreign head/new linked source and stale concurrent writers reject without partial artifacts', async () => {
  const alice = randomUUID(),
    bob = randomUUID();
  await app(alice, true);
  await app(bob, true);
  const modern = createRaceResultV2Repository(db),
    legacy = createRaceRepository(db);
  const saved = await modern.create(alice, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values,
  });
  await expect(
    legacy.updateRaceResult(bob, saved.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: actualValues(),
    }),
  ).rejects.toMatchObject({ code: 'RACE_NOT_FOUND' });
  expect(await counts(bob)).toEqual([{ heads: 0, history: 0, receipts: 0, outbox: 0 }]);
  const before = await counts(alice);
  await expect(
    legacy.updateRaceResult(alice, saved.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...actualValues(), linkedActivityId: randomUUID() },
    }),
  ).rejects.toMatchObject({ code: 'RACE_REFERENCE_UNAVAILABLE' });
  expect(await counts(alice)).toEqual(before);
  const results = await Promise.allSettled(
    [1, 2].map((chipSeconds) =>
      legacy.updateRaceResult(alice, saved.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        values: { ...actualValues(), chipSeconds },
      }),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status !== 'rejected') throw Error('expected concurrent conflict');
  expect(rejected.reason).toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await counts(alice)).toEqual([{ heads: 1, history: 2, receipts: 2, outbox: 2 }]);
});
it('prior V1 updates remain V1 and do not manufacture proof storage', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const legacy = createRaceRepository(db),
    actual = actualValues();
  const saved = await legacy.createRaceResult(athlete, {
    idempotencyKey: randomUUID(),
    values: actual,
  });
  const changed = await legacy.updateRaceResult(athlete, saved.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { ...actual, chipSeconds: 900 },
  });
  const body = (await head(athlete, saved.id))?.['values_json'];
  expect(body).not.toHaveProperty('schemaVersion');
  expect(body).not.toHaveProperty('proofs');
  expect(await legacy.getRaceResult(athlete, saved.id)).toEqual({
    ...actual,
    chipSeconds: 900,
    ...changed,
  });
});

it('successor SQL preserves guard OID/owner/ACL/trigger identity under a plain non-bypass owner', () => {
  expect(guardBefore).toBeDefined();
  expect(guardAfter).toEqual(guardBefore);
  expect(guardAfter).toMatchObject({
    prosecdef: true,
    rolsuper: false,
    rolbypassrls: false,
    public_revoked: true,
    proconfig: ['search_path=pg_catalog, pg_temp'],
  });
  expect(guardAfter?.['triggers']).toHaveLength(2);
});
it('raw caller downgrade/new unavailable/skiprevision/identity mutation deny and rollback all artifacts', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const modern = createRaceResultV2Repository(db),
    attachments = await sources(athlete);
  const saved = await modern.create(athlete, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, proofs: { ...values.proofs, attachments } },
  });
  const image = attachments.find((ref) => ref.kind === 'gallery-image');
  if (!image) throw Error('missing synthetic image');
  await createGalleryMediaRepository(db).softDelete(athlete, image.mediaItemId, {
    expectedAccessRevision: image.expectedAccessRevision,
    idempotencyKey: randomUUID(),
  });
  const before = await head(athlete, saved.id),
    artifacts = await counts(athlete);
  const rawBody = z.record(z.string(), z.unknown()).parse(before?.['values_json']);
  const previousProofs = raceResultProofStorageLifecycleSchema.parse(rawBody['proofs']);
  const changedOpaqueProofs = {
    ...previousProofs,
    attachments: previousProofs.attachments.map((ref) =>
      ref.kind === 'gallery-image' ? { ...ref, mediaItemId: randomUUID() } : ref,
    ),
  };
  const probes = [
    {
      sql: `UPDATE race_result SET values_json=$3::jsonb,revision=revision+1,updated_at=now() WHERE athlete_id=$1 AND id=$2`,
      payload: JSON.stringify({ ...rawBody, chipSeconds: 900, proofs: changedOpaqueProofs }),
      message: 'RACE_PROOF_REDACTION_AUTHORITY_REQUIRED',
    },
    {
      sql: `UPDATE race_result SET values_json=$3::jsonb,revision=revision+1,updated_at=now() WHERE athlete_id=$1 AND id=$2`,
      payload: JSON.stringify(actualValues()),
      message: 'RACE_PROOF_VERSION_DOWNGRADE',
    },
    {
      sql: `UPDATE race_result SET values_json=$3::jsonb,revision=revision+2,updated_at=now() WHERE athlete_id=$1 AND id=$2`,
      payload: JSON.stringify({ ...rawBody, chipSeconds: 900 }),
      message: 'RACE_PROOF_REDACTION_AUTHORITY_REQUIRED',
    },
    {
      sql: `UPDATE race_result SET values_json=$3::jsonb,revision=revision+1,recorded_at=recorded_at+interval '1 second',updated_at=now()+interval '2 seconds' WHERE athlete_id=$1 AND id=$2`,
      payload: JSON.stringify({ ...rawBody, chipSeconds: 900 }),
      message: 'RACE_PROOF_REDACTION_AUTHORITY_REQUIRED',
    },
    {
      sql: `INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())`,
      payload: JSON.stringify({
        ...values,
        proofs: {
          link: null,
          attachments: [
            { kind: 'gallery-image', mediaItemId: image.mediaItemId, status: 'unavailable' },
          ],
        },
        schemaVersion: 2,
      }),
      message: 'RACE_PROOF_REDACTION_AUTHORITY_REQUIRED',
      newId: randomUUID(),
    },
  ];
  for (const probe of probes) {
    await expect(
      db.tenant(athlete, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
        await tx.query(probe.sql, [
          athlete,
          'newId' in probe ? probe.newId : saved.id,
          probe.payload,
        ]);
      }),
    ).rejects.toMatchObject({ code: 'P0001', message: probe.message });
    expect(await head(athlete, saved.id)).toEqual(before);
    expect(await counts(athlete)).toEqual(artifacts);
  }
});
