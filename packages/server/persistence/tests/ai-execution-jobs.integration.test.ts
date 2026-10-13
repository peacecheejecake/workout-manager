import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import type { PlanDraft } from '@workout/contracts/planning';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import {
  installCurrentRuntimeV11,
  verifyCurrentRuntimeV11InstalledIn,
} from '../src/current-runtime-installation-v11.js';
import { grantCurrentRuntimeV11Profile } from '../src/current-runtime-grants-v11.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createConsentRepository } from '../src/repositories.js';
import { createAiSettingsRepository } from '../src/ai-settings.js';
import { createCoachingRunRepository } from '../src/coaching-runs.js';
import { createOperationsRepository } from '../src/operations.js';
import { digestExecutionCatalog } from '@workout/server-coaching/coaching-execution-selection';
import { prepareCoachingExecutionIn } from '../src/coaching-execution-preparation.js';
import {
  AiExecutionJobError,
  createAiExecutionJobRepository,
  cancelRestoredAiExecutionJobIn,
  classifyAttestedSyntheticEvidenceIn,
  digestFrozenExecutionDraft,
  exportAiExecutionJobsIn,
  readAiExecutionJobIn,
} from '../src/ai-execution-jobs.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Real PostgreSQL 17: committed profile27 (V11 installer incl. 148 + app core + V11 runtime
// grants). The disposition SELECT/INSERT, which V11 reserves for the M2-05b dispatcher role, is
// granted to the runtime role here only, test-locally. Synthetic catalog/registry only: not a key, price, model access or
// provider proof. No provider request, budget hold or dispatch happens anywhere here.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `ai_execution_job_${suffix}`;
const ownerRole = `ai_exec_job_owner_${suffix}`;
const runtimeRole = `ai_exec_job_runtime_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 2 });
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
const inspectorUrl = new URL(adminUrl);
inspectorUrl.pathname = `/${dbName}`;
let owner: Pool, inspector: Pool, runtimePool: Pool, database: Database;
const policy = { id: 'running-core-v2-training', version: '1' };
const sol = { providerId: 'openai', modelId: 'gpt-6.1-sol' };
const luna = { providerId: 'openai', modelId: 'gpt-6-luna' };
const catalogRevision = 1;
const settings = {
  revision: 1,
  catalogRevision,
  policyVersion: 'm2-05a-policy:1',
  disclosureVersion: 'm2-05a-disclosure:1',
};
const binding = (selection: typeof sol, purpose: string) => ({
  selection,
  purpose,
  adapterBindingVersion: 'synthetic:adapter:1',
  vendorModelRef: `synthetic:${selection.modelId}`,
  priceModelRef: selection.modelId,
  priceVersion: 'synthetic:price:1',
  tokenizerVersion: 'synthetic:tokenizer:1',
});
const registry = [binding(sol, 'coaching'), binding(luna, 'synthetic_comparison')];
const catalog = {
  schemaVersion: 1,
  catalogRevision,
  policyVersion: settings.policyVersion,
  disclosureVersion: settings.disclosureVersion,
  approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'resource_excerpt'],
  providers: [
    {
      providerId: 'openai',
      displayName: 'Synthetic OpenAI',
      selectable: true,
      availability: { kind: 'available' },
      recipient: {
        recipientId: 'openai',
        displayName: 'Synthetic recipient',
        disclosureVersion: settings.disclosureVersion,
      },
      models: [
        {
          modelId: sol.modelId,
          displayName: 'Synthetic Sol',
          selectable: true,
          availability: { kind: 'available' },
          purposes: ['coaching'],
        },
        {
          modelId: luna.modelId,
          displayName: 'Synthetic Luna',
          selectable: true,
          availability: { kind: 'available' },
          purposes: ['synthetic_comparison'],
        },
      ],
    },
  ],
  recommendedDefault: null,
  recommendedSyntheticComparison: { kind: 'off' },
};
let repository: ReturnType<typeof createAiExecutionJobRepository>;

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole), 107);
  // Committed profile27.
  await installCurrentRuntimeV11(url(ownerRole));
  await grantCurrentRuntimeAppBaselineV2(url(ownerRole), runtimeRole, 'core');
  await grantCurrentRuntimeV11Profile(url(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: url(ownerRole), max: 2 });
  inspector = new Pool({ connectionString: inspectorUrl.toString(), max: 2 });
  // Test-only: the dispatcher-reserved disposition privileges on the runtime role.
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `GRANT SELECT,INSERT ON public.ai_execution_job_disposition TO "${runtimeRole}"`,
    );
    await client.query('COMMIT');
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212))",
    );
    await client.query(
      "INSERT INTO ai_settings_catalog_definition VALUES($1,$2::jsonb,encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex'))",
      [catalogRevision, JSON.stringify(catalog)],
    );
    await client.query('INSERT INTO ai_settings_catalog_head VALUES(true,$1)', [catalogRevision]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  database = createDatabase({ connectionString: url(runtimeRole), max: 6 });
  runtimePool = new Pool({ connectionString: url(runtimeRole), max: 2 });
  repository = createAiExecutionJobRepository(database, { policy, registry });
}, 240000);
afterAll(async () => {
  await database?.close();
  await runtimePool?.end();
  await owner?.end();
  await inspector?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
}, 60000);

async function scenario(comparison: 'off' | 'luna' = 'off') {
  const athleteId = randomUUID();
  const consent = createConsentRepository(database);
  await consent.setConsent(athleteId, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const draft: PlanDraft = {
    title: 'Training',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: null,
        title: 'Run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
  const plan = await createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });
  const thread = (
    await createCoachingThreadRepository(database).create(athleteId, {
      planVersionId: plan.id,
      title: 'Training question',
      scope: { kind: 'session', targetId: 'session' },
      message: 'Synthetic private report',
      idempotencyKey: randomUUID(),
    })
  ).thread;
  await consent.setConsent(athleteId, {
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
  await createAiSettingsRepository(database).write(athleteId, {
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    catalogRevision,
    policyVersion: settings.policyVersion,
    disclosureVersion: settings.disclosureVersion,
    defaultSelection: sol,
    syntheticComparison:
      comparison === 'off' ? { kind: 'off' } : { kind: 'selected', selection: luna },
  });
  const command = (purpose: 'coaching' | 'synthetic_comparison' = 'coaching') => ({
    commandVersion: 1 as const,
    evidenceSnapshotId: evidence.id,
    expectedConversationRevision: 1,
    purpose,
    settings,
    idempotencyKey: randomUUID(),
  });
  return { athleteId, thread, evidence, command };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

async function facts(athleteId: string) {
  const result = await inspector.query(
    `SELECT (SELECT count(*)::int FROM ai_execution_job WHERE athlete_id=$1) AS jobs,
     (SELECT count(*)::int FROM coaching_run WHERE athlete_id=$1) AS runs,
     (SELECT count(*)::int FROM coaching_run WHERE athlete_id=$1 AND source->>'kind'='provider') AS provider_runs,
     (SELECT count(*)::int FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'ai-execution:run:v1:%') AS receipts,
     (SELECT count(*)::int FROM outbox WHERE athlete_id=$1 AND topic='coaching.execution_job_queued') AS queued,
     (SELECT count(*)::int FROM outbox WHERE athlete_id=$1 AND topic='coaching.run_queued') AS fixture_queued,
     (SELECT count(*)::int FROM openai_budget_reservation WHERE athlete_id=$1) AS holds`,
    [athleteId],
  );
  return result.rows[0];
}
/** Owner-only: an identity account with the given issuer for the scenario subject. */
async function account(athleteId: string, issuer: string) {
  await owner.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [athleteId, issuer, randomUUID()],
  );
}
/** Owner fixture publisher: attests the exact current body of one snapshot. */
async function attest(s: Scenario, overrides: { bodySha256?: string } = {}) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [s.athleteId]);
    await client.query(
      `INSERT INTO ai_synthetic_evidence_attestation(athlete_id,evidence_snapshot_id,provenance,fixture_id,subject_issuer,body_sha256,item_manifest)
       SELECT athlete_id,id,'synthetic_fixture_v1','synthetic:m2-05a:1','https://synthetic.invalid',
        coalesce($2,encode(sha256(convert_to(body::text,'UTF8')),'hex')),public.ai_synthetic_evidence_manifest_v1(body)
       FROM core_evidence_snapshot WHERE athlete_id=$1 AND id=$3`,
      [s.athleteId, overrides.bodySha256 ?? null, s.evidence.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function expectCode(operation: Promise<unknown>, code: string) {
  await expect(operation).rejects.toSatisfy(
    (error: unknown) =>
      (error instanceof AiExecutionJobError && error.code === code) ||
      (error instanceof Error && error.message === code),
  );
}

/** Writes a run+job by hand inside the caller's tenant transaction, using a real
 * same-transaction frozen selection. Overrides let a test forge single columns. */
async function manualJob(
  tx: Transaction,
  s: Scenario,
  overrides: Record<string, unknown> = {},
  existingRunId?: string,
) {
  const prepared = await prepareCoachingExecutionIn(
    tx,
    {
      threadId: s.thread.id,
      evidenceSnapshotId: s.evidence.id,
      expectedConversationRevision: 1,
      settings,
      purpose: 'coaching',
    },
    { policy, registry, classifyEvidenceIn: async () => 'health' },
  );
  if (prepared.kind !== 'prepared') throw new Error(`unexpected ${prepared.code}`);
  const { draft } = prepared.frozen;
  // A forged catalog digest with a selection digest recomputed over it: internally
  // consistent, so only the catalog binding can refuse it.
  const forgedCatalogDigest = overrides['forgeCatalogDigest'];
  const catalogDigest =
    typeof forgedCatalogDigest === 'string' ? forgedCatalogDigest : draft.catalogDigest;
  const selectionDigest =
    typeof forgedCatalogDigest === 'string'
      ? digestFrozenExecutionDraft({ ...draft, catalogDigest })
      : prepared.frozen.selectionDigest;
  const runId = existingRunId ?? randomUUID();
  const source = { kind: 'provider', providerId: sol.providerId, modelId: sol.modelId };
  if (!existingRunId)
    await tx.query(
      `INSERT INTO coaching_run(athlete_id,id,thread_id,evidence_snapshot_id,conversation_revision,policy,source,basis)
       VALUES($1,$2,$3,$4,1,$5::jsonb,$6::jsonb,'{}'::jsonb)`,
      [
        tx.athleteId,
        runId,
        s.thread.id,
        s.evidence.id,
        JSON.stringify(policy),
        JSON.stringify(overrides['runSource'] ?? source),
      ],
    );
  const row: Record<string, unknown> = {
    job_id: randomUUID(),
    run_id: runId,
    thread_id: s.thread.id,
    evidence_snapshot_id: s.evidence.id,
    purpose: draft.binding.purpose,
    payload_classification: draft.payloadClassification,
    settings_revision: draft.settingsRevision,
    catalog_revision: draft.catalogRevision,
    catalog_digest: catalogDigest,
    policy_version: draft.policyVersion,
    disclosure_version: draft.disclosureVersion,
    recipient_id: draft.recipientId,
    recipient_disclosure_version: draft.recipientDisclosureVersion,
    provider_id: draft.binding.selection.providerId,
    model_id: draft.binding.selection.modelId,
    adapter_binding_version: draft.binding.adapterBindingVersion,
    vendor_model_ref: draft.binding.vendorModelRef,
    price_model_ref: draft.binding.priceModelRef,
    price_version: draft.binding.priceVersion,
    tokenizer_version: draft.binding.tokenizerVersion,
    app_consent_revision: draft.permissions.app.revision,
    app_consent_digest: draft.permissions.app.digest,
    ai_consent_revision: draft.permissions.ai.revision,
    ai_consent_digest: draft.permissions.ai.digest,
    selection_digest: selectionDigest,
    receipt_key: `ai-execution:run:v1:${'a'.repeat(64)}`,
    request_digest: 'b'.repeat(64),
    athlete_id: tx.athleteId,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => key !== 'runSource' && key !== 'forgeCatalogDigest',
      ),
    ),
  };
  const columns = Object.keys(row);
  await tx.query(
    `INSERT INTO ai_execution_job(${columns.join(',')},command_version,selection_version,restore_generation_id)
     VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')},1,1,public.current_restore_generation())`,
    columns.map((column) => row[column]),
  );
  return { runId, jobId: row['job_id'] as string, row };
}

it('profile27 (installation v11): verification holds, FORCE RLS, no PUBLIC and runtime SELECT/INSERT only', async () => {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    // The test-local dispatcher-only INSERT on the runtime role is itself refused (P27-p1-2);
    // without it (rolled back) the committed profile27 verifies.
    await client.query('SAVEPOINT local_grant');
    await expect(verifyCurrentRuntimeV11InstalledIn(client as PoolClient)).rejects.toThrow(
      'CURRENT_RUNTIME_V11_STRUCTURE_DRIFT',
    );
    await client.query('ROLLBACK TO SAVEPOINT local_grant');
    await client.query(
      `REVOKE INSERT ON public.ai_execution_job_disposition FROM "${runtimeRole}"`,
    );
    const verified = await verifyCurrentRuntimeV11InstalledIn(client as PoolClient);
    expect(verified).toMatchObject({ profileVersion: 11, runtimeStep: 27, sourceDdlTip: 148 });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const shape = await inspector.query(
    `SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner)=$1 AS owned,
      (SELECT array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) FROM aclexplode(c.relacl) a WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$2)) AS runtime,
      NOT EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee=0) AS no_public,
      (SELECT bool_and(NOT has_function_privilege($2,p.oid,'EXECUTE')) FROM pg_proc p WHERE p.proname IN ('guard_ai_execution_job_v1','check_ai_execution_job_commit_v1','ai_synthetic_evidence_manifest_v1','guard_ai_synthetic_evidence_attestation_v1','guard_ai_execution_job_disposition_v1','check_ai_execution_job_disposition_commit_v1')) AS no_function_execute,
      (SELECT bool_and(NOT p.prosecdef) FROM pg_proc p WHERE p.proname IN ('guard_ai_execution_job_v1','check_ai_execution_job_commit_v1','ai_synthetic_evidence_manifest_v1','guard_ai_synthetic_evidence_attestation_v1','guard_ai_execution_job_disposition_v1','check_ai_execution_job_disposition_commit_v1')) AS invoker
     FROM pg_class c WHERE c.oid='public.ai_execution_job'::regclass`,
    [ownerRole, runtimeRole],
  );
  expect(shape.rows).toEqual([
    {
      relrowsecurity: true,
      relforcerowsecurity: true,
      owned: true,
      runtime: ['INSERT', 'SELECT'],
      no_public: true,
      no_function_execute: true,
      invoker: true,
    },
  ]);
});

it('creates run, immutable job, versioned receipt and unclaimed outbox atomically without budget or dispatch', async () => {
  const s = await scenario();
  const job = await repository.create(s.athleteId, s.thread.id, s.command());
  expect(job).toMatchObject({
    schemaVersion: 1,
    commandVersion: 1,
    purpose: 'coaching',
    payloadClassification: 'health',
    selection: sol,
    settingsRevision: 1,
    catalogRevision,
    runStatus: { kind: 'queued' },
    dispatchAuthority: 'none',
  });
  expect(await facts(s.athleteId)).toEqual({
    jobs: 1,
    runs: 1,
    provider_runs: 1,
    receipts: 1,
    queued: 1,
    fixture_queued: 0,
    holds: 0,
  });
  const event = await inspector.query(
    `SELECT payload,attempts,lease_token,completed_at FROM outbox WHERE athlete_id=$1 AND topic='coaching.execution_job_queued'`,
    [s.athleteId],
  );
  expect(event.rows).toEqual([
    {
      payload: { schemaVersion: 1, jobId: job.jobId, runId: job.runId },
      attempts: 0,
      lease_token: null,
      completed_at: null,
    },
  ]);
  expect(await repository.read(s.athleteId, job.jobId)).toEqual(job);
  const stored = await database.tenant(s.athleteId, (tx) => readAiExecutionJobIn(tx, job.jobId));
  expect(stored?.frozen.selectionDigest).toBe(job.selectionDigest);
});

it('exact replay returns the original job without writes, even after consent withdrawal; conflicts are refused', async () => {
  const s = await scenario();
  const command = s.command();
  const job = await repository.create(s.athleteId, s.thread.id, command);
  const before = await facts(s.athleteId);
  expect(await repository.create(s.athleteId, s.thread.id, command)).toEqual(job);
  await expectCode(
    repository.create(s.athleteId, s.thread.id, { ...command, expectedConversationRevision: 2 }),
    'IDEMPOTENCY_CONFLICT',
  );
  await createConsentRepository(database).setConsent(s.athleteId, {
    kind: 'ai',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  // Withdrawal purges the evidence and cancels the run; the frozen job is unchanged.
  expect(await repository.create(s.athleteId, s.thread.id, command)).toEqual({
    ...job,
    runStatus: { kind: 'cancelled', reason: 'consent_withdrawn' },
  });
  expect(await facts(s.athleteId)).toEqual(before);
  await expectCode(
    repository.create(s.athleteId, s.thread.id, s.command()),
    'EVIDENCE_UNAVAILABLE',
  );
  expect(await facts(s.athleteId)).toEqual(before);
});

it('concurrent duplicate commands commit exactly one job', async () => {
  const s = await scenario();
  const command = s.command();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => repository.create(s.athleteId, s.thread.id, command)),
  );
  expect(new Set(results.map((job) => job.jobId)).size).toBe(1);
  expect(await facts(s.athleteId)).toMatchObject({ jobs: 1, runs: 1, receipts: 1, queued: 1 });
});

it('a newer settings head never substitutes the model of an explicit revision or an existing job', async () => {
  const s = await scenario();
  const job = await repository.create(s.athleteId, s.thread.id, s.command());
  await createAiSettingsRepository(database).write(s.athleteId, {
    schemaVersion: 1,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    catalogRevision,
    policyVersion: settings.policyVersion,
    disclosureVersion: settings.disclosureVersion,
    defaultSelection: null,
    syntheticComparison: { kind: 'off' },
  });
  expect(await repository.read(s.athleteId, job.jobId)).toEqual(job);
  const again = await repository.create(s.athleteId, s.thread.id, s.command());
  expect(again).toMatchObject({ settingsRevision: 1, selection: sol });
  await expectCode(
    repository.create(s.athleteId, s.thread.id, {
      ...s.command(),
      settings: { ...settings, revision: 2 },
    }),
    'SELECTION_REQUIRED',
  );
});

it('synthetic comparison is refused for health evidence under the conservative classifier', async () => {
  const s = await scenario('luna');
  const before = await facts(s.athleteId);
  await expectCode(
    repository.create(s.athleteId, s.thread.id, s.command('synthetic_comparison')),
    'SYNTHETIC_PAYLOAD_REQUIRED',
  );
  expect(await facts(s.athleteId)).toEqual(before);
});

it('U3: a Luna job proceeds only on an owner-attested synthetic-fixture snapshot', async () => {
  const s = await scenario('luna');
  await account(s.athleteId, 'https://synthetic.invalid');
  await expectCode(
    repository.create(s.athleteId, s.thread.id, s.command('synthetic_comparison')),
    'SYNTHETIC_PAYLOAD_REQUIRED',
  );
  await attest(s);
  const manifest = await inspector.query(
    'SELECT item_manifest FROM ai_synthetic_evidence_attestation WHERE athlete_id=$1',
    [s.athleteId],
  );
  expect(manifest.rows[0]?.['item_manifest']).toMatchObject({
    schemaVersion: 1,
    plan: expect.any(String),
    thread: s.thread.id,
    messages: [[expect.any(String), 1]],
  });
  const job = await repository.create(s.athleteId, s.thread.id, s.command('synthetic_comparison'));
  expect(job).toMatchObject({
    purpose: 'synthetic_comparison',
    payloadClassification: 'synthetic_only',
    selection: luna,
    dispatchAuthority: 'none',
  });
  // The same attested snapshot may also back a Sol job, still marked synthetic_only.
  expect(await repository.create(s.athleteId, s.thread.id, s.command())).toMatchObject({
    payloadClassification: 'synthetic_only',
    selection: sol,
  });
  // Withdrawal purges the body: the attestation no longer matches and Luna is refused.
  await createConsentRepository(database).setConsent(s.athleteId, {
    kind: 'ai',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(
    await database.tenant(s.athleteId, (tx) =>
      classifyAttestedSyntheticEvidenceIn(tx, { id: s.evidence.id }),
    ),
  ).toBe('health');
  await createOperationsRepository(database).eraseAccount(s.athleteId);
  expect(
    (
      await inspector.query(
        'SELECT count(*)::int AS n FROM ai_synthetic_evidence_attestation WHERE athlete_id=$1',
        [s.athleteId],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});

it('U3: real or missing subjects, forged digests, runtime writes and forged jobs cannot mark data synthetic', async () => {
  const real = await scenario('luna');
  await account(real.athleteId, 'https://accounts.example.com');
  await expect(attest(real)).rejects.toThrow('AI_SYNTHETIC_SUBJECT_NOT_FIXTURE');
  const missing = await scenario('luna');
  await expect(attest(missing)).rejects.toThrow('AI_SYNTHETIC_SUBJECT_NOT_FIXTURE');
  const fixture = await scenario('luna');
  await account(fixture.athleteId, 'https://synthetic.invalid');
  await expect(attest(fixture, { bodySha256: 'a'.repeat(64) })).rejects.toThrow(
    'AI_SYNTHETIC_ATTESTATION_MISMATCH',
  );
  await expect(
    database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `INSERT INTO ai_synthetic_evidence_attestation(athlete_id,evidence_snapshot_id,provenance,fixture_id,subject_issuer,body_sha256,item_manifest)
         VALUES($1,$2,'synthetic_fixture_v1','synthetic:x','https://synthetic.invalid',$3,'{}'::jsonb)`,
        [fixture.athleteId, fixture.evidence.id, 'a'.repeat(64)],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  for (const s of [real, missing])
    await expectCode(
      repository.create(s.athleteId, s.thread.id, s.command('synthetic_comparison')),
      'SYNTHETIC_PAYLOAD_REQUIRED',
    );
  // A caller forging the classification is stopped by the SQL guard.
  await expect(
    database.tenant(real.athleteId, (tx) =>
      manualJob(tx, real, { payload_classification: 'synthetic_only' }),
    ),
  ).rejects.toThrow('AI_EXECUTION_JOB_SYNTHETIC_UNATTESTED');
  await attest(fixture);
  const ownerClient = await owner.connect();
  try {
    await ownerClient.query('BEGIN');
    await ownerClient.query("SELECT set_config('app.athlete_id',$1,true)", [fixture.athleteId]);
    await expect(
      ownerClient.query("UPDATE ai_synthetic_evidence_attestation SET fixture_id='synthetic:y'"),
    ).rejects.toThrow('AI_SYNTHETIC_ATTESTATION_IMMUTABLE');
    await ownerClient.query('ROLLBACK');
  } finally {
    ownerClient.release();
  }
  for (const s of [real, missing]) expect(await facts(s.athleteId)).toMatchObject({ jobs: 0 });
});

it('jobs are immutable to owner and runtime; runtime cannot delete or truncate', async () => {
  const s = await scenario();
  const job = await repository.create(s.athleteId, s.thread.id, s.command());
  const ownerClient = await owner.connect();
  try {
    await ownerClient.query('BEGIN');
    await ownerClient.query("SELECT set_config('app.athlete_id',$1,true)", [s.athleteId]);
    await expect(
      ownerClient.query(
        "UPDATE ai_execution_job SET model_id='gpt-6-luna',price_model_ref='gpt-6-luna' WHERE job_id=$1",
        [job.jobId],
      ),
    ).rejects.toThrow('AI_EXECUTION_JOB_IMMUTABLE');
    await ownerClient.query('ROLLBACK');
    await ownerClient.query('BEGIN');
    await expect(ownerClient.query('TRUNCATE ai_execution_job CASCADE')).rejects.toThrow(
      'AI_EXECUTION_JOB_IMMUTABLE',
    );
    await ownerClient.query('ROLLBACK');
  } finally {
    ownerClient.release();
  }
  for (const statement of [
    "UPDATE ai_execution_job SET model_id='gpt-6-luna' WHERE job_id=$1",
    'DELETE FROM ai_execution_job WHERE job_id=$1',
  ])
    await expect(
      database.tenant(s.athleteId, (tx) => tx.query(statement, [job.jobId])),
    ).rejects.toMatchObject({ code: '42501' });
  expect(await repository.read(s.athleteId, job.jobId)).toEqual(job);
});

it('no automatic binding: committed fixture or earlier provider runs cannot receive a job', async () => {
  const s = await scenario();
  const fixtureRun = await createCoachingRunRepository(database, {
    policy,
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
  }).create(s.athleteId, s.thread.id, {
    schemaVersion: 1,
    evidenceSnapshotId: s.evidence.id,
    expectedConversationRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await expect(
    database.tenant(s.athleteId, (tx) => manualJob(tx, s, {}, fixtureRun.id)),
  ).rejects.toThrow('AI_EXECUTION_JOB_RUN_NOT_BINDABLE');
  const earlier = randomUUID();
  await database.tenant(s.athleteId, (tx) =>
    tx.query(
      `INSERT INTO coaching_run(athlete_id,id,thread_id,evidence_snapshot_id,conversation_revision,policy,source,basis)
       VALUES($1,$2,$3,$4,1,$5::jsonb,$6::jsonb,'{}'::jsonb)`,
      [
        s.athleteId,
        earlier,
        s.thread.id,
        s.evidence.id,
        JSON.stringify(policy),
        JSON.stringify({ kind: 'provider', ...sol }),
      ],
    ),
  );
  await expect(database.tenant(s.athleteId, (tx) => manualJob(tx, s, {}, earlier))).rejects.toThrow(
    'AI_EXECUTION_JOB_RUN_NOT_BINDABLE',
  );
  // A savepoint-inserted run is not the top-level transaction's own row: fail closed.
  await expect(
    database.tenant(s.athleteId, async (tx) => {
      await tx.query('SAVEPOINT nested');
      const run = randomUUID();
      await tx.query(
        `INSERT INTO coaching_run(athlete_id,id,thread_id,evidence_snapshot_id,conversation_revision,policy,source,basis)
         VALUES($1,$2,$3,$4,1,$5::jsonb,$6::jsonb,'{}'::jsonb)`,
        [
          s.athleteId,
          run,
          s.thread.id,
          s.evidence.id,
          JSON.stringify(policy),
          JSON.stringify({ kind: 'provider', ...sol }),
        ],
      );
      await tx.query('RELEASE SAVEPOINT nested');
      return manualJob(tx, s, {}, run);
    }),
  ).rejects.toThrow('AI_EXECUTION_JOB_RUN_NOT_BINDABLE');
  expect(await facts(s.athleteId)).toMatchObject({ jobs: 0 });
});

it('SQL refuses model substitution and forged selection, consent or source facts', async () => {
  const s = await scenario();
  const cases: [Record<string, unknown>, string][] = [
    [
      {
        model_id: luna.modelId,
        price_model_ref: luna.modelId,
        runSource: { kind: 'provider', ...luna },
      },
      'AI_EXECUTION_JOB_SELECTION_MISMATCH',
    ],
    [{ runSource: { kind: 'provider', ...luna } }, 'AI_EXECUTION_JOB_RUN_NOT_BINDABLE'],
    [{ selection_digest: 'c'.repeat(64) }, 'AI_EXECUTION_JOB_SELECTION_DIGEST_INVALID'],
    [{ price_version: 'synthetic:price:2' }, 'AI_EXECUTION_JOB_SELECTION_DIGEST_INVALID'],
    [{ app_consent_digest: 'd'.repeat(64) }, 'AI_EXECUTION_JOB_CONSENT_MISMATCH'],
    [{ ai_consent_revision: 9 }, 'AI_EXECUTION_JOB_CONSENT_MISMATCH'],
    [{ recipient_disclosure_version: 'other:1' }, 'AI_EXECUTION_JOB_CATALOG_STALE'],
    [{ athlete_id: randomUUID() }, 'AI_EXECUTION_JOB_TENANT_MISMATCH'],
  ];
  for (const [overrides, code] of cases)
    await expect(
      database.tenant(s.athleteId, (tx) => manualJob(tx, s, overrides)),
      code,
    ).rejects.toThrow(code);
  expect(await facts(s.athleteId)).toMatchObject({ jobs: 0, runs: 0 });
});

it('SQL binds catalog_digest to the immutable live catalog definition (forged digest + recomputed selection digest)', async () => {
  // P27-p1-1: with an exact receipt and unclaimed outbox event the forged job would commit
  // unless the guard derives the canonical catalog digest from the definition itself.
  const s = await scenario();
  const forged = (catalogDigest: string) =>
    database.tenant(s.athleteId, async (tx) => {
      const made = await manualJob(tx, s, { forgeCatalogDigest: catalogDigest });
      expect(made.row['catalog_digest']).toBe(catalogDigest);
      await tx.query(
        'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
        [
          s.athleteId,
          made.row['receipt_key'],
          JSON.stringify({ version: 1, sha256: 'b'.repeat(64) }),
          JSON.stringify({
            schemaVersion: 1,
            commandVersion: 1,
            jobId: made.jobId,
            runId: made.runId,
            selectionDigest: made.row['selection_digest'],
          }),
        ],
      );
      await tx.query(
        `INSERT INTO outbox(athlete_id,id,idempotency_key,topic,payload)
         VALUES($1,$2,$3,'coaching.execution_job_queued',$4::jsonb)`,
        [
          s.athleteId,
          randomUUID(),
          made.row['receipt_key'],
          JSON.stringify({ schemaVersion: 1, jobId: made.jobId, runId: made.runId }),
        ],
      );
      return made;
    });
  for (const digest of ['f'.repeat(64), '0'.repeat(64)])
    await expect(forged(digest)).rejects.toThrow('AI_EXECUTION_JOB_CATALOG_DIGEST_INVALID');
  expect(await facts(s.athleteId)).toMatchObject({ jobs: 0, runs: 0, receipts: 0, queued: 0 });
  // The genuine canonical digest (TS digestExecutionCatalog) is the one SQL derives.
  const job = await repository.create(s.athleteId, s.thread.id, s.command());
  expect(
    (
      await inspector.query(
        'SELECT catalog_digest FROM ai_execution_job WHERE athlete_id=$1 AND job_id=$2',
        [s.athleteId, job.jobId],
      )
    ).rows,
  ).toEqual([{ catalog_digest: digestExecutionCatalog(catalog) }]);
});
it('commit fails unless the exact receipt and unclaimed outbox event exist in the same transaction', async () => {
  const s = await scenario();
  await expect(database.tenant(s.athleteId, (tx) => manualJob(tx, s))).rejects.toThrow(
    'AI_EXECUTION_JOB_RECEIPT_INVALID',
  );
  const receiptOnly = (result: (ids: { jobId: string; runId: string }) => unknown) =>
    database.tenant(s.athleteId, async (tx) => {
      const made = await manualJob(tx, s);
      await tx.query(
        'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
        [
          s.athleteId,
          made.row['receipt_key'],
          JSON.stringify({ version: 1, sha256: 'b'.repeat(64) }),
          JSON.stringify(result(made)),
        ],
      );
      return made;
    });
  await expect(
    receiptOnly(({ jobId, runId }) => ({
      schemaVersion: 1,
      commandVersion: 1,
      jobId,
      runId,
      selectionDigest: 'e'.repeat(64),
    })),
  ).rejects.toThrow('AI_EXECUTION_JOB_RECEIPT_INVALID');
  await expect(receiptOnly((made) => ({ ...made, schemaVersion: 1 }))).rejects.toThrow(
    'AI_EXECUTION_JOB_RECEIPT_INVALID',
  );
  await expect(
    database.tenant(s.athleteId, async (tx) => {
      const made = await manualJob(tx, s);
      await tx.query(
        'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
        [
          s.athleteId,
          made.row['receipt_key'],
          JSON.stringify({ version: 1, sha256: 'b'.repeat(64) }),
          JSON.stringify({
            schemaVersion: 1,
            commandVersion: 1,
            jobId: made.jobId,
            runId: made.runId,
            selectionDigest: made.row['selection_digest'],
          }),
        ],
      );
      // A claimed or differently shaped event is not the durable queued event.
      await tx.query(
        `INSERT INTO outbox(athlete_id,id,idempotency_key,topic,payload)
         VALUES($1,$2,$3,'coaching.run_queued',$4::jsonb)`,
        [s.athleteId, randomUUID(), made.row['receipt_key'], JSON.stringify({ runId: made.runId })],
      );
    }),
  ).rejects.toThrow('AI_EXECUTION_JOB_OUTBOX_MISSING');
  expect(await facts(s.athleteId)).toMatchObject({ jobs: 0, runs: 0, receipts: 0, queued: 0 });
});

it('tenant RLS: another tenant cannot read, export or write the job', async () => {
  const a = await scenario(),
    b = await scenario();
  const job = await repository.create(a.athleteId, a.thread.id, a.command());
  expect(await repository.read(b.athleteId, job.jobId)).toBeNull();
  expect(
    (
      await database.tenant(b.athleteId, (tx) =>
        tx.query('SELECT count(*)::int AS n FROM ai_execution_job'),
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
  expect((await database.tenant(b.athleteId, (tx) => exportAiExecutionJobsIn(tx))).items).toEqual(
    [],
  );
  await expectCode(
    repository.create(b.athleteId, a.thread.id, {
      ...a.command(),
    }),
    'THREAD_NOT_FOUND',
  );
});

it('personal export lists frozen facts only, in deterministic order', async () => {
  const s = await scenario();
  const first = await repository.create(s.athleteId, s.thread.id, s.command());
  const second = await repository.create(s.athleteId, s.thread.id, s.command());
  const exported = await database.tenant(s.athleteId, (tx) => exportAiExecutionJobsIn(tx));
  expect(exported.items.map((item) => item.jobId)).toEqual([first.jobId, second.jobId]);
  expect(exported.items[0]).toMatchObject({
    selection: sol,
    consentRevisions: { app: 1, ai: 1 },
    selectionDigest: first.selectionDigest,
  });
  const text = JSON.stringify(exported);
  for (const forbidden of ['receipt', 'request_digest', 'restore_generation', 'Synthetic private'])
    expect(text).not.toContain(forbidden);
});

it('account erasure removes jobs through the unchanged erase chain', async () => {
  const s = await scenario();
  await repository.create(s.athleteId, s.thread.id, s.command());
  expect(await createOperationsRepository(database).eraseAccount(s.athleteId)).toEqual({
    erased: true,
  });
  expect(await facts(s.athleteId)).toMatchObject({ jobs: 0, runs: 0, receipts: 0, queued: 0 });
});

it('restore target or generation change refuses new jobs; replay stays readable; jobs keep their generation', async () => {
  const s = await scenario();
  const command = s.command();
  const job = await repository.create(s.athleteId, s.thread.id, command);
  const control = async (sql: string, args: unknown[] = []) => {
    const client = await owner.connect();
    try {
      return (await client.query(sql, args)).rows[0];
    } finally {
      client.release();
    }
  };
  const revision = async () =>
    Number(
      (await control('SELECT public.read_restore_processing_admission() AS c'))?.['c']?.[
        'localRevision'
      ],
    );
  await control('SELECT public.close_restore_processing_exact($1,$2,$3,$4)', [
    await revision(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ]);
  const before = await facts(s.athleteId);
  await expectCode(
    repository.create(s.athleteId, s.thread.id, s.command()),
    'RESTORE_PROCESSING_CLOSED',
  );
  // The SQL guard refuses even a caller that skips the TypeScript precheck.
  await expect(database.tenant(s.athleteId, (tx) => manualJob(tx, s))).rejects.toThrow(
    'RESTORE_PROCESSING_CLOSED',
  );
  expect(await repository.create(s.athleteId, s.thread.id, command)).toEqual(job);
  expect(await facts(s.athleteId)).toEqual(before);
  // Clearing the target in the same generation re-allows authoring.
  await control('SELECT public.close_restore_processing_exact($1,$2)', [
    await revision(),
    randomUUID(),
  ]);
  await repository.create(s.athleteId, s.thread.id, s.command());
  // A rotated generation (restore) closes authoring until the control is re-stamped,
  // and an existing job keeps its original generation for M2-05b to refuse.
  await control('SELECT public.rotate_restore_generation()');
  await expectCode(
    repository.create(s.athleteId, s.thread.id, s.command()),
    'RESTORE_PROCESSING_CLOSED',
  );
  const generations = await inspector.query(
    `SELECT bool_and(restore_generation_id<>public.current_restore_generation()) AS stale FROM ai_execution_job WHERE athlete_id=$1`,
    [s.athleteId],
  );
  expect(generations.rows).toEqual([{ stale: true }]);
  await control('SELECT public.close_restore_processing_exact($1,$2)', [
    await revision(),
    randomUUID(),
  ]);
  const current = await repository.create(s.athleteId, s.thread.id, s.command());
  // U5 restore_cancelled vocabulary and transition contract.
  const second = (
    await inspector.query(
      `SELECT job_id FROM ai_execution_job WHERE athlete_id=$1 AND job_id NOT IN ($2,$3)`,
      [s.athleteId, job.jobId, current.jobId],
    )
  ).rows[0]?.['job_id'] as string;
  await expect(
    database.tenant(s.athleteId, (tx) =>
      tx.query(
        `INSERT INTO ai_execution_job_disposition(athlete_id,job_id,disposition,source_generation_id,target_generation_id)
         SELECT athlete_id,job_id,'restore_cancelled',restore_generation_id,public.current_restore_generation()
         FROM ai_execution_job WHERE job_id=$1`,
        [second],
      ),
    ),
  ).rejects.toThrow('AI_EXECUTION_JOB_DISPOSITION_INCOMPLETE');
  await expect(
    database.tenant(s.athleteId, async (tx) => {
      await tx.query(
        `UPDATE outbox SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1
         WHERE athlete_id=$1 AND topic='coaching.execution_job_queued' AND payload->>'jobId'=$2`,
        [s.athleteId, second],
      );
      expect(await cancelRestoredAiExecutionJobIn(tx, second)).toEqual({ kind: 'busy' });
      throw new Error('synthetic rollback');
    }),
  ).rejects.toThrow('synthetic rollback');
  for (const id of [job.jobId, second]) {
    const result = await database.tenant(s.athleteId, (tx) =>
      cancelRestoredAiExecutionJobIn(tx, id),
    );
    expect(result).toMatchObject({
      kind: 'restore_cancelled',
      job: {
        jobId: id,
        runStatus: { kind: 'cancelled', reason: 'stale_basis' },
        disposition: { kind: 'restore_cancelled' },
      },
    });
    expect(
      await database.tenant(s.athleteId, (tx) => cancelRestoredAiExecutionJobIn(tx, id)),
    ).toEqual({ kind: 'not_applicable' });
  }
  // A job of the current generation is never restore-cancelled.
  expect(
    await database.tenant(s.athleteId, (tx) => cancelRestoredAiExecutionJobIn(tx, current.jobId)),
  ).toEqual({ kind: 'not_applicable' });
  expect((await repository.read(s.athleteId, current.jobId))?.disposition).toBeNull();
  const events = await inspector.query(
    `SELECT payload->>'jobId' AS job,completed_at IS NOT NULL AS done FROM outbox
     WHERE athlete_id=$1 AND topic='coaching.execution_job_queued' ORDER BY 1`,
    [s.athleteId],
  );
  expect(Object.fromEntries(events.rows.map((row) => [row['job'], row['done']]))).toEqual({
    [job.jobId]: true,
    [second]: true,
    [current.jobId]: false,
  });
  const exported = await database.tenant(s.athleteId, (tx) => exportAiExecutionJobsIn(tx));
  expect(exported.items.filter((item) => item.disposition !== null)).toHaveLength(2);
  const ownerClient = await owner.connect();
  try {
    await ownerClient.query('BEGIN');
    await ownerClient.query("SELECT set_config('app.athlete_id',$1,true)", [s.athleteId]);
    await expect(
      ownerClient.query('UPDATE ai_execution_job_disposition SET decided_at=clock_timestamp()'),
    ).rejects.toThrow('AI_EXECUTION_JOB_DISPOSITION_IMMUTABLE');
    await ownerClient.query('ROLLBACK');
  } finally {
    ownerClient.release();
  }
  // Account erasure cascades through jobs into dispositions.
  await createOperationsRepository(database).eraseAccount(s.athleteId);
  expect(
    (
      await inspector.query(
        'SELECT count(*)::int AS n FROM ai_execution_job_disposition WHERE athlete_id=$1',
        [s.athleteId],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});
