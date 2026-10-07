import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { planSnapshotSchema, type PlanSnapshot } from '@workout/contracts/planning';
import { readTrainingPlanAggregateSource } from '../src/training-plan-aggregate-source.js';
import { captureRaceImpactSourcePermissions } from '../src/race-plan-impact-source-permissions.js';
import { Pool, type PoolClient } from 'pg';
import { createOperationsRepository } from '../src/operations.js';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { createDatabase, type Database } from '../src/database.js';
import { createPlanningRepository } from '../src/planning.js';
import { createConsentRepository } from '../src/repositories.js';
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
// Normal107 public saves → explicit staged112. Mapping is ownership lineage,
// never full approval freshness or storage/restore readiness.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `training_history_${suffix}`,
  ownerRole = `training_history_owner_${suffix}`,
  runtimeRole = `training_history_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
let created = false,
  db: Database;
const historicalAthlete = randomUUID();
let oldFirst: PlanSnapshot, oldCurrent: PlanSnapshot, aggregateId: string;
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
  await app(historicalAthlete, true);
  const planning = createPlanningRepository(db);
  oldFirst = await planning.save(historicalAthlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  oldCurrent = await planning.save(historicalAthlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: oldFirst.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'Second synthetic plan' },
  });
  aggregateId = await db.tenant(historicalAthlete, async (tx) =>
    z
      .uuid()
      .parse(
        (
          await tx.query(
            'SELECT aggregate_id FROM plan_head WHERE athlete_id=$1 AND version_id=$2',
            [historicalAthlete, oldCurrent.id],
          )
        ).rows[0]?.['aggregate_id'],
      ),
  );
  const installer = new Pool({ connectionString: url(ownerRole) });
  try {
    await installer.query(
      await readFile(
        new URL('../migrations/112_training_plan_aggregate_history.sql', import.meta.url),
        'utf8',
      ),
    );
  } finally {
    await installer.end();
  }
  // Root integrates the narrow EXECUTE into the regular grant, no private table grant.
  await grantCorePlanning(url(ownerRole), runtimeRole);
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function app(athlete: string, granted: boolean) {
  const repo = createConsentRepository(db),
    old = await repo.getConsent(athlete, 'app');
  return repo.setConsent(athlete, {
    kind: 'app',
    granted,
    expectedRevision: old?.revision ?? 0,
    idempotencyKey: randomUUID(),
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

const ref = (planId: string, versionId: string, itemId = 'session') => ({
  domain: 'training' as const,
  planId,
  versionId,
  itemId,
});
async function facts(
  athlete: string,
  plannedRefs: ReturnType<typeof ref>[],
  visited: string[] = [],
  corrupt = false,
) {
  return db.tenant(athlete, (tx) =>
    captureRaceImpactSourcePermissions(tx, {
      plannedRefs,
      resourceVersionIds: [],
      baseBytes: 0n,
      existingSourceCount: 0,
      sources: {
        async plan(versionId) {
          visited.push(versionId);
          const rows = (
            await tx.query(
              'SELECT id,version,created_at,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2::uuid LIMIT 2',
              [tx.athleteId, versionId],
            )
          ).rows;
          if (rows.length !== 1) throw Error('FIXTURE_EXACT_OWN_PLAN_UNAVAILABLE');
          const row = rows[0];
          if (!row) throw Error('FIXTURE_EXACT_OWN_PLAN_UNAVAILABLE');
          const snapshot = planSnapshotSchema.parse({
            id: row['id'],
            version: row['version'],
            draft: row['draft'],
            createdAt: z.date().parse(row['created_at']).toISOString(),
          });
          return corrupt
            ? { ...snapshot, draft: { ...snapshot.draft, title: 'Synthetic mismatched cache' } }
            : snapshot;
        },
        async race() {
          throw Error('UNEXPECTED_FIXTURE_RACE_READ');
        },
      },
    }),
  );
}
it('migration backfills only actual current association; pre-migration historical identity remains unknown', async () => {
  expect(
    await db.tenant(historicalAthlete, (tx) => readTrainingPlanAggregateSource(tx, oldFirst.id)),
  ).toBeNull();
  expect(
    await db.tenant(historicalAthlete, (tx) => readTrainingPlanAggregateSource(tx, oldCurrent.id)),
  ).toEqual({ versionId: oldCurrent.id, aggregateId });
  const unresolved = await facts(historicalAthlete, [ref(aggregateId, oldFirst.id)]);
  expect(unresolved.planned[0]).toMatchObject({
    state: 'unavailable',
    reason: 'aggregate_identity_unavailable',
    content: null,
  });
});
it('normal public successor saves immutable mapping for all subsequent versions and exact historical session membership', async () => {
  const next = await createPlanningRepository(db).save(historicalAthlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: oldCurrent.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'Third synthetic plan' },
  });
  expect(
    await db.tenant(historicalAthlete, (tx) => readTrainingPlanAggregateSource(tx, next.id)),
  ).toEqual({ versionId: next.id, aggregateId });
  const visited: string[] = [];
  const actual = await facts(
    historicalAthlete,
    [ref(aggregateId, oldCurrent.id), ref(aggregateId, next.id)],
    visited,
  );
  expect([...visited].sort()).toEqual([oldCurrent.id, next.id].sort());
  await expect(
    facts(historicalAthlete, [ref(aggregateId, oldCurrent.id)], [], true),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(actual.complete).toBe(false);
  expect(actual.planned).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requested: ref(aggregateId, oldCurrent.id),
        state: 'historical',
        reason: null,
        aggregateIdentity: 'immutable_version',
        currentHead: { aggregate_id: aggregateId, version_id: next.id },
      }),
      expect.objectContaining({
        requested: ref(aggregateId, next.id),
        state: 'current',
        reason: null,
        aggregateIdentity: 'immutable_version',
      }),
    ]),
  );
  expect(actual.planned.every((f) => f.content !== null)).toBe(true);
});
it('wrong aggregate/missing session/foreign/absent references disclose no content and cannot claim association', async () => {
  const visited: string[] = [];
  const wrong = await facts(
    historicalAthlete,
    [ref(randomUUID(), oldCurrent.id), ref(aggregateId, oldCurrent.id, 'missing')],
    visited,
  );
  expect(visited).toEqual([]);
  expect(wrong.planned).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        state: 'unavailable',
        reason: 'aggregate_identity_unavailable',
        content: null,
      }),
      expect.objectContaining({ state: 'unavailable', reason: 'item_unavailable', content: null }),
    ]),
  );
  const foreign = randomUUID();
  await app(foreign, true);
  expect(
    await db.tenant(foreign, (tx) => readTrainingPlanAggregateSource(tx, oldCurrent.id)),
  ).toBeNull();
  const foreignVisits: string[] = [];
  const noBody = await facts(
    foreign,
    [ref(aggregateId, oldCurrent.id), ref(aggregateId, randomUUID())],
    foreignVisits,
  );
  expect(foreignVisits).toEqual([]);
  expect(noBody.planned.every((f) => f.state === 'unavailable' && f.content === null)).toBe(true);
});
it('runtime cannot insert/update/delete or directly read private mapping or forge historical identity', async () => {
  for (const sql of [
    'SELECT * FROM public.plan_snapshot_aggregate',
    'INSERT INTO public.plan_snapshot_aggregate(athlete_id,version_id,aggregate_id) VALUES($1,$2,$3)',
    'UPDATE public.plan_snapshot_aggregate SET aggregate_id=$3 WHERE athlete_id=$1 AND version_id=$2',
    'DELETE FROM public.plan_snapshot_aggregate WHERE athlete_id=$1 AND version_id=$2',
  ]) {
    await expect(
      db.tenant(historicalAthlete, (tx) =>
        tx.query(
          sql,
          sql.startsWith('SELECT')
            ? []
            : sql.startsWith('DELETE')
              ? [historicalAthlete, oldCurrent.id]
              : [historicalAthlete, oldCurrent.id, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }
  expect(
    await db.tenant(historicalAthlete, (tx) => readTrainingPlanAggregateSource(tx, oldCurrent.id)),
  ).toEqual({ versionId: oldCurrent.id, aggregateId });
});

async function offline<T>(
  athlete: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: url(ownerRole), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      athlete,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
it('runtime cannot replay old head or mutate aggregate and owner cannot rewrite/forge historical association', async () => {
  await expect(
    db.tenant(historicalAthlete, (tx) =>
      tx.query('UPDATE plan_head SET version_id=$2 WHERE athlete_id=$1', [
        historicalAthlete,
        oldFirst.id,
      ]),
    ),
  ).rejects.toMatchObject({ code: 'P0001', message: 'TRAINING_PLAN_HEAD_REPLAY_REJECTED' });
  await expect(
    db.tenant(historicalAthlete, (tx) =>
      tx.query('UPDATE plan_head SET aggregate_id=$2 WHERE athlete_id=$1', [
        historicalAthlete,
        randomUUID(),
      ]),
    ),
  ).rejects.toMatchObject({ code: 'P0001', message: 'TRAINING_PLAN_AGGREGATE_MUTATION' });
  // Offline negative maintenance is not a public writer/admission capability.
  await expect(
    offline(historicalAthlete, (client) =>
      client.query(
        'UPDATE plan_snapshot_aggregate SET aggregate_id=$3 WHERE athlete_id=$1 AND version_id=$2',
        [historicalAthlete, oldCurrent.id, randomUUID()],
      ),
    ),
  ).rejects.toMatchObject({ code: 'P0001', message: 'IMMUTABLE_TRAINING_PLAN_AGGREGATE' });
  await expect(
    offline(historicalAthlete, (client) =>
      client.query(
        'INSERT INTO plan_snapshot_aggregate(athlete_id,version_id,aggregate_id) VALUES($1,$2,$3)',
        [historicalAthlete, oldFirst.id, aggregateId],
      ),
    ),
  ).rejects.toMatchObject({ code: 'P0001', message: 'TRAINING_PLAN_AGGREGATE_SOURCE_REQUIRED' });
  expect(
    await db.tenant(historicalAthlete, (tx) => readTrainingPlanAggregateSource(tx, oldCurrent.id)),
  ).toEqual({ versionId: oldCurrent.id, aggregateId });
});
it('head-first mint without final history rejects at COMMIT and rollback leaves no fabricated lineage', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const saved = await createPlanningRepository(db).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  const fakeVersion = randomUUID();
  // Explicit owner-only negative fixture; no source authority or fake capture.
  await expect(
    offline(athlete, async (client) => {
      await client.query(
        'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,2,$3::jsonb)',
        [athlete, fakeVersion, JSON.stringify(draft())],
      );
      await client.query('UPDATE plan_head SET version_id=$2 WHERE athlete_id=$1', [
        athlete,
        fakeVersion,
      ]);
    }),
  ).rejects.toMatchObject({ code: '23503' });
  expect(
    await db.tenant(athlete, (tx) => readTrainingPlanAggregateSource(tx, fakeVersion)),
  ).toBeNull();
  expect((await createPlanningRepository(db).read(athlete)).head?.id).toBe(saved.id);
});
it('withdrawal retains owned history read; public account erasure cascades lineage without stale deferred failures', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const saved = await createPlanningRepository(db).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  const before = await db.tenant(athlete, (tx) => readTrainingPlanAggregateSource(tx, saved.id));
  expect(before?.versionId).toBe(saved.id);
  await app(athlete, false);
  expect(await db.tenant(athlete, (tx) => readTrainingPlanAggregateSource(tx, saved.id))).toEqual(
    before,
  );
  await createOperationsRepository(db).eraseAccount(athlete);
  expect(
    await offline(
      athlete,
      async (client) =>
        (
          await client.query(
            'SELECT version_id,aggregate_id FROM public.read_training_plan_aggregate($1::uuid)',
            [saved.id],
          )
        ).rows,
    ),
  ).toEqual([]);
});

it('delete/reinsert of head cannot turn unknown pre-migration historical snapshot into a new aggregate mapping', async () => {
  const before = await createPlanningRepository(db).read(historicalAthlete);
  await expect(
    offline(historicalAthlete, async (client) => {
      await client.query('DELETE FROM plan_head WHERE athlete_id=$1', [historicalAthlete]);
      await client.query(
        'INSERT INTO plan_head(athlete_id,version_id,aggregate_id) VALUES($1,$2,$3)',
        [historicalAthlete, oldFirst.id, randomUUID()],
      );
    }),
  ).rejects.toMatchObject({
    code: 'P0001',
    message: 'TRAINING_PLAN_HISTORICAL_IDENTITY_UNAVAILABLE',
  });
  expect(await createPlanningRepository(db).read(historicalAthlete)).toEqual(before);
  expect(
    await db.tenant(historicalAthlete, (tx) => readTrainingPlanAggregateSource(tx, oldFirst.id)),
  ).toBeNull();
});
