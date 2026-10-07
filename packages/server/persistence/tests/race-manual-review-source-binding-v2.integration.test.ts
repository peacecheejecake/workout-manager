import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { raceManualReviewSourceInventoryV2Schema } from '../src/race-manual-review-source-inventory-v2.js';
// Prepared real-DB acceptance; Root executes. normal107 + raw114 staging only.
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
const name = `review_binding_v2_${suffix}`,
  ownerRole = `review_bind_owner_${suffix}`,
  runtimeRole = `review_bind_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let db: Database;
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
});
afterAll(async () => {
  await db?.close();
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

const identitySchema =
  raceManualReviewSourceInventoryV2Schema.out.shape.refs.element.shape.identity;
const resultSchema = z.strictObject({
  bindingVersion: z.literal(2),
  scope: z.literal('candidate_v2_copied_full_bodies_only'),
  hashMethod: z.literal('postgres-owned-source-row-jsonb-utc-v2'),
  sqlRefsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  transactionId: z.string().regex(/^\d+$/),
  callerRole: z.string(),
  athleteId: z.string(),
  rows: z.array(
    z.strictObject({
      ordinal: z.number().int().positive(),
      identity: identitySchema,
      relation: z.string(),
      state: z.enum(['observed', 'unavailable']),
      sourceRowDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      reason: z.literal('source_unavailable').nullable(),
    }),
  ),
  storage: z.literal('not_persisted'),
  admissionAllowed: z.literal(false),
  sourceCompleteness: z.literal('unverified'),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
async function observe(tx: Transaction, refs: unknown) {
  const q = await tx.query(
    'SELECT public.observe_manual_review_owned_source_bindings_v2($1::jsonb) AS source',
    [JSON.stringify(refs)],
  );
  return resultSchema.parse(q.rows[0]?.['source']);
}
function refs(f: Awaited<ReturnType<typeof coherentSources>>) {
  return [
    { kind: 'race-event', sourceId: f.race.id, revision: f.race.revision },
    { kind: 'plan-snapshot', sourceId: f.plan.id, version: f.plan.version },
    {
      kind: 'nutrition-plan-version',
      sourceId: f.nutrition.planId,
      versionId: f.nutrition.versionId,
    },
    {
      kind: 'routine-blueprint-version',
      sourceId: f.blueprint.routineId,
      versionId: f.blueprint.versionId,
    },
    {
      kind: 'routine-schedule-version',
      sourceId: f.approved.schedule.id,
      versionId: f.approved.schedule.versionId,
    },
    { kind: 'routine-occurrence', sourceId: f.occurrence.id },
    { kind: 'routine-run', sourceId: f.run.run.id, revision: f.run.run.revision },
    {
      kind: 'session-completion',
      sourceId: f.completion.report.sessionId,
      planVersionId: f.completion.report.planVersionId,
      revision: f.completion.report.revision,
    },
  ];
}
it('observes eight actual public namespaces without modifying artifacts or granting admission', async () => {
  const f = await coherentSources(db);
  await snapshot(db, f.athlete, async (tx) => {
    const count = () =>
      tx.query(
        'SELECT (SELECT count(*) FROM command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox',
        [f.athlete],
      );
    const before = await count();
    const a = await observe(tx, refs(f)),
      b = await observe(tx, refs(f));
    expect(a).toEqual(b);
    expect(a.rows).toHaveLength(8);
    expect(a.rows.every((v) => v.state === 'observed' && v.sourceRowDigest !== null)).toBe(true);
    expect(a.rows.map((v) => v.relation)).toContain('routine_run_revision');
    expect(a.rows.map((v) => v.relation)).toContain('session_completion_revision');
    expect(a.callerRole).toBe(runtimeRole);
    expect(await count()).toEqual(before);
  });
});
it('binds historical plan, run and completion full rows after current heads advance', async () => {
  const f = await coherentSources(db);
  const old = refs(f);
  const before = await snapshot(db, f.athlete, (tx) => observe(tx, old));
  const next = await f.planning.save(f.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: f.plan.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'Changed current plan' },
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
    expectedPlanVersionId: next.id,
    expectedRevision: 1,
    reason: 'Synthetic correction',
    idempotencyKey: randomUUID(),
  });
  const after = await snapshot(db, f.athlete, (tx) => observe(tx, old));
  expect(after.rows).toEqual(before.rows);
});
it('UTC full-row hash is independent of session timezone and preserves six microseconds', async () => {
  const f = await coherentSources(db);
  await snapshot(db, f.athlete, async (tx) => {
    await tx.query("SET LOCAL TIME ZONE 'Asia/Seoul'");
    const observed = await observe(tx, refs(f));
    expect((await tx.query('SHOW TimeZone')).rows[0]?.['TimeZone']).toBe('Asia/Seoul');
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    const actual = await tx.query(
      "SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS digest FROM plan_snapshot r WHERE athlete_id=$1 AND id=$2",
      [f.athlete, f.plan.id],
    );
    expect(observed.rows.find((v) => v.identity['kind'] === 'plan-snapshot')?.sourceRowDigest).toBe(
      actual.rows[0]?.['digest'],
    );
    expect(actual.rows[0]?.['digest']).not.toBe(impactDependencyDigest(f.plan));
  });
});
it('foreign, missing, stale and opaque identities remain explicit unavailable facts', async () => {
  const f = await coherentSources(db),
    foreign = await coherentSources(db);
  const requested = [
    { kind: 'race-event', sourceId: foreign.race.id, revision: foreign.race.revision },
    { kind: 'plan-snapshot', sourceId: 'opaque-not-db-uuid', version: 1 },
    { kind: 'routine-run', sourceId: f.run.run.id, revision: 9007199254740991 },
    {
      kind: 'session-completion',
      sourceId: f.completion.report.sessionId,
      planVersionId: randomUUID(),
      revision: 1,
    },
  ];
  const result = await snapshot(db, f.athlete, (tx) => observe(tx, requested));
  expect(result.rows).toHaveLength(4);
  expect(result.rows.every((v) => v.state === 'unavailable')).toBe(true);
  const stale = await snapshot(db, f.athlete, (tx) =>
    observe(tx, [{ kind: 'race-event', sourceId: f.race.id, revision: f.race.revision + 1 }]),
  );
  expect(stale.rows[0]?.state).toBe('unavailable');
});
it('rejects malformed, nested, duplicate, ambiguous race, numeric and input byte bounds', async () => {
  const f = await coherentSources(db),
    race = refs(f)[0];
  if (!race) throw Error('FIXTURE_RACE_MISSING');
  for (const invalid of [
    null,
    {},
    [],
    [race, race],
    [{ ...race, sourceId: f.race.id.toUpperCase() }, race],
    [{ ...race, unknown: true }],
    [{ ...race, sourceId: { nested: true } }],
    [{ ...race, revision: -1 }],
    [{ ...race, revision: 1.5 }],
    [{ ...race, revision: '1' }],
    [{ ...race, revision: null }],
    [race, { kind: 'routine-occurrence', sourceId: '\tinvalid' }],
    [race, { kind: 'not-a-namespace', sourceId: randomUUID() }],
    [race, { kind: 'plan-snapshot', sourceId: '😀'.repeat(101), version: 1 }],
    [{ ...race, revision: 2147483648 }],
    [{ ...race, sourceId: randomUUID() }, race],
    Array.from({ length: 5001 }, () => race),
    [race, { kind: 'routine-occurrence', sourceId: 'x'.repeat(4194304) }],
  ]) {
    await expect(snapshot(db, f.athlete, (tx) => observe(tx, invalid))).rejects.toThrow(
      'MANUAL_BINDING',
    );
  }
});
it('requires snapshot isolation, remains invoker-only and PUBLIC has no EXECUTE', async () => {
  const f = await coherentSources(db);
  await expect(db.tenant(f.athlete, (tx) => observe(tx, refs(f)))).rejects.toThrow(
    'MANUAL_BINDING_SNAPSHOT_REQUIRED',
  );
  await snapshot(db, f.athlete, async (tx) => {
    const proc = await tx.query(
      "SELECT p.prosecdef,EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p WHERE p.oid='public.observe_manual_review_owned_source_bindings_v2(jsonb)'::regprocedure",
    );
    expect(proc.rows[0]).toEqual({ prosecdef: false, public_execute: false });
    expect(
      (
        await tx.query(
          "SELECT has_function_privilege(current_user,'public.observe_manual_review_owned_source_bindings_v2(jsonb)','EXECUTE') AS narrow,has_function_privilege(current_user,'public.manual_review_source_row(text,text,text)','EXECUTE') AS legacy_private",
        )
      ).rows[0],
    ).toEqual({ narrow: true, legacy_private: false });
  });
  await expect(
    snapshot(db, f.athlete, (tx) =>
      tx.query('SELECT max(version)::int AS version FROM schema_migrations'),
    ),
  ).rejects.toThrow('permission denied for table schema_migrations');
  const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    expect(
      (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
        'version'
      ],
    ).toBe(107);
  } finally {
    await owner.end();
  }
});

it('rejects the aggregate full-row byte bound before emitting any hashes', async () => {
  const f = await coherentSources(db);
  const base = draft();
  const session = base.sessions[0];
  if (!session) throw Error('FIXTURE_SESSION_MISSING');
  const large = planDraftSchema.parse({
    ...base,
    sessions: [
      session,
      ...Array.from({ length: 600 }, (_, i) => ({
        ...session,
        id: `extra-${i}`,
        notes: 'x'.repeat(550),
      })),
    ],
  });
  expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(1048576);
  let expected = f.plan.id;
  const planRefs: unknown[] = [];
  for (let i = 0; i < 10; i++) {
    const plan = await f.planning.save(f.athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: expected,
      idempotencyKey: randomUUID(),
      draft: large,
    });
    expected = plan.id;
    planRefs.push({ kind: 'plan-snapshot', sourceId: plan.id, version: plan.version });
  }
  await expect(
    snapshot(db, f.athlete, (tx) => observe(tx, [refs(f)[0], ...planRefs])),
  ).rejects.toThrow('MANUAL_BINDING_SOURCE_BOUND');
}, 60000);
it('hashes a synthetic owned immutable full-row timestamp at exact six-microsecond precision', async () => {
  const f = await coherentSources(db),
    id = randomUUID();
  const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  // Plain FORCE-RLS owner, synthetic storage-only row: no approval/head claim.
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [f.athlete]);
    await client.query(
      "INSERT INTO plan_snapshot(athlete_id,id,version,created_at,draft) VALUES($1,$2,99999,'2026-10-07T00:00:00.123456Z',$3::jsonb)",
      [f.athlete, id, JSON.stringify(draft())],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
  await snapshot(db, f.athlete, async (tx) => {
    await tx.query("SET LOCAL TimeZone='Pacific/Honolulu'");
    const first = await observe(tx, [
      refs(f)[0],
      { kind: 'plan-snapshot', sourceId: id, version: 99999 },
    ]);
    await tx.query("SET LOCAL TimeZone='UTC'");
    const row = await tx.query(
      "SELECT to_char(r.created_at,'US') AS micros,encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS digest FROM plan_snapshot r WHERE athlete_id=$1 AND id=$2",
      [f.athlete, id],
    );
    expect(row.rows[0]?.['micros']).toBe('123456');
    expect(first.rows[1]?.sourceRowDigest).toBe(row.rows[0]?.['digest']);
    expect(first.rows).toEqual(
      (await observe(tx, [refs(f)[0], { kind: 'plan-snapshot', sourceId: id, version: 99999 }]))
        .rows,
    );
  });
});

it('deleted current race never exposes a historical raw full-row hash', async () => {
  const f = await coherentSources(db);
  const deletion = await createRaceRepository(db).deleteRaceEvent(f.athlete, f.race.id, {
    expectedRevision: f.race.revision,
    idempotencyKey: randomUUID(),
  });
  const result = await snapshot(db, f.athlete, (tx) =>
    observe(tx, [{ kind: 'race-event', sourceId: f.race.id, revision: deletion.revision }]),
  );
  expect(result.rows[0]).toMatchObject({
    state: 'unavailable',
    sourceRowDigest: null,
    reason: 'source_unavailable',
  });
});
