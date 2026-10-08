import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as baseline from '../src/migrate.js';
import { installCurrentRuntimeV9 } from '../src/current-runtime-installation-v9.js';
import { grantCurrentRuntimeV9Profile } from '../src/current-runtime-grants-v9.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import { captureCurrentRuntimeCatalogWitnessV9In } from '../src/current-runtime-catalog-witness-v9.js';
import { observeCurrentRuntimeColdCatalogV9In } from '../src/current-runtime-cold-catalog-v9.js';
import { currentRuntimeCompiledExpectedV9 } from '../src/current-runtime-compiled-expected-v9.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Metadata only. Root executes PostgreSQL; this fixture creates no health/source
// rows and invokes no product RPC. Observed equality is not dependency closure.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const environments = ['a', 'b'].map((label) => ({
  database: `cold_catalog_v9_${label}_${suffix}`,
  owner: `cold_catalog_v9_owner_${label}_${suffix}`,
  runtime: `cold_catalog_v9_app_${label}_${suffix}`,
}));
const first = z
  .strictObject({ database: z.string(), owner: z.string(), runtime: z.string() })
  .parse(environments[0]);
const unknownRole = `cold_catalog_v9_other_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [],
  databases: string[] = [];
type Environment = (typeof environments)[number];
function url(environment: Environment, role = environment.owner) {
  const value = new URL(adminUrl);
  value.pathname = `/${environment.database}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
async function session<T>(
  environment: Environment,
  role: string,
  apply: (tx: PoolClient) => Promise<T>,
) {
  const pool = new Pool({ connectionString: url(environment, role), max: 1 });
  const tx = await pool.connect();
  try {
    return await apply(tx);
  } finally {
    tx.release();
    await pool.end();
  }
}
// A Vitest timeout does not cancel an asynchronous callback. Serialize entire
// callbacks (including mutation undo), and drain them before destructive cleanup.
// Statement deadlines remain 30s and test deadlines remain unchanged.
let pendingFixtureWork: Promise<void> = Promise.resolve();
function fixtureIt(name: string, apply: () => Promise<void>, timeout?: number) {
  it(
    name,
    async () => {
      const work = pendingFixtureWork.then(apply);
      pendingFixtureWork = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    timeout,
  );
}
beforeAll(async () => {
  // Complete both environments first: actual clusterRoleCount cannot change
  // merely because the second fixture role was provisioned between captures.
  for (const role of [...environments.flatMap((e) => [e.owner, e.runtime]), unknownRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  for (const environment of environments) {
    await admin.query(`CREATE DATABASE "${environment.database}" OWNER "${environment.owner}"`);
    databases.push(environment.database);
  }
  for (const environment of environments) {
    await baseline.migrate(url(environment), 107);
    const installed = await installCurrentRuntimeV9(url(environment));
    expect(installed).toMatchObject({
      profileVersion: 9,
      runtimeStep: 25,
      sourceDdlTip: 142,
      supported: false,
    });
    await grantCurrentRuntimeAppBaselineV2(url(environment), environment.runtime, 'core');
    await grantCurrentRuntimeV9Profile(url(environment), environment.runtime);
  }
}, 180000);
afterAll(async () => {
  await pendingFixtureWork;
  for (const database of databases.reverse()) await dropIsolatedDatabase(admin, database);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

async function readonly<T>(
  environment: Environment,
  role: string,
  apply: (tx: PoolClient) => Promise<T>,
) {
  return session(environment, role, async (tx) => {
    await tx.query('SELECT pg_advisory_lock_shared(872194,1)');
    let locked = false;
    try {
      await tx.query('SELECT pg_advisory_lock_shared(77210,1)');
      locked = true;
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await tx.query('SET LOCAL search_path=pg_catalog,pg_temp');
      return await apply(tx);
    } finally {
      await tx.query('ROLLBACK');
      if (locked) await tx.query('SELECT pg_advisory_unlock_shared(77210,1)');
      await tx.query('SELECT pg_advisory_unlock_shared(872194,1)');
    }
  });
}
const observe = (environment = first) =>
  readonly(environment, environment.runtime, observeCurrentRuntimeColdCatalogV9In);
async function mutate(sql: string, undo: string) {
  await session(first, first.owner, (tx) => tx.query(sql));
  try {
    expect(await observe()).toMatchObject({ catalog: 'incompatible' });
  } finally {
    await session(first, first.owner, (tx) => tx.query(undo));
  }
  expect(await observe()).toMatchObject({ catalog: 'verified' });
}
fixtureIt(
  'actual twoDB runtime whole catalogs match independently pinned owner expected',
  async () => {
    for (const e of environments) {
      const owner = await readonly(e, e.owner, (tx) =>
        captureCurrentRuntimeCatalogWitnessV9In(tx, e.runtime),
      );
      expect(owner.catalogSha256).toBe(currentRuntimeCompiledExpectedV9.catalogSha256);
      expect(owner.sections).toEqual(currentRuntimeCompiledExpectedV9.sections);
      expect(await observe(e)).toMatchObject({
        catalog: 'verified',
        catalogSha256: owner.catalogSha256,
        supported: false,
        processingAuthority: 'none',
        installationReceiptRows: 'not_observed_by_runtime',
      });
    }
  },
  90000,
);
fixtureIt(
  'runtime cannot read installation receipts or call private pooled helpers',
  async () => {
    await session(first, first.runtime, async (tx) => {
      await expect(
        tx.query('SELECT * FROM wm_runtime_installation.profile_extension_v9'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(tx.query('SELECT wm_manual_pooled.assert_owner()')).rejects.toMatchObject({
        code: '42501',
      });
    });
    expect(await observe()).toMatchObject({ catalog: 'verified' });
  },
  60000,
);
fixtureIt('owner session is not accepted as normal runtime', async () => {
  expect(await readonly(first, first.owner, observeCurrentRuntimeColdCatalogV9In)).toMatchObject({
    catalog: 'incompatible',
    reason: 'context_required',
  });
});
fixtureIt('read committed and missing fences are rejected before metadata', async () => {
  await session(first, first.runtime, async (tx) => {
    await tx.query('BEGIN READ ONLY');
    await tx.query('SET LOCAL search_path=pg_catalog,pg_temp');
    try {
      expect(await observeCurrentRuntimeColdCatalogV9In(tx)).toMatchObject({
        reason: 'context_required',
      });
    } finally {
      await tx.query('ROLLBACK');
    }
  });
});
fixtureIt(
  'driver scalar underreport is closed without changing SQL budget',
  async () => {
    await readonly(first, first.runtime, async (tx) => {
      const query = async (sql: string, values?: unknown[]) => {
        const actual = await tx.query(sql, values);
        return {
          rows: actual.rows.map((row) =>
            sql.includes('measured AS MATERIALIZED') ? { ...row, bytes: '1' } : row,
          ),
          rowCount: actual.rowCount,
        };
      };
      expect(await observeCurrentRuntimeColdCatalogV9In({ query })).toMatchObject({
        catalog: 'incompatible',
        reason: 'invalid_response',
      });
    });
  },
  60000,
);
fixtureIt(
  'body metadata drift rejected and exact original body restored',
  async () => {
    const saved = await session(first, first.owner, async (tx) =>
      z
        .strictObject({ definition: z.string(), body: z.string() })
        .parse(
          (
            await tx.query(
              "SELECT pg_get_functiondef(p.oid) definition,p.prosrc body FROM pg_proc p WHERE p.oid='public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)'::regprocedure",
            )
          ).rows[0],
        ),
    );
    await mutate(
      saved.definition.replace(
        saved.body,
        () => saved.body + '\n-- synthetic metadata-only body drift',
      ),
      saved.definition,
    );
  },
  60000,
);
fixtureIt(
  'RLS drift rejected',
  async () => {
    await mutate(
      'ALTER TABLE public.manual_race_evidence_v2 NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE public.manual_race_evidence_v2 FORCE ROW LEVEL SECURITY',
    );
  },
  60000,
);
fixtureIt(
  'trigger drift rejected',
  async () => {
    const t = await session(first, first.owner, async (tx) =>
      z
        .strictObject({ name: z.string() })
        .parse(
          (
            await tx.query(
              "SELECT tgname name FROM pg_trigger WHERE tgrelid='public.manual_race_evidence_v2'::regclass AND NOT tgisinternal AND tgenabled='O' ORDER BY tgname LIMIT 1",
            )
          ).rows[0],
        ),
    );
    const name = '"' + t.name.replaceAll('"', '""') + '"';
    await mutate(
      'ALTER TABLE public.manual_race_evidence_v2 DISABLE TRIGGER ' + name,
      'ALTER TABLE public.manual_race_evidence_v2 ENABLE TRIGGER ' + name,
    );
  },
  60000,
);
fixtureIt(
  'function ACL and private ledger ACL drift rejected',
  async () => {
    await mutate(
      `GRANT EXECUTE ON FUNCTION public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb) TO PUBLIC`,
      `REVOKE EXECUTE ON FUNCTION public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb) FROM PUBLIC`,
    );
    await mutate(
      `GRANT SELECT ON wm_runtime_installation.profile_extension_v9 TO "${first.runtime}"`,
      `REVOKE SELECT ON wm_runtime_installation.profile_extension_v9 FROM "${first.runtime}"`,
    );
  },
  90000,
);
fixtureIt(
  'connected membership rejected while unrelated role is normalization noise',
  async () => {
    expect(await observe()).toMatchObject({ catalog: 'verified' });
    await admin.query(`GRANT "${unknownRole}" TO "${first.runtime}"`);
    try {
      expect(await observe()).toMatchObject({ catalog: 'incompatible' });
    } finally {
      await admin.query(`REVOKE "${unknownRole}" FROM "${first.runtime}"`);
    }
    expect(await observe()).toMatchObject({ catalog: 'verified' });
  },
  60000,
);
fixtureIt(
  'seal constraint drift is not ignored',
  async () => {
    const constraint = await session(first, first.owner, async (tx) =>
      z
        .strictObject({ name: z.string(), definition: z.string() })
        .parse(
          (
            await tx.query(
              "SELECT conname name,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='wm_runtime_installation.profile_extension_v9'::regclass AND contype='c' ORDER BY conname LIMIT 1",
            )
          ).rows[0],
        ),
    );
    const name = '"' + constraint.name.replaceAll('"', '""') + '"';
    await mutate(
      'ALTER TABLE wm_runtime_installation.profile_extension_v9 DROP CONSTRAINT ' + name,
      'ALTER TABLE wm_runtime_installation.profile_extension_v9 ADD CONSTRAINT ' +
        name +
        ' ' +
        constraint.definition,
    );
  },
  60000,
);
