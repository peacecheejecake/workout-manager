import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { accountExportSchema } from '@workout/contracts/operations';
import { createOperationsRepository } from '../src/operations.js';
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

// Bounded historical100 → authenticated102 family → NORMAL105 upgrade acceptance.
// Synthetic trust/AI fixtures never authorize admission, full backup restore or provider dispatch.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const roles = {
  owner: `upgrade_owner_${suffix}`,
  runtime: `upgrade_runtime_${suffix}`,
  worker: `upgrade_worker_${suffix}`,
  outside: `upgrade_outside_${suffix}`,
};
const names = { source: `upgrade_source_${suffix}`, target: `upgrade_target_${suffix}` };
const pools: Pool[] = [];

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
    await c.query('SELECT pg_advisory_xact_lock(77210,1)');
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
    await grants.migrate(url(name), name === names.source ? 100 : 102);
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
  for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
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
async function archive(id: string, canonical: string | null = null) {
  const rows: AppFamilyRow[] = [];
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
          ordinal: rows.length + 1,
        });
      }
    }
  });
  return rows;
}
async function restore(
  id: string,
  rows: AppFamilyRow[],
  fail = false,
  tail: VerifiedSuppressionChain | null = null,
) {
  const entries = rows;
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
async function exact(id: string, rows: AppFamilyRow[]) {
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
  const verified = (selected: typeof records) => {
    const body = {
      localRecordVersion: 1 as const,
      clusterId: '123456789',
      fromLsn: '0/100',
      throughLsn: '0/120',
      previousHash: null,
      transactions: [{ commitLsn: '0/110', endLsn: '0/120', records: selected }],
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
  };
  expect(records).toHaveLength(3);
  return { withdrawal: verified(records.slice(0, 2)), regrant: verified(records) };
}

async function copyOriginalAiConsent(id: string) {
  // This narrow owner fixture copies the actual source consent baseline. No target
  // producer recreates evidence/run/output/candidate/approval or any binding.
  const original = await scoped(
    sourcePool,
    id,
    async (c) =>
      (
        await c.query(
          "SELECT athlete_id,kind,granted,revision FROM consent WHERE athlete_id=$1 AND kind='ai'",
          [id],
        )
      ).rows,
  );
  expect(original).toEqual([{ athlete_id: id, kind: 'ai', granted: true, revision: 1 }]);
  await scoped(targetPool, id, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [id]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
    await c.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'ai',$2,$3)", [
      id,
      original[0]?.['granted'],
      original[0]?.['revision'],
    ]);
  });
}
async function liveCounts(id: string) {
  return scoped(targetPool, id, async (c) => {
    const values: Record<string, number> = {};
    for (const relation of [...relations, ...Object.values(bindings).map((pair) => pair[0])]) {
      values[relation] = z
        .number()
        .int()
        .nonnegative()
        .parse(
          (
            await c.query(
              `SELECT count(*)::integer AS n FROM public.${relation} WHERE athlete_id=$1`,
              [id],
            )
          ).rows[0]?.['n'],
        );
    }
    return values;
  });
}

it('authenticates original source100 families, upgrades102→105 normally, and retains epoch1 materials under exact app2/3 tail', async () => {
  expect((await sourcePool.query('SELECT max(version) AS n FROM schema_migrations')).rows).toEqual([
    { n: 100 },
  ]);
  expect((await targetPool.query('SELECT max(version) AS n FROM schema_migrations')).rows).toEqual([
    { n: 102 },
  ]);
  expect(
    (
      await admin.query(
        'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[])',
        [Object.values(roles)],
      )
    ).rows,
  ).toEqual(Object.values(roles).map(() => ({ rolsuper: false, rolbypassrls: false })));

  const id = randomUUID(),
    s = await seed(id);
  const parent = await candidates().createFromFixture(id, {
    runId: s.run.id,
    idempotencyKey: randomUUID(),
  });
  const sealed = await candidates().derivePartial(id, parent.candidate.id, {
    sessionIds: ['session'],
    periodIds: [],
    includeTitle: false,
    idempotencyKey: randomUUID(),
  });
  const command = {
    confirmed: true as const,
    expectedDigest: sealed.candidate.digest,
    idempotencyKey: randomUUID(),
  };
  const originalApproval = await candidates().approve(id, sealed.candidate.id, command);
  // Produce a second actual source output against the approved current plan so
  // historical-read freshness remains meaningful after restoring that same head.
  const currentThread = (
    await createCoachingThreadRepository(database).create(id, {
      planVersionId: originalApproval.id,
      title: 'Synthetic approved-plan coaching',
      scope: { kind: 'session', targetId: 'session' },
      message: 'Synthetic current plan input',
      idempotencyKey: randomUUID(),
    })
  ).thread;
  const evidence = await createCoreEvidenceSnapshotRepository(database).capture(
    id,
    currentThread.id,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  const run = await runs().create(id, currentThread.id, {
    schemaVersion: 1,
    evidenceSnapshotId: evidence.id,
    expectedConversationRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(
    await runOneCoachingJob({
      athleteId: id,
      store: createCoachingRunWorkerStore(workerDatabase, { policy, source }),
      adapter: createDeterministicFixtureAdapter('synthetic-v1'),
    }),
  ).toBe('stored');
  const originalOutput = await runs().readOutput(id, run.id);
  expect(originalOutput).not.toBeNull();
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
  const trainingRows = await archive(id, canonical);

  const integrated = await sourceFixture(),
    ic = await integrated.fixture.create(integrated.s.athleteId, integrated.cmd),
    iCommand = approval(ic);
  const originalIntegrated = await integrated.repo.approve(integrated.s.athleteId, iCommand);
  expect(originalIntegrated.versions).toHaveLength(4);
  const integratedRows = await archive(integrated.s.athleteId);
  for (const relation of [
    'core_evidence_snapshot',
    'coaching_run',
    'coaching_candidate',
  ] as const) {
    const originals = trainingRows.filter((row) => row.relation === relation);
    expect(originals.length).toBeGreaterThan(0);
    expect(originals.every((row) => row.binding !== null && !row.absence)).toBe(true);
  }
  expect(
    integratedRows.filter(
      (row) => row.relation === 'integrated_candidate_v4' && row.binding !== null && !row.absence,
    ),
  ).toHaveLength(1);
  expect(
    trainingRows.filter((row) => row.relation === 'approval_app_admission_binding'),
  ).toHaveLength(1);
  expect(
    integratedRows.filter((row) => row.relation === 'approval_app_admission_binding'),
  ).toHaveLength(1);

  const legacyId = randomUUID(),
    legacy = await seed(legacyId);
  const legacyOutput = await runs().readOutput(legacyId, legacy.run.id);
  expect(legacyOutput).not.toBeNull();
  // Exact owner-allowed storage absence fixture, not a fabricated pre100 dump.
  // No guard/constraint disable and no target replacement binding.
  await scoped(sourcePool, legacyId, (c) =>
    c.query('DELETE FROM run_app_admission_binding WHERE athlete_id=$1', [legacyId]),
  );
  const legacyRows = await archive(legacyId);
  expect(legacyRows.find((row) => row.relation === 'coaching_run')?.absence).toBe(true);

  for (const owner of [id, integrated.s.athleteId, legacyId]) {
    await account(owner);
    await copyOriginalAiConsent(owner);
  }
  const before = await liveCounts(id);
  await expect(restore(id, trainingRows, true)).rejects.toMatchObject({ code: '22012' });
  expect(await liveCounts(id)).toEqual(before);
  expect(
    (await targetPool.query('SELECT count(*)::integer AS n FROM wm_app_load.descriptor')).rows,
  ).toEqual([{ n: 0 }]);
  for (const [owner, rows] of [
    [id, trainingRows],
    [integrated.s.athleteId, integratedRows],
    [legacyId, legacyRows],
  ] as const) {
    await restore(owner, rows);
    await exact(owner, rows);
  }

  await grants.migrate(url(names.target), 105);
  await grants.grantOperations(url(names.target), roles.runtime);
  const metadata = await targetPool.query(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  expect(metadata.rows.map((row) => row['version'])).toEqual(
    Array.from({ length: 105 }, (_, i) => i + 1),
  );
  for (const version of [103, 104, 105]) {
    const file = grants.migrationFileNames[version - 1];
    if (!file) throw new Error('Migration registry entry missing');
    expect(metadata.rows[version - 1]?.['checksum']).toBe(
      createHash('sha256')
        .update(await readFile(new URL(`../migrations/${file}`, import.meta.url)))
        .digest('hex'),
    );
  }
  const closed = (
    await targetPool.query('SELECT public.read_restore_processing_admission() AS state')
  ).rows[0]?.['state'];
  expect(closed).toMatchObject({
    state: 'CLOSED',
    localRevision: controlRevision,
    targetNonce: nonce,
    targetIncarnation: incarnation,
    admissionAllowed: false,
  });

  for (const [owner, rows] of [
    [id, trainingRows],
    [integrated.s.athleteId, integratedRows],
    [legacyId, legacyRows],
  ] as const) {
    await exact(owner, rows);
    const counts = await liveCounts(owner),
      { regrant: chain, withdrawal } = await tail(owner);
    await expect(
      scoped(targetPool, owner, async (c) => {
        await replayVerifiedSuppressionChainIn(c, chain);
        await c.query('SELECT 1/0');
      }),
    ).rejects.toMatchObject({ code: '22012' });
    expect(await liveCounts(owner)).toEqual(counts);
    expect(
      (
        await scoped(targetPool, owner, (c) =>
          c.query(
            'SELECT count(*)::integer AS n FROM restore_app_consent_replay_receipt WHERE athlete_id=$1',
            [owner],
          ),
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    await scoped(targetPool, owner, (c) => replayVerifiedSuppressionChainIn(c, withdrawal));
    expect(
      (
        await scoped(targetPool, owner, (c) =>
          c.query("SELECT granted,revision FROM consent WHERE athlete_id=$1 AND kind='app'", [
            owner,
          ]),
        )
      ).rows,
    ).toEqual([{ granted: false, revision: 2 }]);
    await exact(owner, rows);
    if (owner === id)
      expect(
        await createCoachingRunRepository(targetDatabase, { policy, source }).readOutput(
          id,
          run.id,
        ),
      ).toEqual(originalOutput);
    if (owner === legacyId)
      expect(
        await createCoachingRunRepository(targetDatabase, { policy, source }).readOutput(
          legacyId,
          legacy.run.id,
        ),
      ).toEqual(legacyOutput);
    const withdrawnExport = accountExportSchema.parse(
      await createOperationsRepository(targetDatabase).exportAccount(owner),
    );
    expect(withdrawnExport.schemaVersion).toBe(33);
    if (withdrawnExport.schemaVersion !== 33) throw new Error('Expected latest export33');
    expect(withdrawnExport.data.evidenceAppBindings.every((row) => row.app_revision === 1)).toBe(
      true,
    );
    await scoped(targetPool, owner, (c) => replayVerifiedSuppressionChainIn(c, chain));
    await scoped(targetPool, owner, (c) => replayVerifiedSuppressionChainIn(c, chain));
    await exact(owner, rows);
    expect(await liveCounts(owner)).toEqual(counts);
    expect(
      (
        await scoped(targetPool, owner, (c) =>
          c.query("SELECT granted,revision FROM consent WHERE athlete_id=$1 AND kind='app'", [
            owner,
          ]),
        )
      ).rows,
    ).toEqual([{ granted: true, revision: 3 }]);
    expect(
      (
        await scoped(targetPool, owner, (c) =>
          c.query(
            'SELECT DISTINCT app_revision FROM evidence_app_admission_binding WHERE athlete_id=$1',
            [owner],
          ),
        )
      ).rows,
    ).toEqual([{ app_revision: 1 }]);
  }
  const targetRuns = createCoachingRunRepository(targetDatabase, { policy, source });
  expect(await targetRuns.readOutput(id, run.id)).toEqual(originalOutput);
  expect(await targetRuns.readOutput(legacyId, legacy.run.id)).toEqual(legacyOutput);
  expect(
    (
      await scoped(targetPool, legacyId, (c) =>
        c.query(
          'SELECT count(*)::integer AS n FROM run_app_admission_binding WHERE athlete_id=$1',
          [legacyId],
        ),
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
  await expect(
    targetDatabase.tenant(legacyId, (tx) =>
      tx.query('SELECT public.require_run_app_binding($1)', [legacy.run.id]),
    ),
  ).rejects.toThrow('APP_BINDING_UNAVAILABLE');
  const targetCandidates = createTrainingCandidateRepository(targetDatabase, { policy, source });
  expect(await targetCandidates.approve(id, sealed.candidate.id, command)).toEqual(
    originalApproval,
  );
  await expect(
    targetCandidates.approve(id, sealed.candidate.id, { ...command, idempotencyKey: randomUUID() }),
  ).rejects.toThrow('STALE_APP_ADMISSION');
  const targetIntegrated = createIntegratedApprovalV4Repository(targetDatabase, {
    policyVersion: 'v4-test',
  });
  expect(await targetIntegrated.approve(integrated.s.athleteId, iCommand)).toEqual(
    originalIntegrated,
  );
  await expect(
    targetIntegrated.approve(integrated.s.athleteId, { ...iCommand, idempotencyKey: randomUUID() }),
  ).rejects.toThrow('STALE_APP_ADMISSION');
  const exported = accountExportSchema.parse(
    await createOperationsRepository(targetDatabase).exportAccount(id),
  );
  expect(exported.schemaVersion).toBe(33);
  if (exported.schemaVersion !== 33) throw new Error('Expected latest export33');
  expect(exported.data.evidenceAppBindings.every((row) => row.app_revision === 1)).toBe(true);
  expect(exported.data.runAppBindings).toHaveLength(
    trainingRows.filter((row) => row.relation === 'coaching_run').length,
  );
  const integratedExport = accountExportSchema.parse(
    await createOperationsRepository(targetDatabase).exportAccount(integrated.s.athleteId),
  );
  expect(integratedExport.schemaVersion).toBe(33);
  if (integratedExport.schemaVersion !== 33) throw new Error('Expected latest export33');
  expect(integratedExport.data.integratedCandidateAppBindings).toHaveLength(1);
  expect(integratedExport.data.approvalAppBindings).toHaveLength(1);
  expect(
    (await targetPool.query('SELECT public.read_restore_processing_admission() AS state'))
      .rows[0]?.['state'],
  ).toEqual(closed);
}, 30000);
