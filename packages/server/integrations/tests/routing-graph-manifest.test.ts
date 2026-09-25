import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GraphManifestError,
  ROUTING_GRAPH_MANIFEST_FILE,
  RoutingDeployment,
  assertVerifiedDeployment,
  createRoutingEngineEndpoint,
  graphBuildIdFromManifest,
  hashGraphDirectory,
  loadRoutingDeployment,
  loadVerifiedRoutingGraph,
  readGraphProperties,
  type RoutingEngineTransport,
  type RoutingGraphManifest,
} from '../src/routing/index.js';
import { deploymentPaths, verifiedDeployment } from './deployment-fixture.js';

const noopTransport: RoutingEngineTransport = {
  send: async () => ({ status: 200, bodyText: '{}', truncated: false, byteLength: 2 }),
};

const directories: string[] = [];

/** A graph-shaped directory: a few files plus the properties the engine writes. */
async function graphDirectory(files: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'routing-graph-'));
  directories.push(directory);
  await writeFile(join(directory, 'edges'), files.edges ?? 'edge-bytes');
  await writeFile(join(directory, 'nodes'), files.nodes ?? 'node-bytes');
  await writeFile(
    join(directory, 'properties.txt'),
    files['properties.txt'] ??
      [
        'datareader.import.date=2026-09-21T14:09:12Z',
        'datareader.data.date=2026-09-18T23:00:00Z',
        'profiles=foot|-1756884051',
      ].join('\n'),
  );
  return directory;
}

async function writeManifest(directory: string, overrides: Partial<RoutingGraphManifest> = {}) {
  const manifest: RoutingGraphManifest = {
    schemaVersion: 1,
    engine: 'graphhopper',
    engineVersion: '10.0',
    engineArtifactSha256: 'e'.repeat(64),
    profileId: 'foot-v1',
    profileConfigSha256: 'f'.repeat(64),
    profileName: 'foot',
    extractSha256: '7'.repeat(64),
    extractRegion: 'Seoul (BBBike city extract)',
    extractByteLength: 51_884_841,
    graphContentSha256: await hashGraphDirectory(directory),
    graphImportedAt: '2026-09-21T14:09:12.000Z',
    roadDataAt: '2026-09-18T23:00:00.000Z',
    builtAt: '2026-09-21T14:09:14.321Z',
    ...overrides,
  };
  await writeFile(
    join(directory, ROUTING_GRAPH_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('graph manifest', () => {
  it('reads the import and road-data timestamps the engine wrote into the graph', async () => {
    const directory = await graphDirectory();
    const properties = await readGraphProperties(directory);
    expect(properties.graphImportedAt).toBe('2026-09-21T14:09:12.000Z');
    expect(properties.roadDataAt).toBe('2026-09-18T23:00:00.000Z');
  });

  it('hashes the graph files and ignores the manifest itself', async () => {
    const directory = await graphDirectory();
    const before = await hashGraphDirectory(directory);
    await writeManifest(directory);
    expect(await hashGraphDirectory(directory)).toBe(before);
  });

  it('notices a single changed byte in the graph', async () => {
    const directory = await graphDirectory();
    const before = await hashGraphDirectory(directory);
    await writeFile(join(directory, 'edges'), 'edge-byteS');
    expect(await hashGraphDirectory(directory)).not.toBe(before);
  });

  it('verifies a graph whose files still match the manifest', async () => {
    const directory = await graphDirectory();
    const manifest = await writeManifest(directory);
    const verified = await loadVerifiedRoutingGraph(directory);
    expect(verified.manifest.graphContentSha256).toBe(manifest.graphContentSha256);
    expect(verified.graphBuildId).toBe(graphBuildIdFromManifest(manifest));
  });

  it('refuses a graph whose files changed after the manifest was written', async () => {
    const directory = await graphDirectory();
    await writeManifest(directory);
    await writeFile(join(directory, 'nodes'), 'tampered');
    await expect(loadVerifiedRoutingGraph(directory)).rejects.toMatchObject({
      code: 'GRAPH_CONTENT_CHANGED',
    });
  });

  it('refuses a graph with no manifest at all', async () => {
    const directory = await graphDirectory();
    await expect(loadVerifiedRoutingGraph(directory)).rejects.toBeInstanceOf(GraphManifestError);
    await expect(loadVerifiedRoutingGraph(directory)).rejects.toMatchObject({
      code: 'MANIFEST_MISSING',
    });
  });

  it('refuses a manifest that is not the expected shape', async () => {
    const directory = await graphDirectory();
    await writeFile(join(directory, ROUTING_GRAPH_MANIFEST_FILE), '{"schemaVersion":1}');
    await expect(loadVerifiedRoutingGraph(directory)).rejects.toMatchObject({
      code: 'MANIFEST_MALFORMED',
    });
  });

  it('refuses a graph whose properties cannot be read', async () => {
    const directory = await graphDirectory({ 'properties.txt': 'nothing useful here' });
    await expect(readGraphProperties(directory)).rejects.toMatchObject({
      code: 'GRAPH_PROPERTIES_UNREADABLE',
    });
  });
});

describe('deployment verification', () => {
  it('refuses a deployment whose engine artifact is not the one in the manifest', async () => {
    const { directory } = await verifiedDeployment({ transport: noopTransport });
    directories.push(directory);
    const paths = deploymentPaths(directory);
    await writeFile(paths.enginePath, 'a different engine build');
    await expect(
      loadRoutingDeployment({
        graphDirectory: paths.graphDirectory,
        engineArtifactPath: paths.enginePath,
        profileConfigPath: paths.configPath,
        endpoint: createRoutingEngineEndpoint('http://127.0.0.1:8991/'),
        transportFactory: () => noopTransport,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_ARTIFACT_MISMATCH' });
  });

  it('refuses a deployment whose profile configuration changed', async () => {
    const { directory } = await verifiedDeployment({ transport: noopTransport });
    directories.push(directory);
    const paths = deploymentPaths(directory);
    await writeFile(paths.configPath, 'a different profile');
    await expect(
      loadRoutingDeployment({
        graphDirectory: paths.graphDirectory,
        engineArtifactPath: paths.enginePath,
        profileConfigPath: paths.configPath,
        endpoint: createRoutingEngineEndpoint('http://127.0.0.1:8991/'),
        transportFactory: () => noopTransport,
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_CONFIG_MISMATCH' });
  });

  it('refuses a deployment whose graph files changed after the manifest was written', async () => {
    const { directory } = await verifiedDeployment({ transport: noopTransport });
    directories.push(directory);
    const paths = deploymentPaths(directory);
    await writeFile(join(paths.graphDirectory, 'edges'), 'tampered');
    await expect(
      loadRoutingDeployment({
        graphDirectory: paths.graphDirectory,
        engineArtifactPath: paths.enginePath,
        profileConfigPath: paths.configPath,
        endpoint: createRoutingEngineEndpoint('http://127.0.0.1:8991/'),
        transportFactory: () => noopTransport,
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_CONTENT_CHANGED' });
  });

  it('carries the verified manifest and a derived deployment id', async () => {
    const { deployment, manifest, directory } = await verifiedDeployment({
      transport: noopTransport,
    });
    directories.push(directory);
    expect(deployment.manifest).toEqual(manifest);
    expect(deployment.graphBuildId).toBe(graphBuildIdFromManifest(manifest));
    expect(deployment.transport).toBe(noopTransport);
  });
});

describe('deployment construction cannot be bypassed', () => {
  /** The reviewer's bypass: reach the constructor through the public export. */
  const constructDirectly = (...args: unknown[]) =>
    new (RoutingDeployment as unknown as new (...parameters: unknown[]) => RoutingDeployment)(
      ...args,
    );

  it('exposes no static that can produce a deployment', () => {
    // `fromVerifiedParts` used to be a public static marked "not public API" in a comment.
    // The only static allowed here is a predicate; anything that returns a deployment
    // would be a second construction path and must fail this test.
    expect(
      (RoutingDeployment as unknown as Record<string, unknown>).fromVerifiedParts,
    ).toBeUndefined();
    expect(
      Object.getOwnPropertyNames(RoutingDeployment).filter(
        (name) => !['length', 'name', 'prototype'].includes(name),
      ),
    ).toEqual(['isVerified']);
    expect(RoutingDeployment.isVerified({})).toBe(false);
  });

  it('refuses a deployment built through the public API with a graph that does not exist', () => {
    const fabricated: RoutingGraphManifest = {
      schemaVersion: 1,
      engine: 'graphhopper',
      engineVersion: '10.0',
      engineArtifactSha256: 'a'.repeat(64),
      profileId: 'foot-v1',
      profileConfigSha256: 'a'.repeat(64),
      profileName: 'foot',
      extractSha256: 'a'.repeat(64),
      extractRegion: 'nowhere',
      extractByteLength: 1,
      graphContentSha256: 'a'.repeat(64),
      graphImportedAt: '2026-09-21T14:09:12.000Z',
      roadDataAt: '2026-09-18T23:00:00.000Z',
      builtAt: '2026-09-21T14:09:14.321Z',
    };
    expect(() =>
      constructDirectly(
        Symbol('not-the-real-key'),
        fabricated,
        '/does-not-exist',
        createRoutingEngineEndpoint('http://127.0.0.1:8991/'),
        noopTransport,
      ),
    ).toThrow(GraphManifestError);
    // Without any key at all, and with plausible-looking ones. `toThrow` actually calls
    // the function; an earlier version used `toMatchObject({})`, which never did, and so
    // proved nothing.
    for (const key of [
      undefined,
      'routing-deployment-construction',
      Symbol.for('routing-deployment-construction'),
      Symbol('routing-deployment-construction'),
      // Every symbol reachable from the module's public surface. The real key must not be
      // among them; an earlier version leaked it through an instance getter.
      ...Object.getOwnPropertySymbols(RoutingDeployment),
      ...Object.getOwnPropertySymbols(RoutingDeployment.prototype),
    ])
      expect(() =>
        constructDirectly(
          key,
          fabricated,
          '/does-not-exist',
          createRoutingEngineEndpoint('http://127.0.0.1:8991/'),
          noopTransport,
        ),
      ).toThrow(GraphManifestError);
  });

  it('refuses a mutation of the manifest after verification', async () => {
    const { deployment, manifest, directory } = await verifiedDeployment({
      transport: noopTransport,
    });
    directories.push(directory);
    const verifiedHash = deployment.manifest.graphContentSha256;
    expect(() => {
      (deployment.manifest as { graphContentSha256: string }).graphContentSha256 = 'b'.repeat(64);
    }).toThrow(TypeError);
    expect(deployment.manifest.graphContentSha256).toBe(verifiedHash);
    expect(deployment.graphBuildId).toBe(graphBuildIdFromManifest(manifest));
  });

  it('stores its own frozen copy rather than sharing a mutable manifest', async () => {
    const { deployment, directory } = await verifiedDeployment({ transport: noopTransport });
    directories.push(directory);
    const verifiedHash = deployment.manifest.graphContentSha256;
    // What a fresh verification of the same graph hands back is mutable and a different
    // object; the deployment's own copy is frozen and unaffected by edits to it.
    const otherHandle = await loadVerifiedRoutingGraph(deploymentPaths(directory).graphDirectory);
    expect(otherHandle.manifest).not.toBe(deployment.manifest);
    expect(Object.isFrozen(otherHandle.manifest)).toBe(false);
    expect(Object.isFrozen(deployment.manifest)).toBe(true);
    otherHandle.manifest.graphContentSha256 = 'c'.repeat(64);
    expect(deployment.manifest.graphContentSha256).toBe(verifiedHash);
  });

  it('refuses a swap of the deployment fields after construction', async () => {
    const { deployment, directory } = await verifiedDeployment({ transport: noopTransport });
    directories.push(directory);
    expect(Object.isFrozen(deployment)).toBe(true);
    expect(() => {
      (deployment as { graphBuildId: string }).graphBuildId = 'deadbeefdeadbeef';
    }).toThrow(TypeError);
  });
});

describe('an unverified deployment cannot be consumed', () => {
  const fabricated = {
    manifest: {
      schemaVersion: 1,
      engine: 'graphhopper',
      engineVersion: '10.0',
      engineArtifactSha256: 'a'.repeat(64),
      profileId: 'foot-v1',
      profileConfigSha256: 'a'.repeat(64),
      profileName: 'foot',
      extractSha256: 'a'.repeat(64),
      extractRegion: 'nowhere',
      extractByteLength: 1,
      graphContentSha256: 'a'.repeat(64),
      graphImportedAt: '2026-09-21T14:09:12.000Z',
      roadDataAt: '2026-09-18T23:00:00.000Z',
      builtAt: '2026-09-21T14:09:14.321Z',
    },
    graphBuildId: 'deadbeefdeadbeef',
    graphDirectory: '/does-not-exist',
    endpoint: createRoutingEngineEndpoint('http://127.0.0.1:8991/'),
    transport: noopTransport,
  };

  it('refuses a structurally identical object that never went through verification', () => {
    expect(RoutingDeployment.isVerified(fabricated)).toBe(false);
    expect(() => assertVerifiedDeployment(fabricated)).toThrow(GraphManifestError);
    expect(() => assertVerifiedDeployment(fabricated)).toThrow('DEPLOYMENT_NOT_VERIFIED');
  });

  it('accepts a deployment that did go through verification', async () => {
    const { deployment, directory } = await verifiedDeployment({ transport: noopTransport });
    directories.push(directory);
    expect(RoutingDeployment.isVerified(deployment)).toBe(true);
    expect(assertVerifiedDeployment(deployment)).toBe(deployment);
  });

  it('refuses an object whose prototype was set to the class', () => {
    // `instanceof` alone would pass this; WeakSet membership does not.
    const disguised = Object.create(RoutingDeployment.prototype) as Record<string, unknown>;
    Object.assign(disguised, fabricated);
    expect(disguised instanceof RoutingDeployment).toBe(true);
    expect(RoutingDeployment.isVerified(disguised)).toBe(false);
    expect(() => assertVerifiedDeployment(disguised)).toThrow(GraphManifestError);
  });
});

describe('the construction key is not reachable from a valid instance', () => {
  /**
   * The defect this closes: the key was stored in the nominal field and exposed through a
   * getter, so a caller could read it off any legitimate deployment and construct a forged
   * one — which the constructor then registered in the WeakSet itself, making
   * `isVerified` return true for an arbitrary graph hash.
   *
   * It is not enough that a guard exists. The material the guard trusts must be
   * unreachable, so this test harvests everything a caller can get from a valid instance
   * and proves none of it opens the constructor.
   */
  const fabricated: RoutingGraphManifest = {
    schemaVersion: 1,
    engine: 'graphhopper',
    engineVersion: '10.0',
    engineArtifactSha256: 'a'.repeat(64),
    profileId: 'foot-v1',
    profileConfigSha256: 'a'.repeat(64),
    profileName: 'foot',
    extractSha256: 'a'.repeat(64),
    extractRegion: 'nowhere',
    extractByteLength: 1,
    graphContentSha256: 'a'.repeat(64),
    graphImportedAt: '2026-09-21T14:09:12.000Z',
    roadDataAt: '2026-09-18T23:00:00.000Z',
    builtAt: '2026-09-21T14:09:14.321Z',
  };

  /** Everything a caller can read off an instance, its prototype and the class. */
  function reachableValues(deployment: RoutingDeployment): unknown[] {
    const found: unknown[] = [];
    const visit = (target: object) => {
      for (const key of [
        ...Object.getOwnPropertyNames(target),
        ...Object.getOwnPropertySymbols(target),
      ]) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (descriptor === undefined) continue;
        if (descriptor.get !== undefined) {
          try {
            found.push(descriptor.get.call(deployment));
          } catch {
            // a getter that throws exposes nothing
          }
        }
        if ('value' in descriptor) found.push(descriptor.value);
      }
    };
    visit(deployment);
    visit(Object.getPrototypeOf(deployment) as object);
    visit(RoutingDeployment);
    found.push(deployment.manifest, deployment.endpoint, deployment.transport);
    return found;
  }

  it('exposes no symbol at all on a valid instance', async () => {
    const { deployment, directory } = await verifiedDeployment({ transport: noopTransport });
    directories.push(directory);
    expect(Object.getOwnPropertySymbols(deployment)).toEqual([]);
    expect(reachableValues(deployment).filter((value) => typeof value === 'symbol')).toEqual([]);
  });

  it('cannot construct an unverified deployment from anything a valid instance yields', async () => {
    const { deployment, directory } = await verifiedDeployment({ transport: noopTransport });
    directories.push(directory);
    const candidates = reachableValues(deployment);
    expect(candidates.length).toBeGreaterThan(5);
    for (const candidate of candidates) {
      let forged: RoutingDeployment | undefined;
      try {
        forged = new (
          RoutingDeployment as unknown as new (...parameters: unknown[]) => RoutingDeployment
        )(
          candidate,
          fabricated,
          '/does-not-exist',
          createRoutingEngineEndpoint('http://127.0.0.1:8991/'),
          noopTransport,
        );
      } catch {
        continue; // refused, which is the expected outcome
      }
      // If construction succeeded, the guard is broken: report which value opened it.
      expect({
        openedBy: String(candidate),
        isVerified: RoutingDeployment.isVerified(forged),
      }).toBe('no value from a valid instance may construct a deployment');
    }
  });

  it('keeps a forged deployment out of the verified set even if one were built', async () => {
    const { deployment, directory } = await verifiedDeployment({ transport: noopTransport });
    directories.push(directory);
    // The nominal field is not the key, so copying the instance shape proves nothing.
    const copied = { ...deployment } as unknown;
    expect(RoutingDeployment.isVerified(copied)).toBe(false);
    expect(() => assertVerifiedDeployment(copied)).toThrow(GraphManifestError);
  });
});

describe('the trust path has no public member on it', () => {
  const fabricatedDeployment = () => ({
    manifest: {
      schemaVersion: 1,
      engine: 'graphhopper',
      engineVersion: '10.0',
      engineArtifactSha256: 'a'.repeat(64),
      profileId: 'foot-v1',
      profileConfigSha256: 'a'.repeat(64),
      profileName: 'foot',
      extractSha256: 'a'.repeat(64),
      extractRegion: 'nowhere',
      extractByteLength: 1,
      graphContentSha256: 'a'.repeat(64),
      graphImportedAt: '2026-09-21T14:09:12.000Z',
      roadDataAt: '2026-09-18T23:00:00.000Z',
      builtAt: '2026-09-21T14:09:14.321Z',
    },
    graphBuildId: 'deadbeefdeadbeef',
    graphDirectory: '/does-not-exist',
    endpoint: createRoutingEngineEndpoint('http://127.0.0.1:8991/'),
    transport: noopTransport,
  });

  /**
   * The predicate-replacement bypass: `RoutingDeployment.isVerified = () => true` was
   * enough, because the assertion called that public static instead of the WeakSet.
   */
  it('still refuses a forged object after the public predicate is replaced', () => {
    const original = RoutingDeployment.isVerified;
    // The class is frozen, so this should throw; the point of the test is what happens to
    // the guard either way, so the outcome of the assignment itself is not asserted here.
    try {
      (RoutingDeployment as unknown as Record<string, unknown>).isVerified = () => true;
    } catch {
      // frozen, as intended
    }
    try {
      const forged = fabricatedDeployment();
      expect(() => assertVerifiedDeployment(forged)).toThrow(GraphManifestError);
      expect(() => assertVerifiedDeployment(forged)).toThrow('DEPLOYMENT_NOT_VERIFIED');
    } finally {
      if (RoutingDeployment.isVerified !== original)
        (RoutingDeployment as unknown as Record<string, unknown>).isVerified = original;
    }
  });

  it('still refuses a forged object at the adapter after the predicate is replaced', async () => {
    const original = RoutingDeployment.isVerified;
    try {
      (RoutingDeployment as unknown as Record<string, unknown>).isVerified = () => true;
    } catch {
      // frozen, as intended
    }
    try {
      const { GraphHopperRoutingAdapter } = await import('../src/routing/index.js');
      expect(
        () =>
          new GraphHopperRoutingAdapter({
            deployment: fabricatedDeployment() as never,
            clock: { now: () => new Date('2026-09-21T12:00:00.000Z') },
          }),
      ).toThrow(GraphManifestError);
    } finally {
      if (RoutingDeployment.isVerified !== original)
        (RoutingDeployment as unknown as Record<string, unknown>).isVerified = original;
    }
  });

  /**
   * White-box on purpose. Freezing the class makes the public predicate unreplaceable, so
   * a behavioural test cannot tell "the assertion does not use it" apart from "it uses it
   * but nobody can swap it". Both properties are wanted, and only this one pins the first:
   * removing the public member from the trust path is the primary fix, the freeze is
   * defence in depth. Verified by reverting each independently.
   */
  it('routes the assertion through the module-private predicate, not the public static', () => {
    const source = assertVerifiedDeployment.toString();
    expect(source).toContain('isRegisteredDeployment');
    expect(source).not.toContain('isVerified');
  });

  it('cannot be redefined: the class and its prototype are frozen', () => {
    expect(Object.isFrozen(RoutingDeployment)).toBe(true);
    expect(Object.isFrozen(RoutingDeployment.prototype)).toBe(true);
    expect(() =>
      Object.defineProperty(RoutingDeployment, 'isVerified', { value: () => true }),
    ).toThrow(TypeError);
  });

  /**
   * The harvesting idea pointed at the trust path itself: enumerate every member a caller
   * can reach on the guard's public surface and assert none of it is writable.
   */
  it('exposes nothing writable on the guard surface', () => {
    for (const target of [RoutingDeployment, RoutingDeployment.prototype]) {
      for (const key of [
        ...Object.getOwnPropertyNames(target),
        ...Object.getOwnPropertySymbols(target),
      ]) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        expect(descriptor).toBeDefined();
        if (descriptor === undefined) continue;
        expect({ key: String(key), configurable: descriptor.configurable }).toEqual({
          key: String(key),
          configurable: false,
        });
        if ('writable' in descriptor)
          expect({ key: String(key), writable: descriptor.writable }).toEqual({
            key: String(key),
            writable: false,
          });
      }
    }
  });
});
