import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
import { prepareRaceManualConsumedUseV2In } from '../src/race-manual-review-consumed-use-v2.js';
import { createResourceAccessRepository } from '../src/resource-access.js';
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
// Root-only actual PG fixture: normal107/public consent+race, existing narrow
// grants. This checks current app/policy binding, never a full permission seal.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `consumed_use_${suffix}`,
  ownerRole = `consumed_use_owner_${suffix}`,
  runtimeRole = `consumed_use_app_${suffix}`;
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
  return inSnapshot(f.athlete, (tx) =>
    prepareRaceManualConsumedUseV2In(tx, f.intent, { bytes: 0n, sources: 0 }),
  );
}
it('normal107+isolated raw115 actual core manual app true AI false use, without storage/apply', async () => {
  const f = await setup(),
    r = await prepare(f);
  expect(r.status).toBe('observed_manual_use');
  if (!('uses' in r)) throw Error('ACTUAL_USES_MISSING');
  expect(
    r.uses.facts.some((x) => x.identity.kind === 'race-event' && x.use === 'core_manual'),
  ).toBe(true);
  expect(r).toMatchObject({
    authority: 'none',
    permissionAuthority: 'none',
    storage: 'not_persisted',
    approvalAllowed: false,
  });
});
it('public retained own resource use permits AI false/unreviewed/include false exact historical text', async () => {
  const f = await setup(),
    catalog = await catalogFixture(f.athlete);
  const advanced = await catalog.resources.appendVersion(f.athlete, catalog.resource.resource.id, {
    expectedCurrentVersionId: catalog.resource.version.id,
    text: 'Actual new resource head, frozen original remains.',
    idempotencyKey: randomUUID(),
  });
  if (advanced.status !== 'available') throw Error('RESOURCE_NEW_HEAD_UNAVAILABLE');
  const r = await prepare(f);
  expect(r.status).toBe('observed_manual_use');
  if (!('uses' in r)) throw Error('ACTUAL_USES_MISSING');
  expect(r.uses.facts.find((x) => x.identity.kind === 'resource-text-version')).toMatchObject({
    use: 'own_retained_text',
    reason: null,
  });
  expect(catalog.resource.resource.includeForCoach).toBe(false);
  await catalog.resources.softDelete(f.athlete, catalog.resource.resource.id, {
    expectedAccessRevision: advanced.resource.accessRevision,
    expectedCurrentVersionId: advanced.version.id,
    idempotencyKey: randomUUID(),
  });
  const removed = await prepare(f);
  expect(removed.status).toBe('blocked');
});
it('actual foreign event ownership and withdrawn app cannot be replaced by client claims', async () => {
  const a = await setup(),
    b = await setup();
  await expect(
    inSnapshot(b.athlete, (tx) =>
      prepareRaceManualConsumedUseV2In(tx, a.intent, { bytes: 0n, sources: 0 }),
    ),
  ).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await a.consent.setConsent(a.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await expect(prepare(a)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
});

it('actual review withdrawal preserves manual raw-text use and semantic dependencies despite AI cleanup', async () => {
  const f = await setup(),
    catalog = await catalogFixture(f.athlete),
    access = createResourceAccessRepository(db);
  const reviewed = await access.setReviewed(f.athlete, catalog.resource.resource.id, {
    reviewed: true,
    expectedAccessRevision: catalog.resource.resource.accessRevision,
    expectedCurrentVersionId: catalog.resource.version.id,
    idempotencyKey: randomUUID(),
  });
  const service = createRaceManualSemanticBasisV2Service(db);
  const before = await service.prepare(f.athlete, f.intent);
  if (before.status !== 'current_dependencies_captured') throw Error('SEMANTIC_BEFORE_UNAVAILABLE');
  await access.setReviewed(f.athlete, catalog.resource.resource.id, {
    reviewed: false,
    expectedAccessRevision: reviewed.accessRevision,
    expectedCurrentVersionId: catalog.resource.version.id,
    idempotencyKey: randomUUID(),
  });
  const r = await prepare(f);
  expect(r.status).toBe('observed_manual_use');
  if ('uses' in r)
    expect(r.uses.facts.find((x) => x.identity.kind === 'resource-text-version')).toMatchObject({
      use: 'own_retained_text',
      reason: null,
      resourceAccess: { deleted: false, cleanupPending: true },
    });
  else throw Error('ACTUAL_RESOURCE_PURPOSE_PROBE_MISSING');
  const after = await service.prepare(f.athlete, f.intent, before.basis);
  expect(after.status).toBe('current_dependencies_captured');
  if (after.status !== 'current_dependencies_captured') throw Error('SEMANTIC_AFTER_UNAVAILABLE');
  expect(after.semanticDigest).toBe(before.semanticDigest);
  expect(after.rawReadSetDigest).not.toBe(before.rawReadSetDigest);
});

for (const transition of ['coach-off', 'ai-withdraw'] as const)
  it(`public ${transition} preserves owned manual text with pending AI cleanup`, async () => {
    const f = await setup(),
      catalog = await catalogFixture(f.athlete);
    await f.consent.setConsent(f.athlete, {
      kind: 'ai',
      granted: true,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const access = createResourceAccessRepository(db);
    const reviewed = await access.setReviewed(f.athlete, catalog.resource.resource.id, {
      reviewed: true,
      expectedAccessRevision: catalog.resource.resource.accessRevision,
      expectedCurrentVersionId: catalog.resource.version.id,
      idempotencyKey: randomUUID(),
    });
    const enabled = await access.setCoachUse(f.athlete, catalog.resource.resource.id, {
      includeForCoach: true,
      expectedAccessRevision: reviewed.accessRevision,
      expectedCurrentVersionId: catalog.resource.version.id,
      idempotencyKey: randomUUID(),
    });
    const service = createRaceManualSemanticBasisV2Service(db);
    const before = await service.prepare(f.athlete, f.intent);
    if (before.status !== 'current_dependencies_captured')
      throw Error('SEMANTIC_BEFORE_UNAVAILABLE');
    if (transition === 'coach-off')
      await access.setCoachUse(f.athlete, catalog.resource.resource.id, {
        includeForCoach: false,
        expectedAccessRevision: enabled.accessRevision,
        expectedCurrentVersionId: catalog.resource.version.id,
        idempotencyKey: randomUUID(),
      });
    else
      await f.consent.setConsent(f.athlete, {
        kind: 'ai',
        granted: false,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
      });
    const after = await service.prepare(f.athlete, f.intent, before.basis);
    expect(after.status).toBe('current_dependencies_captured');
    if (after.status !== 'current_dependencies_captured') throw Error('SEMANTIC_AFTER_UNAVAILABLE');
    expect(after.semanticDigest).toBe(before.semanticDigest);
    expect(
      after.prepared.uses.facts.find((x) => x.identity.kind === 'resource-text-version'),
    ).toMatchObject({
      use: 'own_retained_text',
      reason: null,
      resourceAccess: { deleted: false, cleanupPending: true },
    });
  });
