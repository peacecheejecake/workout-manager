import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { join } from 'node:path';

import {
  mapDataLicenceReadPath,
  mapDataScriptReadPath,
  mapDataLicence,
  mapDataLicenceResponseSchema,
  type GeoDatasetsLicenceState,
} from '@workout/contracts/map-data-licence';
import {
  ROUTING_ATTRIBUTION_FILE,
  ROUTING_GRAPH_MANIFEST_FILE,
  TenantAdmissionControl,
  hashGraphDirectory,
  renderRoutingAttribution,
  type RoutingGraphManifest,
} from '@workout/server-integrations/routing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApi } from '../src/app.js';
import { createConfiguredWalkingRoutes } from '../src/routing-deployment.js';
import { registerMapDataLicenceRead } from '../src/map-data-licence-routes.js';
import Fastify from 'fastify';

/**
 * `GET /bff/v1/map-data/licence` (M0-06b-odbl): the ODbL §4.6 disclosure of the graph the API
 * serves, readable by anyone. Asserted through the real application and the real deployment
 * loader, on a graph verified from disk; no engine is started.
 */
let directory: string;
const apps: ReturnType<typeof createApi>[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'map-data-licence-'));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await rm(directory, { recursive: true, force: true });
});

const hashOf = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

/** A verified graph on disk, with its notice rendered and hashed in, as the build writes it. */
async function configuredRouting() {
  const graph = join(directory, 'graph');
  const jar = join(directory, 'engine.jar');
  const profile = join(directory, 'profile.yml');
  await writeFile(jar, 'engine-artifact-bytes');
  await writeFile(profile, 'profile-configuration-bytes');
  await mkdir(graph, { recursive: true });
  await writeFile(join(graph, 'edges'), 'edge-bytes');
  await writeFile(
    join(graph, 'properties.txt'),
    'datareader.import.date=2026-09-21T14:09:12Z\ndatareader.data.date=2026-09-18T23:00:00Z\n',
  );
  const facts = {
    engine: 'graphhopper',
    engineVersion: '10.0',
    engineArtifactSha256: await hashOf(jar),
    profileId: 'foot-v1',
    profileConfigSha256: await hashOf(profile),
    profileName: 'foot',
    extractSha256: '7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea',
    extractRegion: 'Seoul (BBBike city extract)',
    extractByteLength: 51_884_841,
    graphImportedAt: '2026-09-21T14:09:12.000Z',
    roadDataAt: '2026-09-18T23:00:00.000Z',
  } as const;
  await writeFile(join(graph, ROUTING_ATTRIBUTION_FILE), renderRoutingAttribution(facts, null));
  const manifest: RoutingGraphManifest = {
    schemaVersion: 1,
    ...facts,
    graphContentSha256: await hashGraphDirectory(graph),
    builtAt: '2026-09-21T14:09:14.321Z',
  };
  await writeFile(join(graph, ROUTING_GRAPH_MANIFEST_FILE), JSON.stringify(manifest));
  const routing = await createConfiguredWalkingRoutes(
    {
      ROUTING_ENGINE_URL: 'http://127.0.0.1:8991/',
      ROUTING_GRAPH_DIRECTORY: graph,
      ROUTING_ENGINE_ARTIFACT: jar,
      ROUTING_PROFILE_CONFIG: profile,
    },
    {
      admission: new TenantAdmissionControl({ now: () => Date.now() }),
      transportFactory: () => ({
        send: () => Promise.reject(new Error('no engine call is expected here')),
      }),
    },
  );
  if (routing === null) throw new Error('expected a configured deployment');
  return routing;
}

function app(
  options: {
    routing?: Awaited<ReturnType<typeof configuredRouting>>;
    geoDatasetsLicence?: GeoDatasetsLicenceState;
  } = {},
) {
  const authenticate = vi.fn(async () => null);
  const routing = options.routing;
  const instance = createApi({
    allowedOrigins: ['https://workout.example'],
    // Request lines are not what this file asserts; keep them out of the test output.
    logStream: new Writable({ write: (_chunk, _encoding, done) => done() }),
    auth: { authenticate },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    ...(options.geoDatasetsLicence ? { geoDatasetsLicence: options.geoDatasetsLicence } : {}),
    ...(routing
      ? {
          walkingRoutes: routing.walkingRoutes,
          mapDataDisclosure: () => routing.deployments.activeDisclosure,
        }
      : {}),
  });
  apps.push(instance);
  return { instance, authenticate };
}

describe('the public map-data licence read', () => {
  it('serves only the active graph script with its manifest hash', async () => {
    const bytes = Buffer.from('graph import script');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const graph = join(directory, 'graph-script');
    await mkdir(join(graph, 'odbl-scripts'), { recursive: true });
    await writeFile(join(graph, 'odbl-scripts/0.txt'), bytes);
    const graphBuildId = 'a'.repeat(16);
    const disclosed = {
      schemaVersion: 1 as const,
      kind: 'routing-graph' as const,
      licence: mapDataLicence,
      graph: {
        graphBuildId,
        graphContentSha256: 'b'.repeat(64),
        graphImportedAt: '2026-09-21T14:09:12.000Z',
        roadDataAt: '2026-09-18T23:00:00.000Z',
      },
      engine: {
        engine: 'graphhopper' as const,
        engineVersion: '10.0',
        engineArtifactSha256: 'c'.repeat(64),
      },
      profile: {
        profileId: 'foot-v1' as const,
        profileName: 'foot',
        profileConfigSha256: 'd'.repeat(64),
      },
      extract: { sha256: 'e'.repeat(64), region: 'Seoul', byteLength: 10, acquisition: null },
      derivation: {
        osmium: null,
        militaryPerimeterBarriers: null,
        timeConditionalWays: null,
        scripts: { 'scripts/build-routing-graph.mts': digest },
      },
      artifactNotice: 'verified' as const,
    };
    const instance = Fastify();
    let active = disclosed;
    registerMapDataLicenceRead(
      instance,
      () => active,
      { kind: 'none' },
      { routing: () => ({ directory: graph, disclosure: active }) },
    );
    const url = `${mapDataScriptReadPath}/routing/${graphBuildId}/0`;
    expect((await instance.inject({ method: 'GET', url })).body).toBe(bytes.toString());
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: `${mapDataScriptReadPath}/routing/${'f'.repeat(16)}/0`,
        })
      ).statusCode,
    ).toBe(404);
    await writeFile(join(graph, 'odbl-scripts/0.txt'), 'changed');
    expect((await instance.inject({ method: 'GET', url })).statusCode).toBe(404);
    active = { ...disclosed, graph: { ...disclosed.graph, graphBuildId: 'f'.repeat(16) } };
    expect((await instance.inject({ method: 'GET', url })).statusCode).toBe(404);
    await instance.close();
  });
  it('reports loaded legacy place/elevation datasets without a disclosure', async () => {
    const geoDatasetsLicence: GeoDatasetsLicenceState = {
      kind: 'undisclosed',
      placesDatasetId: 'a'.repeat(12),
      elevationDatasetId: 'b'.repeat(12),
    };
    const { instance, authenticate } = app({ geoDatasetsLicence });
    const response = await instance.inject({ method: 'GET', url: mapDataLicenceReadPath });
    expect(response.statusCode).toBe(200);
    expect(mapDataLicenceResponseSchema.parse(response.json()).geoDatasets).toEqual(
      geoDatasetsLicence,
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('answers anyone, with no session, the graph this API is serving', async () => {
    const routing = await configuredRouting();
    const { instance, authenticate } = app({ routing });
    const response = await instance.inject({ method: 'GET', url: mapDataLicenceReadPath });
    expect(response.statusCode).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    const body = mapDataLicenceResponseSchema.parse(response.json());
    expect(body.routing?.graph.graphBuildId).toBe(routing.graphBuildId);
    expect(body.routing?.licence.url).toBe('https://opendatacommons.org/licenses/odbl/1-0/');
    expect(body.routing?.artifactNotice).toBe('verified');
    // Nothing of the deployment's location is published.
    expect(response.body).not.toContain(directory);
    expect(response.body).not.toContain('127.0.0.1');
  });

  it('answers the same document whatever session a request carries', async () => {
    const routing = await configuredRouting();
    const { instance, authenticate } = app({ routing });
    const anonymous = await instance.inject({ method: 'GET', url: mapDataLicenceReadPath });
    const withSession = await instance.inject({
      method: 'GET',
      url: mapDataLicenceReadPath,
      headers: { cookie: 'wm_session=abc', authorization: 'Bearer token' },
    });
    expect(withSession.statusCode).toBe(200);
    expect(withSession.body).toBe(anonymous.body);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('says there is no routing graph when this server computes no routes', async () => {
    const { instance } = app();
    const response = await instance.inject({ method: 'GET', url: mapDataLicenceReadPath });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      routing: null,
      geoDatasets: { kind: 'none' },
    });
  });
});
