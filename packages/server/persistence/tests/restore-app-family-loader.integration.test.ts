import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import type { IntegratedApprovalV023 } from '@workout/contracts/routines';
import {
  runOneCoachingJob,
  createDeterministicFixtureAdapter,
  type CoachingEvaluationAdapter,
} from '@workout/server-coaching/runner';
import { createDatabase, type Database } from '../src/database.js';
import * as grants from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createCoachingRunRepository, createCoachingRunWorkerStore } from '../src/coaching-runs.js';
import { createTrainingCandidateRepository } from '../src/coaching-candidates.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createIntegratedApprovalV4Repository } from '../src/integrated-approval-v4.js';
import { createIntegratedFixtureV4Repository } from '../src/integrated-fixture-v4.js';
import { createRestoreProcessingOwnerPort } from '../src/restore-processing-admission.js';
import {
  appFamilyRowsSha256,
  signAppFamilyArtifact,
  prepareVerifiedAppFamilyArtifact,
  type AppFamilyRow,
  type AppFamilyIdentity,
} from '../src/restore-app-family-artifact.js';
import { stageVerifiedAppFamilyArtifactIn } from '../src/restore-app-family-stage.js';
import {
  prepareVerifiedSuppressionChain,
  replayVerifiedSuppressionChainIn,
  type VerifiedSuppressionChain,
} from '../src/restore-suppression-replay.js';
import { validateSuppressionRecord } from '../src/restore-suppression-records.js';
import { encryptReplaySegment } from '../src/restore-suppression-segment.js';
import type { LocalReplayRecordEnvelope } from '../src/restore-suppression-pgoutput.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Preparation for registered102: synthetic trust inputs never establish full restore
// authority or reopen. Public source producers use restricted runtime roles and normal public grants.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const roles = {
  owner: `family_owner_${suffix}`,
  runtime: `family_runtime_${suffix}`,
  worker: `family_worker_${suffix}`,
  outside: `family_outside_${suffix}`,
};
const names = { source: `family_source_${suffix}`, target: `family_target_${suffix}` };
const pools: Pool[] = [];
const extraRoles: string[] = [];
let sourcePool: Pool,
  targetPool: Pool,
  database: Database,
  workerDatabase: Database,
  targetDatabase: Database;
const policy = { id: 'running-core-v2-training', version: '1' };
const source = { kind: 'deterministic_fixture' as const, fixtureId: 'synthetic-v1' };
const candidates = () => createTrainingCandidateRepository(database, { policy, source });
const runs = () => createCoachingRunRepository(database, { policy, source });
const repository = () =>
  createIntegratedApprovalV4Repository(database, { policyVersion: 'v4-test' });
const nonce = randomUUID(),
  incarnation = randomUUID();
const schemaHash = createHash('sha256')
  .update('synthetic-schema-preparation-not-independent-pin')
  .digest('hex');
const proofHash = createHash('sha256').update('synthetic-owner-family-not-fullproof').digest('hex');
let controlRevision = '';
function url(name: string, role = roles.owner) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  u.searchParams.set('options', '-c timezone=UTC -c datestyle=ISO,YMD');
  return u.toString();
}
async function scoped<T>(pool: Pool, id: string, action: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    const v = await action(c);
    await c.query('COMMIT');
    return v;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
beforeAll(async () => {
  for (const role of Object.values(roles))
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  for (const name of Object.values(names)) {
    await admin.query(`CREATE DATABASE "${name}" OWNER "${roles.owner}"`);
    await grants.migrate(url(name), 101);
    await grants.migrate(url(name), 102);
    const pool = new Pool({ connectionString: url(name), max: 6 });
    pools.push(pool);
    if (name === names.source) sourcePool = pool;
    else targetPool = pool;
    for (const grant of [
      grants.grantCorePlanning,
      grants.grantOperations,
      grants.grantResources,
      grants.grantCoachingConstraints,
      grants.grantCoachingThreads,
      grants.grantCoreEvidenceSnapshots,
      grants.grantCoachingRuns,
      grants.grantCoachingCandidates,
      grants.grantNutritionCore,
      grants.grantRoutineCore,
      grants.grantRecoveryCore,
      grants.grantCheckIns,
      grants.grantSessionCompletions,
      grants.grantIntegratedApprovalV4,
    ])
      await grant(url(name), roles.runtime);
  }
  await grants.grantCoachingRunWorker(url(names.source), roles.worker);
  const c = await targetPool.connect();
  try {
    await c.query('BEGIN');
    const state = await createRestoreProcessingOwnerPort(c).close({
      expectedRevision: '1',
      commandId: randomUUID(),
      targetNonce: nonce,
      targetIncarnation: incarnation,
    });
    controlRevision = state.localRevision;
    await c.query("INSERT INTO wm_app_load.target VALUES(true,$1,$2,'CLOSED',1)", [
      nonce,
      schemaHash,
    ]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  database = createDatabase({ connectionString: url(names.source, roles.runtime) });
  workerDatabase = createDatabase({ connectionString: url(names.source, roles.worker) });
  targetDatabase = createDatabase({ connectionString: url(names.target, roles.runtime) });
}, 30000);
afterAll(async () => {
  await database?.close();
  await workerDatabase?.close();
  await targetDatabase?.close();
  for (const p of pools) await p.end();
  for (const name of Object.values(names)) await dropIsolatedDatabase(admin, name);
  for (const role of [...Object.values(roles), ...extraRoles])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

function plan(): PlanDraft {
  return {
    title: 'Synthetic training',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: 'Maintain the training purpose',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: null,
        title: 'Synthetic run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 0,
        targetRpe: null,
        purpose: 'Endurance',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
}
async function seed(
  athleteId: string,
  adapter: CoachingEvaluationAdapter = createDeterministicFixtureAdapter('synthetic-v1'),
  initialDraft: PlanDraft = plan(),
) {
  await createConsentRepository(database).setConsent(athleteId, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const savedPlan = await createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: initialDraft,
  });
  const thread = (
    await createCoachingThreadRepository(database).create(athleteId, {
      planVersionId: savedPlan.id,
      title: 'Synthetic coaching',
      scope: { kind: 'session', targetId: 'session' },
      message: 'Synthetic private input',
      idempotencyKey: randomUUID(),
    })
  ).thread;
  await createConsentRepository(database).setConsent(athleteId, {
    kind: 'ai',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const evidence = await createCoreEvidenceSnapshotRepository(database).capture(
    athleteId,
    thread.id,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  const run = await runs().create(athleteId, thread.id, {
    schemaVersion: 1,
    evidenceSnapshotId: evidence.id,
    expectedConversationRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(
    await runOneCoachingJob({
      athleteId,
      store: createCoachingRunWorkerStore(workerDatabase, { policy, source }),
      adapter,
    }),
  ).toBe('stored');
  expect((await runs().read(athleteId, run.id))?.status.kind).toBe('analysis_ready');
  return { savedPlan, thread, evidence, run };
}

const planDraft = (title: string) => ({
  title,
  timezone: 'UTC',
  periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
    id: level,
    parentId: index === 0 ? null : (levels[index - 1] ?? null),
    level,
    title: level,
    startDate: '2080-01-01',
    endDateExclusive: '2080-02-01',
    timezone: 'UTC',
    intent: 'fixture',
    isPartial: false,
  })),
  sessions: [],
});

interface Seed {
  athleteId: string;
  planVersionId: string;
  evidenceId: string;
  threadId: string;
  blueprintId: string;
  blueprintVersionId: string;
}

async function v4seed(aiConsentGranted: boolean | null = true): Promise<Seed> {
  const athleteId = randomUUID();
  await createConsentRepository(database).setConsent(athleteId, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const planVersionId = randomUUID();
  const threadId = randomUUID();
  const messageId = randomUUID();
  const blueprintId = randomUUID();
  const blueprintVersionId = randomUUID();
  await database.tenant(athleteId, async (tx) => {
    await tx.query(
      'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,$3::jsonb)',
      [athleteId, planVersionId, JSON.stringify(planDraft('Before'))],
    );
    await tx.query('INSERT INTO plan_head(athlete_id,aggregate_id,version_id) VALUES($1,$2,$2)', [
      athleteId,
      planVersionId,
    ]);
    await tx.query(
      "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'manual_saved')",
      [athleteId, planVersionId],
    );
    if (aiConsentGranted !== null)
      await tx.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'ai',$2,1)", [
        athleteId,
        aiConsentGranted,
      ]);
    await tx.query(
      `INSERT INTO coaching_thread(athlete_id,id,plan_version_id,title,scope,revision)
       VALUES($1,$2,$3,'v4 fixture','{"kind":"block","targetId":"block"}'::jsonb,1)`,
      [athleteId, threadId, planVersionId],
    );
    await tx.query(
      `INSERT INTO coaching_message(athlete_id,id,thread_id,revision,content)
       VALUES($1,$2,$3,1,'Review all four domains')`,
      [athleteId, messageId, threadId],
    );
    const blueprint = {
      schemaVersion: 4,
      routineId: blueprintId,
      versionId: blueprintVersionId,
      title: 'Fixture routine',
      intent: 'atomic approval fixture',
      status: 'published',
      tags: [],
      steps: [],
      choiceGroups: [],
      estimatedDurationSeconds: 0,
      createdAt: '2080-01-01T00:00:00.000Z',
    };
    await tx.query(
      `INSERT INTO routine_blueprint_version
       (athlete_id,routine_id,version_id,version,previous_version_id,record_json,created_at)
       VALUES($1,$2,$3,1,NULL,$4::jsonb,$5)`,
      [athleteId, blueprintId, blueprintVersionId, JSON.stringify(blueprint), blueprint.createdAt],
    );
    await tx.query(
      `INSERT INTO routine_blueprint_head
       (athlete_id,routine_id,version_id,version,visibility) VALUES($1,$2,$3,1,'active')`,
      [athleteId, blueprintId, blueprintVersionId],
    );
  });
  const snapshot = await createCoreEvidenceSnapshotRepository(database).capture(
    athleteId,
    threadId,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-02-01', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  if (snapshot.status !== 'available') throw new Error('Expected available evidence fixture');
  const evidenceId = snapshot.id;
  return { athleteId, planVersionId, evidenceId, threadId, blueprintId, blueprintVersionId };
}

async function sourceFixture() {
  const s = await v4seed();
  const nutrition = await createNutritionRepository(database).savePlan(s.athleteId, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2080-01-01', toInclusive: '2080-01-31' },
      timezone: 'UTC',
      purpose: 'Synthetic',
      linkedTrainingPlanVersionId: s.planVersionId,
      items: [],
    },
  });
  const evidence = await createCoreEvidenceSnapshotRepository(database).capture(
    s.athleteId,
    s.threadId,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  const cmd = {
    threadId: s.threadId,
    evidenceSnapshotId: evidence.id,
    expectedConversationRevision: 1,
    trainingPlanVersionId: s.planVersionId,
    nutritionPlanId: nutrition.planId,
    nutritionPlanVersionId: nutrition.versionId,
    routineBlueprintId: s.blueprintId,
    routineBlueprintVersionId: s.blueprintVersionId,
    recoveryStrategyId: randomUUID(),
    routineScheduleId: randomUUID(),
    window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
    idempotencyKey: randomUUID(),
  };
  return {
    s,
    cmd,
    repo: repository(),
    fixture: createIntegratedFixtureV4Repository(database, repository(), {
      enabled: true,
      environment: 'test',
    }),
  };
}
function approval(
  candidate: Awaited<ReturnType<ReturnType<typeof repository>['prepareInternal']>>,
) {
  return {
    schemaVersion: 4 as const,
    confirmed: true as const,
    proposalId: candidate.proposalId,
    candidateId: candidate.id,
    proposalDigest: candidate.digest,
    writeDomains: ['training', 'nutrition', 'recovery', 'routine_schedule'],
    expectedBasis: candidate.basis,
    idempotencyKey: randomUUID(),
  } satisfies IntegratedApprovalV023;
}

const relations = [
  'plan_snapshot',
  'nutrition_plan_version',
  'routine_blueprint_version',
  'recovery_strategy_version',
  'routine_schedule_version',
  'plan_head',
  'nutrition_plan_head',
  'routine_blueprint_head',
  'recovery_strategy_head',
  'routine_schedule_head',
  'routine_occurrence',
  'coaching_thread',
  'coaching_message',
  'core_evidence_snapshot',
  'coaching_run',
  'coaching_analysis_output',
  'coaching_decision',
  'coaching_proposal',
  'coaching_candidate',
  'integrated_candidate_v4',
  'integrated_approval_v4',
  'command_receipt',
  'plan_history',
  'nutrition_plan_history',
  'recovery_strategy_history',
  'routine_schedule_history',
  'approval_app_admission_binding',
] as const;
type Relation = (typeof relations)[number];
const bindings: Partial<Record<Relation, readonly [string, string]>> = {
  core_evidence_snapshot: ['evidence_app_admission_binding', 'evidence_snapshot_id'],
  coaching_run: ['run_app_admission_binding', 'run_id'],
  coaching_candidate: ['candidate_app_admission_binding', 'candidate_id'],
  integrated_candidate_v4: ['integrated_candidate_app_admission_binding', 'candidate_id'],
};
type Json = AppFamilyRow['row'][string];
const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
const json = z.record(z.string(), jsonValue);
interface Row extends AppFamilyRow {
  hash: string;
  tuple: string;
}
async function hashJson(value: unknown) {
  const r = await sourcePool.query<{ hash: string }>(
    'SELECT wm_app_load.hash_json($1::jsonb) AS hash',
    [JSON.stringify(value)],
  );
  return z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(r.rows[0]?.hash);
}
async function rehash(rows: Row[]) {
  for (const [i, r] of rows.entries()) {
    r.ordinal = i + 1;
    r.hash = await hashJson(r.row);
    r.tuple = await hashJson({
      relation: r.relation,
      row: r.row,
      binding: r.binding,
      absence: r.absence,
      witness: r.witness,
    });
  }
  return rows;
}
async function archive(id: string, canonical: string | null = null) {
  const rows: Row[] = [];
  await scoped(sourcePool, id, async (c) => {
    for (const relation of relations) {
      const result = await c.query<{ v: unknown }>(
        `SELECT to_jsonb(r) AS v FROM public.${relation} r WHERE athlete_id=$1`,
        [id],
      );
      const data = result.rows
        .map((x) => json.parse(x.v))
        .filter(
          (x) =>
            relation !== 'command_receipt' ||
            /^(coaching:candidate:approve|integrated-v4:approve):/.test(
              z.string().parse(x['idempotency_key']),
            ),
        );
      data.sort(
        (a, b) =>
          Number(a['version'] ?? 0) - Number(b['version'] ?? 0) ||
          (relation === 'coaching_candidate'
            ? (a['parent_candidate_id'] ? 1 : 0) - (b['parent_candidate_id'] ? 1 : 0)
            : 0) ||
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
      for (const row of data) {
        const bt = bindings[relation];
        let binding: AppFamilyRow['binding'] = null;
        if (bt) {
          const r = await c.query<{ v: unknown }>(
            `SELECT to_jsonb(b) AS v FROM public.${bt[0]} b WHERE athlete_id=$1 AND ${bt[1]}=$2`,
            [id, row['id']],
          );
          binding = r.rows.length ? json.parse(r.rows[0]?.v) : null;
        }
        rows.push({
          relation,
          row,
          binding,
          absence: binding === null,
          witness:
            relation === 'approval_app_admission_binding' && row['candidate_id'] && canonical
              ? { canonicalRequest: canonical }
              : null,
          ordinal: 0,
          hash: '',
          tuple: '',
        });
      }
    }
  });
  return rehash(rows);
}
async function begin(
  c: PoolClient,
  id: string,
  run: string,
  rows: Row[],
  revision = controlRevision,
  targetNonce: string = nonce,
  targetIncarnation: string = incarnation,
) {
  await c.query('SELECT wm_app_load.begin_stage($1,$2,$3,$4,$5,1,$6,$7,$8,$9::bigint,$10)', [
    run,
    proofHash,
    'owner_restore_app_family',
    targetNonce,
    schemaHash,
    id,
    rows.length,
    await hashJson(rows.map((x) => ({ ordinal: x.ordinal, digest: x.tuple }))),
    revision,
    targetIncarnation,
  ]);
}
async function restore(
  id: string,
  rows: Row[],
  fail = false,
  tail: VerifiedSuppressionChain | null = null,
) {
  const entries: AppFamilyRow[] = rows.map(({ hash: _, tuple: __, ...entry }) => entry);
  const expected: AppFamilyIdentity = {
    sourceKeyId: 'synthetic-source',
    sourceKeyVersion: 1,
    purpose: 'owner_restore_app_family',
    schemaVersion: 100,
    targetSchemaVersion: 102,
    controlRevision,
    targetIncarnation: incarnation,
    schemaHash,
    targetNonce: nonce,
    ownerId: id,
    proofHash,
    expectedStateVersion: 1,
    count: entries.length,
    rowsSha256: appFamilyRowsSha256(entries),
  };
  const key = Buffer.alloc(32, 84);
  const handle = prepareVerifiedAppFamilyArtifact(
    signAppFamilyArtifact({ artifactVersion: 1, ...expected, rows: entries }, key),
    { expected, resolveSourceKey: () => key },
  );
  await scoped(targetPool, id, async (c) => {
    expect(await stageVerifiedAppFamilyArtifactIn(c, handle, expected, randomUUID())).toEqual({
      admissionAllowed: false,
    });
    if (tail) await replayVerifiedSuppressionChainIn(c, tail);
    if (fail) await c.query('SELECT 1/0');
  });
}
async function account(id: string) {
  await targetPool.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [id, 'https://synthetic.invalid', randomUUID()],
  );
}
async function exact(id: string, rows: Row[]) {
  await scoped(targetPool, id, async (c) => {
    for (const r of rows) {
      expect(
        (
          await c.query<{ found: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM public.${r.relation} p WHERE athlete_id=$1 AND to_jsonb(p)=$2::jsonb) AS found`,
            [id, JSON.stringify(r.row)],
          )
        ).rows[0]?.found,
      ).toBe(true);
      const bt = bindings[r.relation];
      if (bt) {
        const data = (
          await c.query<{ v: unknown }>(
            `SELECT to_jsonb(b) AS v FROM public.${bt[0]} b WHERE athlete_id=$1 AND ${bt[1]}=$2`,
            [id, r.row['id']],
          )
        ).rows;
        expect(data.length ? data[0]?.v : null).toEqual(r.binding);
      }
    }
  });
}

it('normal101→102 registry installation and plain owner/runtime privilege boundaries', async () => {
  const metadata = await sourcePool.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  expect(metadata.rows.map((x) => x.version)).toEqual(Array.from({ length: 102 }, (_, i) => i + 1));
  const flags = await admin.query(
    'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',
    [Object.values(roles)],
  );
  expect(flags.rows).toHaveLength(4);
  for (const r of flags.rows) expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  const rt = new Pool({ connectionString: url(names.target, roles.runtime) });
  try {
    await expect(rt.query('SELECT * FROM wm_app_load.descriptor')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      rt.query('SELECT wm_app_load.load_family($1)', [randomUUID()]),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await rt.end();
  }
});
it('normal SQL100 runtime capture/run/candidate bindings remain immutable and equal revision1', async () => {
  const id = randomUUID();
  const s = await seed(id);
  const parent = await candidates().createFromFixture(id, {
    runId: s.run.id,
    idempotencyKey: randomUUID(),
  });
  await scoped(sourcePool, id, async (c) => {
    expect(
      (
        await c.query(
          'SELECT app_revision FROM evidence_app_admission_binding WHERE athlete_id=$1 AND evidence_snapshot_id=$2',
          [id, s.evidence.id],
        )
      ).rows,
    ).toEqual([{ app_revision: 1 }]);
    expect(
      (
        await c.query(
          'SELECT evidence_snapshot_id FROM run_app_admission_binding WHERE athlete_id=$1 AND run_id=$2',
          [id, s.run.id],
        )
      ).rows,
    ).toEqual([{ evidence_snapshot_id: s.evidence.id }]);
    expect(
      (
        await c.query(
          'SELECT run_id FROM candidate_app_admission_binding WHERE athlete_id=$1 AND candidate_id=$2',
          [id, parent.candidate.id],
        )
      ).rows,
    ).toEqual([{ run_id: s.run.id }]);
  });
});
it('public training approval source family loads with exact original receipt and binding lineage', async () => {
  const id = randomUUID(),
    s = await seed(id),
    parent = await candidates().createFromFixture(id, {
      runId: s.run.id,
      idempotencyKey: randomUUID(),
    });
  const sealed = await candidates().derivePartial(id, parent.candidate.id, {
    sessionIds: ['session'],
    periodIds: [],
    includeTitle: false,
    idempotencyKey: randomUUID(),
  });
  const cmd = {
    confirmed: true as const,
    expectedDigest: sealed.candidate.digest,
    idempotencyKey: randomUUID(),
  };
  const original = await candidates().approve(id, sealed.candidate.id, cmd);
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries({
        schemaVersion: 1,
        operation: 'training_candidate_approve',
        candidateId: sealed.candidate.id,
        expectedDigest: sealed.candidate.digest,
        confirmed: true,
      }).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  const rows = await archive(id, canonical);
  expect(rows.length).toBeLessThanOrEqual(32);
  await account(id);
  await restore(id, rows);
  await exact(id, rows);
  expect(
    await createTrainingCandidateRepository(targetDatabase, { policy, source }).approve(
      id,
      sealed.candidate.id,
      cmd,
    ),
  ).toEqual(original);
});
it('public integrated fixture approval retains all four domain histories', async () => {
  const s = await sourceFixture(),
    candidate = await s.fixture.create(s.s.athleteId, s.cmd),
    cmd = approval(candidate),
    original = await s.repo.approve(s.s.athleteId, cmd);
  expect(original.versions).toHaveLength(4);
  const rows = await archive(s.s.athleteId);
  await account(s.s.athleteId);
  await restore(s.s.athleteId, rows);
  await exact(s.s.athleteId, rows);
  expect(
    await createIntegratedApprovalV4Repository(targetDatabase, {
      policyVersion: 'v4-test',
    }).approve(s.s.athleteId, cmd),
  ).toEqual(original);
});
it('post-load failure rolls back source rows, all bindings and stage descriptor', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await account(id);
  await expect(restore(id, rows, true)).rejects.toMatchObject({ code: '22012' });
  await scoped(targetPool, id, async (c) => {
    for (const table of [
      ...relations,
      'evidence_app_admission_binding',
      'run_app_admission_binding',
      'candidate_app_admission_binding',
      'integrated_candidate_app_admission_binding',
      'wm_app_load.descriptor',
    ])
      expect(
        (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE athlete_id=$1`, [id])).rows,
      ).toEqual([{ n: 0 }]);
  });
});
it('exact CLOSED controlRevision and target pair required before descriptor insertion', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await account(id);
  for (const [rev, n, i] of [
    [String(BigInt(controlRevision) - 1n), nonce, incarnation],
    [controlRevision, randomUUID(), incarnation],
    [controlRevision, nonce, randomUUID()],
  ])
    await expect(
      scoped(targetPool, id, (c) => begin(c, id, randomUUID(), rows, rev, n, i)),
    ).rejects.toMatchObject({ code: 'P0001' });
});
async function tail(id: string) {
  await createConsentRepository(database).setConsent(id, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await createConsentRepository(database).setConsent(id, {
    kind: 'app',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  const records = await scoped(sourcePool, id, async (c) =>
    (
      await c.query<Record<string, unknown>>(
        "SELECT e.*,occurred_at::text FROM restore_suppression_event e WHERE athlete_id=$1 AND kind='app_consent_transition' ORDER BY consent_revision",
        [id],
      )
    ).rows.map((row) =>
      validateSuppressionRecord(
        new Map(
          Object.entries(row).map(([k, v]) => [
            k,
            v === null ? null : typeof v === 'boolean' ? (v ? 't' : 'f') : String(v),
          ]),
        ),
      ),
    ),
  );
  const body = {
    localRecordVersion: 1 as const,
    clusterId: '123456789',
    fromLsn: '0/100',
    throughLsn: '0/120',
    previousHash: null,
    transactions: [{ commitLsn: '0/110', endLsn: '0/120', records }],
  };
  const envelope: LocalReplayRecordEnvelope = {
    ...body,
    sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
  const key = Buffer.alloc(32, 84),
    keyId = 'synthetic-family',
    bytes = encryptReplaySegment({ envelope, key, keyId }).bytes;
  return prepareVerifiedSuppressionChain({
    segments: [bytes],
    key,
    keyId,
    anchor: {
      clusterId: body.clusterId,
      fromLsn: body.fromLsn,
      throughLsn: body.throughLsn,
      previousHash: null,
      finalLocalHash: envelope.sha256,
      ciphertextHashes: [createHash('sha256').update(bytes).digest('hex')],
    },
  });
}
it('verified family plus authenticated tail in same transaction preserves binding1 under app3', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id),
    chain = await tail(id);
  await account(id);
  await restore(id, rows, false, chain);
  await exact(id, rows);
  expect(
    await scoped(targetPool, id, (c) =>
      c.query("SELECT granted,revision FROM consent WHERE athlete_id=$1 AND kind='app'", [id]),
    ),
  ).toMatchObject({ rows: [{ granted: true, revision: 3 }] });
});
it('failure after authenticated tail rolls back consent events/receipts and whole family', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id),
    chain = await tail(id);
  await account(id);
  await expect(restore(id, rows, true, chain)).rejects.toMatchObject({ code: '22012' });
  await scoped(targetPool, id, async (c) => {
    for (const table of [
      'consent',
      'restore_suppression_event',
      'restore_app_consent_replay_receipt',
      'core_evidence_snapshot',
      'evidence_app_admission_binding',
      'wm_app_load.descriptor',
    ])
      expect(
        (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE athlete_id=$1`, [id])).rows,
      ).toEqual([{ n: 0 }]);
  });
});
it('generation rotated outside exact CLOSED control is rejected without stage writes', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await account(id);
  await expect(
    scoped(targetPool, id, async (c) => {
      await c.query('SELECT public.rotate_restore_generation()');
      await begin(c, id, randomUUID(), rows);
    }),
  ).rejects.toMatchObject({ message: 'LOAD_GENERATION_REJECTED' });
});
it('absent owned target account and foreign tenant context cannot begin family', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await expect(
    scoped(targetPool, id, (c) => begin(c, id, randomUUID(), rows)),
  ).rejects.toMatchObject({ message: 'LOAD_TARGET_REJECTED' });
  await account(id);
  await expect(
    scoped(targetPool, randomUUID(), (c) => begin(c, id, randomUUID(), rows)),
  ).rejects.toMatchObject({ message: 'LOAD_TARGET_REJECTED' });
});
it('wrong private schema pin rejects even with matching global CLOSED identity', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await account(id);
  await expect(
    scoped(targetPool, id, async (c) => {
      await c.query('UPDATE wm_app_load.target SET schema_hash=$1', ['0'.repeat(64)]);
      await begin(c, id, randomUUID(), rows);
    }),
  ).rejects.toMatchObject({ message: 'LOAD_TARGET_REJECTED' });
});
it('raw owner cannot mutate sealed descriptor or stage tuple after verification', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await account(id);
  await expect(
    scoped(targetPool, id, async (c) => {
      const run = randomUUID();
      await begin(c, id, run, rows);
      await c.query('UPDATE wm_app_load.descriptor SET expected_digest=$2 WHERE run_id=$1', [
        run,
        '0'.repeat(64),
      ]);
    }),
  ).rejects.toMatchObject({ message: 'LOAD_INVENTORY_IMMUTABLE' });
});
it('raw unsigned stage row hash cannot bypass exact SQL typed-row digest', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await account(id);
  const row = rows[0];
  if (!row) throw new Error('FIXTURE_ROW_MISSING');
  await expect(
    scoped(targetPool, id, async (c) => {
      const run = randomUUID();
      await begin(c, id, run, rows);
      await c.query('SELECT wm_app_load.stage_family($1,1,$2,$3,$4,NULL,true,NULL)', [
        run,
        row.relation,
        JSON.stringify(row.row),
        '0'.repeat(64),
      ]);
    }),
  ).rejects.toMatchObject({ message: 'LOAD_FAMILY_ROW_REJECTED' });
});
it('source-signed unknown row fields reject before any live target insertion', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await account(id);
  const row = rows[0];
  if (!row) throw new Error('FIXTURE_ROW_MISSING');
  row.row['callerVerified'] = true;
  await expect(restore(id, rows)).rejects.toThrow();
  expect(
    (
      await scoped(targetPool, id, (c) =>
        c.query('SELECT count(*)::int AS n FROM wm_app_load.descriptor WHERE athlete_id=$1', [id]),
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});
it('source-signed cross-tenant binding cannot become owner authority', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await account(id);
  const row = rows.find((r) => r.binding !== null);
  if (!row?.binding) throw new Error('FIXTURE_BINDING_MISSING');
  row.binding['athlete_id'] = randomUUID();
  await expect(restore(id, rows)).rejects.toThrow();
  expect(
    (
      await scoped(targetPool, id, (c) =>
        c.query('SELECT count(*)::int AS n FROM core_evidence_snapshot WHERE athlete_id=$1', [id]),
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});
async function waitLock(client: PoolClient, pid: number, mode: string) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const result = await client.query<{ waiting: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=77210 AND objid=1 AND objsubid=2 AND mode=$2 AND NOT granted) AS waiting",
      [pid, mode],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('LOCK_WAIT_NOT_OBSERVED');
}
it('runtime global shared blocks loader before lifecycle and tenant locks', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await account(id);
  const rt = new Pool({ connectionString: url(names.target, roles.runtime) }),
    holder = await rt.connect(),
    loader = await targetPool.connect(),
    observer = await targetPool.connect();
  let pending: Promise<unknown> | null = null;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT public.lock_restore_processing_shared()');
    await loader.query('BEGIN');
    await loader.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    const pid = z
      .number()
      .parse((await loader.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
    pending = begin(loader, id, randomUUID(), rows);
    await waitLock(observer, pid, 'ExclusiveLock');
    expect(
      (
        await observer.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND objsubid=1",
          [pid],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    await holder.query('ROLLBACK');
    await pending;
    await loader.query('ROLLBACK');
  } finally {
    await holder.query('ROLLBACK');
    if (pending) await pending.catch(() => undefined);
    await loader.query('ROLLBACK');
    holder.release();
    loader.release();
    observer.release();
    await rt.end();
  }
});
it('loader global exclusive blocks runtime shared status port until rollback', async () => {
  const id = randomUUID();
  await seed(id);
  const rows = await archive(id);
  await account(id);
  const rt = new Pool({ connectionString: url(names.target, roles.runtime) }),
    reader = await rt.connect(),
    loader = await targetPool.connect(),
    observer = await targetPool.connect();
  let pending: Promise<unknown> | null = null;
  try {
    await loader.query('BEGIN');
    await loader.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    await begin(loader, id, randomUUID(), rows);
    await reader.query('BEGIN');
    const pid = z
      .number()
      .parse((await reader.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
    pending = reader.query('SELECT public.lock_restore_processing_shared()');
    await waitLock(observer, pid, 'ShareLock');
    await loader.query('ROLLBACK');
    await pending;
    await reader.query('ROLLBACK');
  } finally {
    await loader.query('ROLLBACK');
    if (pending) await pending.catch(() => undefined);
    await reader.query('ROLLBACK');
    reader.release();
    loader.release();
    observer.release();
    await rt.end();
  }
});
it('registered102 REASSIGN plus existing retarget preserves exact signed family/tail and denies old owner', async () => {
  const id = randomUUID(),
    s = await seed(id),
    parent = await candidates().createFromFixture(id, {
      runId: s.run.id,
      idempotencyKey: randomUUID(),
    });
  const sealed = await candidates().derivePartial(id, parent.candidate.id, {
    sessionIds: ['session'],
    periodIds: [],
    includeTitle: false,
    idempotencyKey: randomUUID(),
  });
  const cmd = {
    confirmed: true as const,
    expectedDigest: sealed.candidate.digest,
    idempotencyKey: randomUUID(),
  };
  const original = await candidates().approve(id, sealed.candidate.id, cmd);
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries({
        schemaVersion: 1,
        operation: 'training_candidate_approve',
        candidateId: sealed.candidate.id,
        expectedDigest: sealed.candidate.digest,
        confirmed: true,
      }).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  const rows = await archive(id, canonical),
    chain = await tail(id);
  const sourceDigest = await hashJson(rows);
  await account(id);
  const nextRole = `family_next_${suffix}`;
  await admin.query(
    `CREATE ROLE "${nextRole}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  extraRoles.push(nextRole);
  const oldPool = targetPool;
  await admin.query(`GRANT "${nextRole}" TO "${roles.owner}"`);
  try {
    await oldPool.query(`REASSIGN OWNED BY "${roles.owner}" TO "${nextRole}"`);
  } finally {
    await admin.query(`REVOKE "${nextRole}" FROM "${roles.owner}"`);
  }
  targetPool = new Pool({ connectionString: url(names.target, nextRole), max: 6 });
  pools.push(targetPool);
  expect(
    (
      await targetPool.query(
        'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user',
      )
    ).rows,
  ).toEqual([{ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false }]);
  expect(
    Number((await targetPool.query('SELECT public.retarget_definer_policies() AS n')).rows[0]?.n),
  ).toBeGreaterThan(0);
  expect(
    (
      await targetPool.query(
        "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=ANY(ARRAY['public.restore_processing_admission'::regclass,'public.restore_processing_close_receipt'::regclass,'wm_app_load.target'::regclass,'wm_app_load.descriptor'::regclass,'public.core_evidence_snapshot'::regclass])",
      )
    ).rows,
  ).toEqual(Array.from({ length: 5 }, () => ({ owner: nextRole })));
  const before = (
    await targetPool.query('SELECT public.read_restore_processing_admission() AS control')
  ).rows;
  await expect(restore(id, rows, true, chain)).rejects.toMatchObject({ code: '22012' });
  await scoped(targetPool, id, async (c) => {
    for (const table of [
      ...relations,
      'evidence_app_admission_binding',
      'run_app_admission_binding',
      'candidate_app_admission_binding',
      'wm_app_load.descriptor',
      'restore_app_consent_replay_receipt',
    ])
      expect(
        (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE athlete_id=$1`, [id])).rows,
      ).toEqual([{ n: 0 }]);
  });
  expect(
    (await targetPool.query('SELECT public.read_restore_processing_admission() AS control')).rows,
  ).toEqual(before);
  await restore(id, rows, false, chain);
  await exact(id, rows);
  expect(
    await createTrainingCandidateRepository(targetDatabase, { policy, source }).approve(
      id,
      sealed.candidate.id,
      cmd,
    ),
  ).toEqual(original);
  expect(await hashJson(await archive(id, canonical))).toEqual(sourceDigest);
  expect(
    (
      await scoped(targetPool, id, (c) =>
        c.query("SELECT granted,revision FROM consent WHERE athlete_id=$1 AND kind='app'", [id]),
      )
    ).rows,
  ).toEqual([{ granted: true, revision: 3 }]);
  await expect(scoped(oldPool, id, (c) => begin(c, id, randomUUID(), rows))).rejects.toMatchObject({
    code: '42501',
  });
  await expect(
    oldPool.query('SELECT public.assert_restore_processing_closed($1::bigint,$2,$3)', [
      controlRevision,
      nonce,
      incarnation,
    ]),
  ).rejects.toMatchObject({ code: '42501' });
});
