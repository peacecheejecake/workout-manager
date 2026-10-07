import {
  prepareRaceManualSemanticBasisV2In,
  compareRaceManualSemanticBasisV2,
} from '../src/race-manual-review-semantic-basis-v2.js';
import { captureRacePlanImpactContext } from '../src/race-plan-impact-context.js';
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
const name = `garmin_core_consumption_${suffix}`,
  ownerRole = `garmin_core_consumption_owner_${suffix}`,
  runtimeRole = `garmin_core_consumption_app_${suffix}`;
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

// Actual public local producers only. recordCollected is the normal trusted local
// collector port with synthetic attribution; remote/provider/binary authenticity0.
async function semantic(x: Awaited<ReturnType<typeof collected>>, expected: unknown | null = null) {
  return inSnapshot(x.f.athlete, (tx) =>
    prepareRaceManualSemanticBasisV2In(tx, x.f.intent, expected, { bytes: 0n, sources: 0 }),
  );
}
it('public collected current core Activity consumes actual app admission and keeps zero/null and unavailable collection permission', async () => {
  const x = await collected();
  const p = await semantic(x);
  expect(p.status).toBe('current_dependencies_captured');
  if (p.status !== 'current_dependencies_captured')
    throw Error(JSON.stringify({ status: p.status, reason: p.reason }));
  expect(p).toMatchObject({
    authority: 'none',
    permissionAuthority: 'none',
    storage: 'not_persisted',
    approvalAllowed: false,
    admissionAllowed: false,
  });
  const facts = p.prepared.uses.facts.filter(
    (f) => f.sourcePurpose?.kind === 'own_garmin_current_core_activity',
  );
  expect(facts).toHaveLength(2);
  for (const f of facts)
    expect(f).toMatchObject({
      use: 'core_manual',
      reason: null,
      sourceAuthentication: 'unverified',
      sourcePurpose: {
        activityId: x.current.id,
        canonicalRevision: x.current.revision,
        source: x.source,
        collectionPermission: 'not_captured',
        appAdmission: { kind: 'app', granted: true, revision: 1 },
      },
    });
  expect(p.prepared.retained.payload.preparation.context.coverage.complete).toBe(false);
  const content = p.prepared.retained.payload.preparation.context.routineActualManifest.runs
    .flatMap((r) => r.actuals)
    .find((a) => a.fact.requested.id === x.current.id)?.fact.content;
  expect(content).toMatchObject({
    original: { durationSeconds: 0, distanceMeters: null },
    overlay: { distanceMeters: 0 },
  });
  expect(await semantic(x, p.basis)).toMatchObject({
    status: 'current_dependencies_captured',
    reason: null,
  });
});
it('app withdrawal retains metadata but denies new core use; reallow revision makes old basis stale', async () => {
  const x = await collected(),
    before = await semantic(x);
  if (before.status !== 'current_dependencies_captured') throw Error('Expected initial basis');
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(
    (await inSnapshot(x.f.athlete, (tx) => capture(tx, x.f))).garminActivityReadFacts.facts[0],
  ).toMatchObject({ state: 'current', source: { collectionPermission: 'not_captured' } });
  await expect(semantic(x)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  const after = await semantic(x);
  expect(after.status).toBe('current_dependencies_captured');
  if (after.status !== 'current_dependencies_captured') throw Error('Expected reallow basis');
  expect(
    after.basis.consumedUses.facts
      .filter((f) => f.sourcePurpose?.kind === 'own_garmin_current_core_activity')
      .map((f) => f.sourcePurpose),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ appAdmission: { kind: 'app', granted: true, revision: 3 } }),
    ]),
  );
  expect(compareRaceManualSemanticBasisV2(before.basis, after.basis).status).toBe('blocked');
});
it('unused compatibility provider consent cycles neither deny saved core use nor synthesize collection permission', async () => {
  const x = await collected(),
    before = await semantic(x);
  if (before.status !== 'current_dependencies_captured') throw Error('Expected initial basis');
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'provider',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'provider',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const after = await semantic(x, before.basis);
  expect(after).toMatchObject({
    status: 'current_dependencies_captured',
    semanticDigest: before.semanticDigest,
  });
});
it('actual current source and app JSON tamper are optimistic mismatches, never credentials', async () => {
  const x = await collected(),
    p = await semantic(x);
  if (p.status !== 'current_dependencies_captured') throw Error('Expected basis');
  for (const field of ['source', 'app'] as const) {
    const forged = structuredClone(p.basis),
      fact = forged.consumedUses.facts.find(
        (f) => f.sourcePurpose?.kind === 'own_garmin_current_core_activity',
      );
    if (fact?.sourcePurpose?.kind !== 'own_garmin_current_core_activity')
      throw Error('Expected Garmin fact');
    if (field === 'source') fact.sourcePurpose.source.contentHash = 'b'.repeat(64);
    else fact.sourcePurpose.appAdmission.revision = 99;
    expect(compareRaceManualSemanticBasisV2(forged, p.basis).status).toBe('blocked');
    expect((await semantic(x, forged)).status).toBe('blocked');
  }
});
it('foreign public owned context cannot acquire core facts; overlay drift and deletion never repin old run source', async () => {
  const x = await collected(),
    foreign = await setup();
  await expect(
    inSnapshot(foreign.athlete, (tx) =>
      prepareRaceManualConsumedUseV2In(tx, x.f.intent, { bytes: 0n, sources: 0 }),
    ),
  ).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await x.activities.updateOverlay(x.f.athlete, x.current.id, {
    expectedRevision: x.current.revision,
    idempotencyKey: randomUUID(),
    reason: 'Synthetic drift',
    title: 'Later',
  });
  const drift = await semantic(x);
  expect(drift.status).toBe('blocked');
  await x.activities.deleteActivity(x.f.athlete, x.current.id, {
    expectedRevision: x.current.revision + 1,
  });
  const deleted = await semantic(x);
  expect(deleted.status).toBe('blocked');
  const c = await inSnapshot(x.f.athlete, (tx) => capture(tx, x.f));
  expect(c.garminActivityReadFacts.facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'garmin_source_deleted',
    source: null,
  });
});
