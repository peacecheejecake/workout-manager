import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { accountExportSchema } from '@workout/contracts/operations';
import { createDatabase, type Database } from '../src/database.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';
import { createActivityRepository } from '../src/activities.js';
import { createIdentityRepository } from '../src/identity.js';
import {
  migrate,
  grantIdentityFunctions,
  grantOperations,
  grantCoachingCandidates,
} from '../src/migrate.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let operations: OperationsRepository;
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
beforeAll(async () => {
  await migrate(adminUrl);
  await grantIdentityFunctions(adminUrl, 'workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCoachingCandidates(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT ON tenant_erasure TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT ON operations_audit TO workout_runtime');
  await admin.query('GRANT EXECUTE ON FUNCTION public.erase_account(text) TO workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON consent,outbox,command_receipt,plan_snapshot,plan_head,plan_history,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 6 });
  operations = createOperationsRepository(database);
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
async function seed(athlete: string) {
  const imported = await createActivityRepository(database).importActivity(athlete, {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: hash() },
    activity: {
      title: 'Private fixture',
      kind: 'running',
      startedAt: null,
      timezone: null,
      durationSeconds: null,
      durationKind: 'unknown',
      distanceMeters: 0,
    },
  });
  await database.tenant(athlete, async (tx) => {
    const id = randomUUID();
    await tx.query(
      'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,$3::jsonb)',
      [athlete, id, JSON.stringify({ fixture: 'private-plan' })],
    );
    await tx.query('INSERT INTO plan_head(athlete_id,version_id) VALUES($1,$2)', [athlete, id]);
    await tx.query(
      "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'manual_saved')",
      [athlete, id],
    );
    await tx.query("INSERT INTO consent VALUES($1,'ai',true,1)", [athlete]);
  });
  return imported;
}
const sessionInput = () => ({
  tokenHash: hash(),
  csrfToken: hash(),
  issuer: 'https://identity.example',
  subject: randomUUID(),
  now: new Date(),
  expiresAt: new Date(Date.now() + 60000),
});
async function waitForBlockedLogin() {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const result = await admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%auth_create_session%' AND pid<>pg_backend_pid()",
    );
    if (result.rowCount) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Expected login to wait on erasure lock');
}
async function waitForBlockedStatement(fragment: string) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const result = await admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND position($1 in query)>0 AND pid<>pg_backend_pid()",
      [fragment],
    );
    if (result.rowCount) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected advisory lock wait for ${fragment}`);
}

it('exports coaching records only while evidence and AI consent remain available', async () => {
  const athlete = randomUUID();
  const other = randomUUID();
  await seed(athlete);
  await seed(other);
  const planId = (await operations.exportAccount(athlete)).data.planSnapshots[0]?.['id'];
  expect(typeof planId).toBe('string');
  const threadId = randomUUID();
  const snapshotId = randomUUID();
  const runId = randomUUID();
  const outputId = randomUUID();
  const decisionId = randomUUID();
  const proposalId = randomUUID();
  const candidateId = randomUUID();
  const privateText = 'Synthetic untrusted output body';
  const connection = await admin.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await connection.query(
      `INSERT INTO coaching_thread(athlete_id,id,plan_version_id,title,scope,revision)
       VALUES($1,$2,$3,'Synthetic run','{"kind":"session","targetId":"session"}'::jsonb,1)`,
      [athlete, threadId, planId],
    );
    await connection.query(
      `INSERT INTO core_evidence_snapshot(athlete_id,id,thread_id,created_at,body)
       VALUES($1,$2,$3,clock_timestamp(),'{}'::jsonb)`,
      [athlete, snapshotId, threadId],
    );
    await connection.query(
      `INSERT INTO coaching_run(athlete_id,id,thread_id,evidence_snapshot_id,conversation_revision,policy,source,basis)
       VALUES($1,$2,$3,$4,1,'{"id":"running-core-v2-training","version":"1"}'::jsonb,
        '{"kind":"deterministic_fixture","fixtureId":"export-test"}'::jsonb,
        '{"schemaVersion":1,"marker":"synthetic-basis"}'::jsonb)`,
      [athlete, runId, threadId, snapshotId],
    );
    await connection.query(
      'INSERT INTO coaching_analysis_output(athlete_id,id,run_id,body) VALUES($1,$2,$3,$4::jsonb)',
      [athlete, outputId, runId, JSON.stringify({ text: privateText })],
    );
    await connection.query(
      'INSERT INTO coaching_decision(athlete_id,id,run_id,body) VALUES($1,$2,$3,$4::jsonb)',
      [athlete, decisionId, runId, JSON.stringify({ analysis: privateText })],
    );
    await connection.query(
      'INSERT INTO coaching_proposal(athlete_id,id,decision_id,body) VALUES($1,$2,$3,$4::jsonb)',
      [athlete, proposalId, decisionId, JSON.stringify({ strategy: privateText })],
    );
    await connection.query(
      `INSERT INTO coaching_candidate
       (athlete_id,id,decision_id,proposal_id,parent_candidate_id,digest,body)
       VALUES($1,$2,$3,$4,NULL,$5,$6::jsonb)`,
      [
        athlete,
        candidateId,
        decisionId,
        proposalId,
        'a'.repeat(64),
        JSON.stringify({ draft: privateText }),
      ],
    );
    // The self-FKs alone would allow this two-row cycle in a single statement.
    await connection.query('SAVEPOINT candidate_parent_cycle');
    const firstCycleId = randomUUID();
    const secondCycleId = randomUUID();
    await expect(
      connection.query(
        `INSERT INTO coaching_candidate
         (athlete_id,id,decision_id,proposal_id,parent_candidate_id,digest,body)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb),($1,$5,$3,$4,$2,$8,$7::jsonb)`,
        [
          athlete,
          firstCycleId,
          decisionId,
          proposalId,
          secondCycleId,
          'b'.repeat(64),
          JSON.stringify({ draft: 'Synthetic cycle' }),
          'c'.repeat(64),
        ],
      ),
    ).rejects.toThrow('COACHING_CANDIDATE_PARENT_CYCLE');
    await connection.query('ROLLBACK TO SAVEPOINT candidate_parent_cycle');
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  const before = await operations.exportAccount(athlete);
  if (before.schemaVersion !== 9) throw new Error('Expected coaching export v9');
  expect(before.data.coachingRuns).toEqual([
    expect.objectContaining({ id: runId, basis: { schemaVersion: 1, marker: 'synthetic-basis' } }),
  ]);
  expect(before.data.coachingAnalysisOutputs).toEqual([
    expect.objectContaining({ id: outputId, run_id: runId, body: { text: privateText } }),
  ]);
  expect(before.data.coachingDecisions).toEqual([
    expect.objectContaining({ id: decisionId, run_id: runId, body: { analysis: privateText } }),
  ]);
  expect(before.data.coachingProposals).toEqual([
    expect.objectContaining({
      id: proposalId,
      decision_id: decisionId,
      body: { strategy: privateText },
    }),
  ]);
  expect(before.data.coachingCandidates).toEqual([
    expect.objectContaining({
      id: candidateId,
      digest: 'a'.repeat(64),
      body: { draft: privateText },
    }),
  ]);
  const otherExport = await operations.exportAccount(other);
  if (otherExport.schemaVersion !== 9) throw new Error('Expected coaching export v9');
  expect(otherExport.data.coachingAnalysisOutputs).toEqual([]);
  expect(otherExport.data.coachingCandidates).toEqual([]);
  const blocker = await admin.connect();
  let withdrawal: Promise<unknown> | undefined;
  let exportAfterWithdrawal: Promise<unknown> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    withdrawal = database.tenant(athlete, (tx) =>
      tx.query(
        "UPDATE consent SET granted=false,revision=revision+1 WHERE athlete_id=$1 AND kind='ai'",
        [athlete],
      ),
    );
    await waitForBlockedStatement('UPDATE consent SET granted=false');
    exportAfterWithdrawal = operations.exportAccount(athlete);
    await waitForBlockedStatement('SELECT pg_advisory_xact_lock(hashtextextended($1,0))');
  } finally {
    await blocker.query('COMMIT');
    blocker.release();
  }
  await withdrawal;
  const withdrawn = await exportAfterWithdrawal;
  if (!withdrawn) throw new Error('Expected concurrent export');
  const withdrawnArtifact = accountExportSchema.parse(withdrawn);
  if (withdrawnArtifact.schemaVersion !== 9) throw new Error('Expected coaching export v9');
  expect(withdrawnArtifact.data.coachingAnalysisOutputs).toEqual([
    expect.objectContaining({ id: outputId, body: null, purged_reason: 'consent_withdrawn' }),
  ]);
  for (const [collection, id] of [
    [withdrawnArtifact.data.coachingDecisions, decisionId],
    [withdrawnArtifact.data.coachingProposals, proposalId],
    [withdrawnArtifact.data.coachingCandidates, candidateId],
  ] as const) {
    expect(collection).toEqual([
      expect.objectContaining({ id, body: null, purged_reason: 'consent_withdrawn' }),
    ]);
  }
  expect(withdrawnArtifact.data.coachingCandidates[0]?.['digest']).toBeNull();
  expect(JSON.stringify(withdrawnArtifact)).not.toContain(privateText);
  // Simulate a legacy or malformed restored row to verify the export projection fails closed.
  const legacy = await admin.connect();
  try {
    await legacy.query('BEGIN');
    await legacy.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await legacy.query("SET LOCAL session_replication_role='replica'");
    await legacy.query(
      'UPDATE coaching_analysis_output SET body=$3::jsonb,purged_reason=NULL WHERE athlete_id=$1 AND id=$2',
      [athlete, outputId, JSON.stringify({ text: privateText })],
    );
    await legacy.query(
      'UPDATE coaching_decision SET body=$3::jsonb,purged_reason=NULL WHERE athlete_id=$1 AND id=$2',
      [athlete, decisionId, JSON.stringify({ analysis: privateText })],
    );
    await legacy.query(
      'UPDATE coaching_proposal SET body=$3::jsonb,purged_reason=NULL WHERE athlete_id=$1 AND id=$2',
      [athlete, proposalId, JSON.stringify({ strategy: privateText })],
    );
    await legacy.query(
      'UPDATE coaching_candidate SET body=$3::jsonb,digest=$4,purged_reason=NULL WHERE athlete_id=$1 AND id=$2',
      [athlete, candidateId, JSON.stringify({ draft: privateText }), 'a'.repeat(64)],
    );
    await legacy.query('COMMIT');
  } catch (error) {
    await legacy.query('ROLLBACK');
    throw error;
  } finally {
    legacy.release();
  }
  const guarded = await operations.exportAccount(athlete);
  if (guarded.schemaVersion !== 9) throw new Error('Expected coaching export v9');
  expect(guarded.data.coachingAnalysisOutputs).toEqual([
    expect.objectContaining({
      id: outputId,
      body: null,
      purged_reason: 'consent_or_evidence_unavailable',
    }),
  ]);
  for (const collection of [
    guarded.data.coachingDecisions,
    guarded.data.coachingProposals,
    guarded.data.coachingCandidates,
  ]) {
    expect(collection[0]).toMatchObject({
      body: null,
      purged_reason: 'consent_or_evidence_unavailable',
    });
  }
  expect(guarded.data.coachingCandidates[0]?.['digest']).toBeNull();
  expect(JSON.stringify(guarded)).not.toContain(privateText);
  await operations.eraseAccount(athlete);
  const auditor = await admin.connect();
  try {
    await auditor.query('BEGIN');
    await auditor.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    for (const table of [
      'coaching_candidate',
      'coaching_proposal',
      'coaching_decision',
      'coaching_run',
      'coaching_analysis_output',
    ]) {
      expect(
        (
          await auditor.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
            athlete,
          ])
        ).rows[0].count,
      ).toBe(0);
    }
    await auditor.query('ROLLBACK');
  } finally {
    auditor.release();
  }
});

describe('M1-06a scoped export, operational status and durable erasure', () => {
  it('exports a complete allowlisted tenant snapshot without credentials, receipts or outbox internals', async () => {
    const first = randomUUID(),
      second = randomUUID();
    await seed(first);
    await seed(second);
    await database.tenant(first, (tx) =>
      tx.query('INSERT INTO command_receipt VALUES($1,$2,$3::jsonb,$3::jsonb)', [
        first,
        randomUUID(),
        JSON.stringify({ token: 'MUST_NOT_EXPORT' }),
      ]),
    );
    const artifact = await operations.exportAccount(first);
    expect(artifact.data.activities).toHaveLength(1);
    expect(artifact.data.planSnapshots).toHaveLength(1);
    expect(artifact.data.sourceRevisions).toHaveLength(1);
    expect(artifact.athleteId).toBe(first);
    expect(JSON.stringify(artifact)).not.toContain(second);
    expect(JSON.stringify(artifact)).not.toContain('MUST_NOT_EXPORT');
    expect(Object.keys(artifact.data)).not.toContain('outbox');
    const status = await operations.status(first);
    expect(status.outbox.pending).toBe(1);
    expect(status.audit[0]?.action).toBe('export_requested');
    expect((await operations.status(second)).audit).toEqual([]);
  });
  it('exports manual reports and immutable correction history in v2, distinguishing local hiding from account erasure', async () => {
    const athlete = randomUUID();
    const activities = createActivityRepository(database);
    const created = await activities.createManualActivity(athlete, {
      confirmed: true,
      idempotencyKey: randomUUID(),
      activity: {
        title: 'Synthetic manual report',
        kind: 'running',
        startedAt: '2026-09-16T08:00:00+09:00',
        timezone: 'Asia/Seoul',
        durationSeconds: 0,
        durationKind: 'timer',
        distanceMeters: null,
      },
      report: { sessionRpe: 0, note: 'Synthetic original report', planLink: null },
    });
    const before = await operations.exportAccount(athlete);
    expect(before.schemaVersion).toBe(9);
    expect(before.data.activitySources).toEqual([
      expect.objectContaining({ kind: 'manual', activity_id: created.activityId }),
    ]);
    expect(before.data.overlays[0]).toMatchObject({
      values_json: {
        userReport: {
          sessionRpe: 0,
          note: 'Synthetic original report',
          source: 'user',
          method: 'self_report',
        },
      },
    });
    const originalHistory = before.data.overlayRevisions;
    expect(originalHistory).toHaveLength(1);
    await activities.updateOverlay(athlete, created.activityId, {
      expectedRevision: created.revision,
      idempotencyKey: randomUUID(),
      reason: 'Withdraw report',
      report: { sessionRpe: null, note: null, planLink: null },
    });
    const corrected = await operations.exportAccount(athlete);
    expect(corrected.data.overlays[0]).toMatchObject({
      values_json: { userReport: { sessionRpe: null, rpeReportedAt: null, note: null } },
    });
    expect(corrected.data.overlayRevisions).toHaveLength(2);
    expect(corrected.data.overlayRevisions[0]).toEqual(originalHistory[0]);
    await activities.deleteActivity(athlete, created.activityId, {
      expectedRevision: created.revision + 1,
    });
    expect(await activities.getActivity(athlete, created.activityId)).toBeNull();
    expect((await activities.listActivities(athlete)).total).toBe(0);
    const hidden = await operations.exportAccount(athlete);
    expect(hidden.data.activities[0]).toMatchObject({ deleted: true });
    expect(hidden.data.suppressions).toEqual([expect.objectContaining({ kind: 'manual' })]);
    expect(hidden.data.overlayRevisions).toEqual(corrected.data.overlayRevisions);
    await operations.eraseAccount(athlete);
    for (const table of [
      'activity_canonical',
      'activity_source_head',
      'activity_source_revision',
      'activity_overlay',
      'activity_overlay_revision',
      'activity_suppression',
      'command_receipt',
      'outbox',
    ]) {
      expect(
        (
          await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
            athlete,
          ])
        ).rows[0].count,
      ).toBe(0);
    }
    await expect(operations.exportAccount(athlete)).rejects.toThrow('ACCOUNT_ERASED');
  });
  it('rejects more than1000 rows or oversized exports rather than returning a truncated success', async () => {
    const athlete = randomUUID();
    await database.tenant(athlete, (tx) =>
      tx.query(
        "INSERT INTO activity_canonical(athlete_id,id,revision,original) SELECT $1,gen_random_uuid(),1,'{}'::jsonb FROM generate_series(1,1001)",
        [athlete],
      ),
    );
    await expect(operations.exportAccount(athlete)).rejects.toMatchObject({
      code: 'EXPORT_TOO_LARGE',
    });
    expect((await operations.status(athlete)).audit).toEqual([]);
    const big = randomUUID();
    await database.tenant(big, (tx) =>
      tx.query(
        "INSERT INTO plan_snapshot(athlete_id,id,version,draft) SELECT $1,gen_random_uuid(),n,jsonb_build_object('body',repeat('x',950000)) FROM generate_series(1,9) n",
        [big],
      ),
    );
    await expect(operations.exportAccount(big)).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
  });
  it('erases all health/history/source/auth records and blocks stale writes while keeping only bounded audit facts', async () => {
    const identities = createIdentityRepository({ connectionString: runtimeUrl });
    try {
      const input = sessionInput();
      const identity = await identities.createSession(input);
      await seed(identity.athleteId);
      const other = randomUUID();
      await seed(other);
      expect(await operations.eraseAccount(identity.athleteId)).toEqual({ erased: true });
      expect(await operations.eraseAccount(identity.athleteId)).toEqual({ erased: true });
      expect(await identities.findSession(input.tokenHash, new Date())).toBeNull();
      const account = await admin.query(
        'SELECT * FROM identity_private.account WHERE athlete_id=$1',
        [identity.athleteId],
      );
      expect(account.rows).toEqual([]);
      for (const table of [
        'activity_canonical',
        'activity_source_head',
        'activity_source_revision',
        'activity_overlay',
        'activity_overlay_revision',
        'activity_suppression',
        'activity_import_receipt',
        'plan_head',
        'plan_snapshot',
        'plan_history',
        'consent',
        'command_receipt',
        'outbox',
      ]) {
        const result = await admin.query(
          `SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`,
          [identity.athleteId],
        );
        expect(result.rows[0].count).toBe(0);
      }
      const facts = await admin.query('SELECT action FROM operations_audit WHERE athlete_id=$1', [
        identity.athleteId,
      ]);
      expect(facts.rows).toEqual([{ action: 'account_erased' }]);
      await expect(
        database.tenant(identity.athleteId, (tx) =>
          tx.query("INSERT INTO consent VALUES($1,'ai',true,1)", [identity.athleteId]),
        ),
      ).rejects.toThrow('ACCOUNT_ERASED');
      expect((await operations.exportAccount(other)).data.activities).toHaveLength(1);
      const newIdentity = await identities.createSession({ ...input, tokenHash: hash() });
      expect(newIdentity.athleteId).not.toBe(identity.athleteId);
    } finally {
      await identities.close();
    }
  });
  it('rejects cross-tenant erasure and direct runtime deletion of immutable plan history', async () => {
    const first = randomUUID(),
      second = randomUUID();
    await seed(first);
    await expect(
      database.exclusiveTenant(second, (tx) =>
        tx.query('SELECT public.erase_account($1)', [first]),
      ),
    ).rejects.toThrow('ERASURE_TENANT_MISMATCH');
    await expect(
      database.tenant(first, (tx) =>
        tx.query('DELETE FROM plan_history WHERE athlete_id=$1', [first]),
      ),
    ).rejects.toThrow('IMMUTABLE_PLAN_RECORD');
    expect((await operations.exportAccount(first)).data.planHistory).toHaveLength(1);
  });
  it('rolls back erasure of health, identity, audit and tombstone together', async () => {
    const identities = createIdentityRepository({ connectionString: runtimeUrl });
    try {
      const input = sessionInput();
      const identity = await identities.createSession(input);
      await seed(identity.athleteId);
      await expect(
        database.exclusiveTenant(identity.athleteId, async (tx) => {
          await tx.query('SELECT public.erase_account($1)', [identity.athleteId]);
          throw new Error('simulate commit failure');
        }),
      ).rejects.toThrow('simulate commit failure');
      expect((await operations.exportAccount(identity.athleteId)).data.activities).toHaveLength(1);
      expect(await identities.findSession(input.tokenHash, new Date())).not.toBeNull();
      const erased = await admin.query('SELECT * FROM tenant_erasure WHERE athlete_id=$1', [
        identity.athleteId,
      ]);
      expect(erased.rows).toEqual([]);
    } finally {
      await identities.close();
    }
  });
  it('a login waiting behind deletion creates a fresh identity and cannot restore the retired athlete', async () => {
    const identities = createIdentityRepository({ connectionString: runtimeUrl });
    try {
      const input = sessionInput();
      const original = await identities.createSession(input);
      await seed(original.athleteId);
      let pending: ReturnType<typeof identities.createSession> | undefined;
      await database.exclusiveTenant(original.athleteId, async (tx) => {
        pending = identities.createSession({ ...input, tokenHash: hash() });
        await waitForBlockedLogin();
        await tx.query('SELECT public.erase_account($1)', [original.athleteId]);
      });
      const loggedIn = await pending;
      expect(loggedIn?.athleteId).not.toBe(original.athleteId);
      if (!loggedIn) throw new Error('Missing concurrent login');
      expect((await operations.exportAccount(loggedIn.athleteId)).data.activities).toEqual([]);
    } finally {
      await identities.close();
    }
  });
  it('deletion waits for an active tenant writer and removes its committed result before retiring the account', async () => {
    const athlete = randomUUID();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = database.tenant(athlete, async (tx) => {
      started();
      await resume;
      await tx.query("INSERT INTO consent VALUES($1,'ai',true,1)", [athlete]);
    });
    await ready;
    const erase = operations.eraseAccount(athlete);
    release();
    await Promise.all([write, erase]);
    expect(
      (await admin.query('SELECT * FROM consent WHERE athlete_id=$1', [athlete])).rows,
    ).toEqual([]);
    await expect(operations.exportAccount(athlete)).rejects.toThrow('ACCOUNT_ERASED');
  });
});

it('honors FORCE RLS tombstones when the authentication definer is not a superuser', async () => {
  const identities = createIdentityRepository({ connectionString: runtimeUrl });
  const role = `auth_owner_${randomUUID().replaceAll('-', '')}`;
  const signature = 'public.auth_create_session(text,text,text,text,timestamptz,timestamptz,text)';
  const result = await admin.query(
    'SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure',
    [signature],
  );
  const owner = String(result.rows[0].owner).replaceAll('"', '""');
  try {
    const input = sessionInput();
    const identity = await identities.createSession(input);
    await admin.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [identity.athleteId]);
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public,identity_private TO ${role}`);
    await admin.query(
      `GRANT SELECT,INSERT,DELETE ON identity_private.account,identity_private.session TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON tenant_erasure TO ${role}`);
    await admin.query(`ALTER FUNCTION ${signature} OWNER TO ${role}`);
    await expect(identities.createSession({ ...input, tokenHash: hash() })).rejects.toThrow(
      'IDENTITY_RETRY_REQUIRED',
    );
    const fresh = sessionInput();
    expect((await identities.createSession(fresh)).athleteId).not.toBe(identity.athleteId);
  } finally {
    await admin.query(`ALTER FUNCTION ${signature} OWNER TO "${owner}"`);
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE ${role}`);
    await identities.close();
  }
});

it('reports lease and retry backlog facts without claiming first-attempt processing failed', async () => {
  const athlete = randomUUID();
  await seed(athlete);
  await database.tenant(athlete, (tx) =>
    tx.query(
      "UPDATE outbox SET attempts=1,lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE athlete_id=$1",
      [athlete, randomUUID()],
    ),
  );
  expect((await operations.status(athlete)).outbox).toEqual({
    pending: 0,
    leased: 1,
    retrying: 0,
    completed: 0,
  });
  await database.tenant(athlete, (tx) =>
    tx.query('UPDATE outbox SET lease_token=NULL,lease_until=NULL WHERE athlete_id=$1', [athlete]),
  );
  expect((await operations.status(athlete)).outbox).toEqual({
    pending: 1,
    leased: 0,
    retrying: 1,
    completed: 0,
  });
  await database.tenant(athlete, (tx) =>
    tx.query(
      "INSERT INTO operations_audit(athlete_id,id,action) SELECT $1,gen_random_uuid(),'export_requested' FROM generate_series(1,12)",
      [athlete],
    ),
  );
  expect((await operations.status(athlete)).audit).toHaveLength(10);
});

describe('activity source detail data lifecycle', () => {
  it('exports source detail observations and erases all revisions without exposing another tenant', async () => {
    const athlete = randomUUID(),
      other = randomUUID();
    const activity = createActivityRepository(database);
    const details = {
      schemaVersion: 1 as const,
      streamIndex: 0,
      sessionIndex: 0,
      startedAt: null,
      recordedAt: null,
      elapsedSeconds: null,
      records: [{ index: 0, timestamp: null, distanceMeters: 0, heartRateBpm: null }],
      laps: [],
    };
    await activity.importActivity(athlete, {
      idempotencyKey: randomUUID(),
      source: { kind: 'fixture', sourceId: randomUUID(), revision: 2, contentHash: hash() },
      activity: {
        title: 'Detail lifecycle',
        kind: 'running',
        startedAt: null,
        durationSeconds: null,
        durationKind: 'unknown',
        timezone: null,
        distanceMeters: 0,
      },
      details,
    });
    const exported = await operations.exportAccount(athlete);
    expect(exported.data.sourceRevisions[0]?.['details_json']).toEqual(details);
    expect((await operations.exportAccount(other)).data.sourceRevisions).toEqual([]);
    await operations.eraseAccount(athlete);
    expect(
      (await admin.query('SELECT * FROM activity_source_revision WHERE athlete_id=$1', [athlete]))
        .rowCount,
    ).toBe(0);
    await expect(operations.exportAccount(athlete)).rejects.toThrow('ACCOUNT_ERASED');
  });
});

it('counts source detail bytes toward the export ceiling before writing an export audit', async () => {
  const athlete = randomUUID();
  await database.tenant(athlete, async (tx) => {
    await tx.query(
      "INSERT INTO activity_canonical(athlete_id,id,revision,original) SELECT $1,gen_random_uuid(),1,'{}'::jsonb FROM generate_series(1,3)",
      [athlete],
    );
    await tx.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) SELECT athlete_id,'fixture',id::text,1,repeat('a',64),id FROM activity_canonical WHERE athlete_id=$1",
      [athlete],
    );
    // Deliberately synthetic DB payload: tests the export byte guard independently of DTO validation.
    // Every row stays below the details_json SQL limit, while the combined export exceeds 8 MiB.
    await tx.query(
      "INSERT INTO activity_source_revision(athlete_id,kind,source_id,source_revision,content_hash,normalized_raw,details_json) SELECT athlete_id,kind,source_id,1,content_hash,'{}'::jsonb,jsonb_build_object('bounded_fixture',repeat('x',3*1024*1024)) FROM activity_source_head WHERE athlete_id=$1",
      [athlete],
    );
  });
  await expect(operations.exportAccount(athlete)).rejects.toMatchObject({
    code: 'EXPORT_TOO_LARGE',
  });
  expect((await operations.status(athlete)).audit).toEqual([]);
});
