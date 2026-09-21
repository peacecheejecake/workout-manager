import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ROUTING_GRAPH_MANIFEST_FILE,
  hashGraphDirectory,
  loadRoutingDeployment,
  createRoutingEngineEndpoint,
  type RoutingDeployment,
  type RoutingEngineTransport,
  type RoutingGraphManifest,
} from '../src/routing/index.js';

/**
 * Build a real deployment the only supported way: files on disk, verified.
 *
 * The tests deliberately do not have a shortcut for this. A deployment that could be
 * asserted rather than proved is exactly the hole this fixture exists to keep closed.
 */
export async function verifiedDeployment(options: {
  transport: RoutingEngineTransport;
  manifest?: Partial<RoutingGraphManifest>;
}): Promise<{ deployment: RoutingDeployment; manifest: RoutingGraphManifest; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'routing-deployment-'));
  const enginePath = join(directory, 'engine.jar');
  const configPath = join(directory, 'profile.yml');
  await writeFile(enginePath, 'engine-artifact-bytes');
  await writeFile(configPath, 'profile-configuration-bytes');
  const graphDirectory = join(directory, 'graph');
  await mkdir(graphDirectory, { recursive: true });
  await writeFile(join(graphDirectory, 'edges'), 'edge-bytes');
  await writeFile(
    join(graphDirectory, 'properties.txt'),
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
    engineArtifactSha256: await hashOf(enginePath),
    profileId: 'foot-v1',
    profileConfigSha256: await hashOf(configPath),
    profileName: 'foot',
    extractSha256: '7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea',
    extractRegion: 'Seoul (BBBike city extract)',
    extractByteLength: 51_884_841,
    graphContentSha256: await hashGraphDirectory(graphDirectory),
    graphImportedAt: '2026-09-21T14:09:12.000Z',
    roadDataAt: '2026-09-18T23:00:00.000Z',
    builtAt: '2026-09-21T14:09:14.321Z',
    ...options.manifest,
  };
  await writeFile(
    join(graphDirectory, ROUTING_GRAPH_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const deployment = await loadRoutingDeployment({
    graphDirectory,
    engineArtifactPath: enginePath,
    profileConfigPath: configPath,
    endpoint: createRoutingEngineEndpoint('http://127.0.0.1:8991/'),
    transportFactory: () => options.transport,
  });
  return { deployment, manifest, directory };
}

export function deploymentPaths(directory: string) {
  return {
    graphDirectory: join(directory, 'graph'),
    enginePath: join(directory, 'engine.jar'),
    configPath: join(directory, 'profile.yml'),
  };
}
