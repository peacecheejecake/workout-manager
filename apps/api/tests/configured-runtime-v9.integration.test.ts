import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '@workout/server-persistence/migrate';
import { installCurrentRuntimeV9 } from '@workout/server-persistence/current-runtime-installation-v9';
import { grantCurrentRuntimeAppBaselineV2 } from '@workout/server-persistence/current-runtime-app-grants-v2';
import { grantCurrentRuntimeV9Profile } from '@workout/server-persistence/current-runtime-grants-v9';
import { createConfiguredApi } from '../src/configured.js';
import { CurrentRuntimeV9RepositoriesError } from '../src/current-runtime-v9-repositories.js';

// Root executes actual PG/HTTP. No mocked readiness, source-proof, repositories,
// OIDC, runtime SQL or provider interception. A missing compiled proof remains a
// genuine startup refusal, never a skip/fallback or positive acceptance claim.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const environments = ['named', 'baseline'].map((kind) => ({
  kind,
  database: `configured_v9_${kind}_${suffix}`,
  owner: `configured_v9_owner_${kind}_${suffix}`,
  runtime: `configured_v9_app_${kind}_${suffix}`,
}));
const environmentSchema = z.strictObject({
  kind: z.string(),
  database: z.string(),
  owner: z.string(),
  runtime: z.string(),
});
const named = environmentSchema.parse(environments[0]);
const baseline = environmentSchema.parse(environments[1]);
type Environment = z.infer<typeof environmentSchema>;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [],
  databases: string[] = [];
const apps = new Set<FastifyInstance>();
const directories: string[] = [];
let storageRoot: string;
let pending: Promise<void> = Promise.resolve();
function fixtureIt(label: string, operation: () => Promise<void>) {
  it(
    label,
    async () => {
      // A runner timeout does not cancel pending async work. Mutation restore and
      // app shutdown must finish before another test or destructive DB cleanup.
      const work = pending.then(operation);
      pending = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    90000,
  );
}
function url(environment: Environment, role = environment.runtime) {
  const value = new URL(adminUrl);
  value.pathname = `/${environment.database}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
function configuration(
  environment: Environment,
  role = environment.runtime,
  profile?: 'installed-current-profile25',
) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: url(environment, role),
    PUBLIC_ORIGIN: 'http://127.0.0.1:4301',
    // Deliberately unreachable local discovery. Startup is nonblocking; this
    // does not establish a real IdP/sign-in/logout or external integration.
    OIDC_ISSUER: 'http://127.0.0.1:1',
    OIDC_CLIENT_ID: 'configured-runtime-fixture',
    OIDC_CLIENT_SECRET: 'synthetic-never-log-client-secret',
    ALLOW_INSECURE_LOCALHOST: 'true',
    PRIVATE_RESOURCE_STORAGE_ROOT: storageRoot,
    ...(profile === undefined ? {} : { WORKOUT_RUNTIME_PROFILE: profile }),
  };
}
const silentLog = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
async function start(
  environment: Environment,
  role = environment.runtime,
  profile?: 'installed-current-profile25',
) {
  const app = await createConfiguredApi(configuration(environment, role, profile), {
    logStream: silentLog,
  });
  apps.add(app);
  return app;
}
async function close(app: FastifyInstance) {
  await app.close();
  apps.delete(app);
}
async function owner<T>(environment: Environment, operation: (pool: Pool) => Promise<T>) {
  const pool = new Pool({ connectionString: url(environment, environment.owner), max: 1 });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}
async function refuse(role: string, expectedCode: CurrentRuntimeV9RepositoriesError['code']) {
  let app: FastifyInstance | undefined;
  try {
    app = await start(named, role, 'installed-current-profile25');
    expect.fail('Named runtime must refuse startup; legacy fallback is forbidden');
  } catch (error) {
    expect(error).toBeInstanceOf(CurrentRuntimeV9RepositoriesError);
    expect(error).toMatchObject({ code: expectedCode });
    expect(String(error)).not.toContain('synthetic-never-log-client-secret');
  } finally {
    if (app !== undefined) await close(app);
  }
}
async function drainSessions(database: string, role: string | null = null): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const observed = await admin.query(
      'SELECT count(*)::int count FROM pg_stat_activity WHERE datname=$1 AND ($2::text IS NULL OR usename=$2)',
      [database, role],
    );
    const count = z
      .strictObject({ count: z.number().int().nonnegative() })
      .parse(observed.rows[0]).count;
    if (count === 0) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
async function dropDatabase(database: string) {
  if (!/^configured_v9_[a-z0-9_]+$/.test(database)) throw new Error('INVALID_FIXTURE_DATABASE');
  // Pool.end only initiates backend close. Drain avoids FATAL 57P01 events on
  // already-ended pools; FORCE is a last cleanup resort, not positive proof.
  await drainSessions(database);
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
}
beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'configured-runtime-v9-'));
  directories.push(storageRoot);
  for (const e of environments) {
    for (const role of [e.owner, e.runtime]) {
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
      );
      roles.push(role);
    }
    await admin.query(`CREATE DATABASE "${e.database}" OWNER "${e.owner}"`);
    databases.push(e.database);
  }
  for (const e of environments) {
    await migrate(url(e, e.owner), 107);
    if (e.kind === 'named') {
      expect(await installCurrentRuntimeV9(url(e, e.owner))).toMatchObject({
        profileVersion: 9,
        runtimeStep: 25,
        sourceDdlTip: 142,
        supported: false,
      });
    }
    // Exact named baseline only; no additional direct identity/tenant grants or
    // health/candidate/session/provider rows seeded to repair startup.
    expect(
      await grantCurrentRuntimeAppBaselineV2(url(e, e.owner), e.runtime, 'core'),
    ).toMatchObject({ recipeVersion: 2, deployment: 'core', processingAuthority: 'none' });
    if (e.kind === 'named')
      expect(
        (await grantCurrentRuntimeV9Profile(url(e, e.owner), e.runtime)).grantedFunctions,
      ).toHaveLength(42);
  }
}, 180000);
afterAll(async () => {
  await pending;
  for (const app of apps) await close(app);
  for (const database of databases.reverse()) await dropDatabase(database);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
}, 60000);
fixtureIt(
  'normal configured profile25 reaches real health and closes only after actual runtime readiness',
  async () => {
    const app = await start(named, named.runtime, 'installed-current-profile25');
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(new URL('/health', address), {
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      await close(app);
    }
    // Actual API pools must have closed before teardown. Observation uses fixture
    // admin metadata only; no private tenant/health body query.
    expect(await drainSessions(named.database, named.runtime)).toBe(true);
  },
);
fixtureIt(
  'actual final root body drift refuses configured startup without legacy fallback',
  async () => {
    const original = await owner(named, async (pool) =>
      z
        .strictObject({ definition: z.string(), body: z.string() })
        .parse(
          (
            await pool.query(
              "SELECT pg_get_functiondef(p.oid) definition,p.prosrc body FROM pg_proc p WHERE p.oid='public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)'::regprocedure",
            )
          ).rows[0],
        ),
    );
    await owner(named, (pool) =>
      pool.query(
        original.definition.replace(
          original.body,
          () => original.body + '\n-- synthetic configured metadata-only drift',
        ),
      ),
    );
    try {
      await refuse(named.runtime, 'CURRENT_RUNTIME_V9_INCOMPATIBLE');
    } finally {
      await owner(named, (pool) => pool.query(original.definition));
    }
  },
);
fixtureIt(
  'missing actual root EXECUTE refuses startup without auto-grant or fallback',
  async () => {
    await owner(named, (pool) =>
      pool.query(
        `REVOKE EXECUTE ON FUNCTION public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb) FROM "${named.runtime}"`,
      ),
    );
    try {
      await refuse(named.runtime, 'CURRENT_RUNTIME_V9_INCOMPATIBLE');
    } finally {
      await owner(named, (pool) =>
        pool.query(
          `GRANT EXECUTE ON FUNCTION public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb) TO "${named.runtime}"`,
        ),
      );
    }
  },
);
fixtureIt('actual migration owner credential cannot become configured runtime', async () => {
  await refuse(named.owner, 'CURRENT_RUNTIME_V9_UNAVAILABLE');
});
fixtureIt(
  'baseline107 default configuration still starts without applying the profile25 cold gate',
  async () => {
    const app = await start(baseline);
    try {
      expect((await app.inject('/health')).statusCode).toBe(200);
    } finally {
      await close(app);
    }
  },
);
