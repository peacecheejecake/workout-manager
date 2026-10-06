import {
  supplementaryExerciseVersionSchema,
  supplementarySpecSchema,
  supplementarySessionLinkSchema,
  routineTemplateVersionSchema,
} from '@workout/contracts/supplementary-core';
import { insertSupplementarySessionLink } from '../src/supplementary-core.js';
import {
  integratedDependencyKinds,
  decodeIntegratedDependencyInventory,
} from '../src/race-plan-impact-dependencies.js';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  nutritionPlanVersionSchema,
  type NutritionPlanVersion,
} from '@workout/contracts/nutrition-core';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
} from '@workout/contracts/routines';
import { planDraftSchema } from '@workout/contracts/planning';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import {
  migrate,
  grantOperations,
  grantRaces,
  grantRoutineCore,
  grantRecoveryCore,
  grantCheckIns,
  grantCourses,
} from '../src/migrate.js';
import { captureRacePlanImpactContext } from '../src/race-plan-impact-context.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  dbName = `race_context_${suffix}`,
  ownerRole = `race_context_owner_${suffix}`,
  runtimeRole = `race_context_app_${suffix}`;
let owner: Pool, database: Database, races: RaceRepository;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const values = (): RaceEventValues => ({
  title: 'Synthetic race',
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
});
async function account() {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  // Explicit synthetic account permission for new race plan/actual fixture writes.
  await owned(athlete, (client) =>
    client.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)", [
      athlete,
    ]),
  );
  return athlete;
}
const create = (athlete: string, override: Partial<RaceEventValues> = {}) =>
  races.createRaceEvent(athlete, {
    values: { ...values(), ...override },
    idempotencyKey: randomUUID(),
  });
function capture(
  athlete: string,
  eventId: string,
  expectedRevision = 1,
  selection:
    | { kind: 'keep_plan' }
    | {
        kind: 'move_period';
        expectedCurrentPlanVersionId: string;
        changedSessionIds: string[];
        movedPeriodIds: string[];
      } = { kind: 'keep_plan' },
) {
  return database.tenant(athlete, (tx) =>
    captureRacePlanImpactContext(tx, { eventId, expectedRevision, selection }),
  );
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
async function training(athlete: string, body = draft(), current = true) {
  const id = randomUUID();
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO plan_snapshot(athlete_id,id,version,draft) SELECT $1,$2,coalesce(max(version),0)+1,$3::jsonb FROM plan_snapshot WHERE athlete_id=$1',
      [athlete, id, JSON.stringify(body)],
    );
    if (current)
      await client.query(
        'INSERT INTO plan_head(athlete_id,aggregate_id,version_id) VALUES($1,$2,$3)',
        [athlete, randomUUID(), id],
      );
  });
  return id;
}
function nutrition(
  source: string | null,
  anchors: { entity: 'race' | 'session'; entityId: string; point?: 'start' | 'end' }[] = [],
): NutritionPlanVersion {
  const planId = randomUUID(),
    versionId = randomUUID();
  return nutritionPlanVersionSchema.parse({
    planId,
    versionId,
    version: 1,
    previousVersionId: null,
    period: { from: '2026-10-01', toInclusive: '2026-10-31' },
    timezone: 'Asia/Seoul',
    purpose: 'Synthetic schedule',
    linkedTrainingPlanVersionId: source,
    approvedAt: '2026-10-01T00:00:00Z',
    approvalId: randomUUID(),
    items: anchors.map((anchor, index) => ({
      id: `item${index}`,
      planVersionId: versionId,
      category: 'before',
      title: 'Synthetic hydration',
      anchor: {
        kind: 'relative',
        entity: anchor.entity,
        entityId: anchor.entityId,
        point: anchor.point ?? 'start',
        offsetMinutes: 0,
      },
      foods: [],
      targets: [],
      instructions: 'Review timing',
      evidenceIds: [],
      source: 'user_confirmed',
    })),
  });
}
async function seedNutrition(athlete: string, records: unknown[]) {
  await owned(athlete, async (client) => {
    await client.query(
      `INSERT INTO nutrition_plan_version(athlete_id,plan_id,version_id,version,period_from,period_to,linked_training_plan_version_id,approval_id,approved_at,record_json) SELECT $1,(r->>'planId')::uuid,(r->>'versionId')::uuid,1,(r->'period'->>'from')::date,(r->'period'->>'toInclusive')::date,(r->>'linkedTrainingPlanVersionId')::uuid,(r->>'approvalId')::uuid,(r->>'approvedAt')::timestamptz,r FROM jsonb_array_elements($2::jsonb) r`,
      [athlete, JSON.stringify(records)],
    );
    await client.query(
      'INSERT INTO nutrition_plan_head(athlete_id,plan_id,version,version_id) SELECT athlete_id,plan_id,version,version_id FROM nutrition_plan_version WHERE athlete_id=$1',
      [athlete],
    );
  });
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole));
  owner = new Pool({ connectionString: url(ownerRole) });
  await grantOperations(url(ownerRole), runtimeRole);
  await grantRaces(url(ownerRole), runtimeRole);
  // The configured identity runtime uses these same domain grants; no fixture-only SELECT.
  await grantRoutineCore(url(ownerRole), runtimeRole);
  await grantRecoveryCore(url(ownerRole), runtimeRole);
  await grantCheckIns(url(ownerRole), runtimeRole);
  await grantCourses(url(ownerRole), runtimeRole);
  database = createDatabase({ connectionString: url(runtimeRole) });
  races = createRaceRepository(database);
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
it('installs all99 migrations with plain roles and returns explicit empty rosters/absence, blocked coverage and stable digest', async () => {
  const versions = await owner.query(
    'SELECT count(*)::int AS n,max(version)::int AS last FROM schema_migrations',
  );
  expect(versions.rows[0]).toEqual({ n: 99, last: 99 });
  const roles = await admin.query(
    'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',
    [[ownerRole, runtimeRole]],
  );
  expect(roles.rows).toEqual([
    { rolsuper: false, rolbypassrls: false },
    { rolsuper: false, rolbypassrls: false },
  ]);
  const athlete = await account(),
    event = await create(athlete),
    first = await capture(athlete, event.id),
    second = await capture(athlete, event.id);
  expect(first).toMatchObject({
    status: 'blocked',
    coverage: { complete: false },
    currentTraining: null,
    linkedPlan: null,
    rosters: { nutrition: [], recovery: [], routine: [] },
    coreDependencies: { trainingPlan: { kind: 'absent' } },
    event: { localStartTime: null, targetSeconds: 0 },
  });
  expect(first.coverage.missing).toContain('routine_occurrences_and_started_runs');
  expect(first.readSetDigest).toBe(second.readSetDigest);
});
it('captures a new previously absent nutrition head and changes the read-set digest', async () => {
  const athlete = await account(),
    event = await create(athlete),
    before = await capture(athlete, event.id);
  const record = nutrition(null);
  await seedNutrition(athlete, [record]);
  const after = await capture(athlete, event.id);
  expect(after.rosters.nutrition).toEqual([
    { aggregateId: record.planId, versionId: record.versionId },
  ]);
  expect(after.readSetDigest).not.toBe(before.readSetDigest);
});
it('rejects stale CAS and makes an exact committed event revision/history visible', async () => {
  const athlete = await account(),
    event = await create(athlete);
  await races.updateRaceEvent(athlete, event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values(), title: 'Updated' },
  });
  await expect(capture(athlete, event.id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await capture(athlete, event.id, 2)).event.title).toBe('Updated');
});
it('captures a privacy-generation advance at terminal collection revision from actual deletion', async () => {
  const athlete = await account(),
    event = await create(athlete),
    other = await create(athlete);
  await owned(athlete, (client) =>
    client.query(
      "UPDATE race_collection_head SET revision=2147483647 WHERE athlete_id=$1 AND kind='race-event'",
      [athlete],
    ),
  );
  const before = await capture(athlete, event.id);
  await races.deleteRaceEvent(athlete, other.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const after = await capture(athlete, event.id);
  expect(after.collections.find((head) => head.kind === 'race-event')).toMatchObject({
    revision: 2147483647,
    privacy_generation: '1',
  });
  expect(after.readSetDigest).not.toBe(before.readSetDigest);
});
it('keeps immutable historical event link distinct from current training', async () => {
  const athlete = await account(),
    historical = await training(athlete, draft(), false),
    current = await training(athlete),
    event = await create(athlete, { planVersionId: historical });
  const context = await capture(athlete, event.id);
  expect(context.linkedPlan?.id).toBe(historical);
  expect(context.currentTraining?.snapshot.id).toBe(current);
});
it('classifies race and same-ID session anchors independently, keeps race end unresolved and never estimates it', async () => {
  const athlete = await account(),
    event = await create(athlete),
    body = draft();
  const session = body.sessions[0];
  if (!session) throw Error('fixture');
  session.id = event.id;
  const current = await training(athlete, body);
  const record = nutrition(current, [
    { entity: 'race', entityId: event.id, point: 'end' },
    { entity: 'session', entityId: event.id },
  ]);
  await seedNutrition(athlete, [record]);
  const keep = await capture(athlete, event.id);
  expect(keep.nutrition[0]?.relativeItems).toMatchObject([
    { entity: 'race', affected: true, point: 'end', timing: 'not_resolved' },
    { entity: 'session', affected: false },
  ]);
  expect(keep.affected.nutrition).toEqual([record.planId]);
  const move = await capture(athlete, event.id, 1, {
    kind: 'move_period',
    expectedCurrentPlanVersionId: current,
    changedSessionIds: [event.id],
    movedPeriodIds: ['block'],
  });
  expect(move.nutrition[0]?.relativeItems[1]).toMatchObject({ entity: 'session', affected: true });
});
it('does not rebind a historical current nutrition source to current training', async () => {
  const athlete = await account(),
    old = await training(athlete, draft(), false),
    current = await training(athlete),
    event = await create(athlete);
  await seedNutrition(athlete, [nutrition(old, [{ entity: 'session', entityId: 'session' }])]);
  const context = await capture(athlete, event.id, 1, {
    kind: 'move_period',
    expectedCurrentPlanVersionId: current,
    changedSessionIds: ['session'],
    movedPeriodIds: ['block'],
  });
  expect(context.nutrition[0]).toMatchObject({
    sourceRelation: 'historical',
    relativeItems: [{ affected: false, sourceVersionId: old }],
  });
  expect(context.affected.nutrition).toEqual([]);
});
it('fails closed on a foreign event and a foreign immutable linked source even when raw fixture names its ID', async () => {
  const alice = await account(),
    bob = await account(),
    plan = await training(bob),
    event = await create(alice);
  await expect(capture(bob, event.id)).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await owned(alice, async (client) => {
    const foreign = { ...values(), planVersionId: plan },
      id = randomUUID();
    await client.query(
      'INSERT INTO race_event(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())',
      [alice, id, JSON.stringify(foreign)],
    );
    await client.query(
      'INSERT INTO race_event_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,1,$3::jsonb,now())',
      [alice, id, JSON.stringify(foreign)],
    );
    await expect(capture(alice, id)).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  });
  // Committed fixture: separate owner tx cannot be visible before commit.
  const bad = randomUUID();
  await owned(alice, async (client) => {
    const body = { ...values(), planVersionId: plan };
    await client.query(
      'INSERT INTO race_event(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())',
      [alice, bad, JSON.stringify(body)],
    );
    await client.query(
      'INSERT INTO race_event_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,1,$3::jsonb,now())',
      [alice, bad, JSON.stringify(body)],
    );
  });
  await expect(capture(alice, bad)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});
it('captures completed head revisions without moving actual or planned schedule', async () => {
  const athlete = await account(),
    plan = await training(athlete),
    event = await create(athlete),
    before = await capture(athlete, event.id);
  const report = {
    sessionId: 'session',
    revision: 1,
    planVersionId: plan,
    schedule: {
      blockId: 'block',
      date: '2026-10-06',
      localStartTime: null,
      timezone: 'Asia/Seoul',
    },
    status: 'completed',
    reportedAt: '2026-10-06T00:00:00Z',
    reason: null,
    source: 'user',
    method: 'self_report',
    definitionVersion: 'session-completion-v1',
  };
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO session_completion(athlete_id,session_id,revision,record_json) VALUES($1,$2,1,$3::jsonb)',
      [athlete, 'session', JSON.stringify(report)],
    );
    await client.query(
      'INSERT INTO session_completion_collection_head(athlete_id,revision) VALUES($1,1)',
      [athlete],
    );
  });
  const after = await capture(athlete, event.id);
  expect(after.completions).toEqual([report]);
  expect(after.coreDependencies.sessionCompletions).toEqual({ kind: 'exists', revision: 1 });
  expect(after.currentTraining).toEqual(before.currentTraining);
  expect(after.readSetDigest).not.toBe(before.readSetDigest);
});
it('rejects unknown DTO keys and refuses1001 heads rather than claiming first1000 complete', async () => {
  const athlete = await account(),
    event = await create(athlete);
  await seedNutrition(athlete, [{ ...nutrition(null), secret: 'unexpected' }]);
  await expect(capture(athlete, event.id)).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  const overflow = await account(),
    other = await create(overflow);
  await seedNutrition(
    overflow,
    Array.from({ length: 1001 }, () => nutrition(null)),
  );
  await expect(capture(overflow, other.id)).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
});

it('captures nonempty recovery/routine rosters and classifies a current source session rule without touching occurrences/runs', async () => {
  const athlete = await account(),
    source = await training(athlete),
    event = await create(athlete);
  const current = await capture(athlete, event.id),
    aggregate = current.currentTraining?.aggregateId;
  if (!aggregate) throw Error('Missing current fixture');
  const option = randomUUID();
  const recovery = recoveryStrategyVersionSchema.parse({
    schemaVersion: 1,
    strategyId: randomUUID(),
    versionId: randomUUID(),
    version: 1,
    previousVersionId: null,
    status: 'user_confirmed',
    selectedOptionId: option,
    createdAt: '2026-10-01T00:00:00Z',
    draft: {
      title: 'Synthetic recovery',
      goal: 'Review existing plan',
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'Asia/Seoul',
      knownFacts: [],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [{ kind: 'training', aggregateId: aggregate, headVersionId: source }],
      options: [
        {
          id: option,
          title: 'Keep reviewed plan',
          kind: 'maintain_existing_plan',
          methodVersionId: null,
          explanation: 'User reviewed',
        },
      ],
      reassessment: [
        {
          id: randomUUID(),
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Review plan change',
          policyVersion: null,
        },
      ],
    },
  });
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic checklist',
    intent: 'Review',
    status: 'published',
    tags: [],
    steps: [],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-10-01T00:00:00Z',
  });
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: randomUUID(),
    versionId: randomUUID(),
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'Asia/Seoul',
      maxOccurrences: 10,
    },
    rule: { kind: 'session_links', sessionIds: ['session'], point: 'end', offsetMinutes: 0 },
    state: 'active',
  });
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO recovery_strategy_version(athlete_id,strategy_id,version_id,version,record_json) VALUES($1,$2,$3,1,$4::jsonb)',
      [athlete, recovery.strategyId, recovery.versionId, JSON.stringify(recovery)],
    );
    await client.query(
      'INSERT INTO recovery_strategy_head(athlete_id,strategy_id,version,version_id) VALUES($1,$2,1,$3)',
      [athlete, recovery.strategyId, recovery.versionId],
    );
    await client.query(
      'INSERT INTO routine_blueprint_version(athlete_id,routine_id,version_id,version,record_json,created_at) VALUES($1,$2,$3,1,$4::jsonb,$5)',
      [
        athlete,
        blueprint.routineId,
        blueprint.versionId,
        JSON.stringify(blueprint),
        blueprint.createdAt,
      ],
    );
    await client.query(
      'INSERT INTO routine_schedule_version(athlete_id,schedule_id,version_id,blueprint_routine_id,blueprint_version_id,source_plan_version_id,record_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [
        athlete,
        schedule.id,
        schedule.versionId,
        blueprint.routineId,
        blueprint.versionId,
        source,
        JSON.stringify(schedule),
      ],
    );
    await client.query(
      'INSERT INTO routine_schedule_head(athlete_id,schedule_id,version_id) VALUES($1,$2,$3)',
      [athlete, schedule.id, schedule.versionId],
    );
  });
  const before = await capture(athlete, event.id),
    after = await capture(athlete, event.id, 1, {
      kind: 'move_period',
      expectedCurrentPlanVersionId: source,
      changedSessionIds: ['session'],
      movedPeriodIds: ['block'],
    });
  expect(after.rosters.recovery).toEqual([
    { aggregateId: recovery.strategyId, versionId: recovery.versionId },
  ]);
  expect(after.rosters.routine).toEqual([
    { aggregateId: schedule.id, versionId: schedule.versionId },
  ]);
  expect(before.affected.routine).toEqual([]);
  expect(after.routines[0]).toMatchObject({
    sourceRelation: 'current',
    sourceVersionId: source,
    affected: true,
  });
  expect(after.coverage.missing).toContain('routine_occurrences_and_started_runs');
  const counts = await owned(athlete, (client) =>
    client.query(
      'SELECT (SELECT count(*)::int FROM routine_occurrence WHERE athlete_id=$1) AS occurrences,(SELECT count(*)::int FROM routine_run WHERE athlete_id=$1) AS runs',
      [athlete],
    ),
  );
  expect(counts.rows[0]).toEqual({ occurrences: 0, runs: 0 });
});

async function measuredCapture(athlete: string, eventId: string) {
  let transportedBytes = 0;
  const queries: { sql: string; parameters: unknown[] | undefined }[] = [];
  const result = database.tenant(athlete, (tx) =>
    captureRacePlanImpactContext(
      {
        athleteId: tx.athleteId,
        query: async (sql, parameters) => {
          queries.push({ sql, parameters });
          const response = await tx.query(sql, parameters);
          transportedBytes += Buffer.byteLength(JSON.stringify(response.rows));
          return response;
        },
      },
      { eventId, expectedRevision: 1, selection: { kind: 'keep_plan' } },
    ),
  );
  return { result, queries, bytes: () => transportedBytes };
}
function repeatedNutrition(
  source: string | null,
  raceId: string,
  count: number,
  instructions = 'Review timing',
) {
  const record = nutrition(
    source,
    Array.from({ length: count }, () => ({ entity: 'race' as const, entityId: raceId })),
  );
  record.items.forEach((item) => {
    item.instructions = instructions;
  });
  return nutritionPlanVersionSchema.parse(record);
}
it('rejects more than4MiB via scalar SQL preflight before any DTO body reaches the driver', async () => {
  const athlete = await account(),
    event = await create(athlete);
  await seedNutrition(
    athlete,
    Array.from({ length: 12 }, () => repeatedNutrition(null, event.id, 200, 'x'.repeat(2000))),
  );
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'decoded_bytes',
  });
  expect(measured.bytes()).toBeLessThan(4096);
  expect(
    measured.queries.some(({ sql }) =>
      sql.startsWith('SELECT id,revision,values_json FROM race_event'),
    ),
  ).toBe(false);
});
it('rejects5001 classified relative anchors across valid bounded heads without DTO decode or truncation', async () => {
  const athlete = await account(),
    event = await create(athlete);
  await seedNutrition(
    athlete,
    Array.from({ length: 21 }, (_, index) =>
      repeatedNutrition(null, event.id, index === 20 ? 1 : 250),
    ),
  );
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'relative_anchors',
  });
  expect(measured.bytes()).toBeLessThan(4096);
});
it('loads each exact historical Plan and owned race source only once across repeated anchors', async () => {
  const athlete = await account(),
    historical = await training(athlete, draft(), false);
  await training(athlete);
  const event = await create(athlete, { planVersionId: historical }),
    other = await create(athlete);
  await seedNutrition(
    athlete,
    Array.from({ length: 20 }, () =>
      nutrition(
        historical,
        Array.from({ length: 100 }, (_, index) =>
          index % 2 === 0
            ? { entity: 'session' as const, entityId: 'session' }
            : { entity: 'race' as const, entityId: other.id },
        ),
      ),
    ),
  );
  const measured = await measuredCapture(athlete, event.id),
    context = await measured.result;
  expect(context.nutrition).toHaveLength(20);
  const planReads = measured.queries.filter(({ sql }) =>
    sql.includes('AS created_at,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2'),
  );
  expect(planReads).toHaveLength(1);
  expect(planReads[0]?.parameters?.[1]).toBe(historical);
  const raceReads = measured.queries.filter(({ sql }) =>
    sql.startsWith('SELECT revision,values_json FROM race_event'),
  );
  expect(raceReads).toHaveLength(1);
  expect(raceReads[0]?.parameters?.[1]).toBe(other.id);
  expect(
    measured.queries.filter(
      ({ sql, parameters }) =>
        sql.startsWith('SELECT values_json FROM race_event_revision') &&
        parameters?.[1] === other.id,
    ),
  ).toHaveLength(1);
  expect(context.coverage.complete).toBe(false);
});
it('bounds5001 unique source identities before decoding adversarial stored source-reference bodies', async () => {
  const athlete = await account(),
    event = await create(athlete),
    records = Array.from({ length: 250 }, () => {
      const option = randomUUID();
      return recoveryStrategyVersionSchema.parse({
        schemaVersion: 1,
        strategyId: randomUUID(),
        versionId: randomUUID(),
        version: 1,
        previousVersionId: null,
        status: 'user_confirmed',
        selectedOptionId: option,
        createdAt: '2026-10-01T00:00:00Z',
        draft: {
          title: 'Synthetic bound probe',
          goal: 'Check reference budget',
          startDate: '2026-10-01',
          endDateExclusive: '2026-11-01',
          timezone: 'Asia/Seoul',
          knownFacts: [],
          missingInformation: [],
          priority: 'normal',
          observations: [],
          planRefs: Array.from({ length: 20 }, () => ({
            kind: 'training',
            aggregateId: randomUUID(),
            headVersionId: randomUUID(),
          })),
          options: [
            {
              id: option,
              title: 'Keep',
              kind: 'maintain_existing_plan',
              methodVersionId: null,
              explanation: 'Budget fixture',
            },
          ],
          reassessment: [
            {
              id: randomUUID(),
              trigger: 'plan_changed',
              plannedAt: null,
              description: 'Review',
              policyVersion: null,
            },
          ],
        },
      });
    });
  // References intentionally have no owned target: the bounded scalar preflight must run
  // before either body decoding or per-reference ownership queries.
  await owned(athlete, async (client) => {
    await client.query(
      `INSERT INTO recovery_strategy_version(athlete_id,strategy_id,version_id,version,record_json) SELECT $1,(r->>'strategyId')::uuid,(r->>'versionId')::uuid,1,r FROM jsonb_array_elements($2::jsonb) r`,
      [athlete, JSON.stringify(records)],
    );
    await client.query(
      'INSERT INTO recovery_strategy_head(athlete_id,strategy_id,version,version_id) SELECT athlete_id,strategy_id,version,version_id FROM recovery_strategy_version WHERE athlete_id=$1',
      [athlete],
    );
  });
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'unique_sources',
  });
  expect(measured.bytes()).toBeLessThan(4096);
});

it('strictly rejects missing, unexpected and duplicate dependency kinds before accepting an inventory', () => {
  const valid = integratedDependencyKinds.map((kind) => ({ kind, state: 'present', revision: 0 }));
  expect(decodeIntegratedDependencyInventory(valid)).toEqual(valid);
  for (const bad of [
    valid.slice(1),
    [...valid.slice(1), valid[1]],
    [...valid.slice(1), { kind: 'not_a_dependency', state: 'absent' }],
    valid.map((item, index) => (index === 0 ? { ...item, revision: 2147483648 } : item)),
    valid.map((item, index) => (index === 0 ? { ...item, unexpected: true } : item)),
  ])
    expect(() => decodeIntegratedDependencyInventory(bad)).toThrow('INVALID_CONTEXT');
});

it('distinguishes absent inventory from present zero and sees same-count actual corrections and tombstones', async () => {
  const athlete = await account(),
    event = await create(athlete);
  const absent = await capture(athlete, event.id);
  expect(absent.dependencyInventory).toEqual(
    integratedDependencyKinds.map((kind) => ({ kind, state: 'absent' })),
  );
  await owned(athlete, (client) =>
    client.query('INSERT INTO integrated_dependency_head(athlete_id) VALUES($1)', [athlete]),
  );
  const zero = await capture(athlete, event.id);
  expect(zero.dependencyInventory).toEqual(
    integratedDependencyKinds.map((kind) => ({ kind, state: 'present', revision: 0 })),
  );
  expect(zero.readSetDigest).not.toBe(absent.readSetDigest);
  const activityId = randomUUID();
  await owned(athlete, (client) =>
    client.query(
      'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
      [athlete, activityId, JSON.stringify({ title: 'Synthetic actual', distanceMeters: 0 })],
    ),
  );
  const first = await capture(athlete, event.id);
  await owned(athlete, (client) =>
    client.query(
      'UPDATE activity_canonical SET revision=revision+1,original=$3::jsonb WHERE athlete_id=$1 AND id=$2',
      [athlete, activityId, JSON.stringify({ title: 'Corrected actual', distanceMeters: null })],
    ),
  );
  const corrected = await capture(athlete, event.id);
  expect(corrected.coreDependencies.activities.count).toBe(first.coreDependencies.activities.count);
  expect(corrected.dependencyInventory.find((item) => item.kind === 'activity_revision')).toEqual({
    kind: 'activity_revision',
    state: 'present',
    revision: 2,
  });
  expect(corrected.readSetDigest).not.toBe(first.readSetDigest);
  await owned(athlete, (client) =>
    client.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'fixture',$2,1,$3,$4)",
      [athlete, randomUUID(), 'a'.repeat(64), activityId],
    ),
  );
  await owned(athlete, (client) =>
    client.query(
      'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
      [athlete, activityId],
    ),
  );
  expect(
    (await capture(athlete, event.id)).dependencyInventory.find(
      (item) => item.kind === 'activity_revision',
    ),
  ).toMatchObject({ revision: 3 });
  const other = await account(),
    otherEvent = await create(other);
  expect(
    (await capture(other, otherEvent.id)).dependencyInventory.every(
      (item) => item.state === 'absent',
    ),
  ).toBe(true);
  expect(corrected.coverage.complete).toBe(false);
  expect(corrected.coverage.missing).toContain('complete_catalog_and_actual_manifest');
});

function syntheticExercise(exerciseId: string = randomUUID(), versionId: string = randomUUID()) {
  return supplementaryExerciseVersionSchema.parse({
    schemaVersion: 2,
    exerciseId,
    versionId,
    name: 'Synthetic balance',
    family: 'balance_stability',
    equipment: ['bodyweight'],
    tags: [],
    countDefinitions: [],
    mediaAssetIds: [],
    resourceVersionIds: [],
    reviewState: 'unreviewed',
    description: 'Frozen synthetic catalog',
    safetyNotes: '',
    supportedMetrics: ['duration'],
    createdAt: '2026-10-01T00:00:00Z',
  });
}
function syntheticSpec(exerciseVersionId: string, routineVersionId: string | null = null) {
  return supplementarySpecSchema.parse({
    schemaVersion: 2,
    kind: 'supplementary',
    routineVersionId,
    blocks: [
      {
        id: 'block-one',
        mode: 'single',
        rounds: 1,
        sets: [
          {
            id: 'target-one',
            exerciseVersionId,
            side: 'bilateral',
            count: null,
            durationSeconds: {
              min: 10,
              max: 10,
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
  });
}
async function seedExercise(
  athlete: string,
  definition = syntheticExercise(),
  previous: ReturnType<typeof syntheticExercise> | null = null,
) {
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO supplementary_exercise_version(athlete_id,exercise_id,version_id,version,previous_version_id,previous_version,created_at,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [
        athlete,
        definition.exerciseId,
        definition.versionId,
        previous ? 2 : 1,
        previous?.versionId ?? null,
        previous ? 1 : null,
        definition.createdAt,
        JSON.stringify(definition),
      ],
    );
    if (previous)
      await client.query(
        'UPDATE supplementary_exercise_head SET version=2,version_id=$3 WHERE athlete_id=$1 AND exercise_id=$2',
        [athlete, definition.exerciseId, definition.versionId],
      );
    else
      await client.query(
        'INSERT INTO supplementary_exercise_head(athlete_id,exercise_id,version,version_id) VALUES($1,$2,1,$3)',
        [athlete, definition.exerciseId, definition.versionId],
      );
  });
  return definition;
}
function strengthDraft(count = 1) {
  const body = draft(),
    original = body.sessions[0];
  if (!original) throw new Error('Missing synthetic session');
  return planDraftSchema.parse({
    ...body,
    sessions: Array.from({ length: count }, (_, index) => ({
      ...original,
      id: `strength-${index}`,
      sport: 'strength',
    })),
  });
}
async function seedLink(
  athlete: string,
  planVersionId: string,
  plannedSessionId: string,
  content: unknown,
) {
  const link = supplementarySessionLinkSchema.parse({
    schemaVersion: 2,
    planVersionId,
    plannedSessionId,
    content,
  });
  await owned(athlete, (client) =>
    insertSupplementarySessionLink(
      { athleteId: athlete, query: (sql, parameters) => client.query(sql, parameters) },
      link,
    ),
  );
}
it('captures empty strength links, exact embedded copies and immutable historical references after catalog head changes', async () => {
  const athlete = await account(),
    firstExercise = await seedExercise(athlete);
  const oldPlan = await training(athlete, strengthDraft(), false);
  const current = await training(athlete, strengthDraft());
  const event = await create(athlete, { planVersionId: oldPlan });
  const absent = await capture(athlete, event.id);
  expect(absent.supplementaryManifest.sessions).toHaveLength(2);
  expect(absent.supplementaryManifest.sessions.every((row) => row.state === 'absent')).toBe(true);
  await seedLink(athlete, oldPlan, 'strength-0', {
    kind: 'embedded',
    spec: syntheticSpec(firstExercise.versionId),
  });
  const pinned = await capture(athlete, event.id);
  expect(pinned.supplementaryManifest.copies[0]?.link.planVersionId).toBe(oldPlan);
  expect(pinned.supplementaryManifest.exercises).toMatchObject([
    { exerciseId: firstExercise.exerciseId, versionId: firstExercise.versionId, version: 1 },
  ]);
  expect(pinned.readSetDigest).not.toBe(absent.readSetDigest);
  await seedExercise(athlete, syntheticExercise(firstExercise.exerciseId), firstExercise);
  const advanced = await capture(athlete, event.id);
  expect(advanced.supplementaryManifest).toEqual(pinned.supplementaryManifest);
  expect(advanced.readSetDigest).not.toBe(pinned.readSetDigest);
  expect(advanced.currentTraining?.snapshot.id).toBe(current);
  await expect(
    owned(athlete, (client) =>
      client.query(
        'UPDATE supplementary_exercise_version SET record_json=record_json WHERE athlete_id=$1 AND version_id=$2',
        [athlete, firstExercise.versionId],
      ),
    ),
  ).rejects.toThrow('IMMUTABLE_SUPPLEMENTARY_RECORD');
  expect(advanced.coverage.missing).toHaveLength(5);
});

it('captures exact routine frozen target copies and rejects an unexpected actual SQL target reference', async () => {
  const athlete = await account(),
    exercise = await seedExercise(athlete);
  const routineId = randomUUID(),
    versionId = randomUUID();
  const template = routineTemplateVersionSchema.parse({
    schemaVersion: 2,
    routineId,
    versionId,
    title: 'Synthetic frozen routine',
    purpose: 'Synthetic source',
    requiredEquipment: ['bodyweight'],
    spec: syntheticSpec(exercise.versionId, versionId),
    createdAt: '2026-10-01T00:00:00Z',
  });
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO supplementary_routine_version(athlete_id,routine_id,version_id,version,created_at,record_json) VALUES($1,$2,$3,1,$4,$5::jsonb)',
      [athlete, routineId, versionId, template.createdAt, JSON.stringify(template)],
    );
    await client.query(
      'INSERT INTO supplementary_routine_head(athlete_id,routine_id,version,version_id) VALUES($1,$2,1,$3)',
      [athlete, routineId, versionId],
    );
  });
  const plan = await training(athlete, strengthDraft()),
    event = await create(athlete);
  await seedLink(athlete, plan, 'strength-0', {
    kind: 'routine_version',
    routineVersionId: versionId,
  });
  const captured = await capture(athlete, event.id);
  expect(captured.supplementaryManifest.routines).toMatchObject([
    { routineId, versionId, version: 1 },
  ]);
  expect(captured.supplementaryManifest.copies[0]?.targets).toEqual([
    { block_id: 'block-one', target_set_id: 'target-one', exercise_version_id: exercise.versionId },
  ]);
  await owned(athlete, (client) =>
    client.query(
      'INSERT INTO supplementary_session_target_ref(athlete_id,plan_version_id,planned_session_id,block_id,target_set_id,exercise_version_id) VALUES($1,$2,$3,$4,$5,$6)',
      [athlete, plan, 'strength-0', 'block-one', 'unexpected-target', exercise.versionId],
    ),
  );
  await expect(capture(athlete, event.id)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});

it('does not expose another tenant catalog body or accept its immutable version reference', async () => {
  const foreign = await account(),
    foreignExercise = await seedExercise(foreign);
  const athlete = await account(),
    plan = await training(athlete, strengthDraft()),
    event = await create(athlete);
  await expect(
    seedLink(athlete, plan, 'strength-0', {
      kind: 'embedded',
      spec: syntheticSpec(foreignExercise.versionId),
    }),
  ).rejects.toThrow('TARGET_LINK_INVALID');
  expect((await capture(athlete, event.id)).supplementaryManifest.exercises).toEqual([]);
  const rows = await database.tenant(athlete, (tx) =>
    tx.query('SELECT record_json FROM supplementary_exercise_version WHERE version_id=$1', [
      foreignExercise.versionId,
    ]),
  );
  expect(rows.rows).toEqual([]);
});

it('rejects5001 supplementary target rows by scalar preflight before transporting any copy body', async () => {
  const athlete = await account(),
    exercise = await seedExercise(athlete),
    plan = await training(athlete, strengthDraft()),
    event = await create(athlete);
  await seedLink(athlete, plan, 'strength-0', {
    kind: 'embedded',
    spec: syntheticSpec(exercise.versionId),
  });
  // Plain owner adds adversarial extra rows without disabling the real FK/immutable triggers.
  await owned(athlete, (client) =>
    client.query(
      "INSERT INTO supplementary_session_target_ref(athlete_id,plan_version_id,planned_session_id,block_id,target_set_id,exercise_version_id) SELECT $1,$2,'strength-0','block-one','extra-'||i,$3 FROM generate_series(1,5000) i",
      [athlete, plan, exercise.versionId],
    ),
  );
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'unique_sources',
  });
  expect(measured.bytes()).toBeLessThan(4096);
  expect(
    measured.queries.some((item) =>
      item.sql.startsWith('SELECT plan_version_id,planned_session_id,content_kind'),
    ),
  ).toBe(false);
});

it('includes embedded frozen bodies in the shared4MiB budget before DTO decode', async () => {
  const athlete = await account(),
    exercise = await seedExercise(athlete),
    plan = await training(athlete, strengthDraft(100)),
    event = await create(athlete);
  const base = syntheticSpec(exercise.versionId),
    block = base.blocks[0];
  if (!block?.sets[0]) throw new Error('Missing synthetic target');
  const set = block.sets[0];
  const large = supplementarySpecSchema.parse({
    ...base,
    blocks: [
      {
        ...block,
        sets: [
          {
            ...set,
            durationSeconds: {
              min: 10,
              max: 10,
              unit: 's',
              basis: 'user_confirmed',
              evidenceIds: Array.from(
                { length: 400 },
                (_, index) => `synthetic-${index}-${'x'.repeat(128)}`,
              ),
            },
          },
        ],
      },
    ],
  });
  await owned(athlete, async (client) => {
    await client.query(
      "INSERT INTO supplementary_session_link(athlete_id,plan_version_id,planned_session_id,content_kind,routine_version_id,embedded_spec_json) SELECT $1,$2,'strength-'||i,'embedded',NULL,$3::jsonb FROM generate_series(0,99) i",
      [athlete, plan, JSON.stringify(large)],
    );
  });
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'decoded_bytes',
  });
  expect(measured.bytes()).toBeLessThan(4096);
  expect(
    measured.queries.some((item) =>
      item.sql.startsWith('SELECT plan_version_id,planned_session_id,content_kind'),
    ),
  ).toBe(false);
}, 30000);

it('fails closed on int4 dependency overflow and rolls back the actual mutation', async () => {
  const athlete = await account(),
    event = await create(athlete),
    activityId = randomUUID();
  await owned(athlete, async (client) => {
    await client.query(
      "INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,'{}'::jsonb)",
      [athlete, activityId],
    );
    await client.query(
      'UPDATE integrated_dependency_head SET activity_revision=2147483647 WHERE athlete_id=$1',
      [athlete],
    );
  });
  const before = await capture(athlete, event.id);
  await expect(
    owned(athlete, (client) =>
      client.query('UPDATE activity_canonical SET revision=2 WHERE athlete_id=$1 AND id=$2', [
        athlete,
        activityId,
      ]),
    ),
  ).rejects.toMatchObject({ code: '22003' });
  expect((await capture(athlete, event.id)).readSetDigest).toBe(before.readSetDigest);
});

it('reads all12 real head columns distinctly without treating zero or unrelated tenant heads as absent', async () => {
  const athlete = await account(),
    event = await create(athlete);
  await owned(athlete, async (client) => {
    await client.query('INSERT INTO integrated_dependency_head(athlete_id) VALUES($1)', [athlete]);
    // Synthetic inventory fixture, not a claim that this test invokes all12 domain producers.
    await client.query(
      `UPDATE integrated_dependency_head SET ${integratedDependencyKinds.map((kind, index) => `${kind}=${index}`).join(',')} WHERE athlete_id=$1`,
      [athlete],
    );
  });
  expect((await capture(athlete, event.id)).dependencyInventory).toEqual(
    integratedDependencyKinds.map((kind, index) => ({ kind, state: 'present', revision: index })),
  );
});
