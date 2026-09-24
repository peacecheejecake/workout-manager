import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ROUTING_GRAPH_MANIFEST_FILE,
  hashGraphDirectory,
  type RoutingGraphManifest,
} from '@workout/server-integrations/routing';
import { grantCourses, grantOperations, migrate } from '@workout/server-persistence/migrate';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConfiguredApi } from '../src/configured.js';
import type { RoutingDeploymentSwitch } from '../src/routing-deployment.js';

/**
 * Two API instances, one engine, one PostgreSQL (M2-01ah).
 *
 * Each instance is the production composition `start.ts` runs — `createConfiguredApi`, with
 * its own database pool — and they share nothing but the database and the engine. The engine
 * is a loopback HTTP stand-in that holds every search until the test lets it answer and
 * counts how many searches it is running at once: that count is what the tenant bound and
 * the engine cap exist to limit, so it is what these tests assert. Before M2-01ah each
 * instance counted in its own process and two instances admitted twice the tenant bound.
 */
vi.mock('@workout/server-identity/oidc', () => ({
  // Startup OIDC discovery is a network call and not what this file is about.
  createOidcProvider: vi.fn(async () => ({ authorizationUrl: vi.fn(), exchange: vi.fn() })),
}));

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Isolated real PostgreSQL required: run pnpm test:integration');
const admin = new Pool({ connectionString: adminUrl });

const realAnswer = await readFile(
  new URL(
    '../../../packages/server/integrations/tests/fixtures/graphhopper-gwanghwamun.json',
    import.meta.url,
  ),
  'utf8',
);
const engineInfo = JSON.stringify({
  version: '10.0',
  profiles: [{ name: 'foot' }],
  import_date: '2026-09-21T14:09:12Z',
  data_date: '2026-09-18T23:00:00Z',
});
const request = (requestId: string) => ({
  schemaVersion: 1,
  requestId,
  requestRevision: 1,
  profileId: 'foot-v1',
  waypoints: [
    [126.9769, 37.5759],
    [126.9779, 37.5663],
  ],
});

/** A GraphHopper stand-in that holds every `/route` until `open()` and counts them. */
function heldEngine() {
  let running = 0;
  let peak = 0;
  let searches = 0;
  let waiting: Array<() => void> = [];
  let held = true;
  const server: Server = createServer((incoming, reply) => {
    const path = new URL(incoming.url ?? '/', 'http://engine').pathname;
    if (path === '/info') {
      reply.writeHead(200, { 'content-type': 'application/json' }).end(engineInfo);
      return;
    }
    running += 1;
    searches += 1;
    peak = Math.max(peak, running);
    const answer = () => {
      running -= 1;
      reply.writeHead(200, { 'content-type': 'application/json' }).end(realAnswer);
    };
    if (held) waiting.push(answer);
    else answer();
  });
  return {
    server,
    get running() {
      return running;
    },
    get peak() {
      return peak;
    },
    get searches() {
      return searches;
    },
    open() {
      held = false;
      const answers = waiting;
      waiting = [];
      for (const answer of answers) answer();
    },
  };
}

let directory: string;
let engine: ReturnType<typeof heldEngine>;
let routingEnvironment: Record<string, string>;
const apis: Array<{ close(): Promise<unknown> }> = [];

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCourses(adminUrl, 'workout_runtime');
});

beforeEach(async () => {
  await admin.query('DELETE FROM routing_admission');
  directory = await mkdtemp(join(tmpdir(), 'routing-admission-'));
  const paths = {
    graph: join(directory, 'graph'),
    jar: join(directory, 'engine.jar'),
    profile: join(directory, 'profile.yml'),
    storage: join(directory, 'storage'),
  };
  await mkdir(paths.storage);
  await writeFile(paths.jar, 'engine-artifact-bytes');
  await writeFile(paths.profile, 'profile-configuration-bytes');
  await mkdir(paths.graph);
  await writeFile(join(paths.graph, 'edges'), 'edge-bytes');
  await writeFile(
    join(paths.graph, 'properties.txt'),
    'datareader.import.date=2026-09-21T14:09:12Z\ndatareader.data.date=2026-09-18T23:00:00Z\n',
  );
  const hashOf = async (path: string) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const manifest: RoutingGraphManifest = {
    schemaVersion: 1,
    engine: 'graphhopper',
    engineVersion: '10.0',
    engineArtifactSha256: await hashOf(paths.jar),
    profileId: 'foot-v1',
    profileConfigSha256: await hashOf(paths.profile),
    profileName: 'foot',
    extractSha256: '7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea',
    extractRegion: 'Seoul (BBBike city extract)',
    extractByteLength: 51_884_841,
    graphContentSha256: await hashGraphDirectory(paths.graph),
    graphImportedAt: '2026-09-21T14:09:12.000Z',
    roadDataAt: '2026-09-18T23:00:00.000Z',
    builtAt: '2026-09-21T14:09:14.321Z',
  };
  await writeFile(join(paths.graph, ROUTING_GRAPH_MANIFEST_FILE), JSON.stringify(manifest));
  engine = heldEngine();
  await new Promise<void>((resolve) => engine.server.listen(0, '127.0.0.1', resolve));
  const { port } = engine.server.address() as AddressInfo;
  routingEnvironment = {
    NODE_ENV: 'test',
    DATABASE_URL: runtimeUrl,
    PUBLIC_ORIGIN: 'http://127.0.0.1:4301',
    OIDC_ISSUER: 'http://127.0.0.1:4302',
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: 'secret',
    ALLOW_INSECURE_LOCALHOST: 'true',
    PRIVATE_RESOURCE_STORAGE_ROOT: paths.storage,
    ROUTING_ENGINE_URL: `http://127.0.0.1:${port}/`,
    ROUTING_GRAPH_DIRECTORY: paths.graph,
    ROUTING_ENGINE_ARTIFACT: paths.jar,
    ROUTING_PROFILE_CONFIG: paths.profile,
  };
});

afterEach(async () => {
  engine.open();
  await Promise.all(apis.splice(0).map((api) => api.close()));
  await new Promise((resolve) => engine.server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
  await admin.end();
});

/** One API instance: the production composition with its own pool. */
async function instance(extra: Record<string, string> = {}): Promise<RoutingDeploymentSwitch> {
  return (await instanceWithApi(extra)).control;
}

async function instanceWithApi(extra: Record<string, string> = {}) {
  let control: RoutingDeploymentSwitch | undefined;
  const api = await createConfiguredApi(
    { ...routingEnvironment, ...extra },
    {
      onRoutingDeployments: (deployments) => {
        control = deployments;
      },
    },
  );
  apis.push(api);
  if (control === undefined) throw new Error('routing was not configured');
  return { control, api };
}

describe('two API instances share the tenant bound (M2-01ah)', () => {
  it('never lets one tenant run more than two engine searches across both instances', async () => {
    const [first, second] = [await instance(), await instance()];
    const tenant = randomUUID();
    const pending = Array.from({ length: 8 }, (_, index) =>
      (index % 2 === 0 ? first : second).walkingRoutes.compute(tenant, request(`r-${index}`), {}),
    );
    // Every refusal answers without the engine; the two admitted ones are held there.
    await vi.waitFor(() => expect(engine.running).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(engine.running).toBe(2);
    engine.open();
    const results = await Promise.all(pending);
    const outcomes = results.map((result) => result.result.outcome).sort();
    expect(outcomes).toEqual([...Array(6).fill('overloaded'), ...Array(2).fill('route_computed')]);
    for (const refused of results.filter((result) => result.result.outcome === 'overloaded'))
      expect(refused.retryAfterSeconds).toBe(1);
    expect(engine.peak).toBe(2);
    expect(engine.searches).toBe(2);
  });

  it('keeps a disconnected caller’s permit on every instance until the engine stops', async () => {
    const [first, second] = [await instance(), await instance()];
    const tenant = randomUUID();
    const callers = [new AbortController(), new AbortController()];
    const cancelled = callers.map((caller, index) =>
      first.walkingRoutes.compute(tenant, request(`cancel-${index}`), { signal: caller.signal }),
    );
    await vi.waitFor(() => expect(engine.running).toBe(2));
    for (const caller of callers) caller.abort();
    // Both callers are answered at once...
    expect((await Promise.all(cancelled)).map((result) => result.result.outcome)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    // ...but the engine still runs both searches, so the OTHER instance has no permit either.
    const refused = await second.walkingRoutes.compute(tenant, request('while-running'), {});
    expect(refused.result.outcome).toBe('overloaded');
    expect(refused.retryAfterSeconds).toBe(1);
    const held = await admin.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM routing_admission WHERE athlete_id=$1 AND released_at IS NULL',
      [tenant],
    );
    expect(held.rows[0]?.total).toBe(2);
    // The engine stops; the permits come back, and the other instance is admitted.
    engine.open();
    await vi.waitFor(async () => {
      const released = await admin.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM routing_admission WHERE athlete_id=$1 AND released_at IS NOT NULL',
        [tenant],
      );
      expect(released.rows[0]?.total).toBe(2);
    });
    const admitted = await second.walkingRoutes.compute(tenant, request('after-engine'), {});
    expect(admitted.result.outcome).toBe('route_computed');
  });
});

describe('an instance that shuts down (M2-01ah)', () => {
  it('releases the permit of a search still running when it closes, before its pool goes', async () => {
    const { control, api } = await instanceWithApi();
    const tenant = randomUUID();
    const caller = new AbortController();
    const pending = control.walkingRoutes.compute(tenant, request('shutdown'), {
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(engine.running).toBe(1));
    caller.abort();
    expect((await pending).result.outcome).toBe('cancelled');
    // The instance shuts down while the engine is still on the cancelled search.
    apis.splice(apis.indexOf(api), 1);
    const closing = api.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    engine.open();
    await closing;
    // Released through the instance's own pool before it closed, not left to its lease.
    const rows = await admin.query<{ released: boolean }>(
      'SELECT released_at IS NOT NULL AS released FROM routing_admission WHERE athlete_id=$1',
      [tenant],
    );
    expect(rows.rows).toEqual([{ released: true }]);
  });
});

describe('the engine cap across tenants and instances (M2-01ah)', () => {
  it('runs at most ROUTING_ENGINE_CONCURRENCY searches, whoever asks', async () => {
    const cap = { ROUTING_ENGINE_CONCURRENCY: '3' };
    const [first, second] = [await instance(cap), await instance(cap)];
    const pending = Array.from({ length: 6 }, (_, index) =>
      (index % 2 === 0 ? first : second).walkingRoutes.compute(
        randomUUID(),
        request(`cap-${index}`),
        {},
      ),
    );
    await vi.waitFor(() => expect(engine.running).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 100));
    engine.open();
    const outcomes = (await Promise.all(pending)).map((result) => result.result.outcome).sort();
    // Six tenants, one request each: every tenant is inside its own bound, so only the
    // engine cap can refuse.
    expect(outcomes).toEqual([...Array(3).fill('overloaded'), ...Array(3).fill('route_computed')]);
    expect(engine.peak).toBe(3);
  });

  it('refuses a malformed cap at startup', async () => {
    await expect(instance({ ROUTING_ENGINE_CONCURRENCY: 'many' })).rejects.toMatchObject({
      code: 'ROUTING_CONFIGURATION_INVALID',
    });
    await expect(instance({ ROUTING_ENGINE_CONCURRENCY: '0' })).rejects.toMatchObject({
      code: 'ROUTING_CONFIGURATION_INVALID',
    });
  });
});
