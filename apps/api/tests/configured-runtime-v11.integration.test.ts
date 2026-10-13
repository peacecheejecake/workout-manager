import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '@workout/server-persistence/migrate';
import { installCurrentRuntimeV11 } from '@workout/server-persistence/current-runtime-installation-v11';
import { grantCurrentRuntimeAppBaselineV2 } from '@workout/server-persistence/current-runtime-app-grants-v2';
import {
  grantCurrentRuntimeV11Profile,
  grantCurrentRuntimeV11GalleryWorker,
  grantCurrentRuntimeV11AiDispatcher,
  currentRuntimeV11GalleryWorkerRole,
  currentRuntimeV11AiDispatcherRole,
} from '@workout/server-persistence/current-runtime-grants-v11';
import { createDatabase, type Transaction } from '@workout/server-persistence/database';
import { createIdentityRepository } from '@workout/server-persistence/identity';
import { createConsentRepository } from '@workout/server-persistence/repositories';
import { createRaceRepository } from '@workout/server-persistence/races';
import { parseAccountExportIncludingV40 } from '@workout/contracts/operations';
import { createConfiguredApi } from '../src/configured.js';
import { CurrentRuntimeSourceBuildRepositoriesV3Error } from '../src/current-runtime-source-build-repositories-v3.js';

// Profile27 successor of configured-runtime-v10 (installed-current-profile26 is retired by
// decision U6 and now refused at environment parse). PENDING ROOT REGISTRATION: this suite
// passes only after root registers the V11 installer/grants, readiness v3 + source-build
// proof v3 and pins the compiled V11 expectation; before that the named profile27 startup
// is a genuine V3 refusal, never a skip or fallback.
// Root executes actual PG/HTTP. No mocked readiness, source-proof, repositories,
// OIDC, runtime SQL or provider interception. A missing compiled proof remains a
// genuine startup refusal, never a skip/fallback or positive acceptance claim.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const environments = ['named', 'baseline'].map((kind) => ({
  kind,
  database: `configured_v11_${kind}_${suffix}`,
  owner: `configured_v11_owner_${kind}_${suffix}`,
  runtime: `configured_v11_app_${kind}_${suffix}`,
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
  profile?: 'installed-current-profile27',
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
  profile?: 'installed-current-profile27',
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
async function refuse(
  role: string,
  expectedCode: CurrentRuntimeSourceBuildRepositoriesV3Error['code'],
) {
  let app: FastifyInstance | undefined;
  try {
    app = await start(named, role, 'installed-current-profile27');
    expect.fail('Named runtime must refuse startup; legacy fallback is forbidden');
  } catch (error) {
    expect(error).toBeInstanceOf(CurrentRuntimeSourceBuildRepositoriesV3Error);
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
  if (!/^configured_v11_[a-z0-9_]+$/.test(database)) throw new Error('INVALID_FIXTURE_DATABASE');
  // Pool.end only initiates backend close. Drain avoids FATAL 57P01 events on
  // already-ended pools; FORCE is a last cleanup resort, not positive proof.
  await drainSessions(database);
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
}
beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'configured-runtime-v11-'));
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
  // The profile27 catalog always contains both fixed principals (cluster roles).
  for (const role of [currentRuntimeV11GalleryWorkerRole, currentRuntimeV11AiDispatcherRole]) {
    if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) continue;
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  for (const e of environments) {
    await migrate(url(e, e.owner), 107);
    if (e.kind === 'named') {
      expect(await installCurrentRuntimeV11(url(e, e.owner))).toMatchObject({
        profileVersion: 11,
        parentProfileVersion: 10,
        runtimeStep: 27,
        sourceDdlTip: 148,
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
        z
          .object({ grantedFunctions: z.array(z.string()) })
          .parse(await grantCurrentRuntimeV11Profile(url(e, e.owner), e.runtime)).grantedFunctions
          .length,
      ).toBeGreaterThan(42);
    if (e.kind === 'named') {
      await grantCurrentRuntimeV11GalleryWorker(
        url(e, e.owner),
        currentRuntimeV11GalleryWorkerRole,
      );
      await grantCurrentRuntimeV11AiDispatcher(url(e, e.owner), currentRuntimeV11AiDispatcherRole);
    }
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
  'normal configured profile27 reaches real health and closes only after actual runtime readiness',
  async () => {
    const app = await start(named, named.runtime, 'installed-current-profile27');
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
      await refuse(named.runtime, 'CURRENT_RUNTIME_SOURCE_BUILD_V3_INCOMPATIBLE');
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
      await refuse(named.runtime, 'CURRENT_RUNTIME_SOURCE_BUILD_V3_INCOMPATIBLE');
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
  await refuse(named.owner, 'CURRENT_RUNTIME_SOURCE_BUILD_V3_UNAVAILABLE');
});
fixtureIt(
  'baseline107 default configuration still starts without applying the profile27 cold gate',
  async () => {
    const app = await start(baseline);
    try {
      expect((await app.inject('/health')).statusCode).toBe(200);
    } finally {
      await close(app);
    }
  },
);

// M202-P1-02. A real session in the real identity store, then the real configured
// composition over HTTP inject: no mocked repositories, readiness or SQL.
const origin = 'http://127.0.0.1:4301';
async function signedIn(environment: Environment) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const store = createIdentityRepository({ connectionString: url(environment), max: 1 });
  try {
    const now = new Date();
    const session = await store.createSession({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      csrfToken,
      issuer: 'https://synthetic.test',
      subject: randomUUID(),
      expiresAt: new Date(now.getTime() + 3_600_000),
      now,
      loginStartedAt: now,
    });
    return {
      athleteId: session.athleteId,
      headers: {
        cookie: `workout_session=${token}`,
        'x-workout-session-id': session.sessionId,
        'x-csrf-token': csrfToken,
        origin,
      },
    };
  } finally {
    await store.close();
  }
}
async function raceWithAppConsent(environment: Environment, athleteId: string) {
  const database = createDatabase({ connectionString: url(environment) });
  try {
    await createConsentRepository(database).setConsent(athleteId, {
      kind: 'app',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    return await createRaceRepository(database).createRaceEvent(athleteId, {
      idempotencyKey: randomUUID(),
      values: {
        title: 'Synthetic race',
        localDate: '2026-11-08',
        localStartTime: '09:00',
        timezone: 'UTC',
        locationName: null,
        distance: { kind: 'standard', class: '10k' },
        priority: null,
        participation: 'registered',
        officialUrl: null,
        course: null,
        targetSeconds: null,
        planVersionId: null,
      },
    });
  } finally {
    await database.close();
  }
}
async function runtimeTenant<T>(
  environment: Environment,
  athleteId: string,
  operation: (transaction: Transaction) => Promise<T>,
) {
  const database = createDatabase({ connectionString: url(environment) });
  try {
    return await database.tenant(athleteId, operation);
  } finally {
    await database.close();
  }
}
async function storedRace(environment: Environment, athleteId: string, id: string) {
  return runtimeTenant(environment, athleteId, async (tx) =>
    z
      .strictObject({ revision: z.number().int(), localDate: z.string() })
      .parse(
        (
          await tx.query(
            'SELECT revision, values_json->>\'localDate\' AS "localDate" FROM race_event WHERE athlete_id=$1 AND id=$2 AND NOT deleted',
            [athleteId, id],
          )
        ).rows[0],
      ),
  );
}
async function expectDateApprovalRequired(work: Promise<unknown>) {
  const error: unknown = await work.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(z.object({ code: z.string(), message: z.string() }).parse(error)).toMatchObject({
    code: '42501',
    message: 'RACE_DATE_APPROVAL_REQUIRED',
  });
}
function reviewBody(event: { id: string; revision: number }) {
  return {
    schemaVersion: 1,
    intent: {
      expectedEvent: { id: event.id, revision: event.revision },
      newLocalDate: '2026-11-15',
      selection: { kind: 'keep_plan' },
    },
  };
}
const albumsQuery = new URLSearchParams({
  query: JSON.stringify({ limit: 10, sort: 'created_desc_id_asc', cursor: null }),
}).toString();
fixtureIt('baseline107 advertises no post-107 port and registers none of its routes', async () => {
  const app = await start(baseline);
  try {
    const { athleteId, headers } = await signedIn(baseline);
    const get = (path: string) => app.inject({ url: `/bff/v1${path}`, headers });
    const capability = await get('/race-date-change-reviews/capabilities');
    expect(capability.statusCode).toBe(200);
    expect(capability.json()).toEqual({ schemaVersion: 1, dateChangeReviews: false });
    expect((await get('/race-date-change-reviews/capabilities?maxSchemaVersion=2')).json()).toEqual(
      { schemaVersion: 2, dateChangeReviews: false, dateChangeImpact: false },
    );
    expect((await get('/race-results/capabilities')).json()).toEqual({
      schemaVersion: 1,
      legacyResults: true,
      proofResultsV2: false,
    });
    expect((await get('/nutrition/plans/capabilities')).json()).toEqual({
      schemaVersion: 1,
      readV4: true,
      previewV4: false,
      standaloneApprovalV4: false,
    });
    // The race itself is baseline (SQL 098); only the date-change review is not.
    const event = await raceWithAppConsent(baseline, athleteId);
    const review = await app.inject({
      method: 'POST',
      url: `/bff/v1/races/${event.id}/date-change-reviews`,
      headers: { ...headers, 'idempotency-key': `review-${randomUUID()}` },
      payload: reviewBody(event),
    });
    expect(review.statusCode).toBe(404);
    const impact = await app.inject({
      method: 'POST',
      url: `/bff/v1/races/${event.id}/date-change-impact`,
      headers,
      payload: reviewBody(event),
    });
    expect(impact.statusCode).toBe(404);
    expect((await get(`/race-date-change-reviews/${randomUUID()}`)).statusCode).toBe(404);
    expect((await get('/check-in-templates')).statusCode).toBe(404);
    // Gallery navigation/renditions (143/144) and AI execution jobs (148) are profile27
    // members only; baseline107 registers none of their routes.
    expect((await get(`/gallery/albums?${albumsQuery}`)).statusCode).toBe(404);
    expect((await get(`/gallery/media/${randomUUID()}/renditions`)).statusCode).toBe(404);
    expect((await get(`/ai-execution-jobs/${randomUUID()}`)).statusCode).toBe(404);
    // The V34 account export reads baseline tables only and stays available.
    const exported = await app.inject({
      method: 'POST',
      url: '/bff/v1/operations/export',
      headers,
    });
    expect(exported.statusCode).toBe(200);
  } finally {
    await close(app);
  }
});
fixtureIt(
  'installed profile27 advertises the date-change review and a real review request succeeds',
  async () => {
    const app = await start(named, named.runtime, 'installed-current-profile27');
    try {
      const { athleteId, headers } = await signedIn(named);
      const get = (path: string) => app.inject({ url: `/bff/v1${path}`, headers });
      const capability = await get('/race-date-change-reviews/capabilities');
      expect(capability.statusCode).toBe(200);
      expect(capability.json()).toEqual({ schemaVersion: 1, dateChangeReviews: true });
      expect(
        (await get('/race-date-change-reviews/capabilities?maxSchemaVersion=2')).json(),
      ).toEqual({ schemaVersion: 2, dateChangeReviews: true, dateChangeImpact: true });
      expect((await get('/race-results/capabilities')).json()).toEqual({
        schemaVersion: 1,
        legacyResults: true,
        proofResultsV2: true,
      });
      expect((await get('/nutrition/plans/capabilities')).json()).toEqual({
        schemaVersion: 1,
        readV4: true,
        previewV4: true,
        standaloneApprovalV4: true,
      });
      const event = await raceWithAppConsent(named, athleteId);
      const review = await app.inject({
        method: 'POST',
        url: `/bff/v1/races/${event.id}/date-change-reviews`,
        headers: { ...headers, 'idempotency-key': `review-${randomUUID()}` },
        payload: reviewBody(event),
      });
      expect(review.statusCode).toBe(201);
      const reviewed = z
        .object({
          status: z.literal('reviewed'),
          reference: z.object({ candidateId: z.uuid(), applicationDigest: z.string() }),
        })
        .parse(review.json());
      const preview = await get(`/race-date-change-reviews/${reviewed.reference.candidateId}`);
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        reference: { candidateId: reviewed.reference.candidateId },
      });
      const templates = await get('/check-in-templates');
      expect(templates.statusCode).toBe(200);
      expect(templates.json()).toEqual({ items: [] });
      // U3: gallery navigation and renditions are always on in profile27 over the real
      // runtime grants, and the AI execution job store (148) reads through its own RPCs.
      const albums = await get(`/gallery/albums?${albumsQuery}`);
      expect(albums.statusCode).toBe(200);
      expect(albums.json()).toMatchObject({ items: [] });
      const renditions = await get(`/gallery/media/${randomUUID()}/renditions`);
      expect(renditions.statusCode).toBe(404);
      expect(renditions.json()).toEqual({
        error: { code: 'MEDIA_NOT_FOUND' },
        requestId: expect.any(String),
      });
      const job = await get(`/ai-execution-jobs/${randomUUID()}`);
      expect(job.statusCode).toBe(404);
      expect(job.json()).toEqual({
        error: { code: 'JOB_NOT_FOUND' },
        requestId: expect.any(String),
      });
      // The pooled V40 export covers the gallery members; renditions are derived and are
      // never part of the personal export (U1).
      const exported = await app.inject({
        method: 'POST',
        url: '/bff/v1/operations/export',
        headers,
      });
      expect(exported.statusCode).toBe(200);
      const account = parseAccountExportIncludingV40(exported.json());
      expect(account.schemaVersion).toBe(39);
      expect(account.athleteId).toBe(athleteId);
      expect(exported.body).not.toMatch(/rendition/i);
      // M202-P1-03. Profile27 keeps the 146 guard: a direct runtime SQL date change
      // on the configured runtime credential is refused, with and without revision+1.
      for (const revision of ['revision', 'revision+1'])
        await expectDateApprovalRequired(
          runtimeTenant(named, athleteId, (tx) =>
            tx.query(
              `UPDATE race_event SET values_json=values_json||'{"localDate":"2026-11-22"}',revision=${revision} WHERE athlete_id=$1 AND id=$2`,
              [athleteId, event.id],
            ),
          ),
        );
      expect(await storedRace(named, athleteId, event.id)).toEqual({
        revision: event.revision,
        localDate: '2026-11-08',
      });
      // The real approval over HTTP still moves the date through 118 under the guard.
      const approved = await app.inject({
        method: 'POST',
        url: `/bff/v1/race-date-change-reviews/${reviewed.reference.candidateId}/approve`,
        headers: { ...headers, 'idempotency-key': `approve-${randomUUID()}` },
        payload: {
          schemaVersion: 1,
          confirmed: true,
          applicationDigest: reviewed.reference.applicationDigest,
        },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({
        status: 'committed',
        candidateId: reviewed.reference.candidateId,
        race: { eventId: event.id, revision: event.revision + 1 },
      });
      expect(await storedRace(named, athleteId, event.id)).toEqual({
        revision: event.revision + 1,
        localDate: '2026-11-15',
      });
      // After the approval the runtime still cannot move the date back directly.
      await expectDateApprovalRequired(
        runtimeTenant(named, athleteId, (tx) =>
          tx.query(
            `UPDATE race_event SET values_json=values_json||'{"localDate":"2026-11-08"}',revision=revision+1 WHERE athlete_id=$1 AND id=$2`,
            [athleteId, event.id],
          ),
        ),
      );
    } finally {
      await close(app);
    }
    expect(await drainSessions(named.database, named.runtime)).toBe(true);
  },
);
