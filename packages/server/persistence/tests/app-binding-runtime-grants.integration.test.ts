import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  migrationFileNames,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Provisioning uses only the disposable harness administrator. Every migration,
// fixture, gate, and replay runs as a plain owner or a restricted application role.
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `app_grants_${suffix}`;
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
const subjects = [
  ['evidence', 'evidence_app_admission_binding', 'evidence_snapshot_id'],
  ['run', 'run_app_admission_binding', 'run_id'],
  ['candidate', 'candidate_app_admission_binding', 'candidate_id'],
  ['integrated_candidate', 'integrated_candidate_app_admission_binding', 'candidate_id'],
] as const;
const replay = 'SELECT public.replay_app_consent_transition_exact($1,$2,$3,$4,$5,$6,$7) AS result';

beforeAll(async () => {
  for (const role of Object.values(roles))
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${roles.owner}"`);
  await migrate(urlFor(roles.owner));
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
  return { athlete, ids };
}

describe('registered app binding runtime grants (M2-01k-v-c)', () => {
  it('installs exact ordered 1..105 checksums under a plain owner and is idempotent', async () => {
    expect(migrationFileNames).toHaveLength(105);
    expect(migrationFileNames[99]).toBe('100_app_admission_binding.sql');
    const rows = await pool('owner').query<{ version: number; checksum: string }>(
      'SELECT version,checksum FROM schema_migrations ORDER BY version',
    );
    const expected = await Promise.all(
      migrationFileNames.map(async (file, index) => ({
        version: index + 1,
        checksum: createHash('sha256')
          .update(await readFile(new URL(`../migrations/${file}`, import.meta.url)))
          .digest('hex'),
      })),
    );
    expect(rows.rows).toEqual(expected);
    await migrate(urlFor(roles.owner));
    const flags = await admin.query(
      'SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1) ORDER BY rolname',
      [Object.values(roles)],
    );
    expect(flags.rows).toHaveLength(6);
    for (const row of flags.rows)
      expect(row).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
  });

  it.each(subjects)(
    '%s original INSERT binds exact app epoch and rejects cross-tenant processing',
    async (kind, table, idColumn) => {
      const fixture = await seed();
      await tenant('runtime', fixture.athlete, async (client) => {
        expect(
          (
            await client.query(`SELECT public.require_${kind}_app_binding($1) AS revision`, [
              fixture.ids[kind],
            ])
          ).rows,
        ).toEqual([{ revision: 1 }]);
        expect(
          (await client.query(`SELECT * FROM ${table} WHERE ${idColumn}=$1`, [fixture.ids[kind]]))
            .rowCount,
        ).toBe(1);
      });
      const other = await seed();
      await tenant('runtime', other.athlete, async (client) => {
        expect(
          (await client.query(`SELECT * FROM ${table} WHERE ${idColumn}=$1`, [fixture.ids[kind]]))
            .rowCount,
        ).toBe(0);
      });
      await expect(
        tenant('runtime', other.athlete, (client) =>
          client.query(`SELECT public.require_${kind}_app_binding($1)`, [fixture.ids[kind]]),
        ),
      ).rejects.toMatchObject({ message: 'APP_BINDING_UNAVAILABLE' });
    },
  );

  it('worker checks evidence/run while export retains tenant history without processing authority', async () => {
    const fixture = await seed();
    for (const kind of ['evidence', 'run'] as const)
      expect(
        (
          await tenant('worker', fixture.athlete, (client) =>
            client.query(`SELECT public.require_${kind}_app_binding($1) AS revision`, [
              fixture.ids[kind],
            ]),
          )
        ).rows,
      ).toEqual([{ revision: 1 }]);
    for (const table of tables) {
      await tenant('exporter', fixture.athlete, async (client) => {
        expect((await client.query(`SELECT * FROM ${table}`)).rowCount).toBe(
          table === 'approval_app_admission_binding' ? 0 : 1,
        );
      });
    }
    for (const name of ['require_evidence_app_binding', 'require_run_app_binding'])
      await expect(
        tenant('exporter', fixture.athlete, (client) =>
          client.query(`SELECT public.${name}($1)`, [fixture.ids.evidence]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    await expect(
      tenant('worker', fixture.athlete, (client) =>
        client.query('SELECT public.record_approval_app_binding($1,$2,$3)', [
          'synthetic',
          fixture.ids.candidate,
          'a'.repeat(64),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it.each(['runtime', 'worker', 'exporter'] as const)(
    '%s cannot directly mutate any immutable binding or access owner restore receipts',
    async (role) => {
      const fixture = await seed();
      for (const table of tables) {
        for (const sql of [
          `INSERT INTO ${table} DEFAULT VALUES`,
          `UPDATE ${table} SET binding_version=1`,
          `DELETE FROM ${table}`,
        ])
          await expect(
            tenant(role, fixture.athlete, (client) => client.query(sql)),
          ).rejects.toMatchObject({ code: '42501' });
      }
      for (const sql of [
        'SELECT * FROM restore_app_consent_replay_receipt',
        'INSERT INTO restore_app_consent_replay_receipt DEFAULT VALUES',
        replay,
      ])
        await expect(
          tenant(role, fixture.athlete, (client) =>
            client.query(
              sql,
              sql === replay
                ? [fixture.athlete, randomUUID(), '2026-01-01T00:00:00Z', null, null, 1, true]
                : [],
            ),
          ),
        ).rejects.toMatchObject({ code: '42501' });
    },
  );

  it('PUBLIC has no callable app gates, recorder, replay or trigger entry points', async () => {
    const functions = await pool('owner').query<{
      oid: string;
      proname: string;
    }>(`SELECT p.oid::text,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND (p.proname LIKE '%app%binding%' OR p.proname IN ('require_app_admission_revision','replay_app_consent_transition_exact','verify_restore_app_consent_replay_receipt','verify_app_consent_event_fields','record_app_consent_transition_suppression_event'))`);
    expect(functions.rows.length).toBeGreaterThanOrEqual(12);
    for (const fn of functions.rows) {
      expect(
        (
          await pool('outsider').query(
            "SELECT has_function_privilege(current_user,$1::oid,'EXECUTE') AS allowed",
            [fn.oid],
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
    }
    await expect(
      tenant('outsider', randomUUID(), (client) =>
        client.query('SELECT public.require_app_admission_revision(NULL)'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('even the plain owner cannot revise captured immutable bindings', async () => {
    const fixture = await seed();
    for (const [, table] of subjects)
      await expect(
        tenant('owner', fixture.athlete, (client) =>
          client.query(`UPDATE ${table} SET binding_version=1`),
        ),
      ).rejects.toMatchObject({ message: 'IMMUTABLE_APP_ADMISSION_BINDING' });
  });

  it('withdrawal and regrant never reopen the previous bound epoch while export reads survive', async () => {
    const fixture = await seed();
    for (const [revision, granted, code] of [
      [2, false, 'APP_CONSENT_REQUIRED'],
      [3, true, 'STALE_APP_ADMISSION'],
    ] as const) {
      await tenant('owner', fixture.athlete, (client) =>
        client.query(
          "UPDATE consent SET revision=$2,granted=$3 WHERE athlete_id=$1 AND kind='app'",
          [fixture.athlete, revision, granted],
        ),
      );
      for (const [kind] of subjects)
        await expect(
          tenant('runtime', fixture.athlete, (client) =>
            client.query(`SELECT public.require_${kind}_app_binding($1)`, [fixture.ids[kind]]),
          ),
        ).rejects.toMatchObject({ message: code });
      expect(
        (
          await tenant('exporter', fixture.athlete, (client) =>
            client.query('SELECT app_revision FROM evidence_app_admission_binding'),
          )
        ).rows,
      ).toEqual([{ app_revision: 1 }]);
    }
  });

  it('REASSIGN OWNED follows live owner for exact replay and receipt policy without inferred authorization', async () => {
    const fixture = await seed();
    const event = (
      await pool('owner').query(
        `SELECT event_id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
      FROM restore_suppression_event WHERE athlete_id=$1 AND kind='app_consent_transition'`,
        [fixture.athlete],
      )
    ).rows[0];
    if (!event) throw new Error('Missing original production app transition');
    const args = [fixture.athlete, event['event_id'], event['occurred_at'], null, null, 1, true];
    expect(
      (await tenant('owner', fixture.athlete, (client) => client.query(replay, args))).rows,
    ).toEqual([{ result: 'already_applied' }]);
    const inspectionUrl = new URL(adminUrl as string);
    inspectionUrl.pathname = `/${databaseName}`;
    const inspection = new Pool({ connectionString: inspectionUrl.toString() });
    try {
      await inspection.query(`REASSIGN OWNED BY "${roles.owner}" TO "${roles.next}"`);
      await pool('next').query('SELECT public.retarget_definer_policies()');
      expect(
        (await tenant('next', fixture.athlete, (client) => client.query(replay, args))).rows,
      ).toEqual([{ result: 'already_applied' }]);
      await expect(
        tenant('owner', fixture.athlete, (client) => client.query(replay, args)),
      ).rejects.toMatchObject({ code: '42501' });
      expect(
        (
          await pool('next').query(
            'SELECT count(*)::int AS total FROM restore_app_consent_replay_receipt',
          )
        ).rows,
      ).toEqual([{ total: 1 }]);
      const policy = await pool('next').query<{ qual: string; with_check: string }>(
        "SELECT qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='restore_app_consent_replay_receipt'",
      );
      expect(policy.rows).toHaveLength(1);
      for (const expression of [policy.rows[0]?.qual, policy.rows[0]?.with_check]) {
        expect(expression).toContain('SESSION_USER');
        expect(expression).toContain('relowner');
        expect(expression).not.toContain(roles.owner);
      }
      // The former owner has lost direct read authority after the ownership transfer.
      await expect(
        pool('owner').query('SELECT * FROM restore_app_consent_replay_receipt'),
      ).rejects.toMatchObject({ code: '42501' });
      expect(
        (
          await tenant('runtime', fixture.athlete, (client) =>
            client.query('SELECT public.require_evidence_app_binding($1) AS revision', [
              fixture.ids.evidence,
            ]),
          )
        ).rows,
      ).toEqual([{ revision: 1 }]);
    } finally {
      await inspection.query(`REASSIGN OWNED BY "${roles.next}" TO "${roles.owner}"`);
      await pool('owner').query('SELECT public.retarget_definer_policies()');
      await inspection.end();
    }
  });
});
