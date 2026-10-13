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
import { captureCurrentRuntimeCatalogWitnessV10In } from '../src/current-runtime-catalog-witness-v10.js';
import {
  captureCurrentRuntimeCatalogWitnessV11In,
  parseCurrentRuntimeCatalogWitnessV11,
} from '../src/current-runtime-catalog-witness-v11.js';
import { currentRuntimeCompiledExpectedV11 } from '../src/current-runtime-compiled-expected-v11.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Metadata only. Root executes PostgreSQL; this fixture creates no health/source
// rows and invokes no product RPC. a: fresh profile27, c: committed profile26 upgraded.
// The worker and dispatcher names are fixed (cluster-global): created here with the expected
// deployment attributes only when absent and dropped only if this file created them.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const environments = (['a', 'c'] as const).map((label) => ({
  label,
  database: `current_runtime_catalog_v11_${label}_${suffix}`,
  owner: `current_runtime_catalog_v11_owner_${label}_${suffix}`,
  runtime: `current_runtime_catalog_v11_app_${label}_${suffix}`,
}));
type Environment = (typeof environments)[number];
const first = z
  .strictObject({
    label: z.literal('a'),
    database: z.string(),
    owner: z.string(),
    runtime: z.string(),
  })
  .parse(environments[0]);
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
async function grantProfile27(environment: Environment) {
  await grantCurrentRuntimeV11Profile(url(environment), environment.runtime);
  await grantCurrentRuntimeV11GalleryWorker(url(environment), worker);
  await grantCurrentRuntimeV11AiDispatcher(url(environment), dispatcher);
}
beforeAll(async () => {
  for (const role of environments.flatMap((e) => [e.owner, e.runtime])) {
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
    if (environment.label === 'c') {
      await installCurrentRuntimeV10(url(environment));
      await grantCurrentRuntimeAppBaselineV2(url(environment), environment.runtime, 'core');
      await grantCurrentRuntimeV10Profile(url(environment), environment.runtime);
    }
    expect(await installCurrentRuntimeV11(url(environment))).toMatchObject({
      profileVersion: 11,
      runtimeStep: 27,
      sourceDdlTip: 148,
      supported: false,
    });
    if (environment.label === 'a')
      await grantCurrentRuntimeAppBaselineV2(url(environment), environment.runtime, 'core');
    await grantProfile27(environment);
  }
}, 600000);
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
    // Session locks before BEGIN avoid acquiring the RR snapshot before waiting.
    await tx.query('SELECT pg_advisory_lock_shared(872194,1)');
    let lifecycleLocked = false;
    try {
      await tx.query('SELECT pg_advisory_lock_shared(77210,1)');
      lifecycleLocked = true;
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await tx.query("SET LOCAL statement_timeout='30000ms'");
      await tx.query('SET LOCAL search_path=pg_catalog,pg_temp');
      return await apply(tx);
    } finally {
      await tx.query('ROLLBACK');
      if (lifecycleLocked) await tx.query('SELECT pg_advisory_unlock_shared(77210,1)');
      await tx.query('SELECT pg_advisory_unlock_shared(872194,1)');
    }
  });
}
const capture = (environment: Environment = first) =>
  readonly(environment, environment.owner, (tx) =>
    captureCurrentRuntimeCatalogWitnessV11In(tx, environment.runtime),
  );
async function mutation(sql: string, undo: string, check: () => Promise<void>) {
  await session(first, first.owner, (tx) => tx.query(sql));
  try {
    await check();
  } finally {
    await session(first, first.owner, (tx) => tx.query(undo));
  }
  expect((await capture()).catalogSha256).toBe(currentRuntimeCompiledExpectedV11.catalogSha256);
}
fixtureIt(
  'fresh and upgraded profile27 captures agree with the compiled expected without claiming closure',
  async () => {
    const [fresh, upgraded] = [await capture(environments[0]), await capture(environments[1])];
    for (const witness of [fresh, upgraded]) {
      expect(witness).toMatchObject({
        witnessVersion: 11,
        metadataEncoding: currentRuntimeCompiledExpectedV11.metadataEncoding,
        supported: false,
        processingAuthority: 'none',
        profile: { profileVersion: 11, runtimeStep: 27, sourceDdlTip: 148 },
        rpcRecipe: { recipeVersion: 11, rootCount: 51, workerRootCount: 5 },
        closure: {
          dynamicDependencies: 'not_verified',
          strictCallerWire: 'not_verified',
          effectiveRecipe: 'not_verified',
        },
        observation: { expectedRootCount: 51, expectedWorkerRootCount: 5 },
        unmappedRoleTags: [],
      });
      expect(witness.catalogSha256).toBe(currentRuntimeCompiledExpectedV11.catalogSha256);
      expect(witness.observation.sqlJsonbSha256).toBe(
        currentRuntimeCompiledExpectedV11.sqlJsonbSha256,
      );
      expect(witness.sections).toEqual(currentRuntimeCompiledExpectedV11.sections);
      expect(parseCurrentRuntimeCatalogWitnessV11(witness)).toEqual(witness);
    }
    expect(upgraded.metadata).toEqual(fresh.metadata);
    expect(fresh.metadata.roles.map((r) => r.tag)).toEqual(
      expect.arrayContaining(['ai_dispatcher', 'gallery_rendition_worker', 'owner', 'runtime']),
    );
    const claim = fresh.metadata.functions.filter((f) => f.name === 'claim_gallery_rendition_v1');
    expect(claim).toEqual([
      expect.objectContaining({
        schema: 'public',
        runtimeExecute: false,
        acl: expect.arrayContaining([
          expect.objectContaining({ grantee: 'gallery_rendition_worker', privilege: 'EXECUTE' }),
        ]),
      }),
    ]);
  },
  120000,
);
fixtureIt('profile26 witness refuses a profile27 database', async () => {
  for (const environment of environments)
    await expect(
      readonly(environment, environment.owner, (tx) =>
        captureCurrentRuntimeCatalogWitnessV10In(tx, environment.runtime),
      ),
    ).rejects.toThrow();
});
fixtureIt(
  'rejects nonowner/runtime capture, a fixed principal as runtime, and READ COMMITTED',
  async () => {
    await expect(
      readonly(first, first.runtime, (tx) =>
        captureCurrentRuntimeCatalogWitnessV11In(tx, first.runtime),
      ),
    ).rejects.toThrow('CATALOG_WITNESS_CONTEXT_REQUIRED');
    for (const role of [worker, dispatcher])
      await expect(
        readonly(first, first.owner, (tx) => captureCurrentRuntimeCatalogWitnessV11In(tx, role)),
      ).rejects.toThrow('CATALOG_WITNESS_CONTEXT_REQUIRED');
    await session(first, first.owner, async (tx) => {
      await tx.query('SELECT pg_advisory_lock_shared(872194,1)');
      await tx.query('SELECT pg_advisory_lock_shared(77210,1)');
      try {
        await tx.query('BEGIN READ ONLY');
        await tx.query('SET LOCAL search_path=pg_catalog,pg_temp');
        await expect(captureCurrentRuntimeCatalogWitnessV11In(tx, first.runtime)).rejects.toThrow(
          'CATALOG_WITNESS_CONTEXT_REQUIRED',
        );
      } finally {
        await tx.query('ROLLBACK');
        await tx.query('SELECT pg_advisory_unlock_shared(77210,1)');
        await tx.query('SELECT pg_advisory_unlock_shared(872194,1)');
      }
    });
  },
  120000,
);
fixtureIt(
  'principal ACL drift refuses capture before catalog transfer',
  async () => {
    const claim = 'public.claim_gallery_rendition_v1(uuid,integer)';
    for (const [sql, undo] of [
      // worker RPC leaked to the runtime
      [
        `GRANT EXECUTE ON FUNCTION ${claim} TO "${first.runtime}"`,
        `REVOKE EXECUTE ON FUNCTION ${claim} FROM "${first.runtime}"`,
      ],
      // worker loses its RPC
      [
        `REVOKE EXECUTE ON FUNCTION ${claim} FROM "${worker}"`,
        `GRANT EXECUTE ON FUNCTION ${claim} TO "${worker}"`,
      ],
      // dispatcher table privilege beyond its allowance
      [
        `GRANT SELECT ON public.ai_execution_job TO "${dispatcher}"`,
        `REVOKE SELECT ON public.ai_execution_job FROM "${dispatcher}"`,
      ],
      // runtime reaches the dispatcher's disposition table
      [
        `GRANT SELECT ON public.ai_execution_job_disposition TO "${first.runtime}"`,
        `REVOKE SELECT ON public.ai_execution_job_disposition FROM "${first.runtime}"`,
      ],
      // missing direct gallery root grant
      [
        `REVOKE EXECUTE ON FUNCTION public.read_gallery_renditions_v1(uuid) FROM "${first.runtime}"`,
        `GRANT EXECUTE ON FUNCTION public.read_gallery_renditions_v1(uuid) TO "${first.runtime}"`,
      ],
    ] as const)
      await mutation(sql, undo, async () => {
        await expect(capture()).rejects.toThrow(
          /CATALOG_WITNESS_INVALID|CATALOG_WITNESS_CONTEXT_REQUIRED|CURRENT_RUNTIME_V11_/,
        );
      });
  },
  240000,
);
fixtureIt(
  'missing direct parent root grant refuses capture',
  async () => {
    const signature = 'public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)';
    await mutation(
      `REVOKE EXECUTE ON FUNCTION ${signature} FROM "${first.runtime}"`,
      `GRANT EXECUTE ON FUNCTION ${signature} TO "${first.runtime}"`,
      async () => {
        await expect(capture()).rejects.toThrow('CATALOG_WITNESS_INVALID');
      },
    );
  },
  120000,
);
