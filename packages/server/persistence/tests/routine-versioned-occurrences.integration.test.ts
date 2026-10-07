import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineScheduleVersionSchema,
} from '@workout/contracts/routines';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate, grantCorePlanning, grantOperations, grantRoutineCore } from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { requireAppAdmission } from '../src/app-admission.js';
import { persistRoutineScheduleVersionIn } from '../src/race-manual-approval-domain-writes.js';
import { expandRoutineSchedule } from '../src/routine-expansion.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Public normal107 producers + isolated raw121. Direct materialization is a
// fenced test caller, not proof of whole manual-approval/recipe authority.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `routine_versioned_${suffix}`,
  ownerRole = `routine_versioned_owner_${suffix}`,
  runtimeRole = `routine_versioned_app_${suffix}`;
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
const metadataSql = `SELECT
 (SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid)) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.routine_occurrence'::regclass AND contype<>'u') AS constraints,
 (SELECT jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(oid)) ORDER BY tgname) FROM pg_trigger WHERE tgrelid='public.routine_occurrence'::regclass AND NOT tgisinternal) AS triggers,
 (SELECT jsonb_build_object('source',prosrc,'config',proconfig,'acl',proacl::text,'owner',proowner) FROM pg_proc WHERE oid='public.routine_immutable()'::regprocedure) AS immutable,
 (SELECT jsonb_build_object('rls',relrowsecurity,'force',relforcerowsecurity,'acl',relacl::text,'owner',relowner) FROM pg_class WHERE oid='public.routine_occurrence'::regclass) AS relation,
 (SELECT jsonb_agg(jsonb_build_object('name',polname,'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid)) ORDER BY polname) FROM pg_policy WHERE polrelid='public.routine_occurrence'::regclass) AS policies`;
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
    const before = (await owner.query(metadataSql)).rows;
    await owner.query(
      await readFile(
        new URL('../migrations/121_routine_versioned_occurrences.sql', import.meta.url),
        'utf8',
      ),
    );
    expect((await owner.query(metadataSql)).rows).toEqual(before);
    expect(
      (
        await owner.query(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.routine_occurrence'::regclass AND contype='u'",
        )
      ).rows,
    ).toEqual([
      { definition: 'UNIQUE (athlete_id, schedule_id, schedule_version_id, anchor_key)' },
    ]);
    expect(
      (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
        'version'
      ],
    ).toBe(107);
  } finally {
    await owner.end();
  }
  for (const grant of [grantCorePlanning, grantOperations, grantRoutineCore])
    await grant(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('FIXTURE_VALUE_MISSING');
  return value;
}
async function snapshot<T>(athlete: string, fn: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw new Error('SNAPSHOT_PORT_REQUIRED');
  return db.snapshotTenant(athlete, fn);
}
async function setup() {
  const athlete = randomUUID(),
    owner = new Pool({ connectionString: url(ownerRole) });
  try {
    await owner.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await owner.end();
  }
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic checklist',
    intent: 'Manual',
    status: 'published',
    tags: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-10-08T00:00:00Z',
    steps: [
      {
        id: 'check',
        title: 'Check',
        content: { kind: 'checklist', prompt: 'Checked?' },
        timing: { kind: 'ordered', afterStepId: null },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
  });
  const repository = createRoutineRepository(db);
  await repository.saveBlueprint(athlete, {
    blueprint,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: randomUUID(),
    versionId: randomUUID(),
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: '2026-10-08',
      endDateExclusive: '2026-10-10',
      timezone: 'UTC',
      maxOccurrences: 2,
    },
    rule: { kind: 'dates', dates: ['2026-10-08', '2026-10-09'], localTime: '07:00' },
    state: 'draft',
  });
  const preview = await repository.previewSchedule(athlete, {
    schedule,
    sourcePlanVersionId: null,
  });
  const approved = await repository.approveSchedule(athlete, {
    schedule,
    sourcePlanVersionId: null,
    previewDigest: preview.previewDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  return { athlete, blueprint, repository, approved };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function originalRows(f: Fixture) {
  return db.tenant(
    f.athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT id,record_json FROM routine_occurrence WHERE athlete_id=$1 AND schedule_id=$2 ORDER BY id',
          [f.athlete, f.approved.schedule.id],
        )
      ).rows,
  );
}
async function successorIn(tx: Transaction, f: Fixture, localTime: string) {
  await requireAppAdmission(tx);
  const head = required(
    (
      await tx.query(
        'SELECT v.record_json FROM routine_schedule_head h JOIN routine_schedule_version v ON v.athlete_id=h.athlete_id AND v.schedule_id=h.schedule_id AND v.version_id=h.version_id WHERE h.athlete_id=$1 AND h.schedule_id=$2',
        [f.athlete, f.approved.schedule.id],
      )
    ).rows[0],
  );
  const prior = routineScheduleVersionSchema.parse(head['record_json']);
  const started = (
    await tx.query(
      'SELECT o.record_json FROM routine_occurrence o JOIN routine_run r ON r.athlete_id=o.athlete_id AND r.occurrence_id=o.id WHERE o.athlete_id=$1 AND o.schedule_id=$2',
      [f.athlete, prior.id],
    )
  ).rows.map((row) => routineOccurrenceSchema.parse(row['record_json']));
  // Actual aggregate-wide started roster under the same tenant fence. No caller
  // affected flag or fabricated schedule is substituted for this source read.
  const startedKeys = new Set(started.map((o) => o.anchorKey));
  const proposed = routineScheduleVersionSchema.parse({
    ...prior,
    versionId: randomUUID(),
    rule: { kind: 'dates', dates: ['2026-10-08', '2026-10-09'], localTime },
  });
  const occurrences = expandRoutineSchedule(proposed, null).filter(
    (o) => !startedKeys.has(o.anchorKey),
  );
  const saved = await persistRoutineScheduleVersionIn(tx, {
    aggregateId: prior.id,
    expectedVersionId: prior.versionId,
    schedule: proposed,
    sourcePlanVersionId: null,
    occurrences,
    approvedAt: '2026-10-08T00:00:00Z',
  });
  return { prior, proposed, occurrences, saved };
}
function start(f: Fixture, occurrenceId: string, repository = f.repository) {
  const command = {
    runId: randomUUID(),
    blueprintVersionId: f.blueprint.versionId,
    occurrenceId,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
  return { command, promise: repository.startRun(f.athlete, command) };
}
function gate() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitForOwnLockWaiter() {
  await expect
    .poll(
      async () => {
        const result = await admin.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND wait_event_type='Lock' AND wait_event='advisory'",
          [name, runtimeRole],
        );
        return z.number().parse(result.rows[0]?.['count']);
      },
      { timeout: 2000, interval: 10 },
    )
    .toBeGreaterThan(0);
}

it('materializes same anchors with new IDs, preserves originals, and exposes only current occurrences', async () => {
  const f = await setup(),
    original = await originalRows(f);
  const next = await snapshot(f.athlete, (tx) => successorIn(tx, f, '08:00'));
  expect(next.occurrences.map((o) => o.anchorKey)).toEqual(
    f.approved.occurrences.map((o) => o.anchorKey),
  );
  expect(
    next.occurrences.every((o) => !f.approved.occurrences.some((old) => old.id === o.id)),
  ).toBe(true);
  const rows = await originalRows(f);
  expect(rows.filter((row) => original.some((old) => old['id'] === row['id']))).toEqual(original);
  expect((await f.repository.readSchedule(f.athlete, f.approved.schedule.id))?.occurrences).toEqual(
    next.occurrences,
  );
  await expect(start(f, required(f.approved.occurrences[0]).id).promise).rejects.toMatchObject({
    code: 'OCCURRENCE_UNAVAILABLE',
  });
  expect((await start(f, required(next.occurrences[0]).id).promise).run.origin).toEqual({
    kind: 'planned',
    occurrenceId: required(next.occurrences[0]).id,
  });
});
it('preserves started original run, checklist actual and blueprint through two successors and receipt replay', async () => {
  const f = await setup(),
    original = await originalRows(f),
    initial = start(f, required(f.approved.occurrences[0]).id),
    run = await initial.promise;
  const recorded = await f.repository.recordStep(f.athlete, {
    runId: run.run.id,
    stepId: 'check',
    state: 'performed',
    actualRefs: [],
    occurredAt: new Date().toISOString(),
    reason: null,
    expectedRevision: run.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  expect(recorded.run.progress[0]?.actualRefs[0]?.kind).toBe('checklist_confirmation');
  const before = await db.tenant(f.athlete, async (tx) => ({
    actuals: (
      await tx.query(
        'SELECT * FROM routine_checklist_confirmation WHERE athlete_id=$1 ORDER BY id',
        [f.athlete],
      )
    ).rows,
    blueprint: (
      await tx.query(
        'SELECT record_json FROM routine_blueprint_version WHERE athlete_id=$1 AND version_id=$2',
        [f.athlete, f.blueprint.versionId],
      )
    ).rows,
  }));
  for (const time of ['08:00', '09:00']) {
    const next = await snapshot(f.athlete, (tx) => successorIn(tx, f, time));
    expect(next.occurrences.map((o) => o.anchorKey)).not.toContain(
      required(f.approved.occurrences[0]).anchorKey,
    );
    expect(await f.repository.readRun(f.athlete, run.run.id)).toEqual(recorded);
  }
  expect(await f.repository.startRun(f.athlete, initial.command)).toEqual(run);
  const after = await db.tenant(f.athlete, async (tx) => ({
    actuals: (
      await tx.query(
        'SELECT * FROM routine_checklist_confirmation WHERE athlete_id=$1 ORDER BY id',
        [f.athlete],
      )
    ).rows,
    blueprint: (
      await tx.query(
        'SELECT record_json FROM routine_blueprint_version WHERE athlete_id=$1 AND version_id=$2',
        [f.athlete, f.blueprint.versionId],
      )
    ).rows,
  }));
  expect(after).toEqual(before);
  expect(
    (await originalRows(f)).filter((row) => original.some((old) => old['id'] === row['id'])),
  ).toEqual(original);
});
it('rejects stale CAS and duplicate input; SQL still rejects same-version anchor duplication', async () => {
  const f = await setup();
  const next = await snapshot(f.athlete, (tx) => successorIn(tx, f, '08:00'));
  await expect(
    snapshot(f.athlete, (tx) =>
      persistRoutineScheduleVersionIn(tx, {
        aggregateId: f.approved.schedule.id,
        expectedVersionId: f.approved.schedule.versionId,
        schedule: { ...next.proposed, versionId: randomUUID() },
        sourcePlanVersionId: null,
        occurrences: [],
        approvedAt: '2026-10-08T00:00:00Z',
      }),
    ),
  ).rejects.toThrow('STALE_BASIS');
  const occurrence = required(next.occurrences[0]),
    duplicateId = randomUUID();
  await expect(
    db.tenant(f.athlete, (tx) =>
      tx.query(
        'INSERT INTO routine_occurrence(athlete_id,id,schedule_id,schedule_version_id,blueprint_routine_id,blueprint_version_id,anchor_key,scheduled_at,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
        [
          f.athlete,
          duplicateId,
          next.proposed.id,
          next.proposed.versionId,
          f.blueprint.routineId,
          f.blueprint.versionId,
          occurrence.anchorKey,
          occurrence.scheduledAt,
          JSON.stringify({ ...occurrence, id: duplicateId }),
        ],
      ),
    ),
  ).rejects.toMatchObject({ code: '23505' });
  // Duplicate identity is rejected before the first SQL mutation, independent of
  // schema availability. New-version tuple is otherwise a valid public shape.
  const proposed = { ...next.proposed, versionId: randomUUID() },
    item = { ...occurrence, schedule: { id: proposed.id, versionId: proposed.versionId } };
  await expect(
    snapshot(f.athlete, (tx) =>
      persistRoutineScheduleVersionIn(tx, {
        aggregateId: proposed.id,
        expectedVersionId: next.proposed.versionId,
        schedule: proposed,
        sourcePlanVersionId: null,
        occurrences: [item, { ...item, id: randomUUID() }],
        approvedAt: '2026-10-08T00:00:00Z',
      }),
    ),
  ).rejects.toThrow('CANDIDATE_NOT_APPROVABLE');
  expect((await f.repository.readSchedule(f.athlete, proposed.id))?.schedule.versionId).toBe(
    next.proposed.versionId,
  );
});
it('serializes start-first: frozen original is excluded after the waiting snapshot fence', async () => {
  const f = await setup(),
    reached = gate(),
    release = gate();
  const holding: Database = {
    ...db,
    tenant: async (athlete, operation) =>
      db.tenant(athlete, async (tx) => {
        const result = await operation(tx);
        reached.resolve();
        await release.promise;
        return result;
      }),
  };
  const initial = start(
    f,
    required(f.approved.occurrences[0]).id,
    createRoutineRepository(holding),
  );
  await reached.promise;
  const successor = snapshot(f.athlete, (tx) => successorIn(tx, f, '08:00'));
  try {
    await waitForOwnLockWaiter();
  } finally {
    release.resolve();
  }
  const run = await initial.promise,
    next = await successor;
  expect(next.occurrences.map((o) => o.anchorKey)).not.toContain(
    required(f.approved.occurrences[0]).anchorKey,
  );
  expect((await f.repository.readRun(f.athlete, run.run.id))?.run).toEqual(run.run);
});
it('serializes successor-first: old unstarted run is refused after head commit', async () => {
  const f = await setup(),
    reached = gate(),
    release = gate();
  const successor = snapshot(f.athlete, async (tx) => {
    const result = await successorIn(tx, f, '08:00');
    reached.resolve();
    await release.promise;
    return result;
  });
  await reached.promise;
  const initial = start(f, required(f.approved.occurrences[0]).id);
  const rejection = expect(initial.promise).rejects.toMatchObject({
    code: 'OCCURRENCE_UNAVAILABLE',
  });
  try {
    await waitForOwnLockWaiter();
  } finally {
    release.resolve();
  }
  await successor;
  await rejection;
  expect((await f.repository.listRuns(f.athlete)).items).toHaveLength(0);
});
it('rolls back materialized version/head/occurrences before a later public start', async () => {
  const f = await setup(),
    original = await originalRows(f);
  await expect(
    snapshot(f.athlete, async (tx) => {
      await successorIn(tx, f, '08:00');
      throw new Error('SYNTHETIC_ROLLBACK');
    }),
  ).rejects.toThrow('SYNTHETIC_ROLLBACK');
  expect(await originalRows(f)).toEqual(original);
  expect((await f.repository.readSchedule(f.athlete, f.approved.schedule.id))?.schedule).toEqual(
    f.approved.schedule,
  );
  expect((await start(f, required(f.approved.occurrences[0]).id).promise).run.origin.kind).toBe(
    'planned',
  );
});
