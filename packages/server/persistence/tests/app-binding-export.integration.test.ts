import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  grantCoachingCandidates,
  grantCoachingRuns,
  grantCoachingRunWorker,
  grantCoreEvidenceSnapshots,
  grantIntegratedApprovalV4,
  grantOperations,
  migrate,
} from '../src/migrate.js';
import { accountExportSchema } from '@workout/contracts/operations';
import { createDatabase } from '../src/database.js';
import { createOperationsRepository } from '../src/operations.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Provisioning uses only the disposable harness administrator. Every migration,
// fixture, gate, and replay runs as a plain owner or a restricted application role.
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `app_export_accept_${suffix}`;
const roles = {
  owner: `app_owner_${suffix}`,
  next: `app_next_${suffix}`,
  runtime: `app_rt_${suffix}`,
  worker: `app_worker_${suffix}`,
  exporter: `app_export_${suffix}`,
  outsider: `app_public_${suffix}`,
};
function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'plain';
  return url.toString();
}
const pools = Object.fromEntries(
  Object.entries(roles).map(([key, role]) => [
    key,
    new Pool({ connectionString: urlFor(role), max: 1 }),
  ]),
);
function pool(name: keyof typeof roles): Pool {
  const value = pools[name];
  if (!value) throw new Error('Missing isolated role pool');
  return value;
}
async function tenant<T>(
  name: keyof typeof roles,
  athlete: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool(name).connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const tables = [
  'evidence_app_admission_binding',
  'run_app_admission_binding',
  'candidate_app_admission_binding',
  'integrated_candidate_app_admission_binding',
  'approval_app_admission_binding',
] as const;
const replay = 'SELECT public.replay_app_consent_transition_exact($1,$2,$3,$4,$5,$6,$7) AS result';

beforeAll(async () => {
  for (const role of Object.values(roles))
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${roles.owner}"`);
  await migrate(urlFor(roles.owner), 104);
  const roleFlags = await admin.query(
    'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1)',
    [Object.values(roles)],
  );
  expect(roleFlags.rows).toHaveLength(6);
  for (const flags of roleFlags.rows)
    expect(flags).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  expect(
    (
      await pool('owner').query(
        'SELECT count(*)::int AS total,min(version),max(version) FROM schema_migrations',
      )
    ).rows,
  ).toEqual([{ total: 104, min: 1, max: 104 }]);
  // No manual runtime grants: use the production grant helpers exclusively.
  for (const grant of [
    grantOperations,
    grantCoreEvidenceSnapshots,
    grantCoachingRuns,
    grantCoachingCandidates,
    grantIntegratedApprovalV4,
  ])
    await grant(urlFor(roles.owner), roles.runtime);
  await grantCoachingRunWorker(urlFor(roles.owner), roles.worker);
  await grantOperations(urlFor(roles.owner), roles.exporter);
}, 30_000);

afterAll(async () => {
  await Promise.all(Object.values(pools).map((value) => value.end()));
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

async function seed() {
  const athlete = randomUUID();
  const ids = {
    evidence: randomUUID(),
    run: randomUUID(),
    candidate: randomUUID(),
    integrated_candidate: randomUUID(),
  };
  const plan = randomUUID(),
    thread = randomUUID(),
    decision = randomUUID(),
    proposal = randomUUID();
  await pool('owner').query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [athlete, 'https://synthetic.invalid', athlete],
  );
  // Minimal SQL lineage fixture tests SQL permissions/triggers, not DTO/provider acceptance.
  await tenant('owner', athlete, async (client) => {
    await client.query("INSERT INTO consent VALUES($1,'app',true,1)", [athlete]);
    await client.query(
      "INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,'{}')",
      [athlete, plan],
    );
    await client.query(
      `INSERT INTO coaching_thread(athlete_id,id,plan_version_id,title,scope,revision)
      VALUES($1,$2,$3,'Synthetic permission fixture','{"kind":"phase","targetId":"synthetic"}',1)`,
      [athlete, thread, plan],
    );
  });
  // Actual restricted runtime INSERT invokes the owner trigger; no binding rows are seeded.
  await tenant('runtime', athlete, async (client) => {
    await client.query(
      "INSERT INTO core_evidence_snapshot(athlete_id,id,thread_id,created_at,body) VALUES($1,$2,$3,clock_timestamp(),'{}')",
      [athlete, ids.evidence, thread],
    );
    await client.query(
      `INSERT INTO coaching_run(athlete_id,id,thread_id,evidence_snapshot_id,conversation_revision,policy,source,basis)
      VALUES($1,$2,$3,$4,1,'{}','{}','{}')`,
      [athlete, ids.run, thread, ids.evidence],
    );
    await client.query(
      "INSERT INTO coaching_decision(athlete_id,id,run_id,body) VALUES($1,$2,$3,'{}')",
      [athlete, decision, ids.run],
    );
    await client.query(
      "INSERT INTO coaching_proposal(athlete_id,id,decision_id,body) VALUES($1,$2,$3,'{}')",
      [athlete, proposal, decision],
    );
    await client.query(
      "INSERT INTO coaching_candidate(athlete_id,id,decision_id,proposal_id,digest,body) VALUES($1,$2,$3,$4,$5,'{}')",
      [athlete, ids.candidate, decision, proposal, 'a'.repeat(64)],
    );
    await client.query(
      `INSERT INTO integrated_candidate_v4(athlete_id,id,proposal_id,digest,body,created_at)
      VALUES($1,$2,$3,$4,$5,clock_timestamp())`,
      [
        athlete,
        ids.integrated_candidate,
        randomUUID(),
        'b'.repeat(64),
        { basis: { evidenceSnapshotId: ids.evidence } },
      ],
    );
  });
  return { athlete, ids, plan, thread };
}

const bindingCollections = [
  'evidenceAppBindings',
  'runAppBindings',
  'candidateAppBindings',
  'integratedCandidateAppBindings',
  'approvalAppBindings',
] as const;
async function exporter() {
  const database = createDatabase({ connectionString: urlFor(roles.exporter), max: 1 });
  return { database, operations: createOperationsRepository(database) };
}
async function seedApproval(fixture: Awaited<ReturnType<typeof seed>>) {
  const receiptKey = `coaching:candidate:approve:${createHash('sha256').update(randomUUID()).digest('hex')}`;
  const canonical = JSON.stringify({
    operation: 'training_candidate_approve',
    candidateId: fixture.ids.candidate,
    confirmed: true,
  });
  // Minimal receipt lineage exercises the real SQL recorder, not a complete plan approval.
  await tenant('owner', fixture.athlete, async (client) => {
    await client.query(
      'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3,$4)',
      [
        fixture.athlete,
        receiptKey,
        { requestHash: createHash('sha256').update(canonical).digest('hex') },
        { versionId: fixture.plan },
      ],
    );
    await client.query('SELECT public.record_approval_app_binding($1,$2,$3)', [
      receiptKey,
      fixture.ids.candidate,
      canonical,
    ]);
  });
  return receiptKey;
}
async function seedReplayReceipt(fixture: Awaited<ReturnType<typeof seed>>) {
  const event = (
    await pool('owner').query(
      `SELECT event_id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
    FROM restore_suppression_event WHERE athlete_id=$1 AND kind='app_consent_transition' AND consent_revision=1`,
      [fixture.athlete],
    )
  ).rows[0];
  if (!event) throw new Error('Missing synthetic production consent event');
  const args = [fixture.athlete, event['event_id'], event['occurred_at'], null, null, 1, true];
  expect(
    (await tenant('owner', fixture.athlete, (client) => client.query(replay, args))).rows,
  ).toEqual([{ result: 'already_applied' }]);
  return args;
}
async function exported(fixture: Awaited<ReturnType<typeof seed>>) {
  const { database, operations } = await exporter();
  try {
    const artifact = await operations.exportAccount(fixture.athlete);
    if (artifact.schemaVersion !== 33) throw new Error('Expected actual current v33 producer');
    return artifact;
  } finally {
    await database.close();
  }
}

describe('app binding account export v32 (M2-01k-v-c)', () => {
  it('strictly projects all five owned factual collections without executable receipts or foreign rows', async () => {
    const fixture = await seed(),
      other = await seed();
    const receiptKey = await seedApproval(fixture);
    await seedApproval(other);
    await seedReplayReceipt(fixture);
    const artifact = await exported(fixture);
    expect(accountExportSchema.parse(artifact)).toEqual(artifact);
    expect(artifact.data.evidenceAppBindings).toEqual([
      expect.objectContaining({
        evidence_snapshot_id: fixture.ids.evidence,
        binding_version: 1,
        app_revision: 1,
      }),
    ]);
    expect(artifact.data.runAppBindings).toEqual([
      { run_id: fixture.ids.run, evidence_snapshot_id: fixture.ids.evidence, binding_version: 1 },
    ]);
    expect(artifact.data.candidateAppBindings).toEqual([
      { candidate_id: fixture.ids.candidate, run_id: fixture.ids.run, binding_version: 1 },
    ]);
    expect(artifact.data.integratedCandidateAppBindings).toEqual([
      {
        candidate_id: fixture.ids.integrated_candidate,
        evidence_snapshot_id: fixture.ids.evidence,
        binding_version: 1,
      },
    ]);
    expect(artifact.data.approvalAppBindings).toEqual([
      expect.objectContaining({
        candidate_id: fixture.ids.candidate,
        integrated_candidate_id: null,
        integrated_approval_id: null,
        binding_version: 1,
      }),
    ]);
    const serialized = JSON.stringify(artifact);
    for (const forbidden of [
      receiptKey,
      'receipt_key',
      'restore_app_consent_replay_receipt',
      'training_candidate_approve',
      ...Object.values(other.ids),
    ])
      expect(serialized).not.toContain(forbidden);
    for (const name of bindingCollections) {
      expect(
        accountExportSchema.safeParse({
          ...artifact,
          data: {
            ...artifact.data,
            [name]: artifact.data[name].map((row) => ({ ...row, receipt_key: receiptKey })),
          },
        }).success,
      ).toBe(false);
    }
  });

  it('retains immutable app facts after false2/regrant3 without upgrading their epoch', async () => {
    const fixture = await seed();
    await seedApproval(fixture);
    const before = await exported(fixture);
    for (const [revision, granted] of [
      [2, false],
      [3, true],
    ] as const) {
      await tenant('owner', fixture.athlete, (client) =>
        client.query(
          "UPDATE consent SET revision=$2,granted=$3 WHERE athlete_id=$1 AND kind='app'",
          [fixture.athlete, revision, granted],
        ),
      );
      const current = await exported(fixture);
      for (const name of bindingCollections) expect(current.data[name]).toEqual(before.data[name]);
      expect(current.data.evidenceAppBindings[0]?.app_revision).toBe(1);
      await expect(
        tenant('runtime', fixture.athlete, (client) =>
          client.query('SELECT public.require_evidence_app_binding($1)', [fixture.ids.evidence]),
        ),
      ).rejects.toMatchObject({
        message: granted ? 'STALE_APP_ADMISSION' : 'APP_CONSENT_REQUIRED',
      });
    }
  });

  it.each(bindingCollections)(
    '%s keeps strict max1000 and never accepts portable facts as commands',
    async (name) => {
      const fixture = await seed();
      await seedApproval(fixture);
      const artifact = await exported(fixture);
      const first = artifact.data[name][0];
      if (!first) throw new Error('Missing actual factual projection fixture');
      expect(
        accountExportSchema.safeParse({
          ...artifact,
          data: { ...artifact.data, [name]: Array.from({ length: 1001 }, () => first) },
        }).success,
      ).toBe(false);
    },
  );

  it('actual SQL max1000 fails closed for approval facts before any export audit write', async () => {
    const fixture = await seed();
    await tenant('owner', fixture.athlete, async (client) => {
      // Owner-only SQL receipt fixture isolates this new array ceiling; no other export collection exceeds1000.
      await client.query(
        `INSERT INTO command_receipt(athlete_id,idempotency_key,request,result)
        SELECT $1,'synthetic-cap-'||n,'{}','{}' FROM generate_series(1,1001) n`,
        [fixture.athlete],
      );
      await client.query(
        `INSERT INTO approval_app_admission_binding(athlete_id,receipt_key,candidate_id)
        SELECT athlete_id,idempotency_key,$2 FROM command_receipt WHERE athlete_id=$1`,
        [fixture.athlete, fixture.ids.candidate],
      );
    });
    const { database, operations } = await exporter();
    try {
      await expect(operations.exportAccount(fixture.athlete)).rejects.toMatchObject({
        code: 'EXPORT_TOO_LARGE',
      });
      expect(
        (
          await tenant('owner', fixture.athlete, (client) =>
            client.query(
              'SELECT count(*)::int AS total FROM operations_audit WHERE athlete_id=$1',
              [fixture.athlete],
            ),
          )
        ).rows,
      ).toEqual([{ total: 0 }]);
    } finally {
      await database.close();
    }
  });

  it('erases all five owned bindings while exact restore receipts survive without resurrection', async () => {
    const fixture = await seed(),
      other = await seed();
    await seedApproval(fixture);
    await seedApproval(other);
    const args = await seedReplayReceipt(fixture);
    const { database, operations } = await exporter();
    try {
      expect(await operations.eraseAccount(fixture.athlete)).toEqual({ erased: true });
      for (const table of tables)
        expect(
          (
            await tenant('owner', fixture.athlete, (client) =>
              client.query(`SELECT * FROM ${table}`),
            )
          ).rowCount,
        ).toBe(0);
      expect(
        (
          await pool('owner').query(
            'SELECT * FROM restore_app_consent_replay_receipt WHERE athlete_id=$1',
            [fixture.athlete],
          )
        ).rowCount,
      ).toBe(1);
      // Normal deletion is not authenticated external exact-erasure replay proof.
      await expect(
        tenant('owner', fixture.athlete, (client) => client.query(replay, args)),
      ).rejects.toMatchObject({ message: 'RESTORE_APP_TENANT_ERASED' });
      for (const table of [
        'consent',
        'core_evidence_snapshot',
        'coaching_run',
        'coaching_candidate',
        ...tables,
      ])
        expect(
          (
            await tenant('owner', fixture.athlete, (client) =>
              client.query(`SELECT * FROM ${table}`),
            )
          ).rowCount,
        ).toBe(0);
      await expect(operations.exportAccount(fixture.athlete)).rejects.toThrow('ACCOUNT_ERASED');
      const otherArtifact = await exported(other);
      for (const name of bindingCollections) expect(otherArtifact.data[name]).toHaveLength(1);
    } finally {
      await database.close();
    }
  });
});
