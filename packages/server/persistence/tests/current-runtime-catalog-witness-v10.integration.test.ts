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
import { captureCurrentRuntimeCatalogWitnessV9In } from '../src/current-runtime-catalog-witness-v9.js';
import {
  captureCurrentRuntimeCatalogWitnessV10In,
  parseCurrentRuntimeCatalogWitnessV10,
} from '../src/current-runtime-catalog-witness-v10.js';
import { currentRuntimeCompiledExpectedV10 } from '../src/current-runtime-compiled-expected-v10.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Metadata only. Root executes PostgreSQL; this fixture creates no health/source
// rows and invokes no product RPC. a: fresh profile26, c: committed profile25 upgraded.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const environments = (['a', 'c'] as const).map((label) => ({
  label,
  database: `current_runtime_catalog_v10_${label}_${suffix}`,
  owner: `current_runtime_catalog_v10_owner_${label}_${suffix}`,
  runtime: `current_runtime_catalog_v10_app_${label}_${suffix}`,
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
beforeAll(async () => {
  for (const role of environments.flatMap((e) => [e.owner, e.runtime])) {
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
    if (environment.label === 'c') {
      await installCurrentRuntimeV9(url(environment));
      await grantCurrentRuntimeAppBaselineV2(url(environment), environment.runtime, 'core');
      await grantCurrentRuntimeV9Profile(url(environment), environment.runtime);
    }
    expect(await installCurrentRuntimeV10(url(environment))).toMatchObject({
      profileVersion: 10,
      runtimeStep: 26,
      sourceDdlTip: 146,
      supported: false,
    });
    if (environment.label === 'a')
      await grantCurrentRuntimeAppBaselineV2(url(environment), environment.runtime, 'core');
    await grantCurrentRuntimeV10Profile(url(environment), environment.runtime);
  }
}, 240000);
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
    captureCurrentRuntimeCatalogWitnessV10In(tx, environment.runtime),
  );
async function mutation(sql: string, undo: string, check: () => Promise<void>) {
  await session(first, first.owner, (tx) => tx.query(sql));
  try {
    await check();
  } finally {
    await session(first, first.owner, (tx) => tx.query(undo));
  }
  expect((await capture()).catalogSha256).toBe(currentRuntimeCompiledExpectedV10.catalogSha256);
}
fixtureIt(
  'fresh and upgraded profile26 captures agree with the compiled expected without claiming closure',
  async () => {
    const [fresh, upgraded] = [await capture(environments[0]), await capture(environments[1])];
    for (const witness of [fresh, upgraded]) {
      expect(witness).toMatchObject({
        witnessVersion: 10,
        supported: false,
        processingAuthority: 'none',
        profile: { profileVersion: 10, runtimeStep: 26, sourceDdlTip: 146 },
        rpcRecipe: { recipeVersion: 10, rootCount: 42 },
        closure: {
          dynamicDependencies: 'not_verified',
          strictCallerWire: 'not_verified',
          effectiveRecipe: 'not_verified',
        },
        observation: { expectedRootCount: 42 },
      });
      expect(witness.catalogSha256).toBe(currentRuntimeCompiledExpectedV10.catalogSha256);
      expect(witness.observation.sqlJsonbSha256).toBe(
        currentRuntimeCompiledExpectedV10.sqlJsonbSha256,
      );
      expect(witness.sections).toEqual(currentRuntimeCompiledExpectedV10.sections);
      expect(parseCurrentRuntimeCatalogWitnessV10(witness)).toEqual(witness);
    }
    expect(upgraded.metadata).toEqual(fresh.metadata);
    const guard = fresh.metadata.functions.filter(
      (f) => f.name === 'guard_race_event_local_date_approval_v1',
    );
    expect(guard).toEqual([
      expect.objectContaining({
        schema: 'public',
        securityDefiner: false,
        runtimeExecute: false,
      }),
    ]);
  },
  120000,
);
fixtureIt('profile25 witness refuses a profile26 database', async () => {
  for (const environment of environments)
    await expect(
      readonly(environment, environment.owner, (tx) =>
        captureCurrentRuntimeCatalogWitnessV9In(tx, environment.runtime),
      ),
    ).rejects.toThrow();
});
fixtureIt(
  'rejects nonowner/runtime capture and READ COMMITTED before catalog evidence',
  async () => {
    await expect(
      readonly(first, first.runtime, (tx) =>
        captureCurrentRuntimeCatalogWitnessV10In(tx, first.runtime),
      ),
    ).rejects.toThrow('CATALOG_WITNESS_CONTEXT_REQUIRED');
    await session(first, first.owner, async (tx) => {
      await tx.query('SELECT pg_advisory_lock_shared(872194,1)');
      await tx.query('SELECT pg_advisory_lock_shared(77210,1)');
      try {
        await tx.query('BEGIN READ ONLY');
        await tx.query('SET LOCAL search_path=pg_catalog,pg_temp');
        await expect(captureCurrentRuntimeCatalogWitnessV10In(tx, first.runtime)).rejects.toThrow(
          'CATALOG_WITNESS_CONTEXT_REQUIRED',
        );
      } finally {
        await tx.query('ROLLBACK');
        await tx.query('SELECT pg_advisory_unlock_shared(77210,1)');
        await tx.query('SELECT pg_advisory_unlock_shared(872194,1)');
      }
    });
  },
);
fixtureIt(
  'disabled, replica-only or dropped local-date trigger refuses capture',
  async () => {
    for (const [sql, undo] of [
      [
        'ALTER TABLE public.race_event DISABLE TRIGGER race_local_date_approval_guard',
        'ALTER TABLE public.race_event ENABLE TRIGGER race_local_date_approval_guard',
      ],
      [
        'ALTER TABLE public.race_event ENABLE REPLICA TRIGGER race_local_date_approval_guard',
        'ALTER TABLE public.race_event ENABLE TRIGGER race_local_date_approval_guard',
      ],
      [
        'DROP TRIGGER race_local_date_approval_guard ON public.race_event',
        'CREATE TRIGGER race_local_date_approval_guard BEFORE UPDATE OF values_json ON public.race_event FOR EACH ROW EXECUTE FUNCTION public.guard_race_event_local_date_approval_v1()',
      ],
    ] as const)
      await mutation(sql, undo, async () => {
        await expect(capture()).rejects.toThrow('CURRENT_RUNTIME_V10_FUNCTION_DRIFT');
      });
  },
  120000,
);
fixtureIt(
  'guard exposure to runtime or PUBLIC refuses capture before catalog transfer',
  async () => {
    for (const grantee of [`"${first.runtime}"`, 'PUBLIC'])
      await mutation(
        `GRANT EXECUTE ON FUNCTION public.guard_race_event_local_date_approval_v1() TO ${grantee}`,
        `REVOKE EXECUTE ON FUNCTION public.guard_race_event_local_date_approval_v1() FROM ${grantee}`,
        async () => {
          await expect(capture()).rejects.toThrow(
            /CURRENT_RUNTIME_V10_FUNCTION_DRIFT|CATALOG_WITNESS_INVALID/,
          );
        },
      );
  },
  120000,
);
fixtureIt(
  'missing direct root grant refuses capture',
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
