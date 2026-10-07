import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { accountExportV35Schema } from '@workout/contracts/operations';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import type { NutritionPlanDraft } from '@workout/contracts/nutrition-core';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  grantCorePlanning,
  grantNutritionCore,
  grantRaces,
  grantOperations,
  grantGalleryMedia,
  grantResources,
} from '../src/migrate.js';
import { createOperationsRepository, createOperationsV35Repository } from '../src/operations.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceResultV2Repository } from '../src/race-result-v2.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { createResourceFileUploadRepository } from '../src/resource-file-uploads.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createRestoreGenerationRepository } from '../src/restore-generation.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root executes this prepared file; no PG executed by the implementing agent.
// Public media staging validates DB metadata, not external file bytes or authenticity.
// Focused staging only: normal public107 plus explicit unregistered108/109/110.
// This does not prove registry installation, public API activation or restore admission.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `operations_v35_${suffix}`,
  ownerRole = `operations_v35_owner_${suffix}`,
  runtimeRole = `operations_v35_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
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
  await migrate(url(ownerRole), 107);
  const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    const state = await owner.query('SELECT max(version)::int AS version FROM schema_migrations');
    if (state.rows[0]?.['version'] !== 107) throw Error('EXPORT_V35_EXPECTED_PUBLIC_107');
    for (const file of [
      '108_nutrition_race_disconnection.sql',
      '109_race_result_proof_lifecycle.sql',
      '110_nutrition_disconnection_lineage.sql',
    ])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    await owner.query(
      `GRANT EXECUTE ON FUNCTION public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb), public.read_nutrition_disconnection_origin(uuid,uuid,text) TO "${runtimeRole}"`,
    );
  } finally {
    await owner.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantNutritionCore,
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
async function app(athlete: string, granted: boolean) {
  const repo = createConsentRepository(db);
  const current = await repo.getConsent(athlete, 'app');
  await repo.setConsent(athlete, {
    kind: 'app',
    granted,
    expectedRevision: current?.revision ?? 0,
    idempotencyKey: randomUUID(),
  });
}
const values: RaceEventValues = {
  title: 'Synthetic race',
  localDate: '2026-10-07',
  localStartTime: '09:00',
  timezone: 'UTC',
  locationName: null,
  distance: { kind: 'standard', class: '10k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: null,
  targetSeconds: null,
  planVersionId: null,
};
function draft(eventId: string, point: 'start' | 'end' = 'start'): NutritionPlanDraft {
  return {
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'UTC',
    purpose: 'Own meal schedule',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'meal',
        category: 'before',
        title: 'Meal',
        anchor: { kind: 'relative', entity: 'race', entityId: eventId, point, offsetMinutes: -30 },
        foods: [
          {
            foodVersionId: null,
            description: 'Retained food',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
        ],
        targets: [],
        instructions: 'User-approved meal action',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
}
function intent(eventId: string, revision = 1) {
  return {
    schemaVersion: 2 as const,
    command: {
      kind: 'create' as const,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
      draft: draft(eventId),
    },
    expectedRaceHeads: [{ namespace: 'race-event' as const, eventId, revision }],
  };
}
async function setup() {
  const athlete = randomUUID();
  const offline = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    await offline.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, randomUUID()],
    );
  } finally {
    await offline.end();
  }
  await app(athlete, true);
  const event = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values,
  });
  return { athlete, event, writer: createNutritionRacePlanWriter(db) };
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
function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw Error('MISSING_FIXTURE');
  return value;
}
function unknownNutrient<T extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: T) {
  return { value: null, unit, status: 'unknown' as const, evidenceIds: [] };
}
it('public V2 approval, race deletion V3 and explicit V4 writer export retained facts after app withdrawal, isolated from another tenant', async () => {
  const s = await setup(),
    ops = createOperationsV35Repository(db);
  const legacyDraft = draft(s.event.id);
  legacyDraft.items = legacyDraft.items.map((item) => ({
    ...item,
    anchor: { kind: 'absolute', date: '2026-10-07', localTime: '08:00', timezone: 'UTC' },
  }));
  const v1 = await createNutritionRepository(db).savePlan(s.athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: legacyDraft,
  });
  const v2 = await s.writer.savePlanV2(s.athlete, intent(s.event.id));
  const intake = await createNutritionRepository(db).createIntake(s.athlete, {
    idempotencyKey: randomUUID(),
    restoreGeneration: (await createRestoreGenerationRepository(db).read(s.athlete)).generationId,
    intakeId: randomUUID(),
    confirmed: true,
    occurredAt: '2026-10-06T00:00:00Z',
    timezone: 'UTC',
    foods: first(v2.items).foods,
    nutrientTotal: {
      energy: unknownNutrient('kcal'),
      carbohydrate: unknownNutrient('g'),
      protein: unknownNutrient('g'),
      fat: unknownNutrient('g'),
      fluid: unknownNutrient('mL'),
      sodium: unknownNutrient('mg'),
    },
    plannedItemId: 'meal',
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  });
  const before = await ops.exportAccount(s.athlete);
  expect(before.data.nutritionPlanVersions.map((row) => row.record_json)).toEqual(
    expect.arrayContaining([v1, v2]),
  );
  await createRaceRepository(db).deleteRaceEvent(s.athlete, s.event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const after = await ops.exportAccount(s.athlete);
  const redacted = nutritionPlanVersionCompatibleV4Schema.parse(
    after.data.nutritionPlanVersions.find((row) => row.version_id === v2.versionId)?.record_json,
  );
  expect(redacted).toMatchObject({
    schemaVersion: 3,
    versionId: v2.versionId,
    items: [{ anchor: { kind: 'disconnected', entity: 'race' }, foods: first(v2.items).foods }],
  });
  expect(JSON.stringify(redacted)).not.toContain(s.event.id);
  const { planVersionId, ...item } = first(redacted.items);
  void planVersionId;
  const { plan: v4 } = await createNutritionRacePlanV4Writer(db).savePlanV4(s.athlete, {
    schemaVersion: 4,
    intent: {
      schemaVersion: 3,
      command: {
        kind: 'update',
        planId: redacted.planId,
        expectedHeadVersionId: redacted.versionId,
        idempotencyKey: randomUUID(),
        confirmed: true,
        draft: {
          period: redacted.period,
          timezone: redacted.timezone,
          purpose: redacted.purpose,
          linkedTrainingPlanVersionId: redacted.linkedTrainingPlanVersionId,
          items: [{ ...item, instructions: 'Explicit retained meal edit' }],
        },
      },
      expectedRaceHeads: [],
      reconnectItemIds: [],
    },
  });
  const other = await setup();
  const foreign = await other.writer.savePlanV2(other.athlete, intent(other.event.id));
  await app(s.athlete, false);
  const exported = accountExportV35Schema.parse(await ops.exportAccount(s.athlete));
  expect(exported.schemaVersion).toBe(35);
  expect(exported.data.nutritionPlanVersions.map((row) => row.record_json)).toEqual(
    expect.arrayContaining([v1, redacted, v4]),
  );
  expect(exported.data.nutritionPlanHeads).toContainEqual({
    plan_id: v4.planId,
    version_id: v4.versionId,
    version: v4.version,
  });
  expect(
    exported.data.nutritionPlanHistory
      .filter((row) => row.plan_id === v4.planId)
      .map((row) => row.version_id),
  ).toEqual(expect.arrayContaining([redacted.versionId, v4.versionId]));
  expect(
    exported.data.intakeEntryRevisions.find((row) => row['intake_id'] === intake.intakeId)?.[
      'record_json'
    ],
  ).toEqual(intake);
  expect(JSON.stringify(exported)).not.toContain(foreign.planId);
  expect(exported.data.consents).toContainEqual({ kind: 'app', granted: false, revision: 2 });
  expect((await createOperationsRepository(db).exportAccount(s.athlete)).schemaVersion).toBe(34);
  for (const key of [
    'nutritionDisconnectionOrigins',
    'raceResultProofRefs',
    'commandReceipts',
    'restoreSuppressionEvents',
  ])
    expect(exported.data).not.toHaveProperty(key);
  for (const row of exported.data.nutritionPlanVersions)
    expect(Object.keys(row).sort()).toEqual(
      [
        'plan_id',
        'version_id',
        'version',
        'previous_version_id',
        'period_from',
        'period_to',
        'linked_training_plan_version_id',
        'approval_id',
        'approved_at',
        'record_json',
      ].sort(),
    );
});
it('normal image/PDF proof source deletion exports exact metadata-free V2 current and history without private proof roster', async () => {
  const s = await setup(),
    attachments = await sources(s.athlete),
    repo = createRaceResultV2Repository(db);
  const result = await repo.create(s.athlete, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    values: {
      kind: 'race-result',
      raceEventId: null,
      localDate: '2026-10-07',
      timezone: 'UTC',
      source: { kind: 'manual' },
      chipSeconds: 0,
      gunSeconds: null,
      officialDistanceMeters: 10000,
      deviceDistanceMeters: null,
      linkedActivityId: null,
      weatherNote: null,
      proofs: { link: 'https://example.test/result', attachments },
    },
  });
  const image = attachments.find((ref) => ref.kind === 'gallery-image'),
    pdf = attachments.find((ref) => ref.kind === 'resource-pdf');
  if (!image || !pdf) throw Error('MISSING_PROOFS');
  await createGalleryMediaRepository(db).softDelete(s.athlete, image.mediaItemId, {
    expectedAccessRevision: image.expectedAccessRevision,
    idempotencyKey: randomUUID(),
  });
  await createPrivateTextResourceRepository(db).softDelete(s.athlete, pdf.resourceId, {
    expectedAccessRevision: pdf.expectedAccessRevision,
    expectedCurrentVersionId: pdf.versionId,
    idempotencyKey: randomUUID(),
  });
  await app(s.athlete, false);
  const exported = await createOperationsV35Repository(db).exportAccount(s.athlete);
  const head = exported.data.raceResults.find((row) => row.id === result.id),
    history = exported.data.raceResultRevisions.filter((row) => row.entity_id === result.id);
  const proofs = {
    link: 'https://example.test/result',
    attachments: [
      { kind: 'gallery-image', mediaItemId: image.mediaItemId, status: 'unavailable' },
      {
        kind: 'resource-pdf',
        resourceId: pdf.resourceId,
        versionId: pdf.versionId,
        status: 'unavailable',
      },
    ],
  };
  expect(head).toMatchObject({
    id: result.id,
    revision: result.revision,
    deleted: false,
    values_json: { proofs, chipSeconds: 0, gunSeconds: null },
  });
  expect(history).toHaveLength(1);
  expect(first(history).values_json).toEqual(head?.values_json);
  for (const row of [head, ...history]) {
    const values = row?.values_json;
    expect(values).toMatchObject({ proofs });
    expect(JSON.stringify(values)).not.toMatch(
      /accessRevision|mediaType|byteSize|sha256|contentHash|verifiedAt|reviewer/,
    );
    expect(values).not.toHaveProperty('id');
    expect(values).not.toHaveProperty('revision');
  }
  expect(exported.data).not.toHaveProperty('raceResultProofRefs');
});
it('deleted race head exports NULL body with no manufactured deletion history and empty other tenant view', async () => {
  const s = await setup();
  const saved = await createRaceRepository(db).createRaceResult(s.athlete, {
    idempotencyKey: randomUUID(),
    values: {
      kind: 'race-result',
      raceEventId: null,
      localDate: '2026-10-07',
      timezone: 'UTC',
      source: { kind: 'manual' },
      chipSeconds: 0,
      gunSeconds: null,
      officialDistanceMeters: null,
      deviceDistanceMeters: null,
      linkedActivityId: null,
      weatherNote: null,
    },
  });
  await createRaceRepository(db).deleteRaceResult(s.athlete, saved.id, {
    expectedRevision: saved.revision,
    idempotencyKey: randomUUID(),
  });
  const exported = await createOperationsV35Repository(db).exportAccount(s.athlete);
  expect(exported.data.raceResults.find((row) => row.id === saved.id)).toMatchObject({
    deleted: true,
    values_json: null,
  });
  expect(exported.data.raceResultRevisions.filter((row) => row.entity_id === saved.id)).toEqual([]);
  const foreign = await createOperationsV35Repository(db).exportAccount(randomUUID());
  expect(foreign.data.raceResults).toEqual([]);
  expect(foreign.data.nutritionPlanVersions).toEqual([]);
});
