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
import { createConsentRepository } from '../src/repositories.js';
import { prepareRaceManualReview } from '../src/race-manual-review-preparation.js';
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
  dbName = `race_prepare_${suffix}`,
  ownerRole = `race_prepare_owner_${suffix}`,
  runtimeRole = `race_prepare_app_${suffix}`;
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
// Synthetic tenant source fixtures use plain owner+tenant context, not browser facts.
const prepare = (athlete: string, eventId: string, revision = 1) =>
  database.tenant(athlete, (tx) => prepareRaceManualReview(tx, intent(eventId, revision)));
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

function record(
  source: string | null,
  anchors: { entity: 'session' | 'race'; entityId: string }[],
): NutritionPlanVersion {
  const versionId = randomUUID();
  return nutritionPlanVersionSchema.parse({
    planId: randomUUID(),
    versionId,
    version: 1,
    previousVersionId: null,
    period: { from: '2026-10-01', toInclusive: '2026-10-31' },
    timezone: 'Asia/Seoul',
    purpose: 'Synthetic preparation',
    linkedTrainingPlanVersionId: source,
    approvedAt: '2026-10-01T00:00:00Z',
    approvalId: randomUUID(),
    items: anchors.map((anchor, index) => ({
      id: `item-${index}`,
      planVersionId: versionId,
      category: 'before',
      title: 'Synthetic timing',
      anchor: { kind: 'relative', ...anchor, point: 'start', offsetMinutes: 0 },
      foods: [],
      targets: [],
      instructions: 'Synthetic',
      evidenceIds: [],
      source: 'user_confirmed',
    })),
  });
}
it('prepares only a blocked, unstored own review using normal105 real capture and actual integrity/calculations', async () => {
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
  const result = await prepare(athlete, event.id),
    again = await prepare(athlete, event.id);
  expect(result.status).toBe('prepared_blocked');
  if (result.status !== 'prepared_blocked' || again.status !== 'prepared_blocked')
    throw new Error('Expected blocked preparation');
  expect(result).toMatchObject({
    storage: 'not_persisted',
    sourceCompleteness: 'unverified',
    approvalAllowed: false,
    integrity: { status: 'consistent', sourceCompleteness: 'unverified', admissionAllowed: false },
    context: { athleteId: athlete, coverage: { complete: false } },
  });
  expect(result.candidate.digest).toBe(again.candidate.digest);
  expect(result.binding.readSetDigest).toBe(result.context.readSetDigest);
  expect(result.sourceInput.athleteId).toBe(athlete);
  expect(result.candidate.body.approval.status).toBe('blocked');
  expect(Object.isFrozen(result.candidate.body)).toBe(true);
  expect(await counts(athlete)).toEqual(before);
});
it('rejects browser capture, digests and affected ID authority and preserves foreign/CAS boundaries', async () => {
  const athlete = await account(),
    other = await account(),
    event = await create(athlete);
  const before = await counts(athlete);
  for (const extra of [
    { sourceFacts: {} },
    { context: {} },
    { readSetDigest: 'a'.repeat(64) },
    { changedSessionIds: ['session'] },
    { approvalAllowed: true },
  ])
    await expect(
      database.tenant(athlete, (tx) =>
        prepareRaceManualReview(tx, { ...intent(event.id), ...extra }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
  await expect(prepare(other, event.id)).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await expect(prepare(athlete, randomUUID())).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await expect(prepare(athlete, event.id, 2)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await counts(athlete)).toEqual(before);
});
it('absent and withdrawn app permission deny preparation without a new consent or write', async () => {
  const own = await account(),
    event = await create(own);
  for (const grant of [null, false]) {
    const athlete = await account(grant),
      before = await counts(athlete);
    await expect(prepare(athlete, event.id)).rejects.toMatchObject({
      code: 'APP_CONSENT_REQUIRED',
    });
    expect(await counts(athlete)).toEqual(before);
  }
});
it('retains exact historical Plan and other-race before/after sources without upgrading legacy pins', async () => {
  const athlete = await account(),
    historical = await training(athlete, draft(), false),
    current = await training(athlete),
    event = await create(athlete, { planVersionId: historical, localStartTime: '08:00:00' }),
    other = await create(athlete, { localDate: '2026-10-10', localStartTime: '09:00:00' });
  const nutrition = record(historical, [{ entity: 'race', entityId: other.id }]);
  await seedNutrition(athlete, [nutrition]);
  const before = await counts(athlete),
    result = await prepare(athlete, event.id);
  if (result.status !== 'prepared_blocked') throw new Error('Expected blocked preparation');
  expect(result.context.currentTraining?.snapshot.id).toBe(current);
  expect(result.context.consumedSources.plans.map((plan) => plan.id)).toEqual(
    [historical, current].sort(),
  );
  expect(result.sourceInput.projectionInput.sourcePlans.map((plan) => plan.id)).toContain(
    historical,
  );
  expect(result.sourceInput.projectionInput.nutrition[0]?.timings).toEqual([
    { itemId: 'item-0', timing: { state: 'resolved', date: '2026-10-10', localTime: '09:00:00' } },
  ]);
  expect(result.candidate.body.nutrition[0]?.items).toMatchObject([
    {
      state: 'unchanged',
      before: { state: 'resolved', date: '2026-10-10', localTime: '09:00:00' },
      after: { state: 'resolved', date: '2026-10-10', localTime: '09:00:00' },
    },
  ]);
  expect(result.sourceInput.sourceFacts.nutritionRacePins[0]?.binding.state).toBe(
    'legacy_unpinned',
  );
  expect(result.missingFacts).toContainEqual(
    expect.objectContaining({ kind: 'immutable_race_pin' }),
  );
  expect(await counts(athlete)).toEqual(before);
});
it('derives and recaptures move-period affected IDs while preparation stays in its caller-owned transaction', async () => {
  const athlete = await account(),
    plan = await training(athlete),
    event = await create(athlete, { planVersionId: plan });
  await seedNutrition(athlete, [record(plan, [{ entity: 'session', entityId: 'session' }])]);
  const before = await counts(athlete);
  const result = await database.tenant(athlete, async (tx) => {
    const first = await tx.query('SELECT txid_current()::text AS id');
    const prepared = await prepareRaceManualReview(tx, {
      ...intent(event.id),
      selection: {
        kind: 'move_period',
        expectedCurrentPlanVersionId: plan,
        periodId: 'block',
        newStartDate: '2026-10-03',
        scope: 'descendants_and_sessions',
      },
    });
    const last = await tx.query('SELECT txid_current()::text AS id');
    expect(last.rows).toEqual(first.rows);
    return prepared;
  });
  if (result.status !== 'prepared_blocked') throw new Error('Expected blocked preparation');
  expect(result.context.affected.nutrition).toHaveLength(1);
  expect(result.candidate.body.calendar.sessionDiffs).toMatchObject([
    { id: 'session', beforeDate: '2026-10-06', afterDate: '2026-10-08' },
  ]);
  expect(result.candidate.body.resolution.requiresResolution).toBe(true);
  expect(await counts(athlete)).toEqual(before);
});
it('unaffected old unresolved has a notice but affected old unresolved still requires resolution', async () => {
  const athlete = await account(),
    plan = await training(athlete),
    event = await create(athlete);
  await seedNutrition(athlete, [
    record(plan, [
      { entity: 'session', entityId: 'session' },
      { entity: 'race', entityId: event.id },
    ]),
  ]);
  const result = await prepare(athlete, event.id);
  if (result.status !== 'prepared_blocked') throw new Error('Expected blocked preparation');
  expect(result.candidate.body.resolution.preservedNotices).toContainEqual(
    expect.objectContaining({ reason: 'existing_unresolved_preserved', itemId: 'item-0' }),
  );
  expect(result.candidate.body.resolution.blocking).toContainEqual(
    expect.objectContaining({
      reason: 'affected_unresolved_requires_resolution',
      itemId: 'item-1',
    }),
  );
  expect(result.integrity.resolution).toBe('requires_resolution');
});
it('withdrawal committed before preparation acquires tenant0 blocks the entire server composition', async () => {
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
    const pending = prepare(athlete, event.id).then(
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
it('preparation retains app lock until caller commit, then subsequent preparation denies revoked processing', async () => {
  const athlete = await account(),
    event = await create(athlete),
    ready = deferred(),
    release = deferred();
  const pending = database.tenant(athlete, async (tx) => {
    const value = await prepareRaceManualReview(tx, intent(event.id));
    ready.resolve();
    await release.promise;
    return value;
  });
  await ready.promise;
  const withdrawal = createConsentRepository(database).setConsent(athlete, {
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
  expect((await pending).context.manualBasis.app).toMatchObject({ granted: true, revision: 1 });
  await withdrawal;
  await expect(prepare(athlete, event.id)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
});
it('concurrent event mutation waits until caller completes preparation and makes the old expectation stale', async () => {
  const athlete = await account(),
    event = await create(athlete),
    ready = deferred(),
    release = deferred();
  const pending = database.tenant(athlete, async (tx) => {
    const value = await prepareRaceManualReview(tx, intent(event.id));
    ready.resolve();
    await release.promise;
    return value;
  });
  await ready.promise;
  const changed = races.updateRaceEvent(athlete, event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values(), title: 'Changed synthetic event' },
  });
  try {
    await waiting();
  } finally {
    release.resolve();
  }
  expect((await pending).context.event.revision).toBe(1);
  await changed;
  await expect(prepare(athlete, event.id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await prepare(athlete, event.id, 2)).context.event.title).toBe('Changed synthetic event');
});

it('event mutation committed before preparation acquires its lock rejects the stale expected revision', async () => {
  const athlete = await account(),
    event = await create(athlete),
    ready = deferred(),
    release = deferred();
  const held: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, async (tx) => {
        const value = await operation(tx);
        ready.resolve();
        await release.promise;
        return value;
      }),
  };
  const mutation = createRaceRepository(held).updateRaceEvent(athlete, event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values(), title: 'Committed before preparation' },
  });
  await ready.promise;
  const pending = prepare(athlete, event.id).then(
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
