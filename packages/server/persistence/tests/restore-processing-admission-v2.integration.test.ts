import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { installCurrentRuntimeV10 } from '../src/current-runtime-installation-v10.js';
import { grantCurrentRuntimeV10Profile } from '../src/current-runtime-grants-v10.js';
import { installCurrentRuntimeV11In } from '../src/current-runtime-installation-v11.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import {
  createRestoreProcessingOwnerPort,
  readRestoreProcessingAdmission,
  requireRestoreProcessingAdmission,
  runRestoreProcessingAdmissionTransaction,
} from '../src/restore-processing-admission.js';
import {
  loadFullRestoreRelationClassificationV2,
  readFullRestoreExpectedStructureV2Bytes,
  restoreAdmissionCensusSha256,
  FULL_RESTORE_EXPECTED_STRUCTURE_V2_SHA256,
  RESTORE_ADMISSION_ROSTER_SHA256,
} from '../src/full-restore-relation-classification-v2.js';
import { evaluateFullRestorePostconditionsV2 } from '../src/full-restore-admission-postconditions-v2.js';
import {
  captureFullRestoreStructureV1,
  createFullRestoreStructureComparatorV1,
} from '../src/full-restore-expected-structure-v1.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import {
  admissionObservation,
  BUDGET_RESERVATION,
  signAdmissionArtifact,
  type RowFacts,
} from './restore-admission-v2-fixtures.js';

// Real PostgreSQL (pinned 17.6 by the caller). Synthetic metadata/receipt rows only: no health,
// personal, provider token or account data. 147 is installed as a member of profile27 by the
// installation v11 (143, 144, 145, 147, 148 over a committed profile26), because the generated
// roster names every profile27 table. Cold catalog v11 is another lane and is NOT exercised
// here. Nothing here turns a not_executed item into a pass.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const evidenceDir = process.env['WM_P27_R_EVIDENCE_DIR'];
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const owner = `adm147_owner_${suffix}`,
  runtime = `adm147_app_${suffix}`;
const base26 = `adm147_base26_${suffix}`,
  base27 = `adm147_base27_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const databases: string[] = [];
const classification = loadFullRestoreRelationClassificationV2();
const census = classification.census;
const q = (v: { schema: string; relation: string }) => `${v.schema}.${v.relation}`;
const ident = (v: { schema: string; relation: string }) => `"${v.schema}"."${v.relation}"`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const H = (c: string) => c.repeat(64);
const evidence: Record<string, unknown> = {};
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('FIXTURE_VALUE_MISSING');
  return value;
}
function record(name: string, value: unknown) {
  evidence[name] = value;
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}

function url(database: string, role = owner) {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
const pools: Pool[] = [];
async function connect(database: string, role = owner): Promise<PoolClient> {
  const pool = new Pool({ connectionString: url(database, role), max: 1 });
  pools.push(pool);
  return pool.connect();
}
async function session<T>(database: string, run: (c: PoolClient) => Promise<T>, role = owner) {
  const pool = new Pool({ connectionString: url(database, role), max: 1 });
  const c = await pool.connect();
  try {
    return await run(c);
  } finally {
    c.release(true);
    await pool.end();
  }
}
async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return 'NO_ERROR';
}
async function sqlState(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? '', message: err.message ?? '' };
  }
  return { code: '', message: 'NO_ERROR' };
}
async function scenario(label: string, template = base27) {
  const database = `adm147_${label}_${suffix}`;
  await admin.query(`CREATE DATABASE "${database}" OWNER "${owner}" TEMPLATE "${template}"`);
  databases.push(database);
  return database;
}
async function apply147(c: PoolClient) {
  // Profile27 over the committed profile26 (installation v11, same transaction).
  await installCurrentRuntimeV11In(c);
}
const ownerPort = (c: PoolClient) => createRestoreProcessingOwnerPort(c);
async function control(c: PoolClient) {
  return (await c.query('SELECT public.read_restore_processing_admission() AS v')).rows[0]?.[
    'v'
  ] as {
    state: string;
    localRevision: string;
    generationId: string;
    targetNonce: string | null;
    targetIncarnation: string | null;
    admissionAllowed: boolean;
    targetAttested: boolean;
  };
}
type Target = { revision: string; nonce: string; incarnation: string };
async function bind(database: string): Promise<Target> {
  return session(database, async (c) => {
    const current = await control(c);
    const nonce = randomUUID(),
      incarnation = randomUUID();
    const closed = await ownerPort(c).close({
      expectedRevision: current.localRevision,
      commandId: randomUUID(),
      targetNonce: nonce,
      targetIncarnation: incarnation,
    });
    return { revision: closed.localRevision, nonce, incarnation };
  });
}
async function flagDrift(c: PoolClient): Promise<number> {
  return Number(
    (
      await c.query(`SELECT count(*)::int AS n FROM public.restore_processing_admission_roster() ro
      JOIN pg_class c ON c.oid=to_regclass(format('%I.%I',ro.schema_name,ro.relation_name))
      WHERE c.relrowsecurity<>ro.force_rls OR c.relforcerowsecurity<>ro.force_rls`)
    ).rows[0]?.['n'],
  );
}
async function openWindow(c: PoolClient, t: Target) {
  await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  return (
    await c.query('SELECT public.open_restore_processing_admission_window($1,$2,$3) AS w', [
      t.revision,
      t.nonce,
      t.incarnation,
    ])
  ).rows[0]?.['w'] as { xid: string; censusRelations: number; rosterSha256: string };
}
async function liveFacts(c: PoolClient): Promise<Map<string, RowFacts>> {
  const facts = new Map<string, RowFacts>();
  for (const r of census) {
    const row =
      (
        await c.query(
          `SELECT (SELECT count(*) FROM ${ident(r)})::int AS n,
          encode(sha256(convert_to(coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM ${ident(r)} t)::text,'[]'),'UTF8')),'hex') AS h`,
        )
      ).rows[0] ?? {};
    facts.set(q(r), { rowCount: Number(row['n']), rowsSha256: String(row['h']) });
  }
  return facts;
}
const censusOf = (facts: Map<string, RowFacts>, override: Record<string, number> = {}) =>
  census.map((r) => ({
    schema: r.schema,
    relation: r.relation,
    rowCount: override[q(r)] ?? facts.get(q(r))?.rowCount ?? 0,
  }));
async function admitSql(
  c: PoolClient,
  t: Target,
  entries: { schema: string; relation: string; rowCount: number }[],
  extra: Partial<{ commandId: string; xid: string; censusSha256: string; artifact: string }> = {},
) {
  const xid =
    extra.xid ?? String((await c.query('SELECT txid_current()::text AS x')).rows[0]?.['x']);
  return (
    await c.query(
      'SELECT public.admit_restore_processing_exact($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) AS r',
      [
        t.revision,
        extra.commandId ?? randomUUID(),
        t.nonce,
        t.incarnation,
        extra.artifact ?? H('a'),
        H('b'),
        H('c'),
        JSON.stringify(entries),
        extra.censusSha256 ?? restoreAdmissionCensusSha256(entries),
        xid,
      ],
    )
  ).rows[0]?.['r'] as Record<string, unknown>;
}
async function inSavepoint<T>(c: PoolClient, run: () => Promise<T>) {
  await c.query('SAVEPOINT probe');
  try {
    return await run();
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT probe');
  }
}
/** Full TS path: helper transaction, observation inside the window, evaluator v2, owner admit. */
async function admitViaTs(database: string, t: Target, commandId = randomUUID()) {
  return session(database, async (c) => {
    let observed: Map<string, RowFacts> | undefined;
    const result = await runRestoreProcessingAdmissionTransaction(c, {
      window: {
        expectedRevision: t.revision,
        targetNonce: t.nonce,
        targetIncarnation: t.incarnation,
      },
      lockTimeoutMs: 10000,
      async observe({ window, query }) {
        const facts = await liveFacts(c);
        observed = facts;
        const seq =
          (
            await query(
              'SELECT last_value::text AS v,is_called AS c,(SELECT max(sequence_id)::text FROM public.openai_budget_journal) AS m FROM public.openai_budget_journal_sequence_id_seq',
            )
          ).rows[0] ?? {};
        const pid = Number((await query('SELECT pg_backend_pid() AS p')).rows[0]?.['p']);
        const artifact = signAdmissionArtifact({
          classification,
          facts,
          target: {
            targetNonce: t.nonce,
            targetIncarnation: t.incarnation,
            closedRevision: t.revision,
          },
          sequence: { lastValue: String(seq['v']), isCalled: Boolean(seq['c']) },
        });
        const observation = admissionObservation({
          classification,
          artifact,
          transaction: { xid: window.xid, backendPid: pid },
          window: { xid: window.xid, rosterSha256: window.rosterSha256 },
          control: {
            state: 'CLOSED',
            localRevision: t.revision,
            targetNonce: t.nonce,
            targetIncarnation: t.incarnation,
          },
          postTail: facts,
          sequence: {
            lastValue: String(seq['v']),
            isCalled: Boolean(seq['c']),
            ownerColumnMax: (seq['m'] as string | null) ?? null,
          },
        });
        const evaluated = evaluateFullRestorePostconditionsV2(
          artifact,
          classification,
          observation,
          {
            commandId,
            budgetReservationRelation: BUDGET_RESERVATION,
          },
        );
        if (!evaluated.ready) throw new Error(`NOT_READY ${evaluated.failures.join(',')}`);
        return { ...evaluated.command, census: [...evaluated.command.census] };
      },
    });
    return { result, observed: must(observed), commandId };
  });
}
async function seedTenants(database: string, tenants: string[]) {
  await session(database, async (c) => {
    for (const tenant of tenants) {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
      await c.query("INSERT INTO public.consent VALUES($1,'app',true,1)", [tenant]);
      for (let i = 0; i < 2; i++)
        await c.query('INSERT INTO public.command_receipt VALUES($1,$2,$3,$4)', [
          tenant,
          `synthetic-${i}`,
          { hash: H('a') },
          { id: randomUUID(), revision: 1 },
        ]);
      await c.query('COMMIT');
    }
  });
}

beforeAll(async () => {
  for (const role of [owner, runtime])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${base26}" OWNER "${owner}"`);
  databases.push(base26);
  await migrate(url(base26), 107);
  await installCurrentRuntimeV10(url(base26));
  await grantCurrentRuntimeAppBaselineV2(url(base26), runtime, 'core');
  await grantCurrentRuntimeV10Profile(url(base26), runtime);
  await admin.query(`CREATE DATABASE "${base27}" OWNER "${owner}" TEMPLATE "${base26}"`);
  databases.push(base27);
  await session(base27, async (c) => {
    await c.query('BEGIN');
    await apply147(c);
    await c.query('COMMIT');
  });
}, 600000);
afterAll(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  for (const database of databases.reverse()) await dropIsolatedDatabase(admin, database);
  for (const role of [runtime, owner]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  record('summary', {
    server: evidence['server'],
    rosterSha256: RESTORE_ADMISSION_ROSTER_SHA256,
    keys: Object.keys(evidence),
  });
  await admin.end();
}, 120000);

describe('147 as a profile27 member over profile26 (installation v11)', () => {
  it('applies, keeps CLOSED/revision, pins roster and grants nothing new to runtime', async () => {
    const server = (
      await admin.query(
        "SELECT version() AS version, current_setting('server_version') AS v, current_setting('max_locks_per_transaction') AS locks, current_setting('max_connections') AS conns",
      )
    ).rows[0];
    record('server', server);
    expect(String(server['v'])).toBe('17.6 (Debian 17.6-2.pgdg12+1)');
    await session(base27, async (c) => {
      expect(await control(c)).toMatchObject({
        state: 'CLOSED',
        localRevision: '1',
        targetNonce: null,
      });
      expect(
        (await c.query('SELECT public.restore_processing_admission_roster_sha256() AS s'))
          .rows[0]?.['s'],
      ).toBe(RESTORE_ADMISSION_ROSTER_SHA256);
      expect(
        (await c.query('SELECT public.restore_processing_admission_roster_drift() AS d')).rows[0]?.[
          'd'
        ],
      ).toBe(false);
      expect(await flagDrift(c)).toBe(0);
    });
    // D4: a never-restored database (NULL target) can never open a window.
    await session(base27, async (c) => {
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      expect(
        await errorOf(() =>
          c.query('SELECT public.open_restore_processing_admission_window(1,$1,$2)', [
            randomUUID(),
            randomUUID(),
          ]),
        ),
      ).toBe('RESTORE_PROCESSING_CONTROL_CONFLICT');
      await c.query('ROLLBACK');
    });
  });
});

describe('C1 whole-table census across tenants (owner NO FORCE window)', () => {
  it('observer sees every tenant inside the window; one-tenant or zero census fails; true census admits', async () => {
    const db = await scenario('c1');
    const [a, b] = [randomUUID(), randomUUID()];
    await seedTenants(db, [a, b]);
    const t = await bind(db);
    const out: Record<string, unknown> = {};
    await session(db, async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.athlete_id',$1,true)", [a]);
      out['ownerTenantAOutsideWindow'] = (
        await c.query('SELECT count(*)::int AS n FROM public.command_receipt')
      ).rows[0]?.['n'];
      await c.query('ROLLBACK');
      const w = await openWindow(c, t);
      expect(w).toMatchObject({
        censusRelations: 225,
        rosterSha256: RESTORE_ADMISSION_ROSTER_SHA256,
      });
      await c.query("SELECT set_config('app.athlete_id',$1,true)", [a]);
      out['ownerTenantAInsideWindow'] = (
        await c.query('SELECT count(*)::int AS n FROM public.command_receipt')
      ).rows[0]?.['n'];
      await c.query("SELECT set_config('app.athlete_id','',true)");
      out['ownerUnsetInsideWindow'] = (
        await c.query('SELECT count(*)::int AS n FROM public.command_receipt')
      ).rows[0]?.['n'];
      const facts = await liveFacts(c);
      out['oneTenant'] = await inSavepoint(c, () =>
        errorOf(() =>
          admitSql(c, t, censusOf(facts, { 'public.command_receipt': 2, 'public.consent': 1 })),
        ),
      );
      out['zeros'] = await inSavepoint(c, () =>
        errorOf(() =>
          admitSql(
            c,
            t,
            census.map((r) => ({ schema: r.schema, relation: r.relation, rowCount: 0 })),
          ),
        ),
      );
      await c.query('ROLLBACK');
    });
    expect(out).toMatchObject({
      ownerTenantAOutsideWindow: 2,
      ownerTenantAInsideWindow: 4,
      ownerUnsetInsideWindow: 4,
      oneTenant: 'RESTORE_PROCESSING_POSTCONDITION_FAILED',
      zeros: 'RESTORE_PROCESSING_POSTCONDITION_FAILED',
    });
    const admitted = await admitViaTs(db, t);
    out['tsAdmit'] = { ...admitted.result, commandId: admitted.commandId };
    out['observedCommandReceipt'] = admitted.observed.get('public.command_receipt');
    expect(admitted.result).toMatchObject({
      replayed: false,
      resultRevision: String(BigInt(t.revision) + 1n),
    });
    await session(db, async (c) => {
      expect(await control(c)).toMatchObject({
        state: 'ADMITTED',
        admissionAllowed: true,
        targetAttested: true,
      });
      expect(await flagDrift(c)).toBe(0);
    });
    record('c1-multitenant', out);
  }, 180000);
});

describe('window protocol', () => {
  it('commit without admit, savepoint rollback, IMMEDIATE, missing/aborted window, runtime RLS', async () => {
    const db = await scenario('window');
    const [a, b] = [randomUUID(), randomUUID()];
    await seedTenants(db, [a, b]);
    const t = await bind(db);
    const out: Record<string, unknown> = {};
    await session(db, async (c) => {
      await openWindow(c, t);
      out['commitWithoutAdmit'] = await errorOf(() => c.query('COMMIT'));
      out['flagDriftAfterFailedCommit'] = await flagDrift(c);
      expect(await control(c)).toMatchObject({ state: 'CLOSED', localRevision: t.revision });

      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await c.query('SAVEPOINT before_open');
      await c.query('SELECT public.open_restore_processing_admission_window($1,$2,$3)', [
        t.revision,
        t.nonce,
        t.incarnation,
      ]);
      out['flagDriftInsideWindow'] = await flagDrift(c);
      await c.query('ROLLBACK TO SAVEPOINT before_open');
      out['flagDriftAfterRollbackToSavepoint'] = await flagDrift(c);
      out['commitAfterSavepointRollback'] = await errorOf(() => c.query('COMMIT'));

      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      out['immediate'] = await errorOf(() =>
        c.query('SELECT public.open_restore_processing_admission_window($1,$2,$3)', [
          t.revision,
          t.nonce,
          t.incarnation,
        ]),
      );
      await c.query('ROLLBACK');

      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const facts = await liveFacts(c);
      out['admitWithoutOpen'] = await errorOf(() => admitSql(c, t, censusOf(facts)));
      await c.query('ROLLBACK');

      await openWindow(c, t);
      await c.query('ROLLBACK');
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      out['admitAfterRolledBackWindow'] = await errorOf(() => admitSql(c, t, censusOf(facts)));
      await c.query('ROLLBACK');
    });
    // Runtime role inside an open window: blocked by ACCESS EXCLUSIVE (lock_timeout), and the
    // window's uncommitted NO FORCE is invisible to other sessions.
    const ownerClient = await connect(db);
    const rt = await connect(db, runtime);
    await openWindow(ownerClient, t);
    await rt.query('BEGIN');
    await rt.query("SET LOCAL lock_timeout='300ms'");
    await rt.query("SELECT set_config('app.athlete_id',$1,true)", [a]);
    out['runtimeReadInsideWindow'] = await sqlState(() =>
      rt.query('SELECT count(*) FROM public.command_receipt'),
    );
    await rt.query('ROLLBACK');
    out['otherSessionSeesForce'] = (
      await rt.query(
        "SELECT relforcerowsecurity AS f FROM pg_class WHERE oid='public.command_receipt'::regclass",
      )
    ).rows[0]?.['f'];
    await ownerClient.query('ROLLBACK');
    ownerClient.release();
    await admitViaTs(db, t);
    await rt.query('BEGIN');
    await rt.query("SELECT set_config('app.athlete_id',$1,true)", [a]);
    out['runtimeTenantAAfterAdmit'] = (
      await rt.query('SELECT count(*)::int AS n FROM public.command_receipt')
    ).rows[0]?.['n'];
    await rt.query('COMMIT');
    rt.release();
    record('window', out);
    expect(out).toMatchObject({
      commitWithoutAdmit: 'RESTORE_PROCESSING_WINDOW_OPEN_AT_COMMIT',
      flagDriftAfterFailedCommit: 0,
      flagDriftInsideWindow: 216,
      flagDriftAfterRollbackToSavepoint: 0,
      commitAfterSavepointRollback: 'NO_ERROR',
      immediate: 'RESTORE_PROCESSING_WINDOW_OPEN_AT_COMMIT',
      admitWithoutOpen: 'RESTORE_PROCESSING_WINDOW_NOT_OPEN',
      admitAfterRolledBackWindow: 'RESTORE_PROCESSING_WINDOW_NOT_OPEN',
      runtimeReadInsideWindow: { code: '55P03' },
      otherSessionSeesForce: true,
      runtimeTenantAAfterAdmit: 2,
    });
  }, 180000);
});

describe('C2/D1 CLOSED guard after admission (102/117/119/125 + TS stage query)', () => {
  it('every loader path is denied once ADMITTED', async () => {
    const db = await scenario('c2');
    const t = await bind(db);
    const { result } = await admitViaTs(db, t);
    const rev = result.resultRevision;
    const out: Record<string, unknown> = {};
    await session(db, async (c) => {
      await c.query('BEGIN');
      out['assertClosed'] = await inSavepoint(c, () =>
        errorOf(() =>
          c.query('SELECT public.assert_restore_processing_closed($1,$2,$3)', [
            rev,
            t.nonce,
            t.incarnation,
          ]),
        ),
      );
      out['tsStageAssertQuery'] = await inSavepoint(c, () =>
        errorOf(() =>
          c.query(
            'SELECT public.assert_restore_processing_closed($1::bigint,$2::uuid,$3::uuid) AS control, public.current_restore_generation()::text AS generation',
            [rev, t.nonce, t.incarnation],
          ),
        ),
      );
      out['ownerPortAssertClosed'] = await inSavepoint(c, () =>
        errorOf(() =>
          ownerPort(c).assertClosed({
            expectedRevision: rev,
            targetNonce: t.nonce,
            targetIncarnation: t.incarnation,
          }),
        ),
      );
      out['load102BeginStage'] = await inSavepoint(c, () =>
        errorOf(() =>
          c.query('SELECT wm_app_load.begin_stage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
            randomUUID(),
            H('d'),
            'owner_restore_app_family',
            t.nonce,
            H('e'),
            1,
            randomUUID(),
            1,
            H('f'),
            rev,
            t.incarnation,
          ]),
        ),
      );
      out['load102AssertContext'] = await inSavepoint(c, async () => {
        const run = randomUUID();
        const inserted = await errorOf(() =>
          c.query(
            `INSERT INTO wm_app_load.descriptor(run_id,owner_xid,proof_hash,purpose,expected_control_revision,target_incarnation,target_nonce,schema_hash,expected_state_version,athlete_id,expected_count,expected_digest)
             VALUES($1,txid_current(),$2,'owner_restore_app_family',$3,$4,$5,$6,1,$7,1,$8)`,
            [run, H('d'), rev, t.incarnation, t.nonce, H('e'), randomUUID(), H('f')],
          ),
        );
        if (inserted !== 'NO_ERROR') return `descriptor insert: ${inserted}`;
        return errorOf(() => c.query('SELECT wm_app_load.assert_context($1)', [run]));
      });
      await c.query('ROLLBACK');
      // 117/119/125 are restore-target-only loaders (D5): installable after admission, unusable.
      await c.query('BEGIN');
      for (const file of [
        '117_restore_current_full_parent_family_loader.sql',
        '119_current_original_postimages.sql',
        '125_restore_identity_target.sql',
      ])
        out[`install_${file.slice(0, 3)}`] = await errorOf(async () =>
          c.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')),
        );
      const generation = (await control(c)).generationId;
      out['load117ConfigureTarget'] = await inSavepoint(c, () =>
        errorOf(() => c.query('SELECT wm_current_app_load.configure_target()')),
      );
      out['load117BeginStageForgedTarget'] = await inSavepoint(c, async () => {
        await c.query('INSERT INTO wm_current_app_load.target VALUES(true,$1,$2,$3,$4,$5,$6)', [
          H('a'),
          t.nonce,
          t.incarnation,
          generation,
          rev,
          'CLOSED',
        ]);
        return errorOf(() =>
          c.query("SELECT wm_current_app_load.begin_stage($1,'{}'::jsonb)", [randomUUID()]),
        );
      });
      out['load119ConfigureProfileForgedTarget'] = await inSavepoint(c, async () => {
        await c.query('INSERT INTO wm_current_app_load.target VALUES(true,$1,$2,$3,$4,$5,$6)', [
          H('a'),
          t.nonce,
          t.incarnation,
          generation,
          rev,
          'CLOSED',
        ]);
        return errorOf(() =>
          c.query("SELECT wm_current_original_postimages.configure_profile('{}'::jsonb)"),
        );
      });
      out['load125ApplyIdentityTarget'] = await inSavepoint(c, async () =>
        errorOf(async () =>
          c.query(
            "SELECT wm_identity_target_load.apply_identity_target_v1($1::jsonb,'{}'::jsonb)",
            [JSON.stringify(await control(c))],
          ),
        ),
      );
      // D5: with a loader namespace present no window can open (after closing to a new target).
      await c.query('ROLLBACK');
    });
    record('c2-closed-guard', out);
    expect(out).toMatchObject({
      assertClosed: 'RESTORE_PROCESSING_CONTROL_CONFLICT',
      tsStageAssertQuery: 'RESTORE_PROCESSING_CONTROL_CONFLICT',
      ownerPortAssertClosed: 'RESTORE_PROCESSING_CONTROL_CONFLICT',
      load102BeginStage: 'RESTORE_PROCESSING_CONTROL_CONFLICT',
      load102AssertContext: 'RESTORE_PROCESSING_CONTROL_CONFLICT',
      install_117: 'NO_ERROR',
      install_119: 'NO_ERROR',
      install_125: 'NO_ERROR',
      load117ConfigureTarget: 'CURRENT_LOAD_CLOSED_REQUIRED',
      load117BeginStageForgedTarget: 'RESTORE_PROCESSING_CONTROL_CONFLICT',
      load119ConfigureProfileForgedTarget: 'RESTORE_PROCESSING_CONTROL_CONFLICT',
    });
    // 125 rejects before its CLOSED assert on any profile26+ catalog (fixed116 profile check).
    expect(String(out['load125ApplyIdentityTarget'])).toMatch(/^IDENTITY_TARGET_/);
  }, 180000);
});

describe('H1/M1/M3/D5 roster completeness, census shape and C order', () => {
  it('rejects subset, target_local, order, duplicates, non-roster, extra/missing tables and drift', async () => {
    const db = await scenario('h1');
    const t = await bind(db);
    const out: Record<string, unknown> = {};
    await session(db, async (c) => {
      await openWindow(c, t);
      const facts = await liveFacts(c);
      const good = censusOf(facts);
      const at = (i: number) => must(good[i]);
      const tryCensus = (
        entries: { schema: string; relation: string; rowCount: number }[],
        shaOverride?: string,
      ) =>
        inSavepoint(c, () =>
          errorOf(() => admitSql(c, t, entries, shaOverride ? { censusSha256: shaOverride } : {})),
        );
      out['subset'] = await tryCensus(good.slice(1));
      out['withTargetLocal'] = await tryCensus(
        [...good, { schema: 'public', relation: 'restore_generation', rowCount: 1 }].sort((x, y) =>
          q(x) < q(y) ? -1 : 1,
        ),
      );
      out['outOfOrder'] = await tryCensus([at(1), at(0), ...good.slice(2)]);
      out['duplicate'] = await tryCensus([at(0), at(0), ...good.slice(1)]);
      out['pgCatalog'] = await tryCensus([
        { schema: 'pg_catalog', relation: 'pg_class', rowCount: 1 },
        ...good,
      ]);
      out['sequence'] = await tryCensus(
        [
          ...good,
          { schema: 'public', relation: 'openai_budget_journal_sequence_id_seq', rowCount: 1 },
        ].sort((x, y) => (q(x) < q(y) ? -1 : 1)),
      );
      out['badDigest'] = await tryCensus(good, H('0'));
      out['badRowCountType'] = await inSavepoint(c, () =>
        errorOf(() => admitSql(c, t, [{ ...at(0), rowCount: 1.5 } as never, ...good.slice(1)])),
      );
      out['tableCreatedAfterOpen'] = await inSavepoint(c, async () => {
        await c.query('CREATE TABLE public.zz_unregistered_after_open(id int)');
        return errorOf(() => admitSql(c, t, good));
      });
      out['loaderNamespaceAfterOpen'] = await inSavepoint(c, async () => {
        await c.query('CREATE SCHEMA wm_current_app_load');
        return errorOf(() => admitSql(c, t, good));
      });
      await c.query('ROLLBACK');
      const opens: Record<string, string> = {};
      const tryOpen = async (label: string, mutate: string) => {
        await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await c.query(mutate);
        opens[label] = await errorOf(() =>
          c.query('SELECT public.open_restore_processing_admission_window($1,$2,$3)', [
            t.revision,
            t.nonce,
            t.incarnation,
          ]),
        );
        await c.query('ROLLBACK');
      };
      await tryOpen('extraPublicTable', 'CREATE TABLE public.zz_unregistered(id int)');
      await tryOpen('extraView_tolerated_kind_v', 'CREATE VIEW public.zz_view AS SELECT 1 AS x');
      await tryOpen(
        'missingRosterTable',
        'ALTER TABLE public.course_preference RENAME TO course_preference_renamed',
      );
      await tryOpen('forceDrift', 'ALTER TABLE public.consent NO FORCE ROW LEVEL SECURITY');
      await tryOpen('rlsDrift', 'ALTER TABLE public.consent DISABLE ROW LEVEL SECURITY');
      await tryOpen(
        'targetLocalForceDrift',
        'ALTER TABLE public.restore_generation NO FORCE ROW LEVEL SECURITY',
      );
      await tryOpen('loaderNamespaceEmpty', 'CREATE SCHEMA wm_identity_target_load');
      await tryOpen(
        'loaderNamespaceWithTable',
        'CREATE SCHEMA wm_current_original_postimages; CREATE TABLE wm_current_original_postimages.t(id int)',
      );
      out['open'] = opens;
    });
    // Owner drift needs a superuser ALTER ... OWNER; committed then reverted.
    const adminDb = new Pool({
      connectionString: (() => {
        const u = new URL(adminUrl);
        u.pathname = `/${db}`;
        return u.toString();
      })(),
      max: 1,
    });
    await adminDb.query(`ALTER TABLE public.course_preference OWNER TO "${runtime}"`);
    out['ownerDrift'] = await session(db, async (c) => {
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const e = await errorOf(() =>
        c.query('SELECT public.open_restore_processing_admission_window($1,$2,$3)', [
          t.revision,
          t.nonce,
          t.incarnation,
        ]),
      );
      await c.query('ROLLBACK');
      return e;
    });
    await adminDb.query(`ALTER TABLE public.course_preference OWNER TO "${owner}"`);
    await adminDb.end();
    record('h1-roster', out);
    expect(out).toMatchObject({
      subset: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
      withTargetLocal: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
      outOfOrder: 'INVALID_RESTORE_PROCESSING_ADMIT',
      duplicate: 'INVALID_RESTORE_PROCESSING_ADMIT',
      pgCatalog: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
      sequence: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
      badDigest: 'INVALID_RESTORE_PROCESSING_ADMIT',
      badRowCountType: 'INVALID_RESTORE_PROCESSING_ADMIT',
      tableCreatedAfterOpen: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
      loaderNamespaceAfterOpen: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
      open: {
        extraPublicTable: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
        extraView_tolerated_kind_v: 'NO_ERROR',
        missingRosterTable: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
        forceDrift: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
        rlsDrift: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
        targetLocalForceDrift: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
        loaderNamespaceEmpty: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
        loaderNamespaceWithTable: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
      },
      ownerDrift: 'RESTORE_PROCESSING_ROSTER_MISMATCH',
    });
  }, 180000);

  it('ICU en-US database: C-ordered census admits; collation order is never used', async () => {
    const icu = `adm147_icu_${suffix}`;
    await admin.query(
      `CREATE DATABASE "${icu}" OWNER "${owner}" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C.UTF-8'`,
    );
    databases.push(icu);
    await migrate(url(icu), 107);
    await installCurrentRuntimeV10(url(icu));
    await session(icu, async (c) => {
      await c.query('BEGIN');
      await apply147(c);
      await c.query('COMMIT');
    });
    const t = await bind(icu);
    const out: Record<string, unknown> = {};
    await session(icu, async (c) => {
      out['datlocprovider'] = (
        await c.query(
          'SELECT datlocprovider::text AS p, datlocale AS l FROM pg_database WHERE datname=current_database()',
        )
      ).rows[0];
      const dbOrder = (
        await c.query(
          "SELECT schema_name||'.'||relation_name AS n FROM public.restore_processing_admission_roster() WHERE relation_class<>'target_local' ORDER BY schema_name, relation_name",
        )
      ).rows.map((r) => String(r['n']));
      const cOrder = census.map(q);
      out['dbCollationOrderDiffers'] = JSON.stringify(dbOrder) !== JSON.stringify(cOrder);
      out['firstDifference'] = dbOrder.findIndex((n, i) => n !== cOrder[i]);
      await openWindow(c, t);
      const facts = await liveFacts(c);
      if (out['dbCollationOrderDiffers']) {
        const byDb = dbOrder.map((n) => must(censusOf(facts).find((e) => q(e) === n)));
        out['dbOrderedCensus'] = await inSavepoint(c, () => errorOf(() => admitSql(c, t, byDb)));
      }
      out['cOrderedCensus'] = await errorOf(() => admitSql(c, t, censusOf(facts)));
      await c.query('COMMIT');
    });
    record('m1-icu-order', out);
    expect(out['cOrderedCensus']).toBe('NO_ERROR');
    if (out['dbCollationOrderDiffers'])
      expect(out['dbOrderedCensus']).toBe('INVALID_RESTORE_PROCESSING_ADMIT');
  }, 600000);
});

describe('H2 authentication_reset relations', () => {
  it('a row in any of the seven blocks admission; concurrent inserts wait for the window', async () => {
    const db = await scenario('h2');
    const t = await bind(db);
    const tenant = randomUUID();
    const inserts: Record<string, { sql: string; params: unknown[] }[]> = {
      'identity_private.login_attempt': [
        {
          sql: "INSERT INTO identity_private.login_attempt(state_hash,browser_hash,nonce,verifier,expires_at) VALUES($1,$2,'synthetic-nonce-0001',repeat('v',43),clock_timestamp()+interval '1 hour')",
          params: [H('a'), H('b')],
        },
      ],
      'identity_private.native_exchange_code': [
        {
          sql: "INSERT INTO identity_private.native_exchange_code(code_hash,code_challenge,issuer,subject,login_started_at,expires_at) VALUES($1,repeat('A',43),'https://synthetic.invalid',$2,clock_timestamp(),clock_timestamp()+interval '1 hour')",
          params: [H('c'), 'synthetic-subject'],
        },
      ],
      'identity_private.native_login_attempt': [
        {
          sql: "INSERT INTO identity_private.native_login_attempt(state_hash,nonce,verifier,code_challenge,expires_at) VALUES($1,'synthetic-nonce-0002',repeat('V',43),repeat('B',43),clock_timestamp()+interval '1 hour')",
          params: [H('d')],
        },
      ],
      'identity_private.session': [
        {
          sql: "INSERT INTO identity_private.session(token_hash,athlete_id,csrf_token,expires_at) SELECT $1,athlete_id,repeat('c',32),clock_timestamp()+interval '1 hour' FROM identity_private.account LIMIT 1",
          params: [H('e')],
        },
      ],
      'public.garmin_connection': [
        {
          sql: "INSERT INTO public.garmin_connection(athlete_id) VALUES(nullif(current_setting('app.athlete_id',true),''))",
          params: [],
        },
      ],
      'public.garmin_attempt': [
        {
          sql: "INSERT INTO public.garmin_connection(athlete_id) VALUES(nullif(current_setting('app.athlete_id',true),''))",
          params: [],
        },
        {
          sql: `INSERT INTO public.garmin_attempt VALUES(nullif(current_setting('app.athlete_id',true),''),$1,$2,0,'{"keyId":"k","iv":"0123456789abcdef","ciphertext":"x","tag":"0123456789abcdefghijkl"}'::jsonb,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,
          params: [H('f'), 'synthetic-session'],
        },
      ],
      'public.garmin_unofficial_connection': [
        {
          sql: "INSERT INTO public.garmin_unofficial_connection(athlete_id) VALUES(nullif(current_setting('app.athlete_id',true),''))",
          params: [],
        },
      ],
    };
    // identity_private.session needs an account row (retained, counted normally).
    await session(db, (c) =>
      c.query(
        "INSERT INTO identity_private.account(issuer,subject) VALUES('https://synthetic.invalid',$1)",
        [randomUUID()],
      ),
    );
    const out: Record<string, unknown> = {};
    await session(db, async (c) => {
      for (const [relation, statements] of Object.entries(inserts)) {
        await openWindow(c, t);
        await c.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
        const seeded = await errorOf(async () => {
          for (const statement of statements) await c.query(statement.sql, statement.params);
        });
        const facts = await liveFacts(c);
        out[relation] = {
          seeded,
          liveCount: facts.get(relation)?.rowCount,
          censusZero: await inSavepoint(c, () =>
            errorOf(() => admitSql(c, t, censusOf(facts, { [relation]: 0 }))),
          ),
          censusLive: await inSavepoint(c, () => errorOf(() => admitSql(c, t, censusOf(facts)))),
        };
        await c.query('ROLLBACK');
      }
    });
    // Concurrent writer: a second owner session inserting a session row waits for the window.
    const holder = await connect(db);
    const writer = await connect(db);
    await openWindow(holder, t);
    const started = Date.now();
    const pending = writer
      .query(
        "INSERT INTO identity_private.session(token_hash,athlete_id,csrf_token,expires_at) SELECT $1,athlete_id,repeat('c',32),clock_timestamp()+interval '1 hour' FROM identity_private.account LIMIT 1",
        [H('9')],
      )
      .then(() => ({ ok: true, waitedMs: Date.now() - started }));
    await new Promise((r) => setTimeout(r, 500));
    const waitingLock = (
      await holder.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND relation='identity_private.session'::regclass",
      )
    ).rows[0]?.['n'];
    const facts = await liveFacts(holder);
    const admitted = await errorOf(() => admitSql(holder, t, censusOf(facts)));
    await holder.query('COMMIT');
    const writerResult = await pending;
    holder.release();
    writer.release();
    out['concurrentWriter'] = {
      waitingLockWhileWindowOpen: waitingLock,
      admitDuringWait: admitted,
      sessionCountAtAdmission: facts.get('identity_private.session')?.rowCount,
      writerCompletedAfterCommit: writerResult,
    };
    record('h2-authentication-reset', out);
    for (const relation of Object.keys(inserts)) {
      const r = out[relation] as Record<string, unknown>;
      expect(r['seeded']).toBe('NO_ERROR');
      expect(r['liveCount']).toBeGreaterThan(0);
      expect(r['censusZero']).toBe('RESTORE_PROCESSING_POSTCONDITION_FAILED');
      expect(r['censusLive']).toBe('RESTORE_PROCESSING_POSTCONDITION_FAILED');
    }
    expect(out['concurrentWriter']).toMatchObject({
      waitingLockWhileWindowOpen: 1,
      admitDuringWait: 'NO_ERROR',
      sessionCountAtAdmission: 0,
      writerCompletedAfterCommit: { ok: true },
    });
  }, 300000);
});

describe('H6 transaction context', () => {
  it('rejects wrong xid, RR/SERIALIZABLE, replica role and a disabled commit guard', async () => {
    const db = await scenario('h6');
    const t = await bind(db);
    const out: Record<string, unknown> = {};
    await session(db, async (c) => {
      await openWindow(c, t);
      const facts = await liveFacts(c);
      const x = String((await c.query('SELECT txid_current()::text AS x')).rows[0]?.['x']);
      out['wrongXid'] = await inSavepoint(c, () =>
        errorOf(() => admitSql(c, t, censusOf(facts), { xid: String(BigInt(x) + 1n) })),
      );
      await c.query('ROLLBACK');
      for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
        await c.query(`BEGIN ISOLATION LEVEL ${level}`);
        out[`open_${level}`] = await errorOf(() =>
          c.query('SELECT public.open_restore_processing_admission_window($1,$2,$3)', [
            t.revision,
            t.nonce,
            t.incarnation,
          ]),
        );
        await c.query('ROLLBACK');
      }
      out['replicaRole'] = await sqlState(() => c.query("SET session_replication_role='replica'"));
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await c.query(
        'ALTER TABLE public.restore_processing_admission DISABLE TRIGGER restore_processing_force_rls_at_commit',
      );
      out['disabledGuard'] = await errorOf(() =>
        c.query('SELECT public.open_restore_processing_admission_window($1,$2,$3)', [
          t.revision,
          t.nonce,
          t.incarnation,
        ]),
      );
      await c.query('ROLLBACK');
    });
    record('h6-context', out);
    expect(out).toMatchObject({
      wrongXid: 'RESTORE_PROCESSING_ADMIT_CONTEXT',
      'open_REPEATABLE READ': 'RESTORE_PROCESSING_ADMIT_CONTEXT',
      open_SERIALIZABLE: 'RESTORE_PROCESSING_ADMIT_CONTEXT',
      replicaRole: { code: '42501' },
      disabledGuard: 'RESTORE_PROCESSING_ADMIT_CONTEXT',
    });
  }, 180000);
});

describe('H4 require_ callers (103/104/106) under CLOSED and ADMITTED', () => {
  it('ADMITTED opens only the processing gate; later gates stay; 104 stays closed; stale generation denies', async () => {
    const db = await scenario('h4');
    const tenant = randomUUID();
    const reservation = { id: randomUUID(), run: randomUUID(), owner: randomUUID() };
    await session(db, async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
      await c.query("INSERT INTO public.consent VALUES($1,'app',true,1)", [tenant]);
      await c.query(
        "INSERT INTO openai_budget_fx_definition VALUES('synthetic-fx-v1',1,1,$1,true)",
        [H('1')],
      );
      await c.query(
        "INSERT INTO openai_budget_price_definition VALUES('synthetic-price-v1','gpt-6.1-sol','synthetic-fx-v1','synthetic-tokenizer-v1',1,1,$1,1,1,'2020-01-01','2090-01-01',false)",
        [H('2')],
      );
      await c.query(
        "INSERT INTO openai_budget_month(period_key) VALUES(date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date) ON CONFLICT DO NOTHING",
      );
      await c.query(
        `INSERT INTO openai_budget_reservation(reservation_id,request_key,request_digest,athlete_id,run_id,subject_digest,period_key,price_version,input_bound,output_bound,reserved_krw,owner_token_digest)
         VALUES($1,$2,$3,$4,$5,$6,date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date,'synthetic-price-v1',1,1,0,$7)`,
        [
          reservation.id,
          H('3'),
          H('4'),
          tenant,
          reservation.run,
          sha(tenant),
          sha(reservation.owner),
        ],
      );
      await c.query(
        "INSERT INTO openai_budget_journal(reservation_id,period_key,event_kind,held_delta,debit_delta) SELECT reservation_id,period_key,'reserved',reserved_krw,0 FROM openai_budget_reservation WHERE reservation_id=$1",
        [reservation.id],
      );
      await c.query('COMMIT');
    });
    const t = await bind(db);
    const probe = async (label: string) => {
      const rt = await connect(db, runtime);
      const own = await connect(db, owner);
      const run = async (c: PoolClient, sql: string, values: unknown[] = []) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
        const result = await errorOf(() => c.query(sql, values));
        await c.query('ROLLBACK');
        return result;
      };
      const generation = (await control(own)).generationId;
      // Profile26 grants the runtime role none of the 103/106 entry points (recorded); the
      // owner calls the same SECURITY DEFINER bodies so the gates themselves are exercised.
      const runtimeExecute = Object.fromEntries(
        await Promise.all(
          [
            'public.reserve_openai_budget(uuid,text,text,text,integer,integer,uuid)',
            'public.begin_openai_budget_dispatch(uuid,uuid,uuid,uuid,integer,uuid)',
            'public.store_race_manual_review(uuid,text,text,uuid,integer,integer,uuid,text,text,text,jsonb,jsonb)',
            'public.assert_ai_settings_write_target()',
            'public.require_restore_processing_admission()',
          ].map(async (f) => [
            f,
            (await rt.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS p", [f]))
              .rows[0]?.['p'],
          ]),
        ),
      );
      const r = {
        runtimeExecute,
        requireRuntime: await run(rt, 'SELECT public.require_restore_processing_admission()'),
        requireTs: await (async () => {
          await rt.query('BEGIN');
          const e = await errorOf(() =>
            requireRestoreProcessingAdmission(Object.assign(rt, { athleteId: tenant })),
          );
          await rt.query('ROLLBACK');
          return e;
        })(),
        reserve103: await run(own, 'SELECT public.reserve_openai_budget($1,$2,$3,$4,1,1,$5)', [
          reservation.run,
          H('5'),
          H('6'),
          'synthetic-price-v1',
          randomUUID(),
        ]),
        dispatch103: await run(
          own,
          'SELECT public.begin_openai_budget_dispatch($1,$2,$3,$4,1,$5) AS ok',
          [reservation.id, reservation.owner, randomUUID(), randomUUID(), reservation.run],
        ),
        store106MatchingApp: await run(
          own,
          'SELECT public.store_race_manual_review($1,$2,$3,$4,1,1,$5,$6,$7,$8,$9,$10)',
          [
            randomUUID(),
            `race-manual-review:store:${H('7')}`,
            H('8'),
            randomUUID(),
            generation,
            H('9'),
            H('a'),
            H('b'),
            '{}',
            '[]',
          ],
        ),
        store106MismatchingApp: await run(
          own,
          'SELECT public.store_race_manual_review($1,$2,$3,$4,1,2,$5,$6,$7,$8,$9,$10)',
          [
            randomUUID(),
            `race-manual-review:store:${H('c')}`,
            H('d'),
            randomUUID(),
            generation,
            H('9'),
            H('a'),
            H('b'),
            '{}',
            '[]',
          ],
        ),
        trigger106MatchingApp: await run(
          own,
          'INSERT INTO public.race_manual_review(athlete_id,app_revision) VALUES($1,1)',
          [tenant],
        ),
        trigger106MismatchingApp: await run(
          own,
          'INSERT INTO public.race_manual_review(athlete_id,app_revision) VALUES($1,2)',
          [tenant],
        ),
        aiSettings104: await run(rt, 'SELECT public.assert_ai_settings_write_target()'),
      };
      rt.release();
      own.release();
      return [label, r] as const;
    };
    const out: Record<string, unknown> = {};
    const setActivation = (enabled: boolean) =>
      session(db, (c) =>
        errorOf(() =>
          c.query(
            'UPDATE public.openai_budget_activation SET enabled=$1,pricing_bundle_digest=$2,verified_tail_digest=$3,generation_id=public.current_restore_generation()',
            [enabled, enabled ? H('e') : null, enabled ? H('f') : null],
          ),
        ),
      );
    out['closed'] = (await probe('closed'))[1];
    const admitted = await admitViaTs(db, t);
    out['activationOff'] = await setActivation(false);
    out['admittedActivationOff'] = (await probe('admitted'))[1];
    out['activationOn'] = await setActivation(true);
    out['admittedActivationOn'] = (await probe('admitted-on'))[1];
    out['readAfterAdmit'] = await session(db, (c) => control(c));
    await session(db, (c) => c.query('SELECT public.rotate_restore_generation()'));
    out['readAfterRotate'] = await session(db, (c) => control(c));
    out['tsReadAfterRotate'] = await session(db, async (c) => {
      await c.query('BEGIN');
      const v = await readRestoreProcessingAdmission(Object.assign(c, { athleteId: tenant }));
      await c.query('ROLLBACK');
      return v;
    });
    out['staleGeneration'] = (await probe('stale'))[1];
    out['admitResult'] = admitted.result;
    record('h4-callers', out);
    const closed = out['closed'] as Record<string, string>;
    const open = out['admittedActivationOff'] as Record<string, string>;
    const on = out['admittedActivationOn'] as Record<string, string>;
    const stale = out['staleGeneration'] as Record<string, string>;
    for (const key of [
      'requireRuntime',
      'reserve103',
      'dispatch103',
      'store106MatchingApp',
      'trigger106MatchingApp',
    ])
      expect(closed[key]).toBe('RESTORE_PROCESSING_CLOSED');
    expect(closed['requireTs']).toBe('RESTORE_PROCESSING_CLOSED');
    expect(closed['aiSettings104']).toBe('AI_SETTINGS_RESTORE_TARGET_CLOSED');
    for (const r of [open, on]) {
      expect(r['requireRuntime']).toBe('NO_ERROR');
      expect(r['requireTs']).toBe('NO_ERROR');
      expect(r['reserve103']).not.toBe('RESTORE_PROCESSING_CLOSED');
      expect(r['dispatch103']).not.toBe('RESTORE_PROCESSING_CLOSED');
      expect(r['store106MatchingApp']).not.toMatch(/RESTORE_PROCESSING_CLOSED|STALE_APP_ADMISSION/);
      expect(r['store106MismatchingApp']).toBe('STALE_APP_ADMISSION');
      expect(r['trigger106MatchingApp']).not.toMatch(
        /RESTORE_PROCESSING_CLOSED|STALE_APP_ADMISSION/,
      );
      expect(r['trigger106MismatchingApp']).toBe('STALE_APP_ADMISSION');
      expect(r['aiSettings104']).toBe('AI_SETTINGS_RESTORE_TARGET_CLOSED');
    }
    expect(out['readAfterRotate']).toMatchObject({
      state: 'ADMITTED',
      admissionAllowed: false,
      targetAttested: true,
    });
    expect(out['tsReadAfterRotate']).toMatchObject({ state: 'ADMITTED', admissionAllowed: false });
    for (const key of [
      'requireRuntime',
      'reserve103',
      'dispatch103',
      'store106MatchingApp',
      'trigger106MatchingApp',
    ])
      expect(stale[key]).toBe('RESTORE_PROCESSING_CLOSED');
    expect(stale['requireTs']).toBe('RESTORE_PROCESSING_CLOSED');
  }, 300000);
});

describe('M2 replay and command id domains', () => {
  it('identical replay, any changed field, superseded replay and cross-table command ids', async () => {
    const db = await scenario('m2');
    const t = await bind(db);
    const out: Record<string, unknown> = {};
    const commandId = randomUUID();
    let entries: { schema: string; relation: string; rowCount: number }[] = [];
    await session(db, async (c) => {
      await openWindow(c, t);
      entries = censusOf(await liveFacts(c));
      out['first'] = await admitSql(c, t, entries, { commandId });
      await c.query('COMMIT');
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      out['identicalReplay'] = await admitSql(c, t, entries, { commandId });
      const changed: Record<string, () => Promise<unknown>> = {
        revision: () =>
          admitSql(c, { ...t, revision: String(BigInt(t.revision) + 1n) }, entries, { commandId }),
        nonce: () => admitSql(c, { ...t, nonce: randomUUID() }, entries, { commandId }),
        incarnation: () => admitSql(c, { ...t, incarnation: randomUUID() }, entries, { commandId }),
        artifact: () => admitSql(c, t, entries, { commandId, artifact: H('e') }),
        census: () =>
          admitSql(
            c,
            t,
            entries.map((e, i) => (i === 0 ? { ...e, rowCount: e.rowCount + 1 } : e)),
            { commandId },
          ),
        censusSha: () => admitSql(c, t, entries, { commandId, censusSha256: H('f') }),
      };
      for (const [k, run] of Object.entries(changed))
        out[`changed_${k}`] = await inSavepoint(c, () => errorOf(run));
      await c.query('COMMIT');
      const admittedRevision = (await control(c)).localRevision;
      const closeId = randomUUID();
      out['closeWithAdmitId'] = await errorOf(() =>
        ownerPort(c).close({
          expectedRevision: admittedRevision,
          commandId,
          targetNonce: t.nonce,
          targetIncarnation: t.incarnation,
        }),
      );
      out['close'] = await ownerPort(c).close({
        expectedRevision: admittedRevision,
        commandId: closeId,
        targetNonce: t.nonce,
        targetIncarnation: t.incarnation,
      });
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      out['replayAfterClose'] = await errorOf(() => admitSql(c, t, entries, { commandId }));
      await c.query('ROLLBACK');
      const closed = (await control(c)).localRevision;
      await openWindow(c, { ...t, revision: closed });
      out['admitWithCloseId'] = await errorOf(() =>
        admitSql(c, { ...t, revision: closed }, censusOf(new Map()), { commandId: closeId }),
      );
      await c.query('ROLLBACK');
    });
    record('m2-replay', out);
    expect(out['first']).toMatchObject({ replayed: false });
    expect(out['identicalReplay']).toMatchObject({
      replayed: true,
      resultRevision: (out['first'] as Record<string, unknown>)['resultRevision'],
      censusSha256: restoreAdmissionCensusSha256(entries),
    });
    for (const k of ['revision', 'nonce', 'incarnation', 'artifact', 'census', 'censusSha'])
      expect(out[`changed_${k}`]).toBe('RESTORE_PROCESSING_ADMIT_CONFLICT');
    expect(out).toMatchObject({
      closeWithAdmitId: 'RESTORE_PROCESSING_CLOSE_CONFLICT',
      replayAfterClose: 'RESTORE_PROCESSING_ADMIT_SUPERSEDED',
      admitWithCloseId: 'RESTORE_PROCESSING_COMMAND_ID_REUSED',
    });
  }, 180000);
});

describe('concurrency (two-session outputs preserved)', () => {
  it('admit vs close, admit vs admit, runtime shared lock, rotation, deadlock', async () => {
    const out: Record<string, unknown> = {};
    const timeline = (log: unknown[], who: string, what: unknown) =>
      log.push({ at: Date.now(), who, what });

    // admit vs close
    {
      const db = await scenario('cc_close');
      const t = await bind(db);
      const a = await connect(db);
      const b = await connect(db);
      const log: unknown[] = [];
      await openWindow(a, t);
      timeline(log, 'A', 'window open');
      const closing = ownerPort(b)
        .close({
          expectedRevision: t.revision,
          commandId: randomUUID(),
          targetNonce: t.nonce,
          targetIncarnation: t.incarnation,
        })
        .then(
          (v) => timeline(log, 'B', { closed: v }),
          (e: Error) => timeline(log, 'B', { error: e.message }),
        );
      await new Promise((r) => setTimeout(r, 400));
      timeline(log, 'A', { admit: await admitSql(a, t, censusOf(await liveFacts(a))) });
      await a.query('COMMIT');
      timeline(log, 'A', 'commit');
      await closing;
      timeline(log, 'final', await control(a));
      a.release();
      b.release();
      out['admitVsClose'] = log;
    }
    // admit vs admit (same command id)
    {
      const db = await scenario('cc_admit');
      const t = await bind(db);
      const a = await connect(db);
      const b = await connect(db);
      const log: unknown[] = [];
      const commandId = randomUUID();
      await openWindow(a, t);
      const facts = await liveFacts(a);
      const entries = censusOf(facts);
      await b.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const second = b
        .query('SELECT public.open_restore_processing_admission_window($1,$2,$3) AS w', [
          t.revision,
          t.nonce,
          t.incarnation,
        ])
        .then(
          (v) => timeline(log, 'B', { window: v.rows[0] }),
          (e: Error) => timeline(log, 'B', { openError: e.message }),
        );
      await new Promise((r) => setTimeout(r, 400));
      timeline(log, 'A', { admit: await admitSql(a, t, entries, { commandId }) });
      await a.query('COMMIT');
      await second;
      await b.query('ROLLBACK');
      await b.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      timeline(log, 'B', {
        replaySameCommand: await admitSql(b, t, entries, { commandId }).catch(
          (e: Error) => e.message,
        ),
      });
      await b.query('COMMIT');
      a.release();
      b.release();
      out['admitVsAdmitSameCommand'] = log;
    }
    // runtime transaction holding shared (77210,1)
    {
      const db = await scenario('cc_shared');
      const t = await bind(db);
      const rt = await connect(db, runtime);
      const a = await connect(db);
      const log: unknown[] = [];
      await rt.query('BEGIN');
      await rt.query('SELECT public.read_restore_processing_admission()');
      timeline(log, 'runtime', 'holds shared (77210,1)');
      await a.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await a.query("SET LOCAL lock_timeout='500ms'");
      timeline(log, 'A', {
        openWhileShared: await sqlState(() =>
          a.query('SELECT public.open_restore_processing_admission_window($1,$2,$3)', [
            t.revision,
            t.nonce,
            t.incarnation,
          ]),
        ),
      });
      await a.query('ROLLBACK');
      await rt.query('COMMIT');
      timeline(log, 'runtime', 'released');
      await openWindow(a, t);
      timeline(log, 'A', {
        admit: await admitSql(a, t, censusOf(await liveFacts(a))).then((r) => r['replayed']),
      });
      await a.query('COMMIT');
      rt.release();
      a.release();
      out['admitVsRuntimeShared'] = log;
    }
    // rotation: during the window (another session) and after admission
    {
      const db = await scenario('cc_rotate');
      const t = await bind(db);
      const a = await connect(db);
      const b = await connect(db);
      const log: unknown[] = [];
      await openWindow(a, t);
      timeline(log, 'B', {
        rotate: (await b.query('SELECT public.rotate_restore_generation() AS g')).rows[0],
      });
      timeline(log, 'A', {
        admitAfterRotation: await errorOf(() => admitSql(a, t, censusOf(new Map()))),
      });
      await a.query('ROLLBACK');
      // Recover: close to a new target under the new generation, admit, rotate again.
      const t2 = await bind(db);
      await admitViaTs(db, t2);
      timeline(log, 'A', { afterAdmit: await control(a) });
      await b.query('SELECT public.rotate_restore_generation()');
      timeline(log, 'B', 'rotated after admission');
      timeline(log, 'A', { afterRotate: await control(a) });
      a.release();
      b.release();
      out['admitVsRotate'] = log;
    }
    // deadlock with a non-advisory writer
    {
      const db = await scenario('cc_deadlock');
      const t = await bind(db);
      const a = await connect(db);
      const w = await connect(db);
      const log: unknown[] = [];
      const tenant = randomUUID();
      await w.query('BEGIN');
      await w.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
      // Late in C order: the window will wait for this lock.
      await w.query('LOCK TABLE public.training_best_revision IN ROW EXCLUSIVE MODE');
      timeline(log, 'W', 'holds ROW EXCLUSIVE on public.training_best_revision');
      await a.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const opening = a
        .query('SELECT public.open_restore_processing_admission_window($1,$2,$3)', [
          t.revision,
          t.nonce,
          t.incarnation,
        ])
        .then(
          () => timeline(log, 'A', 'window open'),
          (e: { code?: string; message: string }) =>
            timeline(log, 'A', { code: e.code, error: e.message }),
        );
      await new Promise((r) => setTimeout(r, 500));
      // Early in C order and already ACCESS EXCLUSIVE by A: W now waits for A -> deadlock.
      const writer = w.query('SELECT count(*) FROM public.activity_canonical').then(
        () => timeline(log, 'W', 'read ok'),
        (e: { code?: string; message: string }) =>
          timeline(log, 'W', { code: e.code, error: e.message }),
      );
      await Promise.all([opening, writer]);
      await a.query('ROLLBACK').catch(() => undefined);
      await w.query('ROLLBACK').catch(() => undefined);
      timeline(log, 'final', { control: await control(a), flagDrift: await flagDrift(a) });
      a.release();
      w.release();
      out['deadlock'] = log;
    }
    record('concurrency', out);
    const close = JSON.stringify(out['admitVsClose']);
    expect(close).toContain('RESTORE_PROCESSING_CONTROL_CONFLICT');
    expect(close).toContain('"state":"ADMITTED"');
    const twice = JSON.stringify(out['admitVsAdmitSameCommand']);
    expect(twice).toContain('"openError":"RESTORE_PROCESSING_CONTROL_CONFLICT"');
    expect(twice).toContain('"replayed":true');
    const shared = JSON.stringify(out['admitVsRuntimeShared']);
    expect(shared).toContain('"code":"55P03"');
    expect(shared).toContain('"admit":false');
    const rotate = JSON.stringify(out['admitVsRotate']);
    expect(rotate).toContain('"admitAfterRotation":"RESTORE_PROCESSING_CONTROL_CONFLICT"');
    expect(rotate).toMatch(/"afterRotate":\{[^}]*"admissionAllowed":false/);
    const deadlock = JSON.stringify(out['deadlock']);
    expect(deadlock).toContain('"code":"40P01"');
    expect(deadlock).toMatch(/"flagDrift":0/);
  }, 300000);
});

describe('atomicity, receipts and ACL', () => {
  it('a failure after the UPDATE rolls back state, receipt and force flags', async () => {
    const db = await scenario('atomic');
    const t = await bind(db);
    const out = await session(db, async (c) => {
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // Injected failure on the receipt INSERT (runs after the control UPDATE inside admit_).
      await c.query(`CREATE FUNCTION public.zz_inject_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'INJECTED_RECEIPT_FAILURE'; END $$`);
      await c.query(
        'CREATE TRIGGER zz_inject BEFORE INSERT ON public.restore_processing_admit_receipt FOR EACH ROW EXECUTE FUNCTION public.zz_inject_receipt_failure()',
      );
      await c.query('SELECT public.open_restore_processing_admission_window($1,$2,$3)', [
        t.revision,
        t.nonce,
        t.incarnation,
      ]);
      const failed = await errorOf(async () => admitSql(c, t, censusOf(await liveFacts(c))));
      await c.query('ROLLBACK');
      return {
        failed,
        control: await control(c),
        receipts: (
          await c.query('SELECT count(*)::int AS n FROM public.restore_processing_admit_receipt')
        ).rows[0]?.['n'],
        flagDrift: await flagDrift(c),
        injectedTriggerGone: (
          await c.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='zz_inject'")
        ).rows[0]?.['n'],
      };
    });
    record('atomicity', out);
    expect(out).toMatchObject({
      failed: 'INJECTED_RECEIPT_FAILURE',
      control: { state: 'CLOSED', localRevision: t.revision },
      receipts: 0,
      flagDrift: 0,
      injectedTriggerGone: 0,
    });
  }, 180000);

  it('receipts are immutable and the runtime role has no owner capability', async () => {
    const db = await scenario('acl');
    const t = await bind(db);
    await admitViaTs(db, t);
    const out: Record<string, unknown> = {};
    await session(db, async (c) => {
      await c.query('BEGIN');
      for (const table of [
        'restore_processing_admit_receipt',
        'restore_processing_close_receipt',
      ]) {
        out[`${table}_update`] = await inSavepoint(c, () =>
          errorOf(() => c.query(`UPDATE public.${table} SET expected_revision=expected_revision`)),
        );
        out[`${table}_delete`] = await inSavepoint(c, () =>
          errorOf(() => c.query(`DELETE FROM public.${table}`)),
        );
        out[`${table}_truncate`] = await inSavepoint(c, () =>
          errorOf(() => c.query(`TRUNCATE public.${table}`)),
        );
      }
      await c.query('ROLLBACK');
    });
    await session(
      db,
      async (rt) => {
        const fns = [
          'open_restore_processing_admission_window(bigint,uuid,uuid)',
          'admit_restore_processing_exact(bigint,uuid,uuid,uuid,text,text,text,jsonb,text,bigint)',
          'close_restore_processing_exact(bigint,uuid,uuid,uuid)',
          'assert_restore_processing_closed(bigint,uuid,uuid)',
          'restore_processing_admission_roster()',
          'restore_processing_admission_roster_sha256()',
          'restore_processing_admission_roster_drift()',
          'restore_processing_admission_loader_namespaces()',
          'restore_processing_plain_owner()',
          'guard_restore_processing_force_rls()',
          'guard_restore_processing_admit_receipt()',
          'read_restore_processing_admission()',
          'require_restore_processing_admission()',
          'lock_restore_processing_shared()',
        ];
        out['runtimeExecute'] = Object.fromEntries(
          await Promise.all(
            fns.map(async (f) => [
              f,
              (
                await rt.query('SELECT has_function_privilege(current_user,$1,$2) AS p', [
                  `public.${f}`,
                  'EXECUTE',
                ])
              ).rows[0]?.['p'],
            ]),
          ),
        );
        out['runtimeCallOpen'] = await sqlState(() =>
          rt.query('SELECT public.open_restore_processing_admission_window(1,$1,$2)', [
            randomUUID(),
            randomUUID(),
          ]),
        );
        out['runtimeReadReceipt'] = await sqlState(() =>
          rt.query('SELECT * FROM public.restore_processing_admit_receipt'),
        );
        out['runtimeInsertReceipt'] = await sqlState(() =>
          rt.query('INSERT INTO public.restore_processing_admit_receipt(command_id) VALUES($1)', [
            randomUUID(),
          ]),
        );
      },
      runtime,
    );
    record('receipts-acl', out);
    for (const table of ['restore_processing_admit_receipt', 'restore_processing_close_receipt']) {
      const message =
        table === 'restore_processing_admit_receipt'
          ? 'IMMUTABLE_RESTORE_PROCESSING_ADMIT_RECEIPT'
          : 'IMMUTABLE_RESTORE_PROCESSING_CLOSE_RECEIPT';
      for (const op of ['update', 'delete', 'truncate'])
        expect(out[`${table}_${op}`]).toBe(message);
    }
    expect(out['runtimeExecute']).toEqual({
      'open_restore_processing_admission_window(bigint,uuid,uuid)': false,
      'admit_restore_processing_exact(bigint,uuid,uuid,uuid,text,text,text,jsonb,text,bigint)': false,
      'close_restore_processing_exact(bigint,uuid,uuid,uuid)': false,
      'assert_restore_processing_closed(bigint,uuid,uuid)': false,
      'restore_processing_admission_roster()': false,
      'restore_processing_admission_roster_sha256()': false,
      'restore_processing_admission_roster_drift()': false,
      'restore_processing_admission_loader_namespaces()': false,
      'restore_processing_plain_owner()': false,
      'guard_restore_processing_force_rls()': false,
      'guard_restore_processing_admit_receipt()': false,
      'read_restore_processing_admission()': true,
      'require_restore_processing_admission()': true,
      'lock_restore_processing_shared()': true,
    });
    expect(out).toMatchObject({
      runtimeCallOpen: { code: '42501' },
      runtimeReadReceipt: { code: '42501' },
      runtimeInsertReceipt: { code: '42501' },
    });
  }, 180000);
});

describe('upgrade and structure', () => {
  it('existing CLOSED row with bound target and close receipts: close replay is byte-identical across 147', async () => {
    const db = await scenario('upgrade', base26);
    const commands: {
      expectedRevision: string;
      commandId: string;
      targetNonce: string | null;
      targetIncarnation: string | null;
    }[] = [];
    const before = await session(db, async (c) => {
      const replies: unknown[] = [];
      let rev = (await control(c)).localRevision;
      for (const target of [
        [randomUUID(), randomUUID()],
        [null, null],
        [randomUUID(), randomUUID()],
      ] as const) {
        const command = {
          expectedRevision: rev,
          commandId: randomUUID(),
          targetNonce: target[0],
          targetIncarnation: target[1],
        };
        commands.push(command);
        const r = (
          await c.query('SELECT public.close_restore_processing_exact($1,$2,$3,$4)::text AS v', [
            command.expectedRevision,
            command.commandId,
            command.targetNonce,
            command.targetIncarnation,
          ])
        ).rows[0]?.['v'];
        replies.push(r);
        rev = String(BigInt(rev) + 1n);
      }
      const replays: unknown[] = [];
      for (const command of commands)
        replays.push(
          (
            await c.query('SELECT public.close_restore_processing_exact($1,$2,$3,$4)::text AS v', [
              command.expectedRevision,
              command.commandId,
              command.targetNonce,
              command.targetIncarnation,
            ])
          ).rows[0]?.['v'],
        );
      return { replies, replays, control: await control(c) };
    });
    await session(db, async (c) => {
      await c.query('BEGIN');
      await apply147(c);
      await c.query('COMMIT');
    });
    const after = await session(db, async (c) => {
      const replays: unknown[] = [];
      for (const command of commands)
        replays.push(
          (
            await c.query('SELECT public.close_restore_processing_exact($1,$2,$3,$4)::text AS v', [
              command.expectedRevision,
              command.commandId,
              command.targetNonce,
              command.targetIncarnation,
            ])
          ).rows[0]?.['v'],
        );
      return {
        replays,
        control: await control(c),
        row: (
          await c.query(
            'SELECT state,admitted_artifact_sha256,admitted_head_sha256,admitted_postconditions_sha256 FROM public.restore_processing_admission',
          )
        ).rows[0],
      };
    });
    record('upgrade', { before, after });
    // Close replay bytes are identical before and after 147 (and equal the original replies).
    expect(after.replays).toEqual(before.replays);
    expect(before.replays).toEqual(before.replies);
    expect(after.control).toEqual(before.control);
    expect(after.row).toEqual({
      state: 'CLOSED',
      admitted_artifact_sha256: null,
      admitted_head_sha256: null,
      admitted_postconditions_sha256: null,
    });
    // The bound target from before 147 can be admitted afterwards (receipt-bound, L6).
    const t = {
      revision: before.control.localRevision,
      nonce: must(must(commands[2]).targetNonce),
      incarnation: must(must(commands[2]).targetIncarnation),
    };
    const admitted = await admitViaTs(db, t);
    expect(admitted.result.control.state).toBe('ADMITTED');
  }, 180000);

  it('successor expected structure matches a clean install and again after open→admit→commit', async () => {
    const comparator = createFullRestoreStructureComparatorV1({
      expectedBytes: readFullRestoreExpectedStructureV2Bytes(),
      expectedSha256: FULL_RESTORE_EXPECTED_STRUCTURE_V2_SHA256,
    });
    const db = await scenario('structure');
    const capture = () =>
      session(db, async (c) => {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const s = await captureFullRestoreStructureV1(c, comparator.relations);
        await c.query('ROLLBACK');
        return comparator.compare(s);
      });
    const clean = await capture();
    const t = await bind(db);
    const { result } = await admitViaTs(db, t);
    const cycled = await capture();
    const locks = (await admin.query("SELECT current_setting('max_locks_per_transaction') AS v"))
      .rows[0]?.['v'];
    record('structure', {
      clean: {
        matched: clean.matched,
        differences: clean.differences,
        actualSha256: clean.actualSha256,
      },
      afterCycle: {
        matched: cycled.matched,
        differences: cycled.differences,
        actualSha256: cycled.actualSha256,
      },
      admitRevision: result.resultRevision,
      maxLocksPerTransaction: locks,
      installationV11: 'installCurrentRuntimeV11In (profile26 -> profile27)',
      coldCatalogV11: 'not_executed (installer lane)',
    });
    expect(clean).toMatchObject({ matched: true, relationCount: 254 });
    expect(cycled).toMatchObject({ matched: true, relationCount: 254 });
  }, 180000);
});
