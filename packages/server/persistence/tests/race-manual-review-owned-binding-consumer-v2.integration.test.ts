import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { saveNutritionPlanV4IntentSchema } from '@workout/contracts/nutrition-race-plan-v4';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { validateRaceImpactConsumedManifest } from '../src/race-plan-impact-complete-manifest.js';
import {
  prepareRaceManualReviewOwnedBindingV2In,
  createRaceManualReviewOwnedBindingV2Service,
} from '../src/race-manual-review-owned-binding-consumer-v2.js';
// Root executes. Baseline normal107 + raw114; separate raw108/109/110/114 V4 staging.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createRaceRepository } from '../src/races.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createSessionCompletionRepository } from '../src/session-completions.js';
import { createConsentRepository } from '../src/repositories.js';
import {
  migrate,
  grantCorePlanning,
  grantSessionCompletions,
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
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `owned_binding_consumer_v2_${suffix}`,
  ownerRole = `owned_binding_consumer_owner_${suffix}`,
  runtimeRole = `owned_binding_consumer_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let db: Database;
let staged: Database;
let stagedCreated = false;
const stagedName = `owned_binding_v4_stage_${suffix}`,
  stagedOwner = `owned_binding_v4_owner_${suffix}`,
  stagedRuntime = `owned_binding_v4_app_${suffix}`;
function url(role: string, databaseName = name) {
  const u = new URL(adminUrl);
  u.pathname = `/${databaseName}`;
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
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    await owner.query(
      await readFile(
        new URL('../migrations/114_manual_review_owned_source_bindings_v2.sql', import.meta.url),
        'utf8',
      ),
    );
    await owner.query(
      `GRANT EXECUTE ON FUNCTION public.observe_manual_review_owned_source_bindings_v2(jsonb) TO "${runtimeRole}"`,
    );
  } finally {
    await owner.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantSessionCompletions,
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
  for (const role of [stagedOwner, stagedRuntime]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${stagedName}" OWNER "${stagedOwner}"`);
  stagedCreated = true;
  await migrate(url(stagedOwner, stagedName), 107);
  const stageOwner = new Pool({ connectionString: url(stagedOwner, stagedName) });
  try {
    for (const file of [
      '108_nutrition_race_disconnection.sql',
      '109_race_result_proof_lifecycle.sql',
      '110_nutrition_disconnection_lineage.sql',
      '114_manual_review_owned_source_bindings_v2.sql',
    ]) {
      await stageOwner.query(
        await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      );
    }
    await stageOwner.query(
      `GRANT EXECUTE ON FUNCTION public.read_nutrition_disconnection_origin(uuid,uuid,text),public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb),public.observe_manual_review_owned_source_bindings_v2(jsonb) TO "${stagedRuntime}"`,
    );
    expect(
      (await stageOwner.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
  } finally {
    await stageOwner.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantSessionCompletions,
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
    await grant(url(stagedOwner, stagedName), stagedRuntime);
  staged = createDatabase({ connectionString: url(stagedRuntime, stagedName), max: 4 });
});
afterAll(async () => {
  await db?.close();
  await staged?.close();
  if (stagedCreated) await dropIsolatedDatabase(admin, stagedName);
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
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

async function grantApp(database: Database, athlete: string) {
  await createConsentRepository(database).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
}
const raceValues = {
  title: 'Synthetic owned source race',
  localDate: '2026-10-06',
  localStartTime: '09:00',
  timezone: 'Asia/Seoul',
  locationName: null,
  distance: { kind: 'standard' as const, class: '10k' as const },
  priority: null,
  participation: 'registered' as const,
  officialUrl: null,
  course: null,
  targetSeconds: 0,
  planVersionId: null,
};
async function coherentSources(database: Database, sessionId = 'session') {
  const athlete = randomUUID();
  await grantApp(database, athlete);
  const planning = createPlanningRepository(database),
    routines = createRoutineRepository(database),
    completions = createSessionCompletionRepository(database);
  const plan = await planning.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: {
      ...draft(),
      sessions: draft().sessions.map((session) => ({ ...session, id: sessionId })),
    },
  });
  const race = await createRaceRepository(database).createRaceEvent(athlete, {
    values: { ...raceValues, planVersionId: plan.id },
    idempotencyKey: randomUUID(),
  });
  const nutrition = await createNutritionRepository(database).savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Synthetic retained source meal',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'meal',
          category: 'meal',
          title: 'Meal',
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
          foods: [],
          targets: [],
          instructions: 'Synthetic explicit meal',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  const blueprint = (
    await routines.saveBlueprint(athlete, {
      blueprint: routineBlueprintVersionSchema.parse({
        schemaVersion: 4,
        routineId: plan.id,
        versionId: randomUUID(),
        title: 'Synthetic immutable checklist',
        intent: 'Read source',
        status: 'published',
        tags: [],
        steps: [
          {
            id: 'step',
            title: 'Check',
            content: { kind: 'checklist', prompt: 'Synthetic checklist' },
            timing: { kind: 'user_scheduled' },
            required: true,
            choiceGroupId: null,
          },
        ],
        choiceGroups: [],
        estimatedDurationSeconds: null,
        createdAt: '2026-01-01T00:00:00Z',
      }),
      expectedVersionId: null,
      confirmed: true,
      idempotencyKey: randomUUID(),
    })
  ).blueprint;
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
    sourcePlanVersionId: plan.id,
  };
  const preview = await routines.previewSchedule(athlete, scheduleInput);
  const approved = await routines.approveSchedule(athlete, {
    ...scheduleInput,
    previewDigest: preview.previewDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const occurrence = approved.occurrences[0];
  if (!occurrence) throw Error('FIXTURE_OCCURRENCE_ABSENT');
  const run = await routines.startRun(athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: occurrence.id,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const completion = await completions.write(athlete, sessionId, {
    action: 'complete',
    confirmed: true,
    expectedPlanVersionId: plan.id,
    expectedRevision: null,
    reason: null,
    idempotencyKey: randomUUID(),
  });
  return {
    athlete,
    plan,
    race,
    nutrition,
    blueprint,
    approved,
    occurrence,
    run,
    completion,
    routines,
    completions,
    planning,
  };
}
async function snapshot<T>(
  database: Database,
  athlete: string,
  fn: (tx: Transaction) => Promise<T>,
) {
  const port = database.snapshotTenant;
  if (!port) throw Error('FIXTURE_SNAPSHOT_PORT_MISSING');
  return port(athlete, fn);
}

const intent = (eventId: string) => ({
  expectedEvent: { id: eventId, revision: 1 },
  newLocalDate: '2026-10-08',
  selection: { kind: 'keep_plan' },
});
async function minimal() {
  const athlete = randomUUID();
  await grantApp(db, athlete);
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    values: raceValues,
    idempotencyKey: randomUUID(),
  });
  return { athlete, race };
}
async function counts(athlete: string) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT
      (SELECT count(*)::text FROM command_receipt WHERE athlete_id=$1) AS receipt,
      (SELECT count(*)::text FROM race_command_receipt WHERE athlete_id=$1) AS race_receipt,
      (SELECT count(*)::text FROM outbox WHERE athlete_id=$1) AS outbox`,
          [athlete],
        )
      ).rows,
  );
}
it('same snapshot public empty capture binds exact SQL and DTO namespaces without writes', async () => {
  const f = await minimal(),
    before = await counts(f.athlete);
  await snapshot(db, f.athlete, async (tx) => {
    const budget = { bytes: 0n, sources: 0 };
    const result = await prepareRaceManualReviewOwnedBindingV2In(tx, intent(f.race.id), budget);
    expect(result.status).toBe('observed_readonly');
    if (result.status === 'blocked') throw Error('FIXTURE_CANDIDATE_MISSING');
    expect(result.preparation.status).toBe('prepared_readonly');
    expect(result.sqlObservation.rows).toHaveLength(1);
    expect(result.sqlObservation.rows[0]?.identity).toEqual({
      kind: 'race-event',
      sourceId: f.race.id,
      revision: 1,
    });
    expect(result.sqlObservation.callerRole).toBe(runtimeRole);
    expect(result.sqlObservation.athleteId).toBe(f.athlete);
    const anchor = (await tx.query('SELECT txid_current()::text AS id')).rows[0];
    expect(result.sqlObservation.transactionId).toBe(anchor?.['id']);
    expect(result).toMatchObject({
      budgetCoverage: 'request_source_response_reservations',
      aggregatePhysicalTransfer: 'not_verified',
      authority: 'none',
      freshness: 'not_checked',
      storage: 'not_persisted',
      approvalAllowed: false,
      admissionAllowed: false,
    });
    expect(result.owned.facts[0]?.dtoDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sqlObservation.rows[0]?.sourceRowDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(budget.bytes).toBeGreaterThan(0n);
    expect(budget.sources).toBeGreaterThan(0);
  });
  expect(await counts(f.athlete)).toEqual(before);
});
it('public eight namespaces preserve ordered membership and all original consumed blockers', async () => {
  const f = await coherentSources(db),
    before = await counts(f.athlete);
  await snapshot(db, f.athlete, async (tx) => {
    const result = await prepareRaceManualReviewOwnedBindingV2In(tx, intent(f.race.id), {
      bytes: 0n,
      sources: 0,
    });
    if (result.status === 'blocked') throw Error('FIXTURE_CANDIDATE_MISSING');
    expect([...new Set(result.inventory.refs.map((ref) => ref.identity.kind))].sort()).toEqual([
      'nutrition-plan-version',
      'plan-snapshot',
      'race-event',
      'routine-blueprint-version',
      'routine-occurrence',
      'routine-run',
      'routine-schedule-version',
      'session-completion',
    ]);
    expect(result.sqlObservation.rows.map((row) => row.identity)).toEqual(
      result.inventory.refs.map((ref) => ref.identity),
    );
    expect(result.sqlObservation.rows.map((row) => row.ordinal)).toEqual(
      result.inventory.refs.map((_, i) => i + 1),
    );
    expect(result.owned.status).toBe('observed_correspondence');
    expect(result.sqlObservation.rows.every((row) => row.state === 'observed')).toBe(true);
    if (result.preparation.status === 'prepared_blocked') {
      expect(result.status).toBe('observed_blocked');
      expect(result.preparation.consumedScope.status).toBe('blocked');
    } else expect(result.status).toBe('observed_readonly');
    expect(result.preparation.context.readSetDigest).toBe(
      result.preparation.candidate.body.binding.readSetDigest,
    );
    expect(result.preparation.candidate.body.coverage.complete).toBe(false);
  });
  expect(await counts(f.athlete)).toEqual(before);
});
// Deliberately tamper actual query response after PostgreSQL execution. This
// verifies boundary rejection, not forged rows as database ownership evidence.
it('rejects altered SQL transaction, role, identity order and refs digest', async () => {
  const f = await minimal();
  for (const change of ['transaction', 'role', 'identity', 'digest'] as const) {
    await expect(
      snapshot(db, f.athlete, async (tx) => {
        const wrapped: Transaction = {
          athleteId: tx.athleteId,
          query: async (sql, values) => {
            const result = await tx.query(sql, values);
            if (!sql.includes('manual_review_owned_binding_consumer_v2')) return result;
            const row = result.rows[0];
            if (!row) throw Error('FIXTURE_OBSERVER_MISSING');
            const observer = z.record(z.string(), z.unknown()).parse(row['observation']);
            if (change === 'transaction') observer['transactionId'] = '0';
            if (change === 'role') observer['callerRole'] = 'unrelated_role';
            if (change === 'digest') observer['sqlRefsDigest'] = '0'.repeat(64);
            if (change === 'identity') {
              const rows = z.array(z.record(z.string(), z.unknown())).parse(observer['rows']);
              const first = rows[0];
              if (!first) throw Error('FIXTURE_ROW_MISSING');
              first['identity'] = { kind: 'race-event', sourceId: randomUUID(), revision: 1 };
              observer['rows'] = rows;
            }
            return { ...result, rows: [{ ...row, observation: observer }] };
          },
        };
        return prepareRaceManualReviewOwnedBindingV2In(wrapped, intent(f.race.id), {
          bytes: 0n,
          sources: 0,
        });
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  }
});
it('contentless unavailable SQL observations remain blocked despite matching DTO evidence', async () => {
  const f = await minimal();
  const result = await snapshot(db, f.athlete, async (tx) => {
    const wrapped: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        const result = await tx.query(sql, values);
        if (!sql.includes('manual_review_owned_binding_consumer_v2')) return result;
        const row = result.rows[0];
        if (!row) throw Error('FIXTURE_OBSERVER_MISSING');
        const observer = z.record(z.string(), z.unknown()).parse(row['observation']);
        const rows = z.array(z.record(z.string(), z.unknown())).parse(observer['rows']);
        const first = rows[0];
        if (!first) throw Error('FIXTURE_ROW_MISSING');
        first['state'] = 'unavailable';
        first['sourceRowDigest'] = null;
        first['reason'] = 'source_unavailable';
        observer['rows'] = rows;
        return { ...result, rows: [{ ...row, observation: observer }] };
      },
    };
    return prepareRaceManualReviewOwnedBindingV2In(wrapped, intent(f.race.id), {
      bytes: 0n,
      sources: 0,
    });
  });
  expect(result.status).toBe('observed_blocked');
  if (result.status === 'blocked') throw Error('FIXTURE_CANDIDATE_MISSING');
  expect(result.owned.status).toBe('observed_correspondence');
  expect(result.sqlObservation.rows[0]).toMatchObject({
    state: 'unavailable',
    sourceRowDigest: null,
    reason: 'source_unavailable',
  });
  expect(result.admissionAllowed).toBe(false);
});
it('app withdrawal still rejects new processing and foreign event does not disclose source', async () => {
  const alice = await minimal(),
    bob = await minimal();
  await expect(
    snapshot(db, bob.athlete, (tx) =>
      prepareRaceManualReviewOwnedBindingV2In(tx, intent(alice.race.id), { bytes: 0n, sources: 0 }),
    ),
  ).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await createConsentRepository(db).setConsent(alice.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const before = await counts(alice.athlete);
  await expect(
    snapshot(db, alice.athlete, (tx) =>
      prepareRaceManualReviewOwnedBindingV2In(tx, intent(alice.race.id), { bytes: 0n, sources: 0 }),
    ),
  ).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  expect(await counts(alice.athlete)).toEqual(before);
});
it('refuses missing snapshot capability and exhausted inherited budget without fallback', async () => {
  const f = await minimal();
  const withoutSnapshot: Database = {
    tenant: db.tenant,
    exclusiveTenant: db.exclusiveTenant,
    close: async () => {},
  };
  await expect(
    createRaceManualReviewOwnedBindingV2Service(withoutSnapshot).prepare(
      f.athlete,
      intent(f.race.id),
    ),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  await snapshot(db, f.athlete, async (tx) => {
    let queries = 0;
    const measured: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        queries++;
        return tx.query(sql, values);
      },
    };
    await expect(
      prepareRaceManualReviewOwnedBindingV2In(measured, intent(f.race.id), {
        bytes: 0n,
        sources: 5001,
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
    expect(queries).toBe(0);
  });
});
it('callback failure rolls back and no retained transaction can query afterward', async () => {
  const f = await minimal(),
    before = await counts(f.athlete);
  let closed: Transaction | undefined;
  await expect(
    snapshot(db, f.athlete, async (tx) => {
      closed = tx;
      await prepareRaceManualReviewOwnedBindingV2In(tx, intent(f.race.id), {
        bytes: 0n,
        sources: 0,
      });
      throw Error('SYNTHETIC_CALLBACK_FAILURE');
    }),
  ).rejects.toThrow('SYNTHETIC_CALLBACK_FAILURE');
  if (!closed) throw Error('FIXTURE_TRANSACTION_MISSING');
  await expect(closed.query('SELECT 1')).rejects.toThrow();
  expect(await counts(f.athlete)).toEqual(before);
});

it('public consumed resource deletion preserves the original blocked manifest despite observed full bodies', async () => {
  const { athlete, race } = await minimal(),
    resources = createPrivateTextResourceRepository(db),
    catalog = createSupplementaryRepository(db),
    routines = createRoutineRepository(db);
  const offline = new Pool({ connectionString: url(ownerRole) });
  try {
    await offline.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await offline.end();
  }
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
      mediaAssetIds: [],
      resourceVersionIds: resource?.status === 'available' ? [resource.version.id] : [],
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

  const training = await createPlanningRepository(db).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
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

  const initial = await snapshot(db, athlete, (tx) =>
    prepareRaceManualReviewOwnedBindingV2In(tx, intent(race.id), { bytes: 0n, sources: 0 }),
  );
  expect(initial.status).toBe('observed_readonly');
  if (initial.status === 'blocked') throw Error('FIXTURE_CANDIDATE_MISSING');
  expect(initial.preparation.context.resourceReadFacts?.requestedVersionIds).toContain(
    resource.version.id,
  );
  expect(initial.preparation.candidate.body.projection.routines).toMatchObject([
    { scheduleVersionId: approved.schedule.versionId },
  ]);
  await resources.softDelete(athlete, resource.resource.id, {
    expectedAccessRevision: resource.resource.accessRevision,
    expectedCurrentVersionId: resource.version.id,
    idempotencyKey: randomUUID(),
  });
  const before = await counts(athlete);
  const result = await snapshot(db, athlete, (tx) =>
    prepareRaceManualReviewOwnedBindingV2In(tx, intent(race.id), { bytes: 0n, sources: 0 }),
  );
  expect(result.status).toBe('observed_blocked');
  if (result.status === 'blocked' || result.preparation.status !== 'prepared_blocked')
    throw Error('FIXTURE_BLOCKED_CANDIDATE_MISSING');
  expect(result.owned.status).toBe('observed_correspondence');
  expect(result.sqlObservation.rows.every((row) => row.state === 'observed')).toBe(true);
  expect(result.preparation.context.resourceReadFacts?.facts).toMatchObject([
    { requestedVersionId: resource.version.id, state: 'deleted', record: null },
  ]);
  const binding = result.preparation.candidate.body.binding;
  expect(result.preparation.consumedScope).toEqual(
    validateRaceImpactConsumedManifest(result.preparation.context, {
      purpose: binding.purpose,
      athleteId: athlete,
      restoreGeneration: binding.restoreGeneration,
      expectedEvent: binding.event,
      expectedPolicy: binding.policy,
      expectedAppRevision: binding.appRevision,
      expectedReadSetDigest: binding.readSetDigest,
    }),
  );
  expect(result.preparation.consumedScope).toMatchObject({
    status: 'blocked',
    blockers: expect.arrayContaining([expect.objectContaining({ reason: 'source_unavailable' })]),
  });
  expect(result.approvalAllowed).toBe(false);
  expect(await counts(athlete)).toEqual(before);
});

it('explicit raw108/109/110/114 public V4 multipin binds only the current full race with all eight namespaces', async () => {
  const f = await coherentSources(staged);
  const { athlete, race } = f;
  // Synthetic identity fixture only; all domain source bodies below use public writers.
  const offline = new Pool({ connectionString: url(stagedOwner, stagedName) });
  try {
    await offline.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await offline.end();
  }
  const races = createRaceRepository(staged);
  const values = { ...raceValues, planVersionId: f.plan.id };
  const meal = (id: string) => ({
    id,
    category: 'before' as const,
    title: 'Food',
    anchor: {
      kind: 'relative' as const,
      entity: 'race' as const,
      entityId: race.id,
      point: 'start' as const,
      offsetMinutes: -30,
    },
    foods: [
      {
        foodVersionId: null,
        description: 'Preserved food',
        quantity: 0,
        unit: 'g' as const,
        sourceBasis: 'manual_total' as const,
      },
    ],
    targets: [],
    instructions: 'Synthetic action',
    evidenceIds: [],
    source: 'user_confirmed' as const,
  });
  const initial = await createNutritionRacePlanWriter(staged).savePlanV2(athlete, {
    schemaVersion: 2,
    command: {
      kind: 'create',
      confirmed: true,
      idempotencyKey: randomUUID(),
      draft: {
        period: { from: '2026-10-01', toInclusive: '2026-10-31' },
        timezone: 'UTC',
        purpose: 'Synthetic two meals',
        linkedTrainingPlanVersionId: null,
        items: [meal('old'), meal('changed')],
      },
    },
    expectedRaceHeads: [{ namespace: 'race-event', eventId: race.id, revision: 1 }],
  });
  const changed = await races.updateRaceEvent(athlete, race.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values, localStartTime: '10:00' },
  });
  const prior = initial;
  const saved = await createNutritionRacePlanV4Writer(staged).savePlanV4(
    athlete,
    saveNutritionPlanV4IntentSchema.parse({
      schemaVersion: 4,
      intent: {
        schemaVersion: 3,
        command: {
          kind: 'update',
          confirmed: true,
          planId: prior.planId,
          expectedHeadVersionId: prior.versionId,
          idempotencyKey: randomUUID(),
          draft: {
            period: prior.period,
            timezone: prior.timezone,
            purpose: prior.purpose,
            linkedTrainingPlanVersionId: null,
            items: prior.items.map(({ planVersionId, ...item }) => {
              void planVersionId;
              return item.id === 'changed'
                ? { ...item, anchor: { ...meal('changed').anchor, offsetMinutes: -60 } }
                : item;
            }),
          },
        },
        expectedRaceHeads: [{ namespace: 'race-event', eventId: race.id, revision: 2 }],
        reconnectItemIds: [],
      },
    }),
  );
  expect('schemaVersion' in saved.plan && saved.plan.schemaVersion).toBe(4);
  if (!('schemaVersion' in saved.plan) || saved.plan.schemaVersion !== 4)
    throw Error('FIXTURE_EXPECTED_V4');
  expect(saved.plan.raceTimingPins.map((p) => p.eventRevision)).toEqual([1, 2]);

  const count = () =>
    staged.tenant(
      athlete,
      async (tx) =>
        (
          await tx.query(
            `SELECT
    (SELECT count(*)::text FROM nutrition_plan_version WHERE athlete_id=$1) AS versions,
    (SELECT count(*)::text FROM command_receipt WHERE athlete_id=$1) AS receipts,
    (SELECT count(*)::text FROM race_command_receipt WHERE athlete_id=$1) AS race_receipts,
    (SELECT count(*)::text FROM routine_command_receipt WHERE athlete_id=$1) AS routine_receipts,
    (SELECT count(*)::text FROM outbox WHERE athlete_id=$1) AS outbox`,
            [athlete],
          )
        ).rows,
    );
  const before = await count();
  await snapshot(staged, athlete, async (tx) => {
    const result = await prepareRaceManualReviewOwnedBindingV2In(
      tx,
      { ...intent(race.id), expectedEvent: { id: race.id, revision: changed.revision } },
      { bytes: 0n, sources: 0 },
    );
    expect(result.status).toBe('observed_readonly');
    if (result.status === 'blocked') throw Error('FIXTURE_CANDIDATE_MISSING');
    expect(result.owned.status).toBe('observed_correspondence');
    expect([...new Set(result.inventory.refs.map((ref) => ref.identity.kind))].sort()).toEqual([
      'nutrition-plan-version',
      'plan-snapshot',
      'race-event',
      'routine-blueprint-version',
      'routine-occurrence',
      'routine-run',
      'routine-schedule-version',
      'session-completion',
    ]);
    expect(
      result.inventory.refs
        .filter((ref) => ref.identity.kind === 'race-event')
        .map((ref) => ref.identity),
    ).toEqual([{ kind: 'race-event', sourceId: race.id, revision: 2 }]);
    expect(
      result.sqlObservation.rows
        .filter((row) => row.identity.kind === 'race-event')
        .map((row) => row.identity),
    ).toEqual([{ kind: 'race-event', sourceId: race.id, revision: 2 }]);
    expect(result.sqlObservation.rows.map((row) => row.identity)).toEqual(
      result.inventory.refs.map((ref) => ref.identity),
    );
    expect(result.sqlObservation.rows.every((row) => row.state === 'observed')).toBe(true);
    expect(
      result.inventory.fragments
        .filter((fragment) => fragment.kind === 'race-timing-pin')
        .map((fragment) => fragment.sourceIdentity),
    ).toEqual(
      expect.arrayContaining([
        { kind: 'race-event', sourceId: race.id, revision: 1 },
        { kind: 'race-event', sourceId: race.id, revision: 2 },
      ]),
    );
    const nutrition = result.preparation.candidate.body.projection.nutrition.find(
      (row) => row.planVersionId === saved.plan.versionId,
    );
    expect(nutrition?.record).toEqual(saved.plan);
    expect(
      result.preparation.candidate.body.pinTransitions
        .filter((pin) => pin.nutritionVersionId === saved.plan.versionId)
        .map((pin) => ({
          id: pin.itemId,
          revision: pin.savedPin?.eventRevision,
          target: pin.proposedTarget,
          allocation: pin.allocation,
        })),
    ).toEqual([
      {
        id: 'changed',
        revision: 2,
        target: { eventId: race.id, eventRevision: 3 },
        allocation: 'not_allocated',
      },
      {
        id: 'old',
        revision: 1,
        target: { eventId: race.id, eventRevision: 3 },
        allocation: 'not_allocated',
      },
    ]);
    const identity = {
      kind: 'nutrition-plan-version',
      sourceId: saved.plan.planId,
      versionId: saved.plan.versionId,
    };
    expect(result.owned.facts).toContainEqual({
      identity,
      state: 'matched',
      dtoDigest: impactDependencyDigest(saved.plan),
      reason: null,
    });
    expect(
      result.sqlObservation.rows.find(
        (row) =>
          row.identity.kind === 'nutrition-plan-version' &&
          row.identity.versionId === saved.plan.versionId,
      )?.sourceRowDigest,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sqlObservation.hashMethod).toBe('postgres-owned-source-row-jsonb-utc-v2');
    expect(result).toMatchObject({
      authority: 'none',
      freshness: 'not_checked',
      storage: 'not_persisted',
      admissionAllowed: false,
      approvalAllowed: false,
      budgetCoverage: 'request_source_response_reservations',
      aggregatePhysicalTransfer: 'not_verified',
    });
    expect(result.preparation.candidate.body.binding.event).toEqual({ id: race.id, revision: 2 });
    expect(result.preparation.candidate.body.coverage.complete).toBe(false);
    expect(
      (
        await tx.query('SELECT revision FROM race_event WHERE athlete_id=$1 AND id=$2', [
          athlete,
          race.id,
        ])
      ).rows[0]?.['revision'],
    ).toBe(2);
  });
  expect(await count()).toEqual(before);
});
