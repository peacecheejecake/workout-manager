import { readFile } from 'node:fs/promises';
import { courseContentDigest } from '@workout/server-courses/digest';
import { createCourseRepository, type PreparedCourseContent } from '../src/courses.js';
import { createActivityTrackRepository } from '../src/activity-tracks.js';
import { createActivityRepository } from '../src/activities.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';

import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository } from '../src/races.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createConsentRepository } from '../src/repositories.js';

import { createRoutineRepository } from '../src/routine-core.js';
import { prepareRaceManualReviewCompatibleV4In } from '../src/race-manual-review-preparation-v2.js';
import { enumerateRaceManualReviewFullCopiedSourcesV2 } from '../src/race-manual-review-full-copied-inventory-v2.js';
import { captureRaceManualReviewFullOwnedSourceInventoryV2In } from '../src/race-manual-review-full-owned-source-inventory-v2.js';
import type { SourceBudget } from '../src/race-plan-impact-nested-sources.js';
import {
  migrate,
  grantCorePlanning,
  grantSupplementaryCore,
  grantActivityTracks,
  grantOperations,
  grantRaces,
  grantRoutineCore,
  grantRecoveryCore,
  grantCheckIns,
  grantCourses,
  grantNutritionCore,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Public normal107 producers, plain owner/runtime grants. Root alone executes PG.
// Pure mapping neither authenticates sources nor closes storage/lifecycle/approval.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `channels_${suffix}`,
  ownerRole = `channels_owner_${suffix}`,
  runtimeRole = `channels_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
let created = false,
  db: Database;
let staged: Database,
  stagedCreated = false;
const stagedName = `channels_stage113_${suffix}`,
  stagedOwner = `channels_sowner_${suffix}`,
  stagedRuntime = `channels_sapp_${suffix}`;
function url(role: string, databaseName = name) {
  const u = new URL(adminUrl);
  u.pathname = `/${databaseName}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, stagedOwner, stagedRuntime]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole));
  const inspector = new Pool({ connectionString: url(ownerRole) });
  try {
    expect(
      (await inspector.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
  } finally {
    await inspector.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantSupplementaryCore,
    grantActivityTracks,
    grantOperations,
    grantRaces,
    grantRoutineCore,
    grantRecoveryCore,
    grantCheckIns,
    grantCourses,
    grantNutritionCore,
    grantResources,
    grantResourceRetrieval,
    grantGalleryMedia,
    grantGarminUnofficial,
  ])
    await grant(url(ownerRole), runtimeRole);
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    await owner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${runtimeRole}"`,
    );
  } finally {
    await owner.end();
  }
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  await admin.query(`CREATE DATABASE "${stagedName}" OWNER "${stagedOwner}"`);
  stagedCreated = true;
  await migrate(url(stagedOwner, stagedName), 107);
  const stageOwner = new Pool({ connectionString: url(stagedOwner, stagedName) });
  try {
    await stageOwner.query(
      await readFile(
        new URL('../migrations/113_race_media_cleanup_source.sql', import.meta.url),
        'utf8',
      ),
    );
    expect(
      (await stageOwner.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
    await stageOwner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${stagedRuntime}"`,
    );
  } finally {
    await stageOwner.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantSupplementaryCore,
    grantActivityTracks,
    grantOperations,
    grantRaces,
    grantRoutineCore,
    grantRecoveryCore,
    grantCheckIns,
    grantCourses,
    grantNutritionCore,
    grantResources,
    grantResourceRetrieval,
    grantGalleryMedia,
    grantGarminUnofficial,
  ])
    await grant(url(stagedOwner, stagedName), stagedRuntime);
  staged = createDatabase({ connectionString: url(stagedRuntime, stagedName), max: 4 });
});
afterAll(async () => {
  await db?.close();
  await staged?.close();
  if (stagedCreated) await dropIsolatedDatabase(admin, stagedName);
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function app(athlete: string, granted: boolean, target = db) {
  const repo = createConsentRepository(target),
    old = await repo.getConsent(athlete, 'app');
  return repo.setConsent(athlete, {
    kind: 'app',
    granted,
    expectedRevision: old?.revision ?? 0,
    idempotencyKey: randomUUID(),
  });
}
async function event(athlete: string, target = db) {
  // Identity FK prerequisite only; no health, source or approval owner insert.
  const owner = new Pool({
    connectionString: target === db ? url(ownerRole) : url(stagedOwner, stagedName),
  });
  try {
    await owner.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await owner.end();
  }
  await app(athlete, true, target);
  return createRaceRepository(target).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic scope race',
      localDate: '2026-10-06',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
  });
}
const draft = () =>
  planDraftSchema.parse({
    title: 'Synthetic plan',
    timezone: 'Asia/Seoul',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, array) => ({
      id: level,
      parentId: index === 0 ? null : array[index - 1],
      level,
      title: level,
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-10-06',
        localStartTime: null,
        title: 'Synthetic planned session',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });

function dereference(root: unknown, path: string): unknown {
  let value = root;
  for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (typeof value !== 'object' || value === null) throw Error('COPIED_LOCATION_UNAVAILABLE');
    value = z
      .record(z.string(), z.unknown())
      .parse(Array.isArray(value) ? Object.fromEntries(value.entries()) : value)[key];
  }
  if (value === undefined) throw Error('COPIED_LOCATION_UNAVAILABLE');
  return value;
}
async function prepared(athlete: string, id: string, revision = 1, target = db) {
  if (!target.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
  return target.snapshotTenant(athlete, async (tx) => {
    const artifacts = async () =>
      (
        await tx.query(
          'SELECT (SELECT count(*) FROM command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox',
          [athlete],
        )
      ).rows;
    const beforeArtifacts = await artifacts();
    expect((await tx.query('SHOW transaction_isolation')).rows[0]?.['transaction_isolation']).toBe(
      'repeatable read',
    );
    const sourceBudget: SourceBudget = { bytes: 0n, sources: 0 };
    const result = await prepareRaceManualReviewCompatibleV4In(
      tx,
      {
        expectedEvent: { id, revision },
        newLocalDate: '2026-10-08',
        selection: { kind: 'keep_plan' },
      },
      sourceBudget,
    );
    if (!('sourceInput' in result) || !('candidate' in result)) {
      // Finite preparation codes only: never include captured bodies, source IDs or GPS.
      const missingFacts = 'missingFacts' in result ? result.missingFacts : [];
      throw Error(
        `PREPARATION_BLOCKED ${JSON.stringify({
          status: result.status,
          stage: result.stage,
          reason: result.reason,
          missingFacts: {
            count: missingFacts.length,
            kinds: [...new Set(missingFacts.map((fact) => fact.kind))],
          },
        })}`,
      );
    }
    const envelope = {
      context: result.context,
      sourceInput: result.sourceInput,
      candidate: result.candidate,
    };
    const inventory = enumerateRaceManualReviewFullCopiedSourcesV2(envelope);

    expect(inventory).toMatchObject({
      sourceAuthentication: 'unverified',
      sqlRowDigest: 'not_captured',
      lifecycleAuthority: 'none',
      permissionAuthority: 'none',
      authority: 'none',
      freshness: 'not_checked',
      storage: 'not_persisted',
      approvalAllowed: false,
      admissionAllowed: false,
      candidateCoverage: { complete: false },
    });
    expect(inventory.candidateCoverage?.missing).toHaveLength(5);
    for (const ref of inventory.refs)
      for (const location of ref.copiedLocations)
        expect(impactDependencyDigest(dereference(envelope, location))).toBe(ref.dtoDigest);
    const captureBytes = sourceBudget.bytes,
      captureVisits = sourceBudget.sources;
    const owned = await captureRaceManualReviewFullOwnedSourceInventoryV2In(
      tx,
      inventory,
      envelope,
      sourceBudget,
    );
    expect(owned.facts.map((row) => row.identity)).toEqual(
      inventory.refs.map((row) => row.identity),
    );
    expect(owned).toMatchObject({
      authority: 'none',
      freshness: 'not_checked',
      sourceAuthentication: 'unverified',
      sqlRowDigest: 'not_captured',
      storage: 'not_persisted',
      admissionAllowed: false,
      approvalAllowed: false,
      coverage: { complete: false },
    });
    expect(sourceBudget.bytes).toBeGreaterThan(captureBytes);
    expect(sourceBudget.sources).toBeGreaterThan(captureVisits);
    for (const row of owned.facts)
      if (row.state === 'matched')
        expect(row.dtoDigest).toBe(
          inventory.refs.find(
            (ref) => impactDependencyDigest(ref.identity) === impactDependencyDigest(row.identity),
          )?.dtoDigest,
        );
    expect(await artifacts()).toEqual(beforeArtifacts);
    return { result, inventory, owned };
  });
}

function mapped(value: Awaited<ReturnType<typeof prepared>>) {
  expect(value.inventory.blockers).toEqual([]);
  expect(value.inventory.inventoryState).toBe('mapped');
  expect(value.inventory.allCopiedBodiesIndexed).toBe(true);
  expect(value.owned.status).toBe('observed_correspondence');
  expect(value.owned.facts.every((row) => row.state === 'matched')).toBe(true);
}
async function catalogFixture(athlete: string, target = db, mediaAssetIds: string[] = []) {
  const resources = createPrivateTextResourceRepository(target),
    catalog = createSupplementaryRepository(target),
    routines = createRoutineRepository(target);
  const resource = await resources.create(athlete, {
    sourceKind: 'text',
    title: 'Synthetic source',
    category: 'guide',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic plain text only.',
    idempotencyKey: randomUUID(),
  });
  if (resource.status !== 'available') throw Error('FIXTURE_RESOURCE_UNAVAILABLE');
  const exercise = await catalog.saveExercise(athlete, {
    definition: {
      schemaVersion: 2,
      exerciseId: randomUUID(),
      versionId: randomUUID(),
      name: 'Synthetic balance',
      family: 'balance_stability',
      equipment: ['bodyweight'],
      tags: [],
      countDefinitions: [],
      mediaAssetIds,
      resourceVersionIds: [resource.version.id],
      reviewState: 'unreviewed',
      description: 'User defined synthetic movement',
      safetyNotes: '',
      supportedMetrics: ['duration'],
      createdAt: '2026-01-01T00:00:00Z',
    },
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const versionId = randomUUID();
  const saved = await catalog.saveRoutine(athlete, {
    template: {
      schemaVersion: 2,
      routineId: randomUUID(),
      versionId,
      title: 'Synthetic workout template',
      purpose: 'User selected practice',
      requiredEquipment: ['bodyweight'],
      spec: {
        schemaVersion: 2,
        kind: 'supplementary',
        routineVersionId: versionId,
        blocks: [
          {
            id: 'block',
            mode: 'single',
            rounds: 1,
            sets: [
              {
                id: 'set',
                exerciseVersionId: exercise.definition.versionId,
                side: 'unspecified',
                count: null,
                durationSeconds: {
                  min: 30,
                  max: 30,
                  unit: 's',
                  basis: 'user_confirmed',
                  evidenceIds: [],
                },
                externalResistance: { kind: 'no_added_load' },
                restAfterSeconds: 0,
                tempo: null,
                effort: null,
              },
            ],
            restBetweenRoundsSeconds: null,
          },
        ],
      },
      createdAt: '2026-01-01T00:00:00Z',
    },
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic source blueprint',
    intent: 'Retained source read',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Named source',
        content: {
          kind: 'workout_template',
          ref: { id: saved.template.routineId, versionId: saved.template.versionId },
        },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-01-01T00:00:00Z',
  });
  const savedBlueprint = await routines.saveBlueprint(athlete, {
    blueprint,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });

  const training = await createPlanningRepository(target).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: {
      ...draft(),
      sessions: draft().sessions.map((session) => ({ ...session, sport: 'strength' })),
    },
    supplementaryLinks: [
      {
        plannedSessionId: 'session',
        content: { kind: 'embedded', spec: { ...saved.template.spec, routineVersionId: null } },
      },
    ],
  });
  const scheduleInput = {
    schedule: {
      schemaVersion: 4 as const,
      id: randomUUID(),
      versionId: randomUUID(),
      blueprint: {
        id: savedBlueprint.blueprint.routineId,
        versionId: savedBlueprint.blueprint.versionId,
      },
      window: {
        startDate: '2026-10-01',
        endDateExclusive: '2026-11-01',
        timezone: 'Asia/Seoul',
        maxOccurrences: 10,
      },
      rule: { kind: 'dates' as const, dates: ['2026-10-06'], localTime: '08:00' },
      state: 'draft' as const,
    },
    sourcePlanVersionId: training.id,
  };
  const schedulePreview = await routines.previewSchedule(athlete, scheduleInput);
  const approved = await routines.approveSchedule(athlete, {
    ...scheduleInput,
    previewDigest: schedulePreview.previewDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  return {
    resource,
    resources,
    exercise,
    saved,
    catalog,
    blueprint: savedBlueprint.blueprint,
    routines,
    approved,
  };
}
function key(athlete: string, media: string, upload: string, hash: string, extension: string) {
  return `private/v1/tenants/${athlete}/gallery/${media}/objects/uploads/${upload}/sha256/${hash}.${extension}`;
}
async function image(athlete: string, target = db) {
  const gallery = createGalleryMediaRepository(target),
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
async function preview(athlete: string, media: string, revision: number, target = db) {
  const gallery = createGalleryMediaRepository(target),
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

it('normal107 public workout template/exercise and retained resource text map exact old versions after new catalog heads', async () => {
  const athlete = randomUUID(),
    race = await event(athlete),
    f = await catalogFixture(athlete);
  const before = await prepared(athlete, race.id);
  mapped(before);
  expect(
    before.inventory.refs.find((r) => r.identity.kind === 'supplementary-session-copy'),
  ).toMatchObject({
    dtoDigest: impactDependencyDigest({ ...f.saved.template.spec, routineVersionId: null }),
  });
  expect(before.result.context.sourcePermissionManifest.resources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        current: expect.objectContaining({
          includeForCoach: false,
          reviewedState: 'unreviewed',
          aiAuthorized: false,
        }),
      }),
    ]),
  );
  for (const [kind, versionId] of [
    ['workout-template-version', f.saved.template.versionId],
    ['supplementary-exercise-version', f.exercise.definition.versionId],
    ['resource-text-version', f.resource.version.id],
  ])
    expect(
      before.inventory.refs.some(
        (r) =>
          r.identity.kind === kind &&
          'versionId' in r.identity &&
          r.identity.versionId === versionId,
      ),
    ).toBe(true);
  await f.catalog.saveExercise(athlete, {
    definition: { ...f.exercise.definition, versionId: randomUUID(), name: 'New current exercise' },
    expectedVersionId: f.exercise.definition.versionId,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const newVersion = randomUUID();
  await f.catalog.saveRoutine(athlete, {
    template: {
      ...f.saved.template,
      versionId: newVersion,
      title: 'New current template',
      spec: { ...f.saved.template.spec, routineVersionId: newVersion },
    },
    expectedVersionId: f.saved.template.versionId,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const historical = await prepared(athlete, race.id);
  mapped(historical);
  expect(
    historical.inventory.refs.find((r) => r.identity.kind === 'supplementary-exercise-version'),
  ).toMatchObject({ dtoDigest: impactDependencyDigest(f.exercise.definition) });
  expect(
    historical.inventory.refs.find((r) => r.identity.kind === 'workout-template-version'),
  ).toMatchObject({ dtoDigest: impactDependencyDigest(f.saved.template) });
  await f.resources.softDelete(athlete, f.resource.resource.id, {
    expectedAccessRevision: f.resource.resource.accessRevision,
    expectedCurrentVersionId: f.resource.version.id,
    idempotencyKey: randomUUID(),
  });
  const deleted = await prepared(athlete, race.id);
  expect(deleted.owned.status).toBe('observed_correspondence');
  expect(deleted.inventory.refs.some((r) => r.identity.kind === 'resource-text-version')).toBe(
    false,
  );
  expect(deleted.result.context.resourceReadFacts?.facts).toEqual(
    expect.arrayContaining([expect.objectContaining({ state: 'deleted', record: null })]),
  );
});
it('normal107 manual activity and intake actuals plus checklist and timer preserve exact source snapshots', async () => {
  const athlete = randomUUID(),
    race = await event(athlete),
    f = await catalogFixture(athlete),
    nutrition = createNutritionRepository(db);
  const plan = await nutrition.savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Synthetic',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'meal',
          category: 'meal',
          title: 'Meal',
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
          foods: [],
          targets: [],
          instructions: '합성 섭취를 기록한다',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  const generation = await db.tenant(athlete, async (tx) =>
    z
      .uuid()
      .parse((await tx.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id']),
  );
  const nutrient = <U extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: U) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: [],
  });
  const intake = await nutrition.createIntake(athlete, {
    idempotencyKey: randomUUID(),
    restoreGeneration: generation,
    intakeId: 'Intake-한글-A',
    confirmed: true,
    occurredAt: '2026-10-06T00:00:00Z',
    timezone: 'Asia/Seoul',
    foods: [
      {
        foodVersionId: null,
        description: 'Reported unknown',
        quantity: null,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
    ],
    nutrientTotal: {
      energy: nutrient('kcal'),
      carbohydrate: nutrient('g'),
      protein: nutrient('g'),
      fat: nutrient('g'),
      fluid: nutrient('mL'),
      sodium: nutrient('mg'),
    },
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  });
  const activities = createActivityRepository(db),
    actual = await activities.createManualActivity(athlete, {
      idempotencyKey: randomUUID(),
      confirmed: true,
      activity: {
        title: 'Manual',
        kind: 'running',
        startedAt: '2026-10-06T00:00:00Z',
        timezone: 'Asia/Seoul',
        durationSeconds: 0,
        durationKind: 'timer',
        distanceMeters: 0,
      },
      report: { sessionRpe: null, note: null, planLink: null },
    });
  const blueprint = routineBlueprintVersionSchema.parse({
    ...f.blueprint,
    routineId: randomUUID(),
    versionId: randomUUID(),
    steps: [
      ...f.blueprint.steps,
      {
        id: 'nutrition',
        title: 'Meal',
        content: {
          kind: 'nutrition_template',
          ref: { id: plan.planId, versionId: plan.versionId },
        },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
      {
        id: 'checklist',
        title: 'Report',
        content: { kind: 'checklist', prompt: 'Synthetic explicit report' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
  });
  await f.routines.saveBlueprint(athlete, {
    blueprint,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  // Explicit public approval: this positive covers a planned occurrence, not the
  // independent unplanned-run projection gap documented in the separate case.
  const scheduleInput = {
    schedule: {
      schemaVersion: 4 as const,
      id: randomUUID(),
      versionId: randomUUID(),
      blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
      window: {
        startDate: '2026-10-01',
        endDateExclusive: '2026-11-01',
        timezone: 'Asia/Seoul',
        maxOccurrences: 10,
      },
      rule: { kind: 'dates' as const, dates: ['2026-10-06'], localTime: '08:00' },
      state: 'draft' as const,
    },
    sourcePlanVersionId: null,
  };
  const schedulePreview = await f.routines.previewSchedule(athlete, scheduleInput);
  const approved = await f.routines.approveSchedule(athlete, {
    ...scheduleInput,
    previewDigest: schedulePreview.previewDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const occurrence = approved.occurrences[0];
  if (!occurrence) throw Error('PUBLIC_APPROVAL_OCCURRENCE_MISSING');
  let run = await f.routines.startRun(athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: occurrence.id,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  for (const [stepId, actualRefs] of [
    [
      'step',
      [
        {
          kind: 'activity',
          id: actual.activityId,
          revisionId: String(actual.revision),
          detailId: null,
          allocationId: null,
        },
      ],
    ],
    ['nutrition', [{ kind: 'intake', id: intake.intakeId, revisionId: intake.revisionId }]],
    ['checklist', []],
  ] as const)
    run = await f.routines.recordStep(athlete, {
      runId: run.run.id,
      stepId,
      state: 'performed',
      actualRefs: [...actualRefs],
      occurredAt: '2026-10-06T00:00:00Z',
      reason: null,
      expectedRevision: run.run.revision,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
  const timer = await f.routines.commandTimer(athlete, {
    runId: run.run.id,
    stepId: 'checklist',
    action: 'start',
    durationSeconds: 30,
    expectedRevision: null,
    idempotencyKey: randomUUID(),
  });
  const before = await prepared(athlete, race.id);
  mapped(before);
  for (const kind of [
    'manual-activity-source',
    'intake-revision',
    'checklist-confirmation',
    'routine-timer',
  ])
    expect(before.inventory.refs.some((r) => r.identity.kind === kind)).toBe(true);
  expect(
    before.inventory.refs.find((r) => r.identity.kind === 'routine-timer')?.identity,
  ).toMatchObject({ sourceId: run.run.id, revision: timer.revision });
  const originalIntakeRef = before.inventory.refs.find(
    (r) => r.identity.kind === 'intake-revision',
  );
  await nutrition.correctIntake(athlete, {
    idempotencyKey: randomUUID(),
    intakeId: intake.intakeId,
    expectedRevision: intake.revision,
    confirmed: true,
    occurredAt: intake.occurredAt,
    timezone: intake.timezone,
    foods: intake.foods,
    nutrientTotal: intake.nutrientTotal,
    plannedItemId: intake.plannedItemId,
    relatedSessionIds: intake.relatedSessionIds,
    relatedActivityIds: intake.relatedActivityIds,
    source: 'user',
    sourceRecordId: null,
    notes: 'Changed current note',
  });
  const changedActivity = await activities.updateOverlay(athlete, actual.activityId, {
    expectedRevision: actual.revision,
    idempotencyKey: randomUUID(),
    reason: 'Synthetic correction',
    title: 'Changed current activity',
  });
  const historical = await prepared(athlete, race.id);
  mapped(historical);
  expect(
    historical.inventory.refs.find((r) => r.identity.kind === 'intake-revision'),
  ).toMatchObject({
    identity: originalIntakeRef?.identity,
    dtoDigest: originalIntakeRef?.dtoDigest,
  });
  expect(
    historical.result.context.routineActualManifest.runs
      .flatMap((r) => r.actuals)
      .some((a) => a.fact.requested.kind === 'intake' && a.fact.state === 'historical'),
  ).toBe(true);
  await activities.deleteActivity(athlete, actual.activityId, {
    expectedRevision: changedActivity.revision,
  });

  await nutrition.deleteIntake(athlete, {
    idempotencyKey: randomUUID(),
    intakeId: intake.intakeId,
    expectedRevision: intake.revision + 1,
    confirmed: true,
    reason: 'user_requested',
  });
  const deleted = await prepared(athlete, race.id);
  expect(
    deleted.inventory.refs.some(
      (r) => r.identity.kind === 'manual-activity-source' || r.identity.kind === 'intake-revision',
    ),
  ).toBe(false);
  expect(
    deleted.inventory.diagnostics.some((d) => d.state === 'deleted' || d.state === 'unavailable'),
  ).toBe(true);
  expect(deleted.owned.status).toBe('observed_correspondence');
  expect(deleted.owned.facts.every((row) => row.state === 'matched')).toBe(true);
});
it('normal107 media cleanup port absence is explicit and raw113 staged descriptors retain preview/cleanup facts without binary proof', async () => {
  const athlete = randomUUID(),
    race = await event(athlete),
    stored = await image(athlete);
  await catalogFixture(athlete, db, [stored.item.id]);
  const normal = await prepared(athlete, race.id);
  expect(normal.result.context.mediaReadFacts?.facts[0]?.cleanup).toMatchObject({
    status: 'unavailable',
    reason: 'READ_CAPABILITY_UNAVAILABLE',
  });
  expect(normal.result.consumedScope.status).toBe('blocked');
  expect(normal.owned.status).toBe('blocked');
  expect(normal.owned.facts.filter((row) => row.state === 'unavailable')).toEqual([
    expect.objectContaining({
      identity: {
        kind: 'gallery-descriptor',
        sourceId: stored.item.id,
        accessRevision: stored.item.accessRevision,
      },
      reason: 'relation_membership_unavailable',
      dtoDigest: null,
    }),
  ]);
  const stagedAthlete = randomUUID(),
    stagedRace = await event(stagedAthlete, staged),
    stagedMedia = await image(stagedAthlete, staged);
  await preview(stagedAthlete, stagedMedia.item.id, 1, staged);
  await catalogFixture(stagedAthlete, staged, [stagedMedia.item.id]);
  const before = await prepared(stagedAthlete, stagedRace.id, 1, staged);
  mapped(before);
  expect(
    before.inventory.refs.some(
      (r) => r.identity.kind === 'gallery-descriptor' && r.representation === 'mutable_observation',
    ),
  ).toBe(true);
  await stagedMedia.gallery.softDelete(stagedAthlete, stagedMedia.item.id, {
    expectedAccessRevision: 2,
    idempotencyKey: randomUUID(),
  });
  const deleted = await prepared(stagedAthlete, stagedRace.id, 1, staged);
  expect(deleted.owned.status).toBe('blocked');
  expect(deleted.owned.facts.filter((row) => row.state === 'unavailable')).toEqual([
    expect.objectContaining({
      identity: { kind: 'gallery-descriptor', sourceId: stagedMedia.item.id, accessRevision: 3 },
      reason: 'source_deleted',
      dtoDigest: null,
    }),
  ]);
  expect(deleted.result.context.mediaReadFacts?.facts[0]).toMatchObject({
    state: 'deleted',
    record: null,
    originalLedger: null,
    previewLedger: null,
  });
  expect(deleted.result.context.mediaReadFacts?.facts).toEqual(
    expect.arrayContaining([expect.objectContaining({ state: 'deleted', record: null })]),
  );
});

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');
function finalRef(input: {
  athleteId: string;
  activityId: string;
  trackId: string;
  uploadId: string;
  artifactKind: 'raw' | 'normalized' | 'map_path';
  sha256: string;
  extension: 'fit' | 'gpx' | 'json';
}) {
  return `private/v1/tenants/${input.athleteId}/activities/${input.activityId}/tracks/${input.trackId}/${input.artifactKind}/uploads/${input.uploadId}/sha256/${input.sha256}.${input.extension}`;
}

/** Store one recording, as the API's upload lifecycle does. */
async function storeTrack(athleteId: string, activityId: string, expectedActivityRevision: number) {
  const tracks = createActivityTrackRepository(db);
  const reservation = await tracks.reserve(
    athleteId,
    activityId,
    { expectedActivityRevision, recordedTrackIndex: 0 },
    `track-${randomUUID()}`,
  );
  const shared = {
    athleteId,
    activityId,
    trackId: reservation.trackId,
    uploadId: reservation.uploadId,
  };
  const rawSha = hashOf(`raw-${reservation.uploadId}`);
  const normalizedSha = hashOf(`normalized-${reservation.uploadId}`);
  const mapPathSha = hashOf(`map-${reservation.uploadId}`);
  await tracks.prepareObjects(athleteId, reservation.uploadId, {
    raw: {
      storageRef: finalRef({ ...shared, artifactKind: 'raw', sha256: rawSha, extension: 'gpx' }),
      sizeBytes: 2048,
      sha256: rawSha,
      format: 'gpx',
      originalFileName: 'run.gpx',
    },
    normalized: {
      storageRef: finalRef({
        ...shared,
        artifactKind: 'normalized',
        sha256: normalizedSha,
        extension: 'json',
      }),
      sizeBytes: 4096,
      sha256: normalizedSha,
    },
    mapPath: {
      storageRef: finalRef({
        ...shared,
        artifactKind: 'map_path',
        sha256: mapPathSha,
        extension: 'json',
      }),
      sizeBytes: 1024,
      sha256: mapPathSha,
    },
    parse: {
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      recordedSourceKind: 'gpx-trk',
      correspondenceDigest: hashOf(`correspondence-${reservation.uploadId}`),
      sampleCount: 5,
      positionedSampleCount: 4,
      segmentCount: 1,
      segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
      distances: { deviceReportedMeters: 1000, recomputedFromPositionsMeters: 998 },
    },
  });
  await tracks.markStaged(athleteId, reservation.uploadId);
  await tracks.finalize(athleteId, reservation.uploadId);
  return { trackId: reservation.trackId, mapPathSha };
}

const coordinates: [number, number][] = [
  [126.9779, 37.5665],
  [126.9789, 37.5668],
  [126.9799, 37.5671],
];

function content(input: {
  activityId: string;
  trackId: string;
  name?: string;
  trackRevision?: number;
  mapPathSha?: string;
  endSampleId?: string;
  coordinates?: [number, number][];
}): PreparedCourseContent {
  const line = input.coordinates ?? coordinates;
  const [startPosition] = line;
  const endPosition = line[line.length - 1];
  if (startPosition === undefined || endPosition === undefined)
    throw new Error('a course needs at least two vertices');
  const generation = {
    kind: 'recorded-segment',
    activityId: input.activityId,
    trackId: input.trackId,
    trackRevision: input.trackRevision ?? 1,
    lineIndex: 0,
    segmentIndex: 0,
    startSampleId: '0:0',
    endSampleId: input.endSampleId ?? '0:2',
    vertexCount: line.length,
    mapPathContentSha256: input.mapPathSha ?? 'a'.repeat(64),
    simplificationVersion: 1,
    toleranceMeters: 2.5,
  } as const;
  const lineage = [
    {
      activityId: input.activityId,
      trackId: input.trackId,
      trackRevision: input.trackRevision ?? 1,
    },
  ];
  const name = input.name ?? 'Seoul loop';
  const result: PreparedCourseContent = {
    name,
    coordinates: line,
    waypoints: [
      { role: 'start', position: startPosition, name: null, sourceSampleId: '0:0', locked: false },
      {
        role: 'finish',
        position: endPosition,
        name: null,
        sourceSampleId: generation.endSampleId,
        locked: false,
      },
    ],
    generation,
    edit: { kind: 'created' },
    lineage,
    distanceMeters: 180.25,
    contentDigest: '',
  };
  return { ...result, contentDigest: courseContentDigest(result) };
}

it('normal107 course exact revision geometry and actual recorded lineage descriptors map without routing/provider truth', async () => {
  const athlete = randomUUID(),
    race = await event(athlete),
    activities = createActivityRepository(db),
    courses = createCourseRepository(db);
  const actual = await activities.createManualActivity(athlete, {
    idempotencyKey: randomUUID(),
    confirmed: true,
    activity: {
      title: 'Manual route',
      kind: 'running',
      startedAt: '2026-10-06T00:00:00Z',
      timezone: 'Asia/Seoul',
      durationSeconds: 600,
      durationKind: 'timer',
      distanceMeters: 1000,
    },
    report: { sessionRpe: null, note: null, planLink: null },
  });
  const track = await storeTrack(athlete, actual.activityId, actual.revision);
  const body = content({
    activityId: actual.activityId,
    trackId: track.trackId,
    mapPathSha: track.mapPathSha,
  });
  const saved = await courses.create(athlete, body, randomUUID());
  if (saved.status !== 'available') throw Error('COURSE_UNAVAILABLE');
  const races = createRaceRepository(db),
    original = await races.getRaceEvent(athlete, race.id);
  if (!original) throw Error('RACE_UNAVAILABLE');
  const { id: _id, revision: _revision, ...values } = original;
  await races.updateRaceEvent(athlete, race.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: {
      ...values,
      course: {
        courseId: saved.course.courseId,
        courseRevision: saved.revision.courseRevision,
        revisionId: saved.revision.revisionId,
      },
    },
  });
  const capture = await prepared(athlete, race.id, 2);
  mapped(capture);
  expect(capture.inventory.refs.some((r) => r.identity.kind === 'course-revision')).toBe(true);
  expect(capture.inventory.refs.some((r) => r.identity.kind === 'activity-track-descriptor')).toBe(
    true,
  );
  const other = randomUUID();
  await event(other);
  await expect(prepared(other, race.id, 2)).rejects.toThrow();
  // Public source activity deletion invalidates course lineage; no latest-head substitution.
  await activities.deleteActivity(athlete, actual.activityId, {
    expectedRevision: actual.revision,
  });
  await expect(prepared(athlete, race.id, 2)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});

it('normal107 public unplanned run preserves manual Activity, Intake, checklist and timer through full owned correspondence', async () => {
  const athlete = randomUUID(),
    race = await event(athlete),
    f = await catalogFixture(athlete),
    nutrition = createNutritionRepository(db);
  const plan = await nutrition.savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Synthetic',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'meal',
          category: 'meal',
          title: 'Meal',
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
          foods: [],
          targets: [],
          instructions: '합성 섭취를 기록한다',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  const generation = await db.tenant(athlete, async (tx) =>
    z
      .uuid()
      .parse((await tx.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id']),
  );
  const nutrient = <U extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: U) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: [],
  });
  const intake = await nutrition.createIntake(athlete, {
    idempotencyKey: randomUUID(),
    restoreGeneration: generation,
    intakeId: 'Intake-한글-A',
    confirmed: true,
    occurredAt: '2026-10-06T00:00:00Z',
    timezone: 'Asia/Seoul',
    foods: [
      {
        foodVersionId: null,
        description: 'Reported unknown',
        quantity: null,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
    ],
    nutrientTotal: {
      energy: nutrient('kcal'),
      carbohydrate: nutrient('g'),
      protein: nutrient('g'),
      fat: nutrient('g'),
      fluid: nutrient('mL'),
      sodium: nutrient('mg'),
    },
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  });
  const activities = createActivityRepository(db),
    actual = await activities.createManualActivity(athlete, {
      idempotencyKey: randomUUID(),
      confirmed: true,
      activity: {
        title: 'Manual',
        kind: 'running',
        startedAt: '2026-10-06T00:00:00Z',
        timezone: 'Asia/Seoul',
        durationSeconds: 0,
        durationKind: 'timer',
        distanceMeters: 0,
      },
      report: { sessionRpe: null, note: null, planLink: null },
    });
  const blueprint = routineBlueprintVersionSchema.parse({
    ...f.blueprint,
    routineId: randomUUID(),
    versionId: randomUUID(),
    steps: [
      ...f.blueprint.steps,
      {
        id: 'nutrition',
        title: 'Meal',
        content: {
          kind: 'nutrition_template',
          ref: { id: plan.planId, versionId: plan.versionId },
        },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
      {
        id: 'checklist',
        title: 'Report',
        content: { kind: 'checklist', prompt: 'Synthetic explicit report' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
  });
  await f.routines.saveBlueprint(athlete, {
    blueprint,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  // No preview/approveSchedule call: actual origin remains unplanned, with no
  // fabricated approved schedule or occurrence and no impact approval.
  let run = await f.routines.startRun(athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  for (const [stepId, actualRefs] of [
    [
      'step',
      [
        {
          kind: 'activity',
          id: actual.activityId,
          revisionId: String(actual.revision),
          detailId: null,
          allocationId: null,
        },
      ],
    ],
    ['nutrition', [{ kind: 'intake', id: intake.intakeId, revisionId: intake.revisionId }]],
    ['checklist', []],
  ] as const)
    run = await f.routines.recordStep(athlete, {
      runId: run.run.id,
      stepId,
      state: 'performed',
      actualRefs: [...actualRefs],
      occurredAt: '2026-10-06T00:00:00Z',
      reason: null,
      expectedRevision: run.run.revision,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
  const timer = await f.routines.commandTimer(athlete, {
    runId: run.run.id,
    stepId: 'checklist',
    action: 'start',
    durationSeconds: 30,
    expectedRevision: null,
    idempotencyKey: randomUUID(),
  });
  expect(run.run.origin.kind).toBe('unplanned');
  expect((await f.routines.readRun(athlete, run.run.id))?.run).toEqual(run.run);
  const value = await prepared(athlete, race.id);
  mapped(value);
  expect(value.result.sourceInput.projectionInput.retainedUnplannedRuns).toEqual([
    { blueprint, run: run.run },
  ]);
  expect(value.result.candidate.body.projection.retainedUnplannedRuns).toEqual([
    { state: 'retained_unplanned', blueprint, run: run.run },
  ]);
  for (const kind of [
    'routine-run',
    'routine-blueprint-version',
    'manual-activity-source',
    'intake-revision',
    'checklist-confirmation',
    'routine-timer',
  ])
    expect(value.inventory.refs.some((ref) => ref.identity.kind === kind)).toBe(true);
  // catalogFixture intentionally approved an unrelated schedule. Preserve its
  // real occurrence copies; only this new run must have no planned association.
  expect(run.run.origin).toEqual({ kind: 'unplanned' });
  expect(
    value.result.context.routineActualManifest.occurrences.map((row) => row.record.id),
  ).toEqual(f.approved.occurrences.map((row) => row.id));
  expect(
    value.result.context.routineActualManifest.occurrences.some(
      (row) => row.startedRun.state === 'present' && row.startedRun.runId === run.run.id,
    ),
  ).toBe(false);
  for (const occurrence of f.approved.occurrences) {
    expect(
      value.inventory.refs.some(
        (ref) =>
          ref.identity.kind === 'routine-occurrence' && ref.identity.sourceId === occurrence.id,
      ),
    ).toBe(true);
    expect(occurrence.blueprint.versionId).not.toBe(blueprint.versionId);
  }
  expect(
    value.result.context.routineActualManifest.schedules.some(
      (row) => row.record.blueprint.versionId === blueprint.versionId,
    ),
  ).toBe(false);
  expect(
    value.inventory.refs.find((ref) => ref.identity.kind === 'routine-timer')?.identity,
  ).toMatchObject({ sourceId: run.run.id, revision: timer.revision });
  expect(value.result.candidate.approvalAllowed).toBe(false);
});
