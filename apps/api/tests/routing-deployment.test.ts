import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GraphManifestError,
  ROUTING_GRAPH_MANIFEST_FILE,
  RoutingEndpointError,
  RoutingTransportError,
  hashGraphDirectory,
  type RoutingEngineEndpoint,
  type RoutingEngineTransport,
  type RoutingGraphManifest,
} from '@workout/server-integrations/routing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RoutingConfigurationError,
  RoutingSwitchError,
  applyRoutingSwitchFile,
  createConfiguredWalkingRoutes,
  switchRefusalCode,
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

describe('blue/green graph replacement (M2-01k-e)', () => {
  const greenInfo = { ...engineInfo, import_date: '2026-09-24T01:00:00Z' };

  /** A second verified graph, imported at another instant, beside the blue one. */
  async function greenGraph() {
    const graph = join(directory, 'green-graph');
    await mkdir(graph, { recursive: true });
    await writeFile(join(graph, 'edges'), 'green-edge-bytes');
    await writeFile(
      join(graph, 'properties.txt'),
      'datareader.import.date=2026-09-24T01:00:00Z\ndatareader.data.date=2026-09-18T23:00:00Z\n',
    );
    const blue = JSON.parse(
      await readFile(join(paths.graph, ROUTING_GRAPH_MANIFEST_FILE), 'utf8'),
    ) as RoutingGraphManifest;
    const manifest: RoutingGraphManifest = {
      ...blue,
      extractRegion: 'Seoul clip (test)',
      graphContentSha256: await hashGraphDirectory(graph),
      graphImportedAt: '2026-09-24T01:00:00.000Z',
    };
    await writeFile(
      join(graph, ROUTING_GRAPH_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return graph;
  }

  /**
   * Two engines on two loopback ports. Each answers `/info` with the graph it serves; an
   * engine can be taken down, and the blue engine's `/route` can be held open.
   */
  function engines() {
    const state = {
      blue: { info: engineInfo as typeof engineInfo, up: true, calls: 0 },
      green: { info: greenInfo as typeof engineInfo, up: true, calls: 0 },
    };
    const blueReleases: (() => void)[] = [];
    let holdBlue = false;
    const transportFactory = (endpoint: RoutingEngineEndpoint): RoutingEngineTransport => {
      const port = endpoint.resolve('/info', new URLSearchParams()).port;
      const which = port === '8991' ? state.blue : state.green;
      return {
        async get(input) {
          if (!which.up) throw new RoutingTransportError('ENGINE_UNREACHABLE');
          if (input.path === '/info')
            return {
              status: 200,
              bodyText: JSON.stringify(which.info),
              truncated: false,
              byteLength: 1,
            };
          which.calls += 1;
          if (which === state.blue && holdBlue)
            await new Promise<void>((resolve) => {
              blueReleases.push(resolve);
            });
          return {
            status: 200,
            bodyText: JSON.stringify(realAnswer),
            truncated: false,
            byteLength: 1,
          };
        },
      };
    };
    return {
      state,
      transportFactory,
      holdBlue: () => {
        holdBlue = true;
      },
      releaseBlue: () => {
        for (const release of blueReleases.splice(0)) release();
      },
      blueHeld: () => blueReleases.length > 0,
    };
  }

  const green = (graph: string) => ({
    ...configured(),
    ROUTING_ENGINE_URL: 'http://127.0.0.1:8993/',
    ROUTING_GRAPH_DIRECTORY: graph,
  });

  async function started(fake: ReturnType<typeof engines>) {
    const routing = await createConfiguredWalkingRoutes(configured(), {
      transportFactory: fake.transportFactory,
    });
    if (routing === null) throw new Error('expected a configured port');
    return routing;
  }

  const graphOf = async (routing: NonNullable<Awaited<ReturnType<typeof started>>>) =>
    (await routing.walkingRoutes.compute('athlete-1', request, {})).result.computation.graph
      .graphBuildId;

  it('moves every later computation to green in one step, and back on rollback', async () => {
    const fake = engines();
    const routing = await started(fake);
    const blueId = routing.deployments.activeGraphBuildId;
    expect(await graphOf(routing)).toBe(blueId);

    const switched = await routing.deployments.switchTo(green(await greenGraph()));
    expect(switched.from).toBe(blueId);
    expect(switched.to).not.toBe(blueId);
    expect(routing.deployments.activeGraphBuildId).toBe(switched.to);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { result } = await routing.walkingRoutes.compute('athlete-1', request, {});
      expect(result.outcome).toBe('route_computed');
      expect(result.computation.graph.graphBuildId).toBe(switched.to);
    }

    const rolledBack = await routing.deployments.rollback();
    expect(rolledBack).toEqual({ from: switched.to, to: blueId });
    expect(await graphOf(routing)).toBe(blueId);
    expect(routing.deployments.previousGraphBuildId).toBe(switched.to);
  });

  it('finishes a computation that started on blue on blue, even after the switch', async () => {
    const fake = engines();
    const routing = await started(fake);
    const blueId = routing.deployments.activeGraphBuildId;
    fake.holdBlue();
    const inFlight = routing.walkingRoutes.compute('athlete-1', request, {});
    await vi.waitFor(() => expect(fake.blueHeld()).toBe(true));
    const switched = await routing.deployments.switchTo(green(await greenGraph()));
    // New work goes to green while blue is still answering the old request.
    expect(await graphOf(routing)).toBe(switched.to);
    fake.releaseBlue();
    const { result } = await inFlight;
    expect(result.outcome).toBe('route_computed');
    expect(result.computation.graph.graphBuildId).toBe(blueId);
  });

  it('refuses a green engine that is not serving the graph it is pinned to, and changes nothing', async () => {
    const fake = engines();
    const routing = await started(fake);
    const blueId = routing.deployments.activeGraphBuildId;
    fake.state.green.info = engineInfo;
    const refusal = await routing.deployments
      .switchTo(green(await greenGraph()))
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RoutingSwitchError);
    expect(refusal).toMatchObject({
      code: 'ROUTING_SWITCH_ENGINE_NOT_SERVING',
      engineOutcome: 'graph_mismatch',
    });
    expect(routing.deployments.activeGraphBuildId).toBe(blueId);
    expect(await graphOf(routing)).toBe(blueId);
    expect(fake.state.green.calls).toBe(0);
  });

  it('refuses a green engine that is down', async () => {
    const fake = engines();
    const routing = await started(fake);
    fake.state.green.up = false;
    await expect(routing.deployments.switchTo(green(await greenGraph()))).rejects.toMatchObject({
      code: 'ROUTING_SWITCH_ENGINE_NOT_SERVING',
      engineOutcome: 'engine_unavailable',
    });
  });

  it('refuses an in-place replacement on the active engine', async () => {
    const fake = engines();
    const routing = await started(fake);
    await expect(
      routing.deployments.switchTo({
        ...configured(),
        ROUTING_GRAPH_DIRECTORY: await greenGraph(),
      }),
    ).rejects.toMatchObject({ code: 'ROUTING_SWITCH_SAME_ENGINE' });
  });

  it('refuses a green graph whose files do not verify', async () => {
    const fake = engines();
    const routing = await started(fake);
    const graph = await greenGraph();
    await writeFile(join(graph, 'edges'), 'tampered');
    await expect(routing.deployments.switchTo(green(graph))).rejects.toMatchObject({
      code: 'GRAPH_CONTENT_CHANGED',
    });
    expect(routing.deployments.previousGraphBuildId).toBeNull();
  });

  it('refuses a rollback with nothing to roll back to, or to an engine that is gone', async () => {
    const fake = engines();
    const routing = await started(fake);
    await expect(routing.deployments.rollback()).rejects.toMatchObject({
      code: 'ROUTING_ROLLBACK_UNAVAILABLE',
    });
    const switched = await routing.deployments.switchTo(green(await greenGraph()));
    fake.state.blue.up = false;
    await expect(routing.deployments.rollback()).rejects.toMatchObject({
      code: 'ROUTING_SWITCH_ENGINE_NOT_SERVING',
      engineOutcome: 'engine_unavailable',
    });
    expect(routing.deployments.activeGraphBuildId).toBe(switched.to);
    expect(await graphOf(routing)).toBe(switched.to);
  });

  it('keeps one tenant bound across the switch', async () => {
    const fake = engines();
    const routing = await started(fake);
    fake.holdBlue();
    const held = [
      routing.walkingRoutes.compute('athlete-1', request, {}),
      routing.walkingRoutes.compute('athlete-1', request, {}),
    ];
    await vi.waitFor(() => expect(fake.state.blue.calls).toBe(2));
    await routing.deployments.switchTo(green(await greenGraph()));
    const refused = await routing.walkingRoutes.compute('athlete-1', request, {});
    expect(refused.result.outcome).toBe('overloaded');
    fake.releaseBlue();
    for (const { result } of await Promise.all(held)) expect(result.outcome).toBe('route_computed');
  });

  describe('the operator switch file', () => {
    it('switches and rolls back through the file the entrypoint reads on SIGHUP', async () => {
      const fake = engines();
      const routing = await started(fake);
      const blueId = routing.deployments.activeGraphBuildId;
      const file = join(directory, 'switch.json');
      await writeFile(file, JSON.stringify({ action: 'switch', ...green(await greenGraph()) }));
      const switched = await applyRoutingSwitchFile(routing.deployments, file);
      expect(switched.from).toBe(blueId);
      expect(await graphOf(routing)).toBe(switched.to);
      await writeFile(file, JSON.stringify({ action: 'rollback' }));
      expect(await applyRoutingSwitchFile(routing.deployments, file)).toEqual({
        from: switched.to,
        to: blueId,
      });
    });

    it('cannot widen the engine host allowlist fixed at startup', async () => {
      const fake = engines();
      const routing = await started(fake);
      const file = join(directory, 'switch.json');
      const graph = await greenGraph();
      await writeFile(
        file,
        JSON.stringify({
          action: 'switch',
          ...green(graph),
          ROUTING_ENGINE_ALLOWED_HOSTS: 'routing.internal',
        }),
      );
      await expect(applyRoutingSwitchFile(routing.deployments, file)).rejects.toThrow(
        'ROUTING_SWITCH_FILE_INVALID',
      );
      await writeFile(
        file,
        JSON.stringify({
          action: 'switch',
          ...green(graph),
          ROUTING_ENGINE_URL: 'http://routing.internal:8993/',
        }),
      );
      const refusal = await applyRoutingSwitchFile(routing.deployments, file).catch(
        (error: unknown) => error,
      );
      expect(switchRefusalCode(refusal)).toBe('ENDPOINT_HOST_NOT_ALLOWED');
    });

    it('refuses a switch file that anyone but its owner could have written', async () => {
      const fake = engines();
      const routing = await started(fake);
      const file = join(directory, 'switch.json');
      await writeFile(file, JSON.stringify({ action: 'switch', ...green(await greenGraph()) }));
      for (const mode of [0o664, 0o646, 0o666]) {
        await chmod(file, mode);
        const refusal = await applyRoutingSwitchFile(routing.deployments, file).catch(
          (error: unknown) => error,
        );
        expect(switchRefusalCode(refusal)).toBe('ROUTING_SWITCH_FILE_WRITABLE_BY_OTHERS');
      }
      expect(routing.deployments.previousGraphBuildId).toBeNull();
      await chmod(file, 0o600);
      const blueId = routing.deployments.activeGraphBuildId;
      const switched = await applyRoutingSwitchFile(routing.deployments, file);
      expect(switched.from).toBe(blueId);
      expect(routing.deployments.activeGraphBuildId).toBe(switched.to);
    });

    it('refuses anything but a regular file, and a FIFO without blocking', async () => {
      const fake = engines();
      const routing = await started(fake);
      const folder = join(directory, 'switch-dir');
      await mkdir(folder, { mode: 0o700 });
      expect(
        switchRefusalCode(
          await applyRoutingSwitchFile(routing.deployments, folder).catch(
            (error: unknown) => error,
          ),
        ),
      ).toBe('ROUTING_SWITCH_FILE_NOT_REGULAR');
      if (process.platform !== 'win32') {
        const fifo = join(directory, 'switch.fifo');
        execFileSync('mkfifo', ['-m', '600', fifo]);
        // Without O_NONBLOCK the open waits for a writer forever; the race makes that a failure.
        const outcome = await Promise.race([
          applyRoutingSwitchFile(routing.deployments, fifo).then(
            () => 'SWITCHED',
            (error: unknown) => switchRefusalCode(error),
          ),
          new Promise<string>((done) => setTimeout(() => done('BLOCKED'), 1_000)),
        ]);
        expect(outcome).toBe('ROUTING_SWITCH_FILE_NOT_REGULAR');
      }
      expect(routing.deployments.previousGraphBuildId).toBeNull();
    });

    it('refuses a relative switch file path', async () => {
      const fake = engines();
      const routing = await started(fake);
      await expect(
        applyRoutingSwitchFile(routing.deployments, 'switch.json'),
      ).rejects.toMatchObject({ code: 'ROUTING_PATH_NOT_ABSOLUTE' });
    });

    it('logs a refusal by its code only, never a message that may carry a path', () => {
      expect(switchRefusalCode(new RoutingSwitchError('ROUTING_SWITCH_SAME_ENGINE'))).toBe(
        'ROUTING_SWITCH_SAME_ENGINE',
      );
      expect(switchRefusalCode(new Error('/private/graph/foot is gone'))).toBe(
        'ROUTING_SWITCH_FAILED',
      );
      expect(switchRefusalCode(new Error('ROUTING_SWITCH_FILE_INVALID'))).toBe(
        'ROUTING_SWITCH_FILE_INVALID',
      );
    });
  });
});
