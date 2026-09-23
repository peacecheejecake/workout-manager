import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GraphManifestError,
  ROUTING_GRAPH_MANIFEST_FILE,
  RoutingEndpointError,
  hashGraphDirectory,
  type RoutingEngineTransport,
  type RoutingGraphManifest,
} from '@workout/server-integrations/routing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RoutingConfigurationError,
  createConfiguredWalkingRoutes,
} from '../src/routing-deployment.js';

/**
 * Operations wiring for the routing engine (M2-01k).
 *
 * What is fixed here: the three configuration states stay apart (off / half-set / set but
 * unverifiable), the only path to a port is the on-disk verification, and the port that
 * comes out computes under the verified identity and refuses an engine that reports a
 * different graph. A real engine run is recorded separately; this file never starts one.
 */
const realAnswer = JSON.parse(
  await readFile(
    new URL(
      '../../../packages/server/integrations/tests/fixtures/graphhopper-gwanghwamun.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as unknown;

const engineInfo = {
  version: '10.0',
  profiles: [{ name: 'foot' }],
  import_date: '2026-09-21T14:09:12Z',
  data_date: '2026-09-18T23:00:00Z',
};

let directory: string;
let paths: { graph: string; jar: string; profile: string };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'routing-configuration-'));
  paths = {
    graph: join(directory, 'graph'),
    jar: join(directory, 'engine.jar'),
    profile: join(directory, 'profile.yml'),
  };
  await writeFile(paths.jar, 'engine-artifact-bytes');
  await writeFile(paths.profile, 'profile-configuration-bytes');
  await mkdir(paths.graph, { recursive: true });
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
  await writeFile(
    join(paths.graph, ROUTING_GRAPH_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const configured = () => ({
  ROUTING_ENGINE_URL: 'http://127.0.0.1:8991/',
  ROUTING_GRAPH_DIRECTORY: paths.graph,
  ROUTING_ENGINE_ARTIFACT: paths.jar,
  ROUTING_PROFILE_CONFIG: paths.profile,
});

function engine(info: typeof engineInfo = engineInfo) {
  const calls: string[] = [];
  const transport: RoutingEngineTransport = {
    async get(request) {
      calls.push(request.path);
      const body = request.path === '/info' ? info : realAnswer;
      return { status: 200, bodyText: JSON.stringify(body), truncated: false, byteLength: 1 };
    },
  };
  return { calls, transportFactory: () => transport };
}

const request = {
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: 1,
  profileId: 'foot-v1',
  waypoints: [
    [126.9769, 37.5759],
    [126.9779, 37.5663],
  ],
};

describe('routing configuration states', () => {
  it('leaves routing off when nothing is configured', async () => {
    await expect(createConfiguredWalkingRoutes({})).resolves.toBeNull();
    await expect(createConfiguredWalkingRoutes({ ROUTING_ENGINE_URL: '  ' })).resolves.toBeNull();
  });

  it('refuses a half configuration and names what is missing', async () => {
    const { ROUTING_PROFILE_CONFIG: _omitted, ...partial } = configured();
    const refusal = await createConfiguredWalkingRoutes(partial).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RoutingConfigurationError);
    expect(refusal).toMatchObject({
      code: 'ROUTING_CONFIGURATION_INCOMPLETE',
      keys: ['ROUTING_PROFILE_CONFIG'],
    });
  });

  it('refuses a host allowlist that configures nothing else', async () => {
    await expect(
      createConfiguredWalkingRoutes({ ROUTING_ENGINE_ALLOWED_HOSTS: 'routing.internal' }),
    ).rejects.toMatchObject({ code: 'ROUTING_CONFIGURATION_INCOMPLETE' });
  });

  it('refuses relative artifact paths', async () => {
    await expect(
      createConfiguredWalkingRoutes({ ...configured(), ROUTING_ENGINE_ARTIFACT: 'engine.jar' }),
    ).rejects.toMatchObject({
      code: 'ROUTING_PATH_NOT_ABSOLUTE',
      keys: ['ROUTING_ENGINE_ARTIFACT'],
    });
  });

  it('refuses an engine host outside the loopback allowlist unless it is named', async () => {
    const elsewhere = { ...configured(), ROUTING_ENGINE_URL: 'http://routing.internal:8991/' };
    const refusal = await createConfiguredWalkingRoutes(elsewhere, engine()).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(RoutingEndpointError);
    expect(refusal).toMatchObject({ code: 'ENDPOINT_HOST_NOT_ALLOWED' });
    await expect(
      createConfiguredWalkingRoutes(
        { ...elsewhere, ROUTING_ENGINE_ALLOWED_HOSTS: 'routing.internal' },
        engine(),
      ),
    ).resolves.not.toBeNull();
  });
});

describe('verification before any computation', () => {
  it('refuses to start on a graph whose files no longer match the manifest', async () => {
    await writeFile(join(paths.graph, 'edges'), 'edge-bytes-changed');
    const refusal = await createConfiguredWalkingRoutes(configured(), engine()).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(GraphManifestError);
    expect(refusal).toMatchObject({ code: 'GRAPH_CONTENT_CHANGED' });
  });

  it('refuses to start with an engine artifact that did not build the graph', async () => {
    await writeFile(paths.jar, 'another-engine');
    await expect(createConfiguredWalkingRoutes(configured(), engine())).rejects.toMatchObject({
      code: 'ENGINE_ARTIFACT_MISMATCH',
    });
  });

  it('refuses to start with a profile configuration that did not build the graph', async () => {
    await writeFile(paths.profile, 'another-profile');
    await expect(createConfiguredWalkingRoutes(configured(), engine())).rejects.toMatchObject({
      code: 'PROFILE_CONFIG_MISMATCH',
    });
  });
});

describe('the configured port', () => {
  it('computes through the verified deployment and records the identity it checked', async () => {
    const fake = engine();
    const routing = await createConfiguredWalkingRoutes(configured(), fake);
    if (routing === null) throw new Error('expected a configured port');
    const { result } = await routing.walkingRoutes.compute('athlete-1', request, {});
    expect(result.outcome).toBe('route_computed');
    expect(result.computation.graph).toMatchObject({
      identitySource: 'engine',
      graphBuildId: routing.graphBuildId,
      graphImportedAt: '2026-09-21T14:09:12.000Z',
    });
    // Identity is asked on every computation, before the route.
    expect(fake.calls).toEqual(['/info', '/route']);
  });

  it('answers graph_mismatch when the running engine serves another import', async () => {
    const fake = engine({ ...engineInfo, import_date: '2026-09-23T01:00:00Z' });
    const routing = await createConfiguredWalkingRoutes(configured(), fake);
    if (routing === null) throw new Error('expected a configured port');
    const { result } = await routing.walkingRoutes.compute('athlete-1', request, {});
    expect(result.outcome).toBe('graph_mismatch');
    expect(result.computation.graph.identitySource).toBe('pinned');
    expect(fake.calls).toEqual(['/info']);
  });
});
