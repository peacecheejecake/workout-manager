/**
 * M2-01g: build the pedestrian routing graph and write the manifest that binds it to the
 * extract, profile and engine artifact it was built from.
 *
 *   node --import tsx scripts/build-routing-graph.mts --execute [--reuse]
 *
 * Opt-in only, refuses to run in CI. Downloads nothing that is not already in the
 * operations allowlist and contacts no external routing service.
 *
 * Why a build-time manifest. Configuration can state hashes, but a hash in a config file
 * describes an intention, not the bytes the engine imported. Here the import happens in
 * this process, the engine reports its own version and the timestamps it wrote into the
 * graph, and the graph files are hashed after the engine has exited. Load time recomputes
 * that hash, so a graph whose files changed is refused instead of served.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROUTING_GRAPH_MANIFEST_FILE,
  graphBuildIdFromManifest,
  hashGraphDirectory,
  loadVerifiedRoutingGraph,
  readGraphProperties,
  routingGraphManifestSchema,
  type RoutingGraphManifest,
} from '../packages/server/integrations/src/routing/index.js';
// The allowlist is the only way data acquisition happens; it takes ids, never URLs.
import { verifyAllowedSourceFile } from './geo/sources.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const extractPath = join(workRoot, 'source', 'region.osm.pbf');
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
const servingConfigSource = join(repositoryRoot, 'scripts/geo/graphhopper-foot-serving.yml');

/** Built here, separate from M2-01d's measurement graph, which stays untouched. */
export const routingGraphDirectory = join(workRoot, 'routing-graph', 'foot');
export const routingGraphConfig = join(workRoot, 'routing-graph', 'config-serving.yml');

const EXTRACT_REGION = 'Seoul (BBBike city extract)';
const ENGINE_PORT = 8991;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const wait = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

export interface EngineHandle {
  readonly process: ChildProcess;
  readonly log: () => string;
}

/** Starts the engine on loopback with the pinned serving profile. */
export function startEngine(options: {
  jarPath: string;
  configPath: string;
  extractPath: string;
  graphPath: string;
  heapMegabytes?: number;
}): EngineHandle {
  const child = spawn(
    'java',
    [
      `-Xmx${options.heapMegabytes ?? 2048}m`,
      '-Xms512m',
      `-Ddw.graphhopper.datareader.file=${options.extractPath}`,
      `-Ddw.graphhopper.graph.location=${options.graphPath}`,
      '-jar',
      options.jarPath,
      'server',
      options.configPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: dirname(options.jarPath) },
  );
  let log = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      log = `${log}${chunk}`.slice(-32768);
    });
  }
  return { process: child, log: () => log };
}

export async function waitForEngine(engine: EngineHandle, port = ENGINE_PORT): Promise<void> {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    if (engine.process.exitCode !== null)
      throw new Error(`ENGINE_EXITED: ${engine.log().slice(-1500)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      await response.text();
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await wait(500);
  }
  throw new Error(`ENGINE_NOT_READY: ${engine.log().slice(-1500)}`);
}

/** SIGTERM, then wait for the process to actually exit before touching its files. */
export async function stopEngine(engine: EngineHandle): Promise<void> {
  if (engine.process.exitCode !== null) return;
  engine.process.kill('SIGTERM');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (engine.process.exitCode !== null || engine.process.signalCode !== null) return;
    await wait(250);
  }
  engine.process.kill('SIGKILL');
  await wait(500);
}

/**
 * Import a fresh graph into `graphDirectory` with the deployed serving configuration and
 * write the manifest that binds it to its inputs. The directory is emptied first. The
 * engine is started only for the import and stopped before any file is hashed.
 *
 * Exported so a second, independent graph build (M2-01k's replacement/rollback run) goes
 * through this exact manifest writer rather than a copy of it. The caller passes input
 * hashes it has already checked against the allowlist.
 *
 * DESTRUCTIVE: `graphDirectory` is removed recursively (`rm -rf`) before the import. Pass
 * only a directory this build owns, never a deployed graph that is being served.
 */
export async function importRoutingGraph(options: {
  readonly graphDirectory: string;
  readonly engineArtifactSha256: string;
  readonly extractSha256: string;
  readonly profileConfigSha256: string;
  readonly extractByteLength: number;
}): Promise<RoutingGraphManifest> {
  await rm(options.graphDirectory, { recursive: true, force: true });
  await mkdir(options.graphDirectory, { recursive: true });

  const engine = startEngine({
    jarPath,
    configPath: routingGraphConfig,
    extractPath,
    graphPath: options.graphDirectory,
  });
  let info: { version: string; import_date: string; data_date: string; profiles: string[] };
  try {
    await waitForEngine(engine);
    const response = await fetch(`http://127.0.0.1:${ENGINE_PORT}/info`);
    const body: unknown = await response.json();
    const parsed = body as {
      version?: unknown;
      import_date?: unknown;
      data_date?: unknown;
      profiles?: { name?: unknown }[];
    };
    if (
      typeof parsed.version !== 'string' ||
      typeof parsed.import_date !== 'string' ||
      typeof parsed.data_date !== 'string' ||
      !Array.isArray(parsed.profiles)
    )
      throw new Error('ENGINE_INFO_UNUSABLE');
    info = {
      version: parsed.version,
      import_date: parsed.import_date,
      data_date: parsed.data_date,
      profiles: parsed.profiles.map((profile) => String(profile.name)),
    };
  } finally {
    // The graph is only hashed once the engine that wrote it has exited.
    await stopEngine(engine);
  }

  const properties = await readGraphProperties(options.graphDirectory);
  if (
    Date.parse(properties.graphImportedAt) !== Date.parse(info.import_date) ||
    Date.parse(properties.roadDataAt) !== Date.parse(info.data_date)
  )
    throw new Error('GRAPH_PROPERTIES_DISAGREE_WITH_ENGINE');
  if (!info.profiles.includes('foot')) throw new Error('ENGINE_PROFILE_MISSING');

  const graphContentSha256 = await hashGraphDirectory(options.graphDirectory);
  const manifest: RoutingGraphManifest = routingGraphManifestSchema.parse({
    schemaVersion: 1,
    engine: 'graphhopper',
    engineVersion: info.version,
    engineArtifactSha256: options.engineArtifactSha256,
    profileId: 'foot-v1',
    profileConfigSha256: options.profileConfigSha256,
    profileName: 'foot',
    extractSha256: options.extractSha256,
    extractRegion: EXTRACT_REGION,
    extractByteLength: options.extractByteLength,
    graphContentSha256,
    graphImportedAt: properties.graphImportedAt,
    roadDataAt: properties.roadDataAt,
    builtAt: new Date().toISOString(),
  } satisfies RoutingGraphManifest);

  await writeFile(
    join(options.graphDirectory, ROUTING_GRAPH_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function main() {
  const argv = process.argv.slice(2);
  const reuse = argv.includes('--reuse');
  if (!argv.includes('--execute') || argv.some((a) => a !== '--execute' && a !== '--reuse')) {
    console.log(
      'Opt-in only: node --import tsx scripts/build-routing-graph.mts --execute [--reuse]. ' +
        'Imports the pedestrian graph from the allowlisted extract already under .geo-build and writes ' +
        'the graph manifest. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Routing graph builds are disabled in CI');

  for (const required of [extractPath, jarPath, servingConfigSource]) {
    try {
      await stat(required);
    } catch {
      throw new Error(`MISSING_PREREQUISITE: ${required}`);
    }
  }
  // A cached jar is checked against the allowlist pin before it is allowed to build.
  const jarIdentity = await verifyAllowedSourceFile('graphhopper-web-jar', jarPath);
  const extractSha256 = await sha256File(extractPath);
  const profileConfigSha256 = await sha256File(servingConfigSource);
  const extractByteLength = (await stat(extractPath)).size;

  await mkdir(dirname(routingGraphConfig), { recursive: true });

  if (reuse) {
    // Reuse may keep an existing graph; it may never relabel one. Without this check a
    // changed extract would be stamped onto an old graph and the manifest would claim
    // provenance the graph does not have. So reuse is only allowed when the existing
    // manifest already describes exactly these inputs, and the graph still hashes to it.
    let existing;
    try {
      existing = await loadVerifiedRoutingGraph(routingGraphDirectory);
    } catch (error) {
      throw new Error(
        `REUSE_REFUSED_NO_VERIFIED_GRAPH: ${error instanceof Error ? error.message : 'unknown'}. ` +
          'Run without --reuse to import a fresh graph.',
      );
    }
    const differences = [
      ['extract', existing.manifest.extractSha256, extractSha256],
      ['profile config', existing.manifest.profileConfigSha256, profileConfigSha256],
      ['engine artifact', existing.manifest.engineArtifactSha256, jarIdentity.sha256],
    ].filter(([, recorded, current]) => recorded !== current);
    if (differences.length > 0)
      throw new Error(
        `REUSE_REFUSED_INPUTS_CHANGED: ${differences
          .map(
            ([what, recorded, current]) =>
              `${what} ${String(recorded).slice(0, 12)} -> ${String(current).slice(0, 12)}`,
          )
          .join(
            ', ',
          )}. The existing graph was not built from these inputs; run without --reuse to re-import.`,
      );
    // Only now that reuse is validated is the deployed configuration touched. Copying
    // first meant a refused reuse still overwrote the config of a running deployment.
    await copyFile(servingConfigSource, routingGraphConfig);
    console.log(
      JSON.stringify({
        reused: true,
        graphDirectory: routingGraphDirectory,
        graphBuildId: existing.graphBuildId,
        graphContentSha256: existing.manifest.graphContentSha256,
        engineVersion: existing.manifest.engineVersion,
        graphImportedAt: existing.manifest.graphImportedAt,
        roadDataAt: existing.manifest.roadDataAt,
      }),
    );
    return;
  }

  await copyFile(servingConfigSource, routingGraphConfig);
  const manifest = await importRoutingGraph({
    graphDirectory: routingGraphDirectory,
    engineArtifactSha256: jarIdentity.sha256,
    extractSha256,
    profileConfigSha256,
    extractByteLength,
  });
  console.log(
    JSON.stringify({
      graphDirectory: routingGraphDirectory,
      graphBuildId: graphBuildIdFromManifest(manifest),
      graphContentSha256: manifest.graphContentSha256,
      engineVersion: manifest.engineVersion,
      graphImportedAt: manifest.graphImportedAt,
      roadDataAt: manifest.roadDataAt,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
