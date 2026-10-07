import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PlanSnapshot } from '@workout/contracts/planning';
import { createRaceRepository } from '../src/races.js';
import { captureRacePlanImpactConsumedScope } from '../src/race-plan-impact-context.js';
import { captureRecoverySourceFacts } from '../src/race-plan-impact-recovery-sources.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import {
  recoveryStrategyVersionSchema,
  type RecoveryStrategyVersion,
  type RecoveryStrategyDraft,
} from '@workout/contracts/recovery-core';
import { type SourceBudget } from '../src/race-plan-impact-nested-sources.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { Pool, type PoolClient } from 'pg';
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
  name = `recovery_source_${suffix}`,
  ownerRole = `recovery_source_owner_${suffix}`,
  runtimeRole = `recovery_source_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
let created = false,
  db: Database;
const historicalAthlete = randomUUID();
let oldFirst: PlanSnapshot,
  oldCurrent: PlanSnapshot,
  aggregateId: string,
  oldStrategy: RecoveryStrategyVersion;
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
  const initialAggregate = await db.tenant(historicalAthlete, async (tx) =>
    z
      .uuid()
      .parse(
        (
          await tx.query(
            'SELECT aggregate_id FROM plan_head WHERE athlete_id=$1 AND version_id=$2',
            [historicalAthlete, oldFirst.id],
          )
        ).rows[0]?.['aggregate_id'],
      ),
  );
  oldStrategy = await createRecoveryRepository(db).createStrategy(historicalAthlete, {
    idempotencyKey: randomUUID(),
    draft: strategyDraft(null, [
      { kind: 'training', aggregateId: initialAggregate, headVersionId: oldFirst.id },
    ]),
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

function strategyDraft(
  methodVersionId: string | null,
  planRefs: RecoveryStrategyDraft['planRefs'] = [],
): RecoveryStrategyDraft {
  return {
    title: 'Synthetic recovery comparison',
    goal: 'User planning only',
    startDate: '2026-10-01',
    endDateExclusive: '2026-10-31',
    timezone: 'Asia/Seoul',
    knownFacts: [],
    missingInformation: [],
    priority: 'normal',
    observations: [],
    planRefs,
    options: [
      {
        id: randomUUID(),
        title: 'Rest',
        kind: 'full_rest',
        methodVersionId: null,
        explanation: 'No actual created',
      },
      ...(methodVersionId === null
        ? []
        : [
            {
              id: randomUUID(),
              title: 'Recorded method',
              kind: 'nonexercise_action' as const,
              methodVersionId,
              explanation: 'Unreviewed user content',
            },
          ]),
    ],
    reassessment: [
      {
        id: randomUUID(),
        trigger: 'user_report_changed',
        plannedAt: null,
        description: 'Review explicitly',
        policyVersion: null,
      },
    ],
  };
}
async function method(athlete: string) {
  return createRecoveryRepository(db).createMethod(athlete, {
    idempotencyKey: randomUUID(),
    title: 'Synthetic rest record',
    category: 'rest',
    intendedUse: 'User reported',
    applicability: [],
    cautions: [],
    sourceDescription: 'User entry',
    evidenceLimitations: 'Not efficacy evidence',
  });
}
const budget = (): SourceBudget => ({ bytes: 0n, sources: 0 });
const capture = (athlete: string, records: RecoveryStrategyVersion[], b = budget()) =>
  db.tenant(athlete, (tx) => captureRecoverySourceFacts(tx, records, b));
it('nonempty actual public strategy consumes exact owned method body/head/hash and all option references once', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const m = await method(athlete),
    repo = createRecoveryRepository(db);
  const first = await repo.createStrategy(athlete, {
    idempotencyKey: randomUUID(),
    draft: strategyDraft(m.versionId),
  });
  const second = await repo.createStrategy(athlete, {
    idempotencyKey: randomUUID(),
    draft: strategyDraft(m.versionId),
  });
  const facts = await capture(athlete, [second, first]);
  expect(facts.methods).toEqual([m]);
  expect(facts.methodCatalogRequests).toEqual([
    { kind: 'recovery_method', ref: { id: m.methodId, versionId: m.versionId } },
  ]);
  expect(facts.methodFacts).toEqual([
    {
      requested: facts.methodCatalogRequests[0],
      state: 'current',
      reason: null,
      content: { digest: impactDependencyDigest(m) },
      currentHead: { aggregate_id: m.methodId, version_id: m.versionId },
      provenance: { source: 'user_recorded', reviewState: 'unreviewed', reviewedAt: null },
    },
  ]);
  expect(facts.unavailable).toEqual([]);
  expect(facts.authority).toBe('none');
  expect(facts.freshness).toBe('not_checked');
  expect(await capture(athlete, [first, second])).toEqual(facts);
});
it('actual public strategy frozen training refs use112 exact historical mapping; pre-migration unknown remains missing', async () => {
  const repo = createRecoveryRepository(db);
  const supported = await repo.createStrategy(historicalAthlete, {
    idempotencyKey: randomUUID(),
    draft: strategyDraft(null, [{ kind: 'training', aggregateId, headVersionId: oldCurrent.id }]),
  });
  await createPlanningRepository(db).save(historicalAthlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: oldCurrent.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'After recovery source' },
  });
  expect((await capture(historicalAthlete, [supported])).trainingAssociations).toEqual([
    { aggregateId, versionId: oldCurrent.id },
  ]);
  expect((await capture(historicalAthlete, [oldStrategy])).unavailable).toEqual([
    {
      kind: 'training',
      requested: { aggregateId, versionId: oldFirst.id },
      reason: 'aggregate_identity_unavailable',
    },
  ]);
});
it('foreign or absent method requests reveal no invented method IDs/body and cannot become catalog requests', async () => {
  const alice = randomUUID(),
    bob = randomUUID();
  await app(alice, true);
  await app(bob, true);
  const m = await method(alice);
  const actual = await createRecoveryRepository(db).createStrategy(alice, {
    idempotencyKey: randomUUID(),
    draft: strategyDraft(m.versionId),
  });
  const foreign = await capture(bob, [actual]);
  expect(foreign.methods).toEqual([]);
  expect(foreign.methodCatalogRequests).toEqual([]);
  expect(foreign.methodFacts).toEqual([]);
  expect(foreign.unavailable).toEqual([
    { kind: 'method', requestedVersionId: m.versionId, reason: 'owned_method_unavailable' },
  ]);
  // Invalid trusted-input probe, never a persisted/authorized strategy or capture.
  const absent = recoveryStrategyVersionSchema.parse({
    ...actual,
    draft: strategyDraft(randomUUID()),
  });
  const missing = await capture(bob, [absent]);
  expect(missing.methods).toEqual([]);
  expect(missing.methodCatalogRequests).toEqual([]);
  expect(missing.unavailable[0]?.kind).toBe('method');
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
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
it('exact original method survives currenthead absence/change; synthetic owner maintenance is not a public update/delete', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const m = await method(athlete),
    strategy = await createRecoveryRepository(db).createStrategy(athlete, {
      idempotencyKey: randomUUID(),
      draft: strategyDraft(m.versionId),
    });
  await offline(athlete, (client) =>
    client.query('DELETE FROM recovery_method_head WHERE athlete_id=$1 AND method_id=$2', [
      athlete,
      m.methodId,
    ]),
  );
  const absent = await capture(athlete, [strategy]);
  expect(absent.methods).toEqual([m]);
  expect(absent.methodFacts[0]).toMatchObject({ state: 'historical', currentHead: null });
  const next = {
    ...m,
    version: 2,
    versionId: randomUUID(),
    title: 'Synthetic maintenance corrected method',
  };
  await offline(athlete, async (client) => {
    await client.query(
      'INSERT INTO recovery_method_version(athlete_id,method_id,version_id,version,record_json) VALUES($1,$2,$3,2,$4::jsonb)',
      [athlete, m.methodId, next.versionId, JSON.stringify(next)],
    );
    await client.query(
      'INSERT INTO recovery_method_head(athlete_id,method_id,version,version_id) VALUES($1,$2,2,$3)',
      [athlete, m.methodId, next.versionId],
    );
  });
  const historical = await capture(athlete, [strategy]);
  expect(historical.methods).toEqual([m]);
  expect(historical.methodFacts[0]).toMatchObject({
    state: 'historical',
    currentHead: { aggregate_id: m.methodId, version_id: next.versionId },
    content: { digest: impactDependencyDigest(m) },
  });
});
it('visited duplicates cannot hide5000limit and bytes reject before fetching a method body', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const m = await method(athlete),
    strategy = await createRecoveryRepository(db).createStrategy(athlete, {
      idempotencyKey: randomUUID(),
      draft: strategyDraft(m.versionId),
    });
  await expect(
    capture(
      athlete,
      Array.from({ length: 1000 }, () => strategy),
      { bytes: 0n, sources: 3000 },
    ),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'unique_sources' });
  await expect(capture(athlete, [strategy], { bytes: 4194000n, sources: 0 })).rejects.toMatchObject(
    { code: 'CONTEXT_UNAVAILABLE', bound: 'decoded_bytes' },
  );
  // Mutated trusted source argument rejects structurally; no approved/body proof.
  const forged = { ...strategy, draft: { ...strategy.draft, foreign: true } };
  await expect(capture(athlete, [forged])).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});

async function event(athlete: string) {
  return createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic recovery scope race',
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
}
it('full owned capture connects actual nonempty public method/strategy sources without granting approval', async () => {
  const athlete = randomUUID();
  await app(athlete, true);
  const m = await method(athlete);
  const strategy = await createRecoveryRepository(db).createStrategy(athlete, {
    idempotencyKey: randomUUID(),
    draft: strategyDraft(m.versionId),
  });
  const race = await event(athlete);
  const result = await db.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, {
      eventId: race.id,
      expectedRevision: race.revision,
      selection: { kind: 'keep_plan' },
    }),
  );
  expect(result.capture.recovery.map((row) => row.record)).toEqual([strategy]);
  expect(result.capture.recoverySources.methods).toEqual([m]);
  expect(result.capture.recoverySources.methodCatalogRequests).toEqual([
    { kind: 'recovery_method', ref: { id: m.methodId, versionId: m.versionId } },
  ]);
  expect(result.capture.recoverySources.unavailable).toEqual([]);
  expect(result.capture.coverage.complete).toBe(false);
  expect(result.capture.coverage.missing).toHaveLength(5);
  expect(result.consumedScope).toMatchObject({
    status: 'validated_read_scope',
    approvalAuthority: 'none',
    freshness: 'not_checked',
    capturedReadSetDigest: result.capture.readSetDigest,
  });
  if (result.consumedScope.status === 'validated_read_scope')
    expect(result.consumedScope.remaining).toHaveLength(5);
});
it('full actual capture preserves the specific unavailable old training identity and blocks its consumed scope', async () => {
  const race = await event(historicalAthlete);
  const result = await db.tenant(historicalAthlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, {
      eventId: race.id,
      expectedRevision: race.revision,
      selection: { kind: 'keep_plan' },
    }),
  );
  expect(result.capture.recoverySources.unavailable).toContainEqual({
    kind: 'training',
    requested: { aggregateId, versionId: oldFirst.id },
    reason: 'aggregate_identity_unavailable',
  });
  expect(result.capture.coverage.complete).toBe(false);
  expect(result.capture.coverage.missing).toHaveLength(5);
  expect(result.consumedScope.status).toBe('blocked');
});
