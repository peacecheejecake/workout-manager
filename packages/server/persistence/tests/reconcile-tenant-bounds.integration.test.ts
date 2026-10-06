import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { migrate, grantResourceObjectCleanupWorker } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Physical scan evidence uses auto_explain, never a zero nested pg_stat delta.
// Bootstrap admin only loads instrumentation before switching session authorization
// to the real NOSUPER/NOBYPASS owner/worker. No production planner GUC is changed.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `reconcile_bounds_${suffix}`;
const roles = {
  owner: `bounds_owner_${suffix}`,
  worker: `bounds_worker_${suffix}`,
  outside: `bounds_outside_${suffix}`,
};
function url(role: string) {
  const value = new URL(adminUrl);
  value.username = role;
  value.password = 'isolated';
  value.pathname = `/${dbName}`;
  return value.toString();
}
const owner = new Pool({ connectionString: url(roles.owner) });
const worker = new Pool({ connectionString: url(roles.worker) });
const outside = new Pool({ connectionString: url(roles.outside) });
const bootstrap = new Pool({ connectionString: url(new URL(adminUrl).username) });
const namespaces = ['activity_track', 'course_thumbnail'] as const;
const functionNames = namespaces.flatMap((name) => [
  `${name}_reconcile_candidates`,
  `${name}_reconcile_window_in_tenant`,
]);
const catalog = () =>
  owner.query(
    `SELECT proname,proowner::regrole::text AS owner,proacl::text AS acl FROM pg_proc WHERE proname=ANY($1) ORDER BY proname`,
    [functionNames],
  );
let oldCatalog: unknown;
let oldChecksums: unknown;
const beforeReads: Record<string, number> = {};
type Scan = { rows: number; removed: number; loops: number; index: string | undefined };
function scans(value: unknown, relation: string): Scan[] {
  const node = z.record(z.string(), z.unknown()).parse(value);
  const children = z.array(z.unknown()).optional().parse(node['Plans']) ?? [];
  const nested = children.flatMap((child) => scans(child, relation));
  if (node['Relation Name'] !== relation) return nested;
  return [
    ...nested,
    {
      rows: z.number().parse(node['Actual Rows']),
      removed: z.number().optional().parse(node['Rows Removed by Filter']) ?? 0,
      loops: z.number().parse(node['Actual Loops']),
      index: z.string().optional().parse(node['Index Name']),
    },
  ];
}
async function measured(
  role: string,
  relation: string,
  statement: string,
  values: unknown[],
  tenant: string,
  repetitions = 1,
) {
  const client = await bootstrap.connect();
  const found: Scan[] = [];
  const listener = (notice: { message?: string | undefined }) => {
    const message = notice.message ?? '';
    const start = message.indexOf('{');
    if (!message.startsWith('duration:') || start < 0) return;
    const decoded: unknown = JSON.parse(message.slice(start));
    const plan = z.object({ Plan: z.unknown() }).parse(decoded);
    found.push(...scans(plan.Plan, relation));
  };
  client.on('notice', listener);
  try {
    await client.query("LOAD 'auto_explain'");
    await client.query(
      'SET auto_explain.log_min_duration=0; SET auto_explain.log_nested_statements=on; SET auto_explain.log_analyze=on; SET auto_explain.log_format=json; SET auto_explain.log_level=notice',
    );
    await client.query(`SET SESSION AUTHORIZATION "${role}"`);
    expect((await client.query('SELECT current_user=session_user AS actual')).rows).toEqual([
      { actual: true },
    ]);
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    const result = await client.query(statement, values);
    const rowCounts = [result.rowCount];
    for (let repeat = 1; repeat < repetitions; repeat++) {
      rowCounts.push((await client.query(statement, values)).rowCount);
    }
    await client.query('ROLLBACK');
    expect(found.length).toBeGreaterThan(0);
    return {
      result,
      rowCounts,
      found,
      reads: found.reduce((sum, scan) => sum + (scan.rows + scan.removed) * scan.loops, 0),
    };
  } finally {
    await client.query('ROLLBACK');
    await client.query('RESET SESSION AUTHORIZATION');
    client.removeListener('notice', listener);
    client.release();
  }
}
async function scoped(client: PoolClient, tenant: string, action: () => Promise<void>) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    await action();
  } finally {
    await client.query('ROLLBACK');
  }
}
beforeAll(async () => {
  for (const role of Object.values(roles))
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${roles.owner}"`);
  await migrate(url(roles.owner), 104);
  await grantResourceObjectCleanupWorker(url(roles.owner), roles.worker);
  oldCatalog = (await catalog()).rows;
  oldChecksums = (
    await owner.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
  ).rows;
  for (const name of namespaces) {
    // Synthetic watched references, no provider or private body data.
    await bootstrap.query(
      `INSERT INTO ${name}_object_ref(storage_ref,athlete_id,recorded_at,sweep_attempts,sweep_error_code,sweep_first_failed_at,sweep_failed_at,sweep_retry_at) SELECT 'private/v1/tenants/synthetic-owner-'||lpad((n/10)::text,3,'0')||'/probe/'||lpad(n::text,5,'0'),'synthetic-owner-'||lpad((n/10)::text,3,'0'),clock_timestamp()-interval '8 days',1,'SYNTHETIC_FAULT',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour' FROM generate_series(0,92) n`,
    );
    await owner.query(`ANALYZE ${name}_object_ref`);
    beforeReads[name] = (
      await measured(
        roles.owner,
        `${name}_object_ref`,
        `SELECT * FROM ${name}_reconcile_window_in_tenant($1,$2)`,
        ['', 1],
        'synthetic-owner-009',
      )
    ).reads;
  }
  await migrate(url(roles.owner), 105);
  await grantResourceObjectCleanupWorker(url(roles.owner), roles.worker);
});
afterAll(async () => {
  await Promise.all([owner.end(), worker.end(), outside.end(), bootstrap.end()]);
  await dropIsolatedDatabase(admin, dbName);
  for (const role of Object.values(roles)) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
it('normal104→105 preserves historical checksums, ownership/ACL and FORCE RLS', async () => {
  expect(
    (
      await owner.query(
        'SELECT version,checksum FROM schema_migrations WHERE version<=104 ORDER BY version',
      )
    ).rows,
  ).toEqual(oldChecksums);
  expect(
    (await owner.query('SELECT checksum FROM schema_migrations WHERE version=105')).rows,
  ).toEqual([
    {
      checksum: createHash('sha256')
        .update(
          await readFile(new URL('../migrations/105_tenant_reconcile_bounds.sql', import.meta.url)),
        )
        .digest('hex'),
    },
  ]);
  expect((await catalog()).rows).toEqual(oldCatalog);
  expect(
    (
      await owner.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)', [
        Object.values(roles),
      ])
    ).rows,
  ).toEqual(Array.from({ length: 3 }, () => ({ rolsuper: false, rolbypassrls: false })));
  expect(
    (
      await owner.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1)',
        [namespaces.map((name) => `${name}_object_ref`)],
      )
    ).rows,
  ).toEqual(Array.from({ length: 2 }, () => ({ relrowsecurity: true, relforcerowsecurity: true })));
});
for (const name of namespaces) {
  it(`${name}: actual nested scans become tenant index N1 across repeated calls and worker N50`, async () => {
    expect(beforeReads[name]).toBeGreaterThan(1);
    for (const fn of ['reconcile_candidates', 'reconcile_window_in_tenant']) {
      const measuredResult = await measured(
        roles.owner,
        `${name}_object_ref`,
        `SELECT * FROM ${name}_${fn}($1,$2)`,
        ['', 1],
        'synthetic-owner-009',
        7,
      );
      expect(measuredResult.rowCounts).toEqual(Array.from({ length: 7 }, () => 1));
      expect(measuredResult.reads).toBe(7);
      expect(measuredResult.found).toHaveLength(7);
      expect(
        measuredResult.found.every(
          (scan) => scan.removed === 0 && scan.index === `${name}_object_ref_tenant_watched`,
        ),
      ).toBe(true);
    }
    for (const n of [1, 2, 10, 50]) {
      const measuredResult = await measured(
        roles.worker,
        `${name}_object_ref`,
        `SELECT * FROM ${name}_reconcile_window($1,$2)`,
        ['', n],
        'caller-sentinel',
      );
      expect(measuredResult.result.rowCount).toBe(n);
      expect(measuredResult.reads).toBe(n);
      expect(measuredResult.result.rows.every((row) => row['deferred'] === true)).toBe(true);
      expect(
        measuredResult.found.every(
          (scan) => scan.removed === 0 && scan.index === `${name}_object_ref_tenant_watched`,
        ),
      ).toBe(true);
    }
  });
  it(`${name}: tenant absence/foreign/cursors/caps and function-local settings remain exact`, async () => {
    const client = await owner.connect();
    try {
      for (const tenant of ['', 'synthetic-foreign'])
        await scoped(client, tenant, async () => {
          for (const fn of ['reconcile_candidates', 'reconcile_window_in_tenant'])
            expect((await client.query(`SELECT * FROM ${name}_${fn}('',1)`)).rowCount).toBe(0);
        });
      await scoped(client, 'synthetic-owner-009', async () => {
        await client.query('SET LOCAL enable_seqscan=on; SET LOCAL enable_bitmapscan=on');
        for (const fn of ['reconcile_candidates', 'reconcile_window_in_tenant']) {
          expect((await client.query(`SELECT * FROM ${name}_${fn}($1,1)`, [null])).rowCount).toBe(
            0,
          );
          for (const n of [null, 0, -1])
            expect((await client.query(`SELECT * FROM ${name}_${fn}('',$1)`, [n])).rowCount).toBe(
              1,
            );
          const rows = await client.query(`SELECT * FROM ${name}_${fn}('',100000)`);
          expect(rows.rowCount).toBe(3);
          expect(
            rows.rows.every((row) =>
              z.string().parse(row['storage_ref']).includes('/synthetic-owner-009/'),
            ),
          ).toBe(true);
          expect(
            (
              await client.query(
                "SELECT current_setting('enable_seqscan') AS seq,current_setting('enable_bitmapscan') AS bitmap,current_setting('app.athlete_id') AS tenant",
              )
            ).rows,
          ).toEqual([{ seq: 'on', bitmap: 'on', tenant: 'synthetic-owner-009' }]);
        }
      });
    } finally {
      client.release();
    }
    const workerClient = await worker.connect();
    try {
      await scoped(workerClient, 'caller-sentinel', async () => {
        await workerClient.query('SET LOCAL enable_seqscan=on; SET LOCAL enable_bitmapscan=off');
        await workerClient.query(`SELECT * FROM ${name}_reconcile_window('',50)`);
        expect(
          (
            await workerClient.query(
              "SELECT current_setting('enable_seqscan') AS seq,current_setting('enable_bitmapscan') AS bitmap,current_setting('app.athlete_id') AS tenant",
            )
          ).rows,
        ).toEqual([{ seq: 'on', bitmap: 'off', tenant: 'caller-sentinel' }]);
      });
    } finally {
      workerClient.release();
    }
  });
  it(`${name}: normal worker helper grants keep legacy/private/PUBLIC/direct-table boundaries`, async () => {
    for (const port of [worker, outside]) {
      for (const fn of ['reconcile_candidates', 'reconcile_window_in_tenant'])
        await expect(port.query(`SELECT * FROM ${name}_${fn}('',1)`)).rejects.toMatchObject({
          code: '42501',
        });
      await expect(port.query(`SELECT * FROM ${name}_object_ref`)).rejects.toMatchObject({
        code: '42501',
      });
    }
    await expect(
      outside.query(`SELECT * FROM ${name}_reconcile_window('',1)`),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await worker.query(`SELECT * FROM ${name}_reconcile_window('',1)`)).rowCount).toBe(1);
  });
}
