import { captureRacePlanImpactContext } from '../src/race-plan-impact-context.js';
import { createHealthKitRegistrationRepository } from '../src/healthkit-registration.js';
import { createHealthKitIngestionRepository } from '../src/healthkit-ingestion.js';
import { createHealthKitActivityRepository } from '../src/healthkit-activity.js';
import { createHealthKitDeregistrationRepository } from '../src/healthkit-deregistration.js';
import { captureRaceManualHealthKitPurposeV2In } from '../src/race-manual-review-healthkit-purpose-v2.js';
import { createActivityRepository } from '../src/activities.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { prepareRaceManualConsumedUseV2In } from '../src/race-manual-review-consumed-use-v2.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createPlanningRepository } from '../src/planning.js';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { planDraftSchema } from '@workout/contracts/planning';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import {
  migrate,
  grantCorePlanning,
  grantActivityTracks,
  grantSupplementaryCore,
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
  grantHealthKitIngestion,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root-only actual PG fixture: normal107/public consent+race, existing narrow
// grants. This checks current app/policy binding, never a full permission seal.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `healthkit_purpose_${suffix}`,
  ownerRole = `healthkit_purpose_owner_${suffix}`,
  runtimeRole = `healthkit_purpose_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false,
  db: Database;
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
  const migrationOwner = new Pool({ connectionString: url(ownerRole) });
  try {
    await migrationOwner.query(
      await readFile(
        new URL(
          '../migrations/115_manual_review_full_owned_source_bindings_v2.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await migrationOwner.query(
      `GRANT EXECUTE ON FUNCTION public.observe_manual_review_full_owned_source_bindings_v2(jsonb) TO "${runtimeRole}"`,
    );
    expect(
      (await migrationOwner.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
  } finally {
    await migrationOwner.end();
  }

  for (const grant of [
    grantCorePlanning,
    grantActivityTracks,
    grantSupplementaryCore,
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
    grantHealthKitIngestion,
    grantGarminUnofficial,
  ])
    await grant(url(ownerRole), runtimeRole);
  const activityOwner = new Pool({ connectionString: url(ownerRole) });
  try {
    await activityOwner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${runtimeRole}"`,
    );
  } finally {
    await activityOwner.end();
  }
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function setup() {
  const athlete = randomUUID();
  const owner = new Pool({ connectionString: url(ownerRole) });
  // Identity-only FK prerequisite. No owner health/source/admission rows.
  try {
    await owner.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await owner.end();
  }
  const consent = createConsentRepository(db);
  await consent.setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  await consent.setConsent(athlete, {
    kind: 'ai',
    granted: false,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic manual binding',
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
  const intent = {
    expectedEvent: { id: race.id, revision: race.revision },
    newLocalDate: '2026-10-08',
    selection: { kind: 'keep_plan' as const },
  };
  return { athlete, consent, intent };
}
async function inSnapshot<T>(athlete: string, op: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
  return db.snapshotTenant(athlete, op);
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

async function prepare(f: Awaited<ReturnType<typeof setup>>) {
  // Diagnose the original capture boundary without exposing rows or health values.
  await inSnapshot(f.athlete, async (tx) => {
    try {
      await captureRacePlanImpactContext(
        tx,
        {
          eventId: f.intent.expectedEvent.id,
          expectedRevision: f.intent.expectedEvent.revision,
          selection: { kind: 'keep_plan' },
        },
        { bytes: 0n, sources: 0 },
      );
    } catch (error: unknown) {
      const code = z.object({ code: z.string().max(100).optional() }).safeParse(error);
      throw Error(
        JSON.stringify({
          diagnostic: 'HK_CAPTURE_FAILED',
          code: code.success ? (code.data.code ?? null) : null,
          issues:
            error instanceof z.ZodError
              ? error.issues.slice(0, 10).map((i) => ({ code: i.code, path: i.path }))
              : [],
          name: error instanceof Error ? error.name : null,
        }),
      );
    }
  });
  return inSnapshot(f.athlete, (tx) =>
    prepareRaceManualConsumedUseV2In(tx, f.intent, { bytes: 0n, sources: 0 }),
  );
}

// Local synthetic native-protocol fixture, not real-device/authenticity evidence.
async function registered() {
  const f = await setup();
  await f.consent.setConsent(f.athlete, {
    kind: 'healthkit',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const registrations = createHealthKitRegistrationRepository(db),
    sampleId = randomUUID();
  const list = await registrations.listWorkouts(f.athlete, {});
  const registered = await registrations.registerWorkouts(f.athlete, {
    schemaVersion: 1,
    sampleIds: [sampleId],
    accountAttributionDeclared: true,
    expectedConsentRevision: 1,
    expectedRegistryRevision: list.registryRevision,
    idempotencyKey: randomUUID(),
  });
  const claim = registered.claims.find((c) => c.sampleId === sampleId);
  if (!claim) throw Error('CLAIM_MISSING');
  await createHealthKitIngestionRepository(db).ingestBatch(
    f.athlete,
    {
      schemaVersion: 2,
      installationId: randomUUID(),
      batchId: randomUUID(),
      events: [
        {
          kind: 'upsert',
          sampleId,
          claimEpoch: claim.claimEpoch,
          sourceBundleId: 'com.apple.health',
          sourceVersion: null,
          activityType: 37,
          observedFrom: '2026-10-06T00:00:00Z',
          observedTo: '2026-10-06T00:00:00Z',
          durationSeconds: 0,
          distanceMeters: null,
          energyKilocalories: null,
        },
      ],
    },
    1,
  );
  const digestRows = await db.tenant(f.athlete, (tx) =>
    tx.query(
      'SELECT payload_digest FROM healthkit_workout_sample WHERE athlete_id=$1 AND sample_id=$2',
      [f.athlete, sampleId],
    ),
  );
  const expectedSampleDigest = z.string().parse(digestRows.rows[0]?.['payload_digest']);
  const created = await createHealthKitActivityRepository(db).createActivity(f.athlete, {
    sampleId,
    expectedSampleDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const activity = await createActivityRepository(db).getActivity(f.athlete, created.activityId);
  if (!activity) throw Error('ACTIVITY_MISSING');
  const raw = await db.tenant(f.athlete, (tx) =>
    tx.query(
      'SELECT c.original,o.values_json AS overlay FROM activity_canonical c LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND c.id=$2',
      [f.athlete, created.activityId],
    ),
  );
  const b = z
    .strictObject({ original: z.unknown(), overlay: z.unknown().nullable() })
    .parse(raw.rows[0]);
  const request = {
    activityId: created.activityId,
    canonicalRevision: 1,
    source: {
      kind: 'healthkit',
      sourceId: sampleId,
      revision: 1,
      contentHash: expectedSampleDigest,
    },
    expectedOriginalDigest: impactDependencyDigest(b.original),
    expectedOverlayDigest: b.overlay === null ? null : impactDependencyDigest(b.overlay),
    expectedOverlayRevision: null,
  };
  const catalog = await catalogFixture(f.athlete);
  let run = await catalog.routines.startRun(f.athlete, {
    runId: randomUUID(),
    blueprintVersionId: catalog.blueprint.versionId,
    occurrenceId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  run = await catalog.routines.recordStep(f.athlete, {
    runId: run.run.id,
    stepId: 'step',
    state: 'performed',
    actualRefs: [
      {
        kind: 'activity',
        id: created.activityId,
        revisionId: '1',
        detailId: null,
        allocationId: null,
      },
    ],
    occurredAt: '2026-10-06T00:00:00Z',
    reason: null,
    expectedRevision: run.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  return { f, created, sampleId, claim, registrations, request, run };
}
it('normal107 public registered sample→ingestion→explicit canonical→actual run reaches exact HK companion/purpose', async () => {
  const x = await registered(),
    r = await prepare(x.f);
  expect(r.status).toBe('observed_manual_use');
  if (r.status !== 'observed_manual_use')
    throw Error(JSON.stringify({ status: r.status, reason: r.reason }));
  const c = r.retained.payload.preparation.context;
  expect(c.healthKitActivityReadFacts).toMatchObject({
    authority: 'none',
    sourceAuthentication: 'unverified',
    freshness: 'not_checked',
    facts: [
      {
        requested: { id: x.created.activityId },
        state: 'current',
        source: { sample: { id: x.sampleId }, claim: { epoch: x.claim.claimEpoch } },
      },
    ],
  });
  expect(c.manualActivityReadFacts?.facts).toEqual([]);
  expect(c.localImportedActivityReadFacts?.facts).toEqual([]);
  expect(
    r.uses.facts.find(
      (f) =>
        f.identity.kind === 'activity-canonical-values' &&
        f.identity.sourceId === x.created.activityId,
    ),
  ).toMatchObject({
    use: 'core_manual',
    reason: null,
    sourceAuthentication: 'unverified',
    sourcePurpose: {
      kind: 'own_healthkit_activity',
      healthkitConsent: { granted: true, revision: 1 },
    },
  });
  expect(
    c.routineActualManifest.runs.find((r) => r.record.id === x.run.run.id)?.actuals[0]?.fact
      .content,
  ).toMatchObject({ original: { durationSeconds: 0, timezone: null, distanceMeters: null } });
});
it('foreign source and stale optimistic tuple never become owned', async () => {
  const x = await registered(),
    foreign = await setup();
  const r = await inSnapshot(foreign.athlete, (tx) =>
    captureRaceManualHealthKitPurposeV2In(tx, x.request, { bytes: 0n, sources: 0 }),
  );
  expect(r).toMatchObject({ reason: 'healthkit_source_unavailable', observation: null });
  expect(
    await inSnapshot(x.f.athlete, (tx) =>
      captureRaceManualHealthKitPurposeV2In(
        tx,
        { ...x.request, canonicalRevision: 2 },
        { bytes: 0n, sources: 0 },
      ),
    ),
  ).toMatchObject({ reason: 'healthkit_source_tuple_mismatch' });
});
it('public deregistration retains no active source/body and no old claim permission', async () => {
  const x = await registered(),
    list = await x.registrations.listWorkouts(x.f.athlete, {});
  await createHealthKitDeregistrationRepository(db).deregisterWorkout(x.f.athlete, {
    schemaVersion: 1,
    confirmRelatedRecordDeletion: true,
    sampleId: x.sampleId,
    claimEpoch: x.claim.claimEpoch,
    expectedConsentRevision: 1,
    expectedRegistryRevision: list.registryRevision,
    idempotencyKey: randomUUID(),
  });
  expect(
    await inSnapshot(x.f.athlete, (tx) =>
      captureRaceManualHealthKitPurposeV2In(tx, x.request, { bytes: 0n, sources: 0 }),
    ),
  ).toMatchObject({ status: 'blocked', reason: 'healthkit_source_deleted', observation: null });
  const tombstone = await db.tenant(x.f.athlete, (tx) =>
    tx.query('SELECT original,deleted FROM activity_canonical WHERE id=$1', [x.created.activityId]),
  );
  expect(tombstone.rows).toEqual([
    {
      original: {
        title: null,
        kind: 'unknown',
        startedAt: null,
        durationSeconds: null,
        durationKind: 'unknown',
        timezone: null,
        distanceMeters: null,
      },
      deleted: true,
    },
  ]);
});
it('public individual withdrawal purges raw source and prevents app-only reuse', async () => {
  const x = await registered();
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'healthkit',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const r = await inSnapshot(x.f.athlete, (tx) =>
    captureRaceManualHealthKitPurposeV2In(tx, x.request, { bytes: 0n, sources: 0 }),
  );
  expect(r.status).toBe('blocked');
  expect(r.observation).toBeNull();
  expect([
    'healthkit_source_deleted',
    'healthkit_consent_required',
    'healthkit_source_unavailable',
  ]).toContain(r.reason);
});
