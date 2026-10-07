import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  grantCorePlanning,
  grantCheckIns,
  grantOperations,
  grantCoachingConstraints,
  grantCoachingThreads,
  grantCoreEvidenceSnapshots,
  grantCoachingRuns,
  grantAiSettings,
} from '../src/migrate.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createConsentRepository } from '../src/repositories.js';
import { createAiSettingsRepository } from '../src/ai-settings.js';
import { createCoachingRunRepository } from '../src/coaching-runs.js';
import {
  prepareCoachingExecutionIn,
  type CoachingExecutionPreparationResult,
} from '../src/coaching-execution-preparation.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Use the normal plain-owner isolated PostgreSQL harness');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `execution_prep_${suffix}`;
const ownerRole = `exec_prep_owner_${suffix}`;
const runtimeRole = `exec_prep_runtime_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
function url(role: string) {
  const value = new URL(adminUrl ?? '');
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
const ownerUrl = url(ownerRole);
const runtimeUrl = url(runtimeRole);
const inspectorUrl = new URL(adminUrl);
inspectorUrl.pathname = `/${dbName}`;
let owner: Pool, inspector: Pool, database: Database;
const policy = { id: 'running-core-v2-training', version: '1' };
const selection = { providerId: 'openai', modelId: 'gpt-6.1-sol' };
const catalogRevision = 1;
const settingsMetadata = {
  revision: 1,
  catalogRevision,
  policyVersion: 'w-a-policy:1',
  disclosureVersion: 'w-a-disclosure:1',
};
const ports = {
  policy,
  registry: [
    {
      selection,
      purpose: 'coaching',
      adapterBindingVersion: 'synthetic:1',
      vendorModelRef: 'synthetic:sol',
      priceModelRef: selection.modelId,
      priceVersion: 'synthetic:price:1',
      tokenizerVersion: 'synthetic:tokenizer:1',
    },
  ],
  classifyEvidenceIn: async () => 'health',
};
// Explicit test-only catalog/registry availability; not real provider/key/price evidence.
const catalog = {
  schemaVersion: 1,
  catalogRevision,
  policyVersion: settingsMetadata.policyVersion,
  disclosureVersion: settingsMetadata.disclosureVersion,
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
        disclosureVersion: settingsMetadata.disclosureVersion,
      },
      models: [
        {
          modelId: selection.modelId,
          displayName: 'Synthetic Sol',
          selectable: true,
          availability: { kind: 'available' },
          purposes: ['coaching'],
        },
      ],
    },
  ],
  recommendedDefault: null,
  recommendedSyntheticComparison: { kind: 'off' },
};
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(ownerUrl, 105);
  owner = new Pool({ connectionString: ownerUrl });
  inspector = new Pool({ connectionString: inspectorUrl.toString() });
  for (const grant of [
    grantCorePlanning,
    grantCheckIns,
    grantOperations,
    grantCoachingConstraints,
    grantCoachingThreads,
    grantCoreEvidenceSnapshots,
    grantCoachingRuns,
    grantAiSettings,
  ])
    await grant(ownerUrl, runtimeRole);
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
  const client = await owner.connect();
  try {
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
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await inspector?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
async function consentingScenario() {
  const athleteId = randomUUID();
  // Named positive preparation scenario opts into app before its own protected seed.
  await createConsentRepository(database).setConsent(athleteId, {
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

  await createAiSettingsRepository(database).write(athleteId, {
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    catalogRevision,
    policyVersion: settingsMetadata.policyVersion,
    disclosureVersion: settingsMetadata.disclosureVersion,
    defaultSelection: selection,
    syntheticComparison: { kind: 'off' },
  });
  return {
    athleteId,
    thread,
    evidence,
    plan,
    intent: {
      threadId: thread.id,
      evidenceSnapshotId: evidence.id,
      expectedConversationRevision: 1,
      settings: settingsMetadata,
      purpose: 'coaching',
    },
  };
}
const prepare = (
  scenario: Awaited<ReturnType<typeof consentingScenario>>,
  intent: unknown = scenario.intent,
) => database.tenant(scenario.athleteId, (tx) => prepareCoachingExecutionIn(tx, intent, ports));
// Diagnostics disclose only the finite state/code, never identifiers or bodies.
function preparationDiagnostic(result: CoachingExecutionPreparationResult): string {
  return result.kind === 'blocked' ? `kind=blocked code=${result.code}` : 'kind=prepared';
}
async function artifacts(subject: string) {
  return (
    await inspector.query(
      `SELECT (SELECT count(*)::int FROM coaching_run WHERE athlete_id=$1) AS runs,(SELECT count(*)::int FROM command_receipt WHERE athlete_id=$1) AS receipts,(SELECT count(*)::int FROM outbox WHERE athlete_id=$1) AS outbox,(SELECT count(*)::int FROM openai_budget_reservation WHERE athlete_id=$1) AS holds`,
      [subject],
    )
  ).rows;
}
it('normal105 plain owner and local frozen preparation create no jobs/receipts/outbox/holds', async () => {
  expect(
    (await owner.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
      .rows,
  ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  const scenario = await consentingScenario();
  const before = await artifacts(scenario.athleteId);
  const result = await prepare(scenario);
  expect(result.kind, preparationDiagnostic(result)).toBe('prepared');
  expect(result).toMatchObject({
    kind: 'prepared',
    storage: 'not_persisted',
    admissionAllowed: false,
    sourceCompleteness: false,
    evidenceSnapshotId: scenario.evidence.id,
  });
  expect(await artifacts(scenario.athleteId)).toEqual(before);
  if (result.kind === 'prepared') expect(result.frozen.draft.permissions.app.revision).toBe(1);
});
it('successful existing create still parses schemaVersion and exact receipt replay precedes withdrawal gate', async () => {
  const scenario = await consentingScenario();
  const repository = createCoachingRunRepository(database, {
    policy,
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
  });
  const command = {
    schemaVersion: 1 as const,
    evidenceSnapshotId: scenario.evidence.id,
    expectedConversationRevision: 1,
    idempotencyKey: randomUUID(),
  };
  const run = await repository.create(scenario.athleteId, scenario.thread.id, command);
  await createConsentRepository(database).setConsent(scenario.athleteId, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const before = await artifacts(scenario.athleteId);
  expect((await repository.create(scenario.athleteId, scenario.thread.id, command)).id).toBe(
    run.id,
  );
  expect(await artifacts(scenario.athleteId)).toEqual(before);
  expect(await prepare(scenario)).toMatchObject({
    kind: 'blocked',
    code: 'APP_CONSENT_REQUIRED',
    admissionAllowed: false,
  });
});
it('foreign evidence and forged browser facts are blocked without copying content', async () => {
  const own = await consentingScenario(),
    foreign = await consentingScenario();
  const before = await artifacts(own.athleteId);
  expect(
    await prepare(own, { ...own.intent, evidenceSnapshotId: foreign.evidence.id }),
  ).toMatchObject({ kind: 'blocked', code: 'EVIDENCE_UNAVAILABLE' });
  expect(
    await prepare(own, {
      ...own.intent,
      permissions: { app: true },
      selectionDigest: 'a'.repeat(64),
    }),
  ).toMatchObject({ kind: 'blocked', code: 'INVALID_INTENT' });
  expect(await artifacts(own.athleteId)).toEqual(before);
});
it('withdraw/regrant does not upgrade the old evidence app epoch', async () => {
  const scenario = await consentingScenario();
  const consent = createConsentRepository(database);
  await consent.setConsent(scenario.athleteId, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await consent.setConsent(scenario.athleteId, {
    kind: 'app',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  expect(await prepare(scenario)).toMatchObject({ kind: 'blocked', code: 'STALE_APP_ADMISSION' });
});
it('historical settings selection is not replaced by newer preferences', async () => {
  const scenario = await consentingScenario();
  await createAiSettingsRepository(database).write(scenario.athleteId, {
    schemaVersion: 1,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    catalogRevision,
    policyVersion: settingsMetadata.policyVersion,
    disclosureVersion: settingsMetadata.disclosureVersion,
    defaultSelection: null,
    syntheticComparison: { kind: 'off' },
  });
  const result = await prepare(scenario);
  expect(result.kind, preparationDiagnostic(result)).toBe('prepared');
  if (result.kind === 'prepared') expect(result.frozen.draft.settingsRevision).toBe(1);
});
it('rollback discards caller writes and never grants admission', async () => {
  const scenario = await consentingScenario();
  const before = await artifacts(scenario.athleteId);
  await expect(
    database.tenant(scenario.athleteId, async (tx) => {
      expect((await prepareCoachingExecutionIn(tx, scenario.intent, ports)).admissionAllowed).toBe(
        false,
      );
      throw new Error('synthetic rollback');
    }),
  ).rejects.toThrow('synthetic rollback');
  expect(await artifacts(scenario.athleteId)).toEqual(before);
});
