import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  nutritionPlanVersionSchema,
  type NutritionPlanVersion,
} from '@workout/contracts/nutrition-core';
import { planDraftSchema } from '@workout/contracts/planning';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { captureRacePlanImpactContext } from '../src/race-plan-impact-context.js';
import { buildRacePlanImpactProjectionInput } from '../src/race-plan-impact-projection-input.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRacePlanImpactPreviewService } from '../src/race-plan-impact-preview.js';
import {
  migrate,
  grantCorePlanning,
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
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  dbName = `race_preview_${suffix}`,
  ownerRole = `race_preview_owner_${suffix}`,
  runtimeRole = `race_preview_app_${suffix}`;
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
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
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
async function account(granted: boolean | null = true) {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  if (granted !== null)
    await createConsentRepository(database).setConsent(athlete, {
      kind: 'app',
      granted,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
  return athlete;
}
const create = (athlete: string, override: Partial<RaceEventValues> = {}) =>
  races.createRaceEvent(athlete, {
    values: { ...values(), ...override },
    idempotencyKey: randomUUID(),
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
      endDateExclusive: level === 'block' ? '2026-10-20' : '2026-11-01',
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
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole));
  owner = new Pool({ connectionString: url(ownerRole) });
  await grantCorePlanning(url(ownerRole), runtimeRole);
  await grantOperations(url(ownerRole), runtimeRole);
  await grantRaces(url(ownerRole), runtimeRole);
  // The configured identity runtime uses these same domain grants; no fixture-only SELECT.
  await grantRoutineCore(url(ownerRole), runtimeRole);
  await grantRecoveryCore(url(ownerRole), runtimeRole);
  await grantCheckIns(url(ownerRole), runtimeRole);
  await grantCourses(url(ownerRole), runtimeRole);
  await grantNutritionCore(url(ownerRole), runtimeRole);
  // Same regular resources/retrieval combination as the configured authenticated runtime.
  await grantResources(url(ownerRole), runtimeRole);
  await grantResourceRetrieval(url(ownerRole), runtimeRole);
  // Existing configured product role composition, not collector-only privilege fabrication.
  await grantGalleryMedia(url(ownerRole), runtimeRole);
  await grantGarminUnofficial(url(ownerRole), runtimeRole);
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
const preview = (athlete: string, eventId: string, revision = 1) =>
  createRacePlanImpactPreviewService(database).preview(athlete, intent(eventId, revision));
const intent = (id: string, revision = 1) => ({
  expectedEvent: { id, revision },
  newLocalDate: '2026-10-08',
  selection: { kind: 'keep_plan' },
});
async function counts(athlete: string) {
  return owned(athlete, async (client) => {
    const names = [
      'plan_snapshot',
      'plan_history',
      'command_receipt',
      'race_command_receipt',
      'outbox',
      'session_completion',
      'activity_canonical',
    ];
    const rows: [string, unknown][] = [];
    for (const name of names) {
      const row = await client.query(`SELECT count(*)::int AS n FROM ${name} WHERE athlete_id=$1`, [
        athlete,
      ]);
      rows.push([name, row.rows[0]?.n]);
    }
    return Object.fromEntries(rows);
  });
}
async function waiting() {
  const end = Date.now() + 2500;
  while (Date.now() < end) {
    const result = await admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'",
      [runtimeRole],
    );
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('EXPECTED_REAL_ADVISORY_WAITER');
}
function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: () => {
      if (!resolve) throw new Error('MISSING_BARRIER');
      resolve();
    },
  };
}
it('uses normal105 and real collector/calculator without writes, receipts, approval or complete coverage', async () => {
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS n,max(version)::int AS last FROM schema_migrations',
      )
    ).rows[0],
  ).toEqual({ n: 105, last: 105 });
  const athlete = await account(),
    event = await create(athlete),
    before = await counts(athlete);
  const result = await preview(athlete, event.id),
    again = await preview(athlete, event.id);
  expect(result.context.event.id).toBe(event.id);
  expect(result.context.coverage.complete).toBe(false);
  expect(result.projection).toMatchObject({
    status: 'projected',
    approvalAllowed: false,
    coverageComplete: false,
  });
  expect(result.context.readSetDigest).toBe(again.context.readSetDigest);
  if (result.projection.status === 'projected')
    expect(result.projection.readSetDigest).toBe(result.context.readSetDigest);
  expect(await counts(athlete)).toEqual(before);
});
it('rejects absent/false app processing before ownership without creating consent', async () => {
  const ownerAthlete = await account(),
    event = await create(ownerAthlete);
  for (const granted of [null, false]) {
    const athlete = await account(granted),
      before = await counts(athlete);
    await expect(preview(athlete, event.id)).rejects.toMatchObject({
      code: 'APP_CONSENT_REQUIRED',
    });
    expect(await counts(athlete)).toEqual(before);
  }
});
it('rejects malformed and browser injected captures/affected IDs using the exported strict intent decoder', async () => {
  const athlete = await account(),
    event = await create(athlete),
    service = createRacePlanImpactPreviewService(database);
  for (const extra of [
    { sourceFacts: {} },
    { readSetDigest: 'a'.repeat(64) },
    { changedSessionIds: ['session'] },
    { expectedEvent: { id: event.id, revision: 0 } },
  ])
    await expect(service.preview(athlete, { ...intent(event.id), ...extra })).rejects.toMatchObject(
      { code: 'INVALID_INTENT' },
    );
});
it('preserves owned event absence/foreign/revision and current Plan CAS errors', async () => {
  const athlete = await account(),
    foreign = await account(),
    event = await create(athlete);
  await expect(preview(foreign, event.id)).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await expect(preview(athlete, randomUUID())).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await expect(preview(athlete, event.id, 2)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(
    createRacePlanImpactPreviewService(database).preview(athlete, {
      ...intent(event.id),
      selection: {
        kind: 'move_period',
        expectedCurrentPlanVersionId: randomUUID(),
        periodId: 'block',
        newStartDate: '2026-10-03',
        scope: 'descendants_and_sessions',
      },
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('derives move-period IDs on the server and recaptures sources in the same actual transaction', async () => {
  const athlete = await account(),
    plan = await training(athlete),
    event = await create(athlete, { planVersionId: plan }),
    before = await counts(athlete);
  const result = await createRacePlanImpactPreviewService(database).preview(athlete, {
    ...intent(event.id),
    selection: {
      kind: 'move_period',
      expectedCurrentPlanVersionId: plan,
      periodId: 'block',
      newStartDate: '2026-10-03',
      scope: 'descendants_and_sessions',
    },
  });
  expect(result.projection).toMatchObject({
    status: 'projected',
    collectorSelection: {
      kind: 'move_period',
      changedSessionIds: ['session'],
      movedPeriodIds: ['block'],
    },
    approvalAllowed: false,
    coverageComplete: false,
  });
  expect(result.context.currentTraining?.snapshot.id).toBe(plan);
  expect(await counts(athlete)).toEqual(before);
});
it('withdrawal committed while preview waits on tenant0 rejects new processing', async () => {
  const athlete = await account(),
    event = await create(athlete),
    client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    await client.query(
      "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='app'",
      [athlete],
    );
    const pending = preview(athlete, event.id).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waiting();
    await client.query('COMMIT');
    expect(await pending).toMatchObject({ error: { code: 'APP_CONSENT_REQUIRED' } });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
it('preview commit precedes concurrent withdrawal; later preview is denied (real Tx barrier only)', async () => {
  const athlete = await account(),
    event = await create(athlete),
    ready = deferred(),
    release = deferred();
  const held: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, async (tx) => {
        const result = await operation(tx);
        ready.resolve();
        await release.promise;
        return result;
      }),
  };
  const pending = createRacePlanImpactPreviewService(held).preview(athlete, intent(event.id));
  await ready.promise;
  const withdrawing = createConsentRepository(database).setConsent(athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  try {
    await waiting();
  } finally {
    release.resolve();
  }
  expect((await pending).context.manualBasis.app).toMatchObject({
    state: 'present',
    granted: true,
    revision: 1,
  });
  await withdrawing;
  await expect(preview(athlete, event.id)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
});
it('event mutation commits after a captured preview, then stale expected revision fails', async () => {
  const athlete = await account(),
    event = await create(athlete),
    ready = deferred(),
    release = deferred();
  const held: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, async (tx) => {
        const result = await operation(tx);
        ready.resolve();
        await release.promise;
        return result;
      }),
  };
  const pending = createRacePlanImpactPreviewService(held).preview(athlete, intent(event.id));
  await ready.promise;
  const mutation = races.updateRaceEvent(athlete, event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values(), title: 'Committed changed event' },
  });
  try {
    await waiting();
  } finally {
    release.resolve();
  }
  expect((await pending).context.event.revision).toBe(1);
  await mutation;
  await expect(preview(athlete, event.id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await preview(athlete, event.id, 2)).context.event.title).toBe('Committed changed event');
});

it('rejects combined output above4MiB even when the captured source and builder input fit separately', async () => {
  const athlete = await account(),
    event = await create(athlete);
  const records = Array.from({ length: 5 }, () => {
    const versionId = randomUUID();
    return nutritionPlanVersionSchema.parse({
      planId: randomUUID(),
      versionId,
      version: 1,
      previousVersionId: null,
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Synthetic bounded schedule',
      linkedTrainingPlanVersionId: null,
      approvedAt: '2026-10-01T00:00:00Z',
      approvalId: randomUUID(),
      items: Array.from({ length: 200 }, (_, index) => ({
        id: `bounded-${index}`,
        planVersionId: versionId,
        category: 'before',
        title: 'Synthetic note',
        anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
        foods: [],
        targets: [],
        instructions: 'x'.repeat(2000),
        evidenceIds: [],
        source: 'user_confirmed',
      })),
    });
  });
  await seedNutrition(athlete, records);
  const context = await database.tenant(athlete, (tx) =>
    captureRacePlanImpactContext(tx, {
      eventId: event.id,
      expectedRevision: 1,
      selection: { kind: 'keep_plan' },
    }),
  );
  expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThan(4194304);
  const projection = buildRacePlanImpactProjectionInput(context, intent(event.id));
  expect(projection.status).toBe('projected');
  expect(Buffer.byteLength(JSON.stringify({ context, projection }), 'utf8')).toBeGreaterThan(
    4194304,
  );
  const before = await counts(athlete);
  await expect(preview(athlete, event.id)).rejects.toMatchObject({
    code: 'CONTEXT_LIMIT',
    bound: 'decoded_bytes',
  });
  expect(await counts(athlete)).toEqual(before);
}, 60000);
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

it('concurrent event commit before capture preserves expected revision conflict', async () => {
  const athlete = await account(),
    event = await create(athlete),
    ready = deferred(),
    release = deferred();
  const held: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, async (tx) => {
        const result = await operation(tx);
        ready.resolve();
        await release.promise;
        return result;
      }),
  };
  const mutation = createRaceRepository(held).updateRaceEvent(athlete, event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values(), title: 'Committed before preview' },
  });
  await ready.promise;
  const pending = preview(athlete, event.id).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await waiting();
  } finally {
    release.resolve();
  }
  await mutation;
  expect(await pending).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
});
it('actual lock timeout rolls back and returns sanitized typed failure; later preview recovers', async () => {
  const athlete = await account(),
    event = await create(athlete),
    client = await owner.connect(),
    before = await counts(athlete);
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    await expect(preview(athlete, event.id)).rejects.toMatchObject({
      name: 'RacePlanImpactPreviewError',
      message: 'CONTEXT_UNAVAILABLE',
      code: 'CONTEXT_UNAVAILABLE',
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  expect((await preview(athlete, event.id)).context.event.id).toBe(event.id);
  expect(await counts(athlete)).toEqual(before);
});
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

it('previews exact historical Plan and other-race timing from server consumed sources without head substitution', async () => {
  const athlete = await account(),
    historicalBody = draft();
  const session = historicalBody.sessions[0];
  if (!session) throw new Error('MISSING_SYNTHETIC_SESSION');
  const historical = await training(
    athlete,
    planDraftSchema.parse({
      ...historicalBody,
      sessions: [
        {
          ...session,
          date: '2026-10-07',
          localStartTime: '07:00:00',
          notes: 'Synthetic historical body',
        },
      ],
    }),
    false,
  );
  const current = await training(athlete),
    event = await create(athlete, { planVersionId: historical }),
    other = await create(athlete, { localDate: '2026-10-08', localStartTime: '08:00:00' });
  await seedNutrition(athlete, [
    nutrition(historical, [
      { entity: 'race', entityId: other.id },
      { entity: 'session', entityId: 'session' },
    ]),
  ]);
  const before = await counts(athlete),
    result = await preview(athlete, event.id);
  expect(result.context.consumedSources.plans.map((row) => row.id).sort()).toEqual(
    [historical, current].sort(),
  );
  expect(result.context.consumedSources.races.map((row) => row.id).sort()).toEqual(
    [event.id, other.id].sort(),
  );
  expect(
    result.context.consumedSources.plans.find((row) => row.id === historical)?.draft.sessions[0]
      ?.date,
  ).toBe('2026-10-07');
  expect(result.projection.status).toBe('projected');
  if (result.projection.status !== 'projected') throw new Error('EXPECTED_SYNTHETIC_PROJECTION');
  expect(
    result.projection.input.sourcePlans.find((row) => row.id === historical)?.draft.sessions[0]
      ?.date,
  ).toBe('2026-10-07');
  expect(result.projection.input.nutrition[0]?.timings).toEqual([
    { itemId: 'item0', timing: { state: 'resolved', date: '2026-10-08', localTime: '08:00:00' } },
    { itemId: 'item1', timing: { state: 'resolved', date: '2026-10-07', localTime: '07:00:00' } },
  ]);
  expect(result.projection.missingFacts).toContainEqual({
    kind: 'immutable_race_pin',
    id: JSON.stringify([result.projection.input.nutrition[0]?.record.versionId, 'item0']),
  });
  expect(result.projection).toMatchObject({
    coverageComplete: false,
    approvalAllowed: false,
    readSetDigest: result.context.readSetDigest,
  });
  expect(await counts(athlete)).toEqual(before);
});
