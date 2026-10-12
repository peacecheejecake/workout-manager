import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as baseline from '../src/migrate.js';
import { installCurrentRuntimeV9 } from '../src/current-runtime-installation-v9.js';
import { grantCurrentRuntimeV9Profile } from '../src/current-runtime-grants-v9.js';
import { installCurrentRuntimeV10 } from '../src/current-runtime-installation-v10.js';
import { grantCurrentRuntimeV10Profile } from '../src/current-runtime-grants-v10.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import { captureCurrentRuntimeCatalogWitnessV10In } from '../src/current-runtime-catalog-witness-v10.js';
import { observeCurrentRuntimeColdCatalogV9In } from '../src/current-runtime-cold-catalog-v9.js';
import { observeCurrentRuntimeColdCatalogV10In } from '../src/current-runtime-cold-catalog-v10.js';
import { currentRuntimeCompiledExpectedV10 } from '../src/current-runtime-compiled-expected-v10.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import { createDatabase, type CatalogTransaction } from '../src/database.js';

// Metadata only. Root executes PostgreSQL; this fixture creates no health/source
// rows and invokes no product RPC. Observed equality is not dependency closure.
// a,b: fresh profile26. c: committed profile25 upgraded to profile26. p: profile25 only.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const environments = (['a', 'b', 'c', 'p'] as const).map((label) => ({
  label,
  database: `cold_catalog_v10_${label}_${suffix}`,
  owner: `cold_catalog_v10_owner_${label}_${suffix}`,
  runtime: `cold_catalog_v10_app_${label}_${suffix}`,
}));
type Environment = (typeof environments)[number];
function environment(label: Environment['label']): Environment {
  const found = environments.find((e) => e.label === label);
  if (!found) throw Error('FIXTURE');
  return found;
}
const first = environment('a');
const profile25 = environment('p');
const profile26 = environments.filter((e) => e.label !== 'p');
const unknownRole = `cold_catalog_v10_other_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [],
  databases: string[] = [];
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
async function installProfile25(environment: Environment) {
  expect(await installCurrentRuntimeV9(url(environment))).toMatchObject({
    profileVersion: 9,
    runtimeStep: 25,
    sourceDdlTip: 142,
  });
  await grantCurrentRuntimeAppBaselineV2(url(environment), environment.runtime, 'core');
  await grantCurrentRuntimeV9Profile(url(environment), environment.runtime);
}
beforeAll(async () => {
  // Every fixture role precedes every observation; unrelated roles are noise anyway.
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
    if (environment.label === 'p') {
      await installProfile25(environment);
      continue;
    }
    if (environment.label === 'c') await installProfile25(environment);
    expect(await installCurrentRuntimeV10(url(environment))).toMatchObject({
      profileVersion: 10,
      parentProfileVersion: 9,
      runtimeStep: 26,
      sourceDdlTip: 146,
      supported: false,
    });
    if (environment.label !== 'c')
      await grantCurrentRuntimeAppBaselineV2(url(environment), environment.runtime, 'core');
    await grantCurrentRuntimeV10Profile(url(environment), environment.runtime);
  }
}, 300000);
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
  readonly(environment, environment.runtime, observeCurrentRuntimeColdCatalogV10In);
const ownerCapture = (environment = first) =>
  readonly(environment, environment.owner, (tx) =>
    captureCurrentRuntimeCatalogWitnessV10In(tx, environment.runtime),
  );
async function mutate(
  sql: string,
  undo: string,
  reason: 'catalog_mismatch' | 'context_required' = 'catalog_mismatch',
) {
  await session(first, first.owner, (tx) => tx.query(sql));
  try {
    expect(await observe()).toMatchObject({ catalog: 'incompatible', reason });
  } finally {
    await session(first, first.owner, (tx) => tx.query(undo));
  }
  expect(await observe()).toMatchObject({ catalog: 'verified' });
}
fixtureIt(
  'fresh and upgraded profile26 owner catalogs and runtime observations match the compiled expected',
  async () => {
    for (const e of profile26) {
      const owner = await ownerCapture(e);
      expect(owner.catalogSha256).toBe(currentRuntimeCompiledExpectedV10.catalogSha256);
      expect(owner.observation.sqlJsonbSha256).toBe(
        currentRuntimeCompiledExpectedV10.sqlJsonbSha256,
      );
      expect(owner.sections).toEqual(currentRuntimeCompiledExpectedV10.sections);
      expect(await observe(e)).toMatchObject({
        catalog: 'verified',
        reason: 'matched',
        profileVersion: 10,
        runtimeStep: 26,
        sourceDdlTip: 146,
        catalogSha256: owner.catalogSha256,
        supported: false,
        processingAuthority: 'none',
        installationReceiptRows: 'not_observed_by_runtime',
      });
    }
  },
  120000,
);
fixtureIt(
  'profile25 is incompatible with the profile26 expected, and profile26 with the profile25 expected',
  async () => {
    expect(
      await readonly(profile25, profile25.runtime, observeCurrentRuntimeColdCatalogV9In),
    ).toMatchObject({ catalog: 'verified', profileVersion: 9 });
    expect(await observe(profile25)).toMatchObject({
      catalog: 'incompatible',
      reason: 'catalog_mismatch',
      profileVersion: 10,
      catalogSha256: null,
    });
    for (const e of profile26)
      expect(await readonly(e, e.runtime, observeCurrentRuntimeColdCatalogV9In)).toMatchObject({
        catalog: 'incompatible',
        reason: 'catalog_mismatch',
        profileVersion: 9,
      });
  },
  120000,
);
fixtureIt(
  'disabled local-date trigger is a catalog mismatch and the owner witness refuses it',
  async () => {
    await session(first, first.owner, (tx) =>
      tx.query('ALTER TABLE public.race_event DISABLE TRIGGER race_local_date_approval_guard'),
    );
    try {
      expect(await observe()).toMatchObject({
        catalog: 'incompatible',
        reason: 'catalog_mismatch',
      });
      await expect(ownerCapture()).rejects.toThrow('CURRENT_RUNTIME_V10_FUNCTION_DRIFT');
    } finally {
      await session(first, first.owner, (tx) =>
        tx.query('ALTER TABLE public.race_event ENABLE TRIGGER race_local_date_approval_guard'),
      );
    }
    expect(await observe()).toMatchObject({ catalog: 'verified' });
  },
  90000,
);
fixtureIt(
  'database catalog wrapper establishes actual read-only context and closes the handle',
  async () => {
    const db = createDatabase({ connectionString: url(first, first.runtime), max: 1 });
    try {
      if (!db.snapshotCatalog) throw Error('CATALOG_CAPABILITY_REQUIRED');
      let saved: CatalogTransaction | undefined;
      let pid = 0;
      const result = await db.snapshotCatalog(async (tx) => {
        saved = tx;
        const context = await tx.query(
          "SELECT pg_backend_pid() pid,current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') readonly",
        );
        expect(context.rows[0]).toMatchObject({ isolation: 'repeatable read', readonly: 'on' });
        pid = z.number().int().positive().parse(context.rows[0]?.['pid']);
        return observeCurrentRuntimeColdCatalogV10In(tx);
      });
      expect(result).toMatchObject({ catalog: 'verified', supported: false });
      if (!saved) throw Error('CATALOG_HANDLE_NOT_CAPTURED');
      await expect(saved.query('SELECT 1')).rejects.toThrow('TRANSACTION_CLOSED');
      expect(
        (await admin.query('SELECT count(*)::int n FROM pg_locks WHERE pid=$1', [pid])).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await db.close();
    }
  },
  60000,
);
fixtureIt(
  'runtime cannot read the v10 receipt ledger or execute the owner-only guard',
  async () => {
    await session(first, first.runtime, async (tx) => {
      await expect(
        tx.query('SELECT * FROM wm_runtime_installation.profile_extension_v10'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        tx.query('SELECT public.guard_race_event_local_date_approval_v1()'),
      ).rejects.toMatchObject({ code: '42501' });
    });
    expect(await observe()).toMatchObject({ catalog: 'verified' });
  },
  60000,
);
fixtureIt('owner session and read committed are rejected before metadata', async () => {
  expect(await readonly(first, first.owner, observeCurrentRuntimeColdCatalogV10In)).toMatchObject({
    catalog: 'incompatible',
    reason: 'context_required',
  });
  await session(first, first.runtime, async (tx) => {
    await tx.query('BEGIN READ ONLY');
    await tx.query('SET LOCAL search_path=pg_catalog,pg_temp');
    try {
      expect(await observeCurrentRuntimeColdCatalogV10In(tx)).toMatchObject({
        reason: 'context_required',
      });
    } finally {
      await tx.query('ROLLBACK');
    }
  });
});
fixtureIt(
  'guard body drift rejected and exact original body restored',
  async () => {
    const saved = await session(first, first.owner, async (tx) =>
      z
        .strictObject({ definition: z.string(), body: z.string() })
        .parse(
          (
            await tx.query(
              "SELECT pg_get_functiondef(p.oid) definition,p.prosrc body FROM pg_proc p WHERE p.oid='public.guard_race_event_local_date_approval_v1()'::regprocedure",
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
  'v10 ledger ACL and guard ACL drift rejected',
  async () => {
    await mutate(
      `GRANT SELECT ON wm_runtime_installation.profile_extension_v10 TO "${first.runtime}"`,
      `REVOKE SELECT ON wm_runtime_installation.profile_extension_v10 FROM "${first.runtime}"`,
      // privateDenied closes before any catalog body is read.
      'context_required',
    );
    await mutate(
      `GRANT EXECUTE ON FUNCTION public.guard_race_event_local_date_approval_v1() TO "${first.runtime}"`,
      `REVOKE EXECUTE ON FUNCTION public.guard_race_event_local_date_approval_v1() FROM "${first.runtime}"`,
    );
  },
  90000,
);
fixtureIt(
  'v10 seal constraint drift is not ignored',
  async () => {
    const constraint = await session(first, first.owner, async (tx) =>
      z
        .strictObject({ name: z.string(), definition: z.string() })
        .parse(
          (
            await tx.query(
              "SELECT conname name,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='wm_runtime_installation.profile_extension_v10'::regclass AND contype='c' ORDER BY conname LIMIT 1",
            )
          ).rows[0],
        ),
    );
    const name = '"' + constraint.name.replaceAll('"', '""') + '"';
    await mutate(
      'ALTER TABLE wm_runtime_installation.profile_extension_v10 DROP CONSTRAINT ' + name,
      'ALTER TABLE wm_runtime_installation.profile_extension_v10 ADD CONSTRAINT ' +
        name +
        ' ' +
        constraint.definition,
    );
  },
  60000,
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
