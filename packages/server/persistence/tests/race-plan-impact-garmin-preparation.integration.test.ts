import { captureRacePlanImpactContext } from '../src/race-plan-impact-context.js';
import { prepareRaceManualReviewCompatibleV4In } from '../src/race-manual-review-preparation-v2.js';
import { prepareRaceManualConsumedUseV2In } from '../src/race-manual-review-consumed-use-v2.js';
import { createActivityRepository } from '../src/activities.js';
import { createGarminUnofficialStore } from '../src/garmin-unofficial.js';
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
  grantGarminUnofficial,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// normal107 public producers + isolated raw115 full-owned observation stage.
// No remote collector, official authentication, device or binary parser evidence.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `garmin_preparation_${suffix}`,
  ownerRole = `garmin_preparation_owner_${suffix}`,
  runtimeRole = `garmin_preparation_app_${suffix}`;
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

async function collected(link = true) {
  const f = await setup(),
    catalog = await catalogFixture(f.athlete),
    activities = createActivityRepository(db);
  const source = {
    kind: 'fit' as const,
    sourceId: `Collected-식-A-${randomUUID()}`,
    revision: 1,
    contentHash: 'a'.repeat(64),
  };
  const imported = await activities.importActivity(f.athlete, {
    idempotencyKey: randomUUID(),
    source,
    activity: {
      title: 'Synthetic saved core',
      kind: 'strength',
      startedAt: '2026-10-06T00:00:00Z',
      timezone: 'Asia/Seoul',
      durationSeconds: 0,
      durationKind: 'unknown',
      distanceMeters: null,
    },
  });
  const current = await activities.updateOverlay(f.athlete, imported.activityId, {
    expectedRevision: imported.revision,
    idempotencyKey: randomUUID(),
    reason: 'Explicit synthetic zero overlay',
    distanceMeters: 0,
  });
  if (link)
    await createGarminUnofficialStore(db).recordCollected({
      athleteId: f.athlete,
      garminActivityId: '987654321',
      provider: 'garmin-connect-unofficial',
      outcome: 'imported',
      sources: [{ kind: source.kind, sourceId: source.sourceId }],
      now: new Date('2026-10-07T00:00:00Z'),
      appRevision: 1,
    });
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
        id: current.id,
        revisionId: String(current.revision),
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
  return { f, source, current, activities, run };
}
function capture(tx: Transaction, f: Awaited<ReturnType<typeof setup>>) {
  return captureRacePlanImpactContext(
    tx,
    {
      eventId: f.intent.expectedEvent.id,
      expectedRevision: f.intent.expectedEvent.revision,
      selection: { kind: 'keep_plan' },
    },
    { bytes: 0n, sources: 0 },
  );
}
it('actual public collected FIT context and compatible preparation consume a distinct Garmin metadata companion', async () => {
  const x = await collected();
  const c = await inSnapshot(x.f.athlete, (tx) => capture(tx, x.f));
  expect(c.garminActivityReadFacts).toMatchObject({
    authority: 'none',
    sourceAuthentication: 'unverified',
    freshness: 'not_checked',
    storage: 'not_persisted',
    applicable: false,
    facts: [
      {
        requested: { id: x.current.id },
        state: 'current',
        source: {
          source: x.source,
          collectionPermission: 'not_captured',
          collection: { provider: 'garmin-connect-unofficial', official: false },
        },
      },
    ],
  });
  expect(c.localImportedActivityReadFacts.facts).toEqual([]);
  expect(c.manualActivityReadFacts.facts).toEqual([]);
  expect(c.healthKitActivityReadFacts.facts).toEqual([]);
  expect(c.coverage.complete).toBe(false);
  const p = await inSnapshot(x.f.athlete, (tx) =>
    prepareRaceManualReviewCompatibleV4In(tx, x.f.intent, { bytes: 0n, sources: 0 }),
  );
  expect(p.status).toBe('prepared_readonly');
  const use = await inSnapshot(x.f.athlete, (tx) =>
    prepareRaceManualConsumedUseV2In(tx, x.f.intent, { bytes: 0n, sources: 0 }),
  );
  expect(use.status).toBe('observed_manual_use');
  if (use.status !== 'observed_manual_use') throw Error('Expected owned core processing');
  expect(use).toMatchObject({
    authority: 'none',
    permissionAuthority: 'none',
    approvalAllowed: false,
    admissionAllowed: false,
  });
  const garmin = use.uses.facts.filter(
    (f) => f.sourcePurpose?.kind === 'own_garmin_current_core_activity',
  );
  expect(garmin).toHaveLength(2);
  for (const fact of garmin)
    expect(fact).toMatchObject({
      reason: null,
      sourceAuthentication: 'unverified',
      sourcePurpose: {
        activityId: x.current.id,
        source: x.source,
        appAdmission: { kind: 'app', granted: true, revision: 1 },
        collectionPermission: 'not_captured',
      },
    });
  // Actual core-purpose observation is not final SQL storage/approval authority.
});
it('unattributed FIT stays local and foreign owned capture never acquires another tenant Garmin facts', async () => {
  const x = await collected(false),
    c = await inSnapshot(x.f.athlete, (tx) => capture(tx, x.f));
  expect(c.garminActivityReadFacts.facts).toEqual([]);
  expect(c.localImportedActivityReadFacts.facts[0]?.requested.id).toBe(x.current.id);
  const attributed = await collected(),
    foreign = await setup(),
    foreignCapture = await inSnapshot(foreign.athlete, (tx) => capture(tx, foreign));
  expect(foreignCapture.garminActivityReadFacts.facts).toEqual([]);
  expect(JSON.stringify(foreignCapture)).not.toContain(attributed.current.id);
});
it('public app withdrawal preserves current Garmin metadata read while new preparation processing remains blocked', async () => {
  const x = await collected();
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const c = await inSnapshot(x.f.athlete, (tx) => capture(tx, x.f));
  expect(c.garminActivityReadFacts.facts[0]).toMatchObject({
    state: 'current',
    source: { collectionPermission: 'not_captured' },
  });
  await expect(
    inSnapshot(x.f.athlete, (tx) =>
      prepareRaceManualReviewCompatibleV4In(tx, x.f.intent, { bytes: 0n, sources: 0 }),
    ),
  ).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
});
it('public overlay head drift and delete cannot resurrect historical copied activity body as current metadata', async () => {
  const x = await collected(),
    next = await x.activities.updateOverlay(x.f.athlete, x.current.id, {
      expectedRevision: x.current.revision,
      idempotencyKey: randomUUID(),
      reason: 'Changed public overlay',
      title: 'New current',
    });
  const drift = await inSnapshot(x.f.athlete, (tx) => capture(tx, x.f));
  expect(drift.garminActivityReadFacts.facts[0]).toMatchObject({
    state: 'unavailable',
    source: null,
    reason: 'requested_revision_unavailable',
  });
  await x.activities.deleteActivity(x.f.athlete, x.current.id, { expectedRevision: next.revision });
  const deleted = await inSnapshot(x.f.athlete, (tx) => capture(tx, x.f));
  expect(deleted.garminActivityReadFacts.facts[0]).toMatchObject({
    state: 'unavailable',
    source: null,
    reason: 'garmin_source_deleted',
  });
  const facts = deleted.routineActualManifest.runs.flatMap((r) => r.actuals.map((a) => a.fact));
  expect(
    facts.find((f) => f.requested.kind === 'activity' && f.requested.id === x.current.id)?.content,
  ).toBeNull();
});
