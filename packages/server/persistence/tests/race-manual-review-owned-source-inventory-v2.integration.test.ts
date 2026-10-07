import {
  captureRaceManualReviewOwnedSourceInventoryV2In,
  raceManualReviewOwnedSourceInventoryV2Schema,
} from '../src/race-manual-review-owned-source-inventory-v2.js';
import { enumerateRaceManualReviewCopiedSourcesV2 } from '../src/race-manual-review-source-inventory-v2.js';
import { assembleRaceManualReviewCandidateCompatibleV4 } from '@workout/server-coaching/race-manual-review-candidate-v2';
import { createRaceRelativeScheduleCalculationPortsCompatibleV4 } from '../src/race-relative-schedule-calculation.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { saveNutritionPlanV4IntentSchema } from '@workout/contracts/nutrition-race-plan-v4';
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
import { prepareRaceManualReviewCompatibleV4In } from '../src/race-manual-review-preparation-v2.js';
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
// A fresh {bytes:0n,sources:0} budget measures ONLY this helper's new transfer.
// It is not an aggregate budget for earlier capture/preview transport.
// Frozen owned helper integration preparation; execution belongs to Root.
// normal107 and separate raw108/109/110 staging never claim registry installation.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `owned_review_v2_${suffix}`,
  ownerRole = `owned_review_v2_owner_${suffix}`,
  runtimeRole = `owned_review_v2_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
let created = false,
  db: Database;
let staged: Database,
  stagedCreated = false;
const stagedName = `owned_review_v2_staged_${suffix}`,
  stagedOwner = `owned_review_v2_stage_owner_${suffix}`,
  stagedRuntime = `owned_review_v2_stage_app_${suffix}`;
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
  await admin.query(`CREATE DATABASE "${stagedName}" OWNER "${stagedOwner}"`);
  stagedCreated = true;
  await migrate(url(stagedOwner, stagedName), 107);
  const stagedPool = new Pool({ connectionString: url(stagedOwner, stagedName), max: 1 });
  try {
    for (const file of [
      '108_nutrition_race_disconnection.sql',
      '109_race_result_proof_lifecycle.sql',
      '110_nutrition_disconnection_lineage.sql',
    ])
      await stagedPool.query(
        await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      );
    // Explicit unregistered staging EXECUTE only, identical to the V4 writer fixture.
    await stagedPool.query(
      `GRANT EXECUTE ON FUNCTION public.read_nutrition_disconnection_origin(uuid,uuid,text),public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb) TO "${stagedRuntime}"`,
    );
  } finally {
    await stagedPool.end();
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
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
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
const intent = (id: string, revision = 1) => ({
  expectedEvent: { id, revision },
  newLocalDate: '2026-10-08',
  selection: { kind: 'keep_plan' },
});
async function prepareIn(tx: Transaction, id: string, revision = 1) {
  const prepared = await prepareRaceManualReviewCompatibleV4In(tx, intent(id, revision));
  if (prepared.status !== 'prepared_readonly' && prepared.status !== 'prepared_blocked')
    throw Error('FIXTURE_CANDIDATE_UNAVAILABLE');
  return prepared;
}
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

async function multipinSources() {
  const athlete = randomUUID();
  const offline = new Pool({ connectionString: url(stagedOwner, stagedName) });
  try {
    await offline.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await offline.end();
  }
  await createConsentRepository(staged).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const races = createRaceRepository(staged),
    values = {
      title: 'Synthetic multipin race',
      localDate: '2026-10-06',
      localStartTime: '09:00',
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard' as const, class: '10k' as const },
      priority: null,
      participation: 'registered' as const,
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    };
  const race = await races.createRaceEvent(athlete, { values, idempotencyKey: randomUUID() });
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

  return { athlete, race, saved, changed };
}

async function artifacts(database: Database, athlete: string) {
  return database.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT (SELECT count(*) FROM command_receipt WHERE athlete_id=$1)::int AS command_receipts,(SELECT count(*) FROM race_command_receipt WHERE athlete_id=$1)::int AS race_receipts,(SELECT count(*) FROM routine_command_receipt WHERE athlete_id=$1)::int AS routine_receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox,(SELECT count(*) FROM nutrition_plan_version WHERE athlete_id=$1)::int AS nutrition_versions,(SELECT count(*) FROM plan_snapshot WHERE athlete_id=$1)::int AS plan_versions`,
          [athlete],
        )
      ).rows,
  );
}

const kinds = [
  'race-event',
  'plan-snapshot',
  'nutrition-plan-version',
  'routine-schedule-version',
  'routine-blueprint-version',
  'routine-occurrence',
  'routine-run',
  'session-completion',
].sort();
function observation(
  result: Awaited<ReturnType<typeof captureRaceManualReviewOwnedSourceInventoryV2In>>,
) {
  expect(raceManualReviewOwnedSourceInventoryV2Schema.parse(result)).toEqual(result);
  expect(result).toMatchObject({
    scope: 'candidate_v2_copied_full_bodies_only',
    observation: 'same_transaction_owned_rows',
    sqlRowDigest: 'not_captured',
    authority: 'none',
    freshness: 'not_checked',
    storage: 'not_persisted',
    admissionAllowed: false,
    approvalAllowed: false,
  });
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.missing).toHaveLength(5);
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
it('actual public eight namespaces match same-snapshot bodies with exact identity and no artifacts', async () => {
  const f = await coherentSources(db),
    before = await artifacts(db, f.athlete);
  await snapshot(db, f.athlete, async (tx) => {
    const prepared = await prepareIn(tx, f.race.id),
      budget = { bytes: 0n, sources: 0 };
    const inventory = enumerateRaceManualReviewCopiedSourcesV2(prepared.candidate);
    expect([...new Set(inventory.refs.map((r) => r.identity.kind))].sort()).toEqual(kinds);
    expect(inventory.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: { kind: 'routine-run', sourceId: f.run.run.id, revision: 0 },
        }),
        expect.objectContaining({
          identity: {
            kind: 'session-completion',
            sourceId: 'session',
            planVersionId: f.plan.id,
            revision: 1,
          },
        }),
      ]),
    );
    const sqls: string[] = [];
    const projectedInstants: string[] = [];
    const measured: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        sqls.push(sql);
        const rows = await tx.query(sql, values);
        // Observe the actual helper SQL transport, not a replacement row fixture.
        if (sql.includes('manual_review_owned_v2 body nutrition-plan-version')) {
          for (const row of rows.rows) {
            projectedInstants.push(
              z.object({ metadata: z.object({ approvedAt: z.string() }) }).parse(row).metadata
                .approvedAt,
            );
          }
        }
        if (sql.includes('manual_review_owned_v2 body routine-occurrence')) {
          for (const row of rows.rows) {
            projectedInstants.push(
              z.object({ metadata: z.object({ scheduledAt: z.string() }) }).parse(row).metadata
                .scheduledAt,
            );
          }
        }
        return rows;
      },
    };
    const result = await captureRaceManualReviewOwnedSourceInventoryV2In(
      measured,
      prepared.candidate,
      budget,
    );
    observation(result);
    expect(result.status).toBe('observed_correspondence');
    const actualInstants = await tx.query(
      `SELECT to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant
       FROM nutrition_plan_version WHERE athlete_id=$1 AND version_id=$2
       UNION ALL
       SELECT to_char(scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant
       FROM routine_occurrence WHERE athlete_id=$1 AND id=$3`,
      [f.athlete, f.nutrition.versionId, f.occurrence.id],
    );
    const expectedInstants = z.array(z.object({ instant: z.string() })).parse(actualInstants.rows);
    expect(projectedInstants).toHaveLength(2);
    expect(projectedInstants.every((value) => /\.\d{6}Z$/.test(value))).toBe(true);
    expect([...projectedInstants].sort()).toEqual(
      expectedInstants.map((row) => row.instant).sort(),
    );
    expect(result.facts.every((fact) => fact.state === 'matched')).toBe(true);
    expect(
      result.facts.map((fact) => ({ identity: fact.identity, dtoDigest: fact.dtoDigest })),
    ).toEqual(inventory.refs.map((ref) => ({ identity: ref.identity, dtoDigest: ref.dtoDigest })));
    expect(
      sqls.filter((sql) => sql.includes('manual_review_owned_v2 body plan-snapshot')),
    ).toHaveLength(1);
    expect(budget.sources).toBe(
      inventory.refs.reduce((n, ref) => n + ref.copiedLocations.length, 0),
    );
    expect(budget.bytes).toBeGreaterThan(0n);
    expect(
      result.facts.some(
        (fact) =>
          fact.identity.kind === 'routine-blueprint-version' &&
          fact.identity.sourceId === f.plan.id,
      ),
    ).toBe(true);
  });
  expect(await artifacts(db, f.athlete)).toEqual(before);
});
it('public historical source and report/run revisions retain exact original bodies after current heads change', async () => {
  const f = await coherentSources(db),
    prior = await snapshot(db, f.athlete, (tx) => prepareIn(tx, f.race.id));
  const nextPlan = await f.planning.save(f.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: f.plan.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'New current plan' },
  });
  await f.routines.saveBlueprint(f.athlete, {
    blueprint: { ...f.blueprint, versionId: randomUUID(), title: 'New independent blueprint' },
    expectedVersionId: f.blueprint.versionId,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  await f.routines.changeRun(f.athlete, {
    runId: f.run.run.id,
    action: 'stop',
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  await f.completions.write(f.athlete, 'session', {
    action: 'retract',
    confirmed: true,
    expectedPlanVersionId: nextPlan.id,
    expectedRevision: 1,
    reason: 'Synthetic correction',
    idempotencyKey: randomUUID(),
  });
  const before = await artifacts(db, f.athlete);
  const result = await snapshot(db, f.athlete, (tx) =>
    captureRaceManualReviewOwnedSourceInventoryV2In(tx, prior.candidate, { bytes: 0n, sources: 0 }),
  );
  observation(result);
  expect(result.status).toBe('observed_correspondence');
  expect(result.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identity: { kind: 'routine-run', sourceId: f.run.run.id, revision: 0 },
        state: 'matched',
      }),
      expect.objectContaining({
        identity: {
          kind: 'session-completion',
          sourceId: 'session',
          planVersionId: f.plan.id,
          revision: 1,
        },
        state: 'matched',
      }),
    ]),
  );
  expect(await artifacts(db, f.athlete)).toEqual(before);
});
it('public race mutation and deletion block old copied event without historical or latest substitution', async () => {
  const f = await coherentSources(db),
    prepared = await snapshot(db, f.athlete, (tx) => prepareIn(tx, f.race.id));
  const raceRepo = createRaceRepository(db);
  await raceRepo.updateRaceEvent(f.athlete, f.race.id, {
    expectedRevision: 1,
    values: { ...raceValues, planVersionId: f.plan.id, title: 'Changed synthetic title' },
    idempotencyKey: randomUUID(),
  });
  const changedBefore = await artifacts(db, f.athlete);
  let result = await snapshot(db, f.athlete, (tx) =>
    captureRaceManualReviewOwnedSourceInventoryV2In(tx, prepared.candidate, {
      bytes: 0n,
      sources: 0,
    }),
  );
  observation(result);
  expect(result.status).toBe('blocked');
  expect(result.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identity: { kind: 'race-event', sourceId: f.race.id, revision: 1 },
        state: 'unavailable',
        reason: 'source_tuple_mismatch',
        dtoDigest: null,
      }),
    ]),
  );
  expect(await artifacts(db, f.athlete)).toEqual(changedBefore);
  await raceRepo.deleteRaceEvent(f.athlete, f.race.id, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  const deletedBefore = await artifacts(db, f.athlete);
  result = await snapshot(db, f.athlete, (tx) =>
    captureRaceManualReviewOwnedSourceInventoryV2In(tx, prepared.candidate, {
      bytes: 0n,
      sources: 0,
    }),
  );
  observation(result);
  expect(result.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identity: { kind: 'race-event', sourceId: f.race.id, revision: 1 },
        state: 'unavailable',
        reason: 'source_deleted',
        dtoDigest: null,
      }),
    ]),
  );
  expect(await artifacts(db, f.athlete)).toEqual(deletedBefore);
});
it('valid-checksum copied DTO tamper is rejected by actual source correspondence and foreign candidate cannot claim tenant ownership', async () => {
  const f = await coherentSources(db),
    bob = await coherentSources(db);
  const prepared = await snapshot(db, f.athlete, (tx) => prepareIn(tx, f.race.id));
  const input = structuredClone(prepared.sourceInput);
  const nutrition = input.projectionInput.nutrition[0];
  if (!nutrition) throw Error('FIXTURE_NUTRITION_MISSING');
  nutrition.record.purpose = 'Forged copied source title';
  const tampered = assembleRaceManualReviewCandidateCompatibleV4(
    input,
    createRaceRelativeScheduleCalculationPortsCompatibleV4(prepared.context.consumedSources.races),
  );
  expect(tampered.status).toBe('assembled_readonly');
  const before = await artifacts(db, f.athlete);
  const result = await snapshot(db, f.athlete, (tx) =>
    captureRaceManualReviewOwnedSourceInventoryV2In(tx, tampered, { bytes: 0n, sources: 0 }),
  );
  observation(result);
  expect(result.status).toBe('blocked');
  expect(result.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identity: {
          kind: 'nutrition-plan-version',
          sourceId: f.nutrition.planId,
          versionId: f.nutrition.versionId,
        },
        state: 'unavailable',
        reason: 'copied_body_mismatch',
        dtoDigest: null,
      }),
    ]),
  );
  const foreign = await snapshot(db, bob.athlete, (tx) => prepareIn(tx, bob.race.id));
  await expect(
    snapshot(db, f.athlete, (tx) =>
      captureRaceManualReviewOwnedSourceInventoryV2In(tx, foreign.candidate, {
        bytes: 0n,
        sources: 0,
      }),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  const disguisedInput = {
    ...foreign.sourceInput,
    athleteId: f.athlete,
    sourceFacts: { ...foreign.sourceInput.sourceFacts, ownerAthleteId: f.athlete },
  };
  const disguised = assembleRaceManualReviewCandidateCompatibleV4(
    disguisedInput,
    createRaceRelativeScheduleCalculationPortsCompatibleV4(foreign.context.consumedSources.races),
  );
  expect(disguised.status).toBe('assembled_readonly');
  const denied = await snapshot(db, f.athlete, (tx) =>
    captureRaceManualReviewOwnedSourceInventoryV2In(tx, disguised, { bytes: 0n, sources: 0 }),
  );
  observation(denied);
  expect(denied.status).toBe('blocked');
  expect(
    denied.facts.every((fact) => fact.state === 'unavailable' && fact.dtoDigest === null),
  ).toBe(true);
  expect(await artifacts(db, f.athlete)).toEqual(before);
});
it('public multipin V4 remains an exact owned Nutrition body and frozen observations never become full historical event rows', async () => {
  const f = await multipinSources(),
    before = await artifacts(staged, f.athlete);
  await snapshot(staged, f.athlete, async (tx) => {
    const prepared = await prepareIn(tx, f.race.id, f.changed.revision);
    const inventory = enumerateRaceManualReviewCopiedSourcesV2(prepared.candidate);
    expect(
      inventory.fragments
        .filter((fragment) => fragment.kind === 'race-timing-pin')
        .map((fragment) => fragment.sourceIdentity),
    ).toEqual(
      expect.arrayContaining([
        { kind: 'race-event', sourceId: f.race.id, revision: 1 },
        { kind: 'race-event', sourceId: f.race.id, revision: 2 },
      ]),
    );
    const result = await captureRaceManualReviewOwnedSourceInventoryV2In(tx, prepared.candidate, {
      bytes: 0n,
      sources: 0,
    });
    observation(result);
    expect(result.status).toBe('observed_correspondence');
    expect(
      result.facts
        .filter((fact) => fact.identity.kind === 'race-event')
        .map((fact) => fact.identity),
    ).toEqual([{ kind: 'race-event', sourceId: f.race.id, revision: 2 }]);
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: {
            kind: 'nutrition-plan-version',
            sourceId: f.saved.plan.planId,
            versionId: f.saved.plan.versionId,
          },
          state: 'matched',
        }),
      ]),
    );
  });
  expect(await artifacts(staged, f.athlete)).toEqual(before);
});
it('long Unicode and escaped public session IDs preserve exact completion identity namespace', async () => {
  const sessionId = 's'.repeat(190) + '한글"\\',
    f = await coherentSources(db, sessionId);
  const result = await snapshot(db, f.athlete, async (tx) => {
    const prepared = await prepareIn(tx, f.race.id);
    return captureRaceManualReviewOwnedSourceInventoryV2In(tx, prepared.candidate, {
      bytes: 0n,
      sources: 0,
    });
  });
  observation(result);
  expect(result.status).toBe('observed_correspondence');
  expect(result.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identity: {
          kind: 'session-completion',
          sourceId: sessionId,
          planVersionId: f.plan.id,
          revision: 1,
        },
        state: 'matched',
      }),
    ]),
  );
});
it('ingress and inherited near-cap budgets reject before SQL transport; base zero measures helper transfer only', async () => {
  const f = await coherentSources(db);
  await snapshot(db, f.athlete, async (tx) => {
    const prepared = await prepareIn(tx, f.race.id);
    let queries = 0;
    const measured: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        queries++;
        return tx.query(sql, values);
      },
    };
    for (const budget of [
      { bytes: 4194304n, sources: 0 },
      { bytes: 0n, sources: 5000 },
    ]) {
      queries = 0;
      await expect(
        captureRaceManualReviewOwnedSourceInventoryV2In(measured, prepared.candidate, budget),
      ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
      expect(queries).toBe(0);
    }
    await expect(
      captureRaceManualReviewOwnedSourceInventoryV2In(
        measured,
        { ...prepared.candidate, unexpected: true },
        { bytes: 0n, sources: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    expect(queries).toBe(0);
    await expect(
      captureRaceManualReviewOwnedSourceInventoryV2In(
        measured,
        { ...prepared.candidate, digest: '0'.repeat(64) },
        { bytes: 0n, sources: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    expect(queries).toBe(0);
  });
});
it('caller-owned rollback and closed transaction cannot produce a receipt or leak source bodies', async () => {
  const f = await coherentSources(db),
    before = await artifacts(db, f.athlete);
  let closed: Transaction | null = null;
  await expect(
    snapshot(db, f.athlete, async (tx) => {
      closed = tx;
      const prepared = await prepareIn(tx, f.race.id);
      const result = await captureRaceManualReviewOwnedSourceInventoryV2In(tx, prepared.candidate, {
        bytes: 0n,
        sources: 0,
      });
      observation(result);
      throw Error('SYNTHETIC_ROLLBACK');
    }),
  ).rejects.toThrow('SYNTHETIC_ROLLBACK');
  expect(await artifacts(db, f.athlete)).toEqual(before);
  // Captured transaction reference is tested directly, never reopened or rebound.
  const getClosed = () => closed;
  if (!getClosed()) throw Error('FIXTURE_CLOSED_TX_MISSING');
  await expect(getClosed()?.query('SELECT 1')).rejects.toThrow();
});
