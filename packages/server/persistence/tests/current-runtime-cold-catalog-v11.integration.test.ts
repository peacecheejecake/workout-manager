import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as baseline from '../src/migrate.js';
import { installCurrentRuntimeV10 } from '../src/current-runtime-installation-v10.js';
import { grantCurrentRuntimeV10Profile } from '../src/current-runtime-grants-v10.js';
import { installCurrentRuntimeV11 } from '../src/current-runtime-installation-v11.js';
import {
  grantCurrentRuntimeV11Profile,
  grantCurrentRuntimeV11GalleryWorker,
  grantCurrentRuntimeV11AiDispatcher,
  currentRuntimeV11GalleryWorkerRole,
  currentRuntimeV11AiDispatcherRole,
} from '../src/current-runtime-grants-v11.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import { captureCurrentRuntimeCatalogWitnessV11In } from '../src/current-runtime-catalog-witness-v11.js';
import { observeCurrentRuntimeColdCatalogV10In } from '../src/current-runtime-cold-catalog-v10.js';
import { observeCurrentRuntimeColdCatalogV11In } from '../src/current-runtime-cold-catalog-v11.js';
import { currentRuntimeCompiledExpectedV11 } from '../src/current-runtime-compiled-expected-v11.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import { createDatabase, type CatalogTransaction } from '../src/database.js';

// Metadata only. Root executes PostgreSQL; this fixture creates no health/source
// rows and invokes no product RPC. Observed equality is not dependency closure.
// a,b: fresh profile27. c: committed profile26 upgraded to profile27. p: profile26 only.
// The worker and dispatcher names are fixed (cluster-global): created here with the expected
// deployment attributes only when absent and dropped only if this file created them.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const environments = (['a', 'b', 'c', 'p'] as const).map((label) => ({
  label,
  database: `cold_catalog_v11_${label}_${suffix}`,
  owner: `cold_catalog_v11_owner_${label}_${suffix}`,
  runtime: `cold_catalog_v11_app_${label}_${suffix}`,
}));
type Environment = (typeof environments)[number];
function environment(label: Environment['label']): Environment {
  const found = environments.find((e) => e.label === label);
  if (!found) throw Error('FIXTURE');
  return found;
}
const first = environment('a');
const profile26 = environment('p');
const profile27 = environments.filter((e) => e.label !== 'p');
const unknownRole = `cold_catalog_v11_other_${suffix}`;
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
const worker = currentRuntimeV11GalleryWorkerRole,
  dispatcher = currentRuntimeV11AiDispatcherRole;
const createdFixed: string[] = [];
async function installProfile26(environment: Environment) {
  expect(await installCurrentRuntimeV10(url(environment))).toMatchObject({
    profileVersion: 10,
    runtimeStep: 26,
    sourceDdlTip: 146,
  });
  await grantCurrentRuntimeAppBaselineV2(url(environment), environment.runtime, 'core');
  await grantCurrentRuntimeV10Profile(url(environment), environment.runtime);
}
beforeAll(async () => {
  // Every fixture role precedes every observation; unrelated roles are noise anyway.
  for (const role of [...environments.flatMap((e) => [e.owner, e.runtime]), unknownRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  for (const role of [worker, dispatcher]) {
    if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) continue;
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdFixed.push(role);
  }
  for (const environment of environments) {
    await admin.query(`CREATE DATABASE "${environment.database}" OWNER "${environment.owner}"`);
    databases.push(environment.database);
  }
  for (const environment of environments) {
    await baseline.migrate(url(environment), 107);
    if (environment.label === 'p') {
      await installProfile26(environment);
      continue;
    }
    if (environment.label === 'c') await installProfile26(environment);
    expect(await installCurrentRuntimeV11(url(environment))).toMatchObject({
      profileVersion: 11,
      parentProfileVersion: 10,
      runtimeStep: 27,
      sourceDdlTip: 148,
      supported: false,
    });
    if (environment.label !== 'c')
      await grantCurrentRuntimeAppBaselineV2(url(environment), environment.runtime, 'core');
    await grantCurrentRuntimeV11Profile(url(environment), environment.runtime);
    await grantCurrentRuntimeV11GalleryWorker(url(environment), worker);
    await grantCurrentRuntimeV11AiDispatcher(url(environment), dispatcher);
  }
}, 900000);
afterAll(async () => {
  await pendingFixtureWork;
  for (const database of databases.reverse()) await dropIsolatedDatabase(admin, database);
  for (const role of [...roles.reverse(), ...createdFixed])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
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
  readonly(environment, environment.runtime, observeCurrentRuntimeColdCatalogV11In);
const ownerCapture = (environment = first) =>
  readonly(environment, environment.owner, (tx) =>
    captureCurrentRuntimeCatalogWitnessV11In(tx, environment.runtime),
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
  'fresh and upgraded profile27 owner catalogs and runtime observations match the compiled expected',
  async () => {
    for (const e of profile27) {
      const owner = await ownerCapture(e);
      expect(owner.catalogSha256).toBe(currentRuntimeCompiledExpectedV11.catalogSha256);
      expect(owner.observation.sqlJsonbSha256).toBe(
        currentRuntimeCompiledExpectedV11.sqlJsonbSha256,
      );
      expect(owner.sections).toEqual(currentRuntimeCompiledExpectedV11.sections);
      expect(await observe(e)).toMatchObject({
        catalog: 'verified',
        reason: 'matched',
        profileVersion: 11,
        runtimeStep: 27,
        sourceDdlTip: 148,
        catalogSha256: owner.catalogSha256,
        supported: false,
        processingAuthority: 'none',
        installationReceiptRows: 'not_observed_by_runtime',
      });
    }
  },
  180000,
);
fixtureIt(
  'profile26 is incompatible with the profile27 expected, and profile27 with the profile26 expected',
  async () => {
    expect(
      await readonly(profile26, profile26.runtime, observeCurrentRuntimeColdCatalogV10In),
    ).toMatchObject({ catalog: 'verified', profileVersion: 10 });
    expect(await observe(profile26)).toMatchObject({
      catalog: 'incompatible',
      reason: 'catalog_mismatch',
      profileVersion: 11,
      catalogSha256: null,
    });
    for (const e of profile27)
      expect(await readonly(e, e.runtime, observeCurrentRuntimeColdCatalogV10In)).toMatchObject({
        catalog: 'incompatible',
        profileVersion: 10,
      });
  },
  180000,
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
        return observeCurrentRuntimeColdCatalogV11In(tx);
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
  'runtime cannot read the v11 ledger, write the dispositions or execute worker/owner-only functions',
  async () => {
    await session(first, first.runtime, async (tx) => {
      await expect(
        tx.query('SELECT * FROM wm_runtime_installation.profile_extension_v11'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        tx.query('INSERT INTO public.ai_execution_job_disposition DEFAULT VALUES'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        tx.query('SELECT public.claim_gallery_rendition_v1(gen_random_uuid(),1)'),
      ).rejects.toMatchObject({ code: '42501' });
    });
    expect(await observe()).toMatchObject({ catalog: 'verified' });
  },
  60000,
);
fixtureIt('owner session, fixed principal sessions and read committed are rejected', async () => {
  expect(await readonly(first, first.owner, observeCurrentRuntimeColdCatalogV11In)).toMatchObject({
    catalog: 'incompatible',
    reason: 'context_required',
  });
  // Fixed principals have the fixture password only when this file created them.
  for (const role of [worker, dispatcher].filter((r) => createdFixed.includes(r)))
    expect(await readonly(first, role, observeCurrentRuntimeColdCatalogV11In)).toMatchObject({
      catalog: 'incompatible',
      reason: 'context_required',
    });
  await session(first, first.runtime, async (tx) => {
    await tx.query('BEGIN READ ONLY');
    await tx.query('SET LOCAL search_path=pg_catalog,pg_temp');
    try {
      expect(await observeCurrentRuntimeColdCatalogV11In(tx)).toMatchObject({
        reason: 'context_required',
      });
    } finally {
      await tx.query('ROLLBACK');
    }
  });
});
fixtureIt(
  'v11 ledger ACL and principal ACL drift rejected',
  async () => {
    await mutate(
      `GRANT SELECT ON wm_runtime_installation.profile_extension_v11 TO "${first.runtime}"`,
      `REVOKE SELECT ON wm_runtime_installation.profile_extension_v11 FROM "${first.runtime}"`,
      // privateDenied closes before any catalog body is read.
      'context_required',
    );
    const claim = 'public.claim_gallery_rendition_v1(uuid,integer)';
    await mutate(
      `REVOKE EXECUTE ON FUNCTION ${claim} FROM "${worker}"`,
      `GRANT EXECUTE ON FUNCTION ${claim} TO "${worker}"`,
    );
    await mutate(
      `REVOKE INSERT ON public.ai_execution_job_disposition FROM "${dispatcher}"`,
      `GRANT INSERT ON public.ai_execution_job_disposition TO "${dispatcher}"`,
    );
    await mutate(
      `GRANT SELECT ON public.gallery_rendition_job TO "${worker}"`,
      `REVOKE SELECT ON public.gallery_rendition_job FROM "${worker}"`,
    );
  },
  180000,
);
fixtureIt(
  'v11 seal constraint drift is not ignored',
  async () => {
    const constraint = await session(first, first.owner, async (tx) =>
      z
        .strictObject({ name: z.string(), definition: z.string() })
        .parse(
          (
            await tx.query(
              "SELECT conname name,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='wm_runtime_installation.profile_extension_v11'::regclass AND contype='c' ORDER BY conname LIMIT 1",
            )
          ).rows[0],
        ),
    );
    const name = '"' + constraint.name.replaceAll('"', '""') + '"';
    await mutate(
      'ALTER TABLE wm_runtime_installation.profile_extension_v11 DROP CONSTRAINT ' + name,
      'ALTER TABLE wm_runtime_installation.profile_extension_v11 ADD CONSTRAINT ' +
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
    for (const member of [first.runtime, worker]) {
      await admin.query(`GRANT "${unknownRole}" TO "${member}"`);
      try {
        expect(await observe()).toMatchObject({ catalog: 'incompatible' });
      } finally {
        await admin.query(`REVOKE "${unknownRole}" FROM "${member}"`);
      }
    }
    expect(await observe()).toMatchObject({ catalog: 'verified' });
  },
  90000,
);
