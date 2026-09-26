import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { join } from 'node:path';

import {
  mapDataLicenceReadPath,
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
