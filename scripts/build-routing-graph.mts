/**
 * M2-01g: build the pedestrian routing graph and write the manifest that binds it to the
 * extract, profile and engine artifact it was built from.
 *
 *   node --import tsx scripts/build-routing-graph.mts --execute [--reuse | --replace-served-graph]
 *   ROUTING_GRAPH_ROOT=<absolute dir outside .geo-build> node --import tsx ... --execute
 *     (a green deployment beside the served one; see `routingGraphRootFrom`)
 *
 * A full import over a directory that already holds a graph manifest is refused unless
 * `--replace-served-graph` is given (`fullImportRefusal`): the blue/green procedure builds
 * beside the served graph instead of over it.
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
import { createReadStream, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
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
import { graphhopperJavaArguments } from './geo/graphhopper-launch.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
const servingConfigSource = join(repositoryRoot, 'scripts/geo/graphhopper-foot-serving.yml');

/**
 * Where the served graph and its profile copy live: `.geo-build/routing-graph`, separate from
 * M2-01d's measurement graph, which stays untouched.
 *
 * `ROUTING_GRAPH_ROOT` (an absolute directory outside `.geo-build`) moves the whole layout,
 * graph, profile copy and the operational probe's graph B, somewhere else (M2-01af). A
 * rebuild with a changed profile then produces a green deployment beside the served one
 * instead of overwriting it, which is what the blue/green procedure needs, and the shared
 * `.geo-build` cache is not written. The build, the operational probe and the swap probe
 * all read these constants, so one variable points all three at the same deployment.
 */
export function routingGraphRootFrom(
  value: string | undefined,
  geoBuild: string = workRoot,
): string {
  if (value === undefined || value === '') return join(geoBuild, 'routing-graph');
  if (!isAbsolute(value)) throw new Error('ROUTING_GRAPH_ROOT_NOT_ABSOLUTE');
  const root = resolve(value);
  // Judged by where the path leads, not by how it is spelled (M2-01ak review round 1): the
  // nearest existing ancestor is resolved through symbolic links (a worktree's `.geo-build`
  // is itself a link, and any other link can alias it), and the comparison ignores case,
  // because APFS and the default macOS volume are case-insensitive (`.GEO-BUILD` is
  // `.geo-build`). The approach of `realOutputPath` in scripts/performance-budget.ts.
  const target = comparablePath(root);
  const spellings = new Set([comparablePath(resolve(geoBuild)), resolve(geoBuild).toLowerCase()]);
  for (const spelling of spellings)
    if (target === spelling || target.startsWith(`${spelling}${sep}`))
      throw new Error('ROUTING_GRAPH_ROOT_INSIDE_GEO_BUILD: leave it unset for .geo-build');
  return root;
}

/**
 * `path` with its nearest existing ancestor resolved through symbolic links and the
 * not-yet-existing rest appended, lower-cased for a case-insensitive comparison. A dangling
 * link (its target not created yet) is followed to where it will lead (M2-01ak review round 2):
 * `elsewhere/dangling -> .geo-build/newdir` must be judged as `.geo-build/newdir`, or a later
 * `mkdir` through it would create the graph inside `.geo-build`. As `realOutputPath` in
 * scripts/performance-budget.ts, bounded so a cycle of dangling links cannot spin.
 */
function comparablePath(path: string): string {
  const missing: string[] = [];
  let existing = path;
  for (let hops = 0; hops < 256; hops += 1) {
    try {
      return join(realpathSync(existing), ...missing.reverse()).toLowerCase();
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) return path.toLowerCase();
      let link: string | null = null;
      try {
        if (lstatSync(existing).isSymbolicLink()) link = readlinkSync(existing);
      } catch {
        link = null;
      }
      if (link !== null) existing = resolve(parent, link);
      else {
        missing.push(basename(existing));
        existing = parent;
      }
    }
  }
  // Refused rather than guessed: a root that cannot be resolved is not shown to be outside.
  throw new Error(`ROUTING_GRAPH_ROOT_UNRESOLVABLE: ${path}`);
}
export const routingGraphRoot = routingGraphRootFrom(process.env.ROUTING_GRAPH_ROOT);
export const routingGraphDirectory = join(routingGraphRoot, 'foot');
export const routingGraphConfig = join(routingGraphRoot, 'config-serving.yml');

/** True when `ROUTING_GRAPH_ROOT` moved the deployment out of `.geo-build`. */
export const routingGraphRelocated = routingGraphRoot !== routingGraphRootFrom(undefined);

/**
 * The OSM extract a deployment is imported from (M2-01ak).
 *
 * `ROUTING_EXTRACT_SOURCE` names an operations-allowlist id, never a path or a URL. Unset, it
 * is the Seoul city extract under `.geo-build/source`, the input of every graph built before
 * M2-01ak, so the served layout and its probes behave as before. `osm-extract-south-korea` is
 * the national extract; it lives in the relocated root (`<ROUTING_GRAPH_ROOT>/extract/`),
 * because `.geo-build` is a shared cache this build does not write, and it is refused for the
 * default root. The build checks the file against the allowlist pin before it imports.
 *
 * `importHeapMegabytes` is the engine heap for a full import of that extract. The Seoul
 * import ran in the launch helper's default (2048 MiB). The national import was measured in
 * M2-01ak (docs/implementation/progress/M2-01ak.md) and gets its own ceiling. Serving keeps
 * the helper's default: the heap needed to serve a graph is not the heap needed to build it.
 */
export interface RoutingExtract {
  readonly sourceId: string;
  readonly path: string;
  readonly region: string;
  readonly importHeapMegabytes: number;
}

const DEFAULT_EXTRACT_SOURCE = 'osm-extract-seoul';

export function routingExtractFrom(sourceId: string | undefined, root: string): RoutingExtract {
  const id = sourceId === undefined || sourceId === '' ? DEFAULT_EXTRACT_SOURCE : sourceId;
  if (id === DEFAULT_EXTRACT_SOURCE)
    return {
      sourceId: id,
      path: join(workRoot, 'source', 'region.osm.pbf'),
      region: 'Seoul (BBBike city extract)',
      importHeapMegabytes: 2048,
    };
  if (id === 'osm-extract-south-korea') {
    if (root === routingGraphRootFrom(undefined))
      throw new Error(
        'ROUTING_EXTRACT_NEEDS_A_RELOCATED_ROOT: the national extract is kept in ROUTING_GRAPH_ROOT, not in the shared .geo-build',
      );
    return {
      sourceId: id,
      path: join(root, 'extract', 'south-korea.osm.pbf'),
      region: 'South Korea (Geofabrik extract 2026-09-01)',
      importHeapMegabytes: 4096,
    };
  }
  throw new Error(`ROUTING_EXTRACT_SOURCE_UNKNOWN: ${id}`);
}
export const routingExtract = routingExtractFrom(
  process.env.ROUTING_EXTRACT_SOURCE,
  routingGraphRoot,
);

/**
 * Where a probe writes its report (M2-01af review F3). The canonical report of each probe
 * records the served deployment, and other nodes rewrite it. A run on a relocated (scratch)
 * deployment therefore must name a different file with `--report-name <name>.json`, written
 * beside the canonical one in `docs/implementation/research`.
 */
export function probeReportPath(argv: readonly string[], canonicalName: string): string {
  const index = argv.indexOf('--report-name');
  const named = index === -1 ? undefined : argv[index + 1];
  if (named !== undefined && !/^[a-z0-9][a-z0-9.-]*\.json$/.test(named))
    throw new Error('REPORT_NAME_MUST_BE_A_PLAIN_JSON_FILE_NAME');
  if (routingGraphRelocated && (named === undefined || named === canonicalName))
    throw new Error(
      `RELOCATED_RUN_NEEDS_ITS_OWN_REPORT: pass --report-name other than ${canonicalName}`,
    );
  return join(repositoryRoot, 'docs/implementation/research', named ?? canonicalName);
}

/**
 * What a report must say about a relocated deployment. Null for the served layout.
 *
 * M2-01af's relocated runs were scratch builds in a temporary directory, and their reports said
 * so. M2-01ak's national graph is relocated too, but into a persistent root that becomes the
 * deployment. A probe cannot know which of the two a root is meant to be, so the note states
 * only facts it can check: whether the root lies in a temporary directory, which extract it was
 * selected with, and which graph the default layout under `.geo-build` holds.
 */
export async function relocatedDeploymentNote(): Promise<Record<string, string> | null> {
  if (!routingGraphRelocated) return null;
  const servedManifest = join(routingGraphRootFrom(undefined), 'foot', ROUTING_GRAPH_MANIFEST_FILE);
  const served = await readFile(servedManifest, 'utf8').then(
    (text) => graphBuildIdFromManifest(routingGraphManifestSchema.parse(JSON.parse(text))),
    () => 'unknown (no served manifest on this machine)',
  );
  const temporary = inTemporaryDirectory(routingGraphRoot);
  return {
    deployment: 'relocated (ROUTING_GRAPH_ROOT)',
    rootLocation: temporary ? 'temporary directory' : 'outside temporary directories',
    extractSource: routingExtract.sourceId,
    note: temporary
      ? `Scratch deployment built outside .geo-build for this run. Its graphs are not persisted and their build ids will not exist elsewhere. The deployed graph is still ${served} (.geo-build/routing-graph).`
      : `Deployment built outside .geo-build in a persistent directory. Whether it is the one being served is stated by the node that ran this probe (the report's file name and progress record), not by this file. The default layout .geo-build/routing-graph holds ${served}.`,
    servedGraphBuildId: served,
  };
}

function inTemporaryDirectory(path: string): boolean {
  const real = (value: string) => {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  };
  const target = real(path);
  return [tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
    .map(real)
    .some((directory) => target === directory || target.startsWith(`${directory}${sep}`));
}

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

/** Loopback listener ports for one engine instance: the API port and the admin port. */
export interface EnginePorts {
  readonly application: number;
  readonly admin: number;
}

/**
 * Starts the engine on loopback with the pinned serving profile.
 *
 * `ports` moves the listeners with Dropwizard `-Ddw.` overrides instead of a second profile
 * file (M2-01k-e). A blue/green pair must run the SAME profile configuration, whose SHA-256
 * the graph manifest pins; a copy that differed only in its port would be a different
 * profile to the deployment guard. The bind host stays whatever the profile says
 * (127.0.0.1).
 */
export function startEngine(options: {
  jarPath: string;
  configPath: string;
  extractPath: string;
  graphPath: string;
  heapMegabytes?: number;
  ports?: EnginePorts;
}): EngineHandle {
  // One command line for every launch: it carries the request-log override that keeps
  // waypoints out of the engine's log (M2-01k-c2, scripts/geo/graphhopper-launch.mjs).
  const child = spawn(
    'java',
    graphhopperJavaArguments({
      jarPath: options.jarPath,
      configPath: options.configPath,
      extractPath: options.extractPath,
      graphPath: options.graphPath,
      ...(options.heapMegabytes === undefined ? {} : { heapMegabytes: options.heapMegabytes }),
      // Blue/green (M2-01k-e): the listener ports move through the same helper.
      ...(options.ports === undefined ? {} : { ports: options.ports }),
    }),
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
  /**
   * A different extract than the allowlisted one under `.geo-build/source` (M2-01k-e's
   * blue/green probe imports a clip of it). The caller hashes it and names its region;
   * both land in the manifest, so the graph never claims the default extract's provenance.
   */
  readonly extract?: { readonly path: string; readonly region: string };
  /** Listener ports for the import engine, so an import can run beside a serving engine. */
  readonly ports?: EnginePorts;
  /** Engine heap for the import; defaults to the selected extract's (`routingExtract`). */
  readonly heapMegabytes?: number;
}): Promise<RoutingGraphManifest> {
  await rm(options.graphDirectory, { recursive: true, force: true });
  await mkdir(options.graphDirectory, { recursive: true });

  const engine = startEngine({
    jarPath,
    configPath: routingGraphConfig,
    extractPath: options.extract?.path ?? routingExtract.path,
    graphPath: options.graphDirectory,
    heapMegabytes: options.heapMegabytes ?? routingExtract.importHeapMegabytes,
    ...(options.ports ? { ports: options.ports } : {}),
  });
  const port = options.ports?.application ?? ENGINE_PORT;
  let info: { version: string; import_date: string; data_date: string; profiles: string[] };
  try {
    await waitForEngine(engine, port);
    const response = await fetch(`http://127.0.0.1:${port}/info`);
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
    extractRegion: options.extract?.region ?? routingExtract.region,
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

/**
 * A full import empties `graphDirectory` first (`importRoutingGraph`) and the build then
 * overwrites the profile copy beside it. Over a directory that already holds a graph manifest
 * that is an in-place replacement of a graph that may be served: the blue/green procedure
 * builds the new graph beside it instead (`ROUTING_GRAPH_ROOT`). So a full import over a
 * manifest is refused unless `--replace-served-graph` says the replacement is intended
 * (M2-01af review F4). Returns the refusal code, or null when the import may proceed.
 */
export async function fullImportRefusal(
  graphDirectory: string,
  replaceServedGraph: boolean,
): Promise<string | null> {
  if (replaceServedGraph) return null;
  const hasManifest = await stat(join(graphDirectory, ROUTING_GRAPH_MANIFEST_FILE)).then(
    () => true,
    () => false,
  );
  return hasManifest ? 'FULL_IMPORT_OVER_EXISTING_GRAPH_REFUSED' : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const reuse = argv.includes('--reuse');
  const replaceServedGraph = argv.includes('--replace-served-graph');
  const known = new Set(['--execute', '--reuse', '--replace-served-graph']);
  if (
    !argv.includes('--execute') ||
    argv.some((a) => !known.has(a)) ||
    (reuse && replaceServedGraph)
  ) {
    console.log(
      'Opt-in only: node --import tsx scripts/build-routing-graph.mts --execute ' +
        '[--reuse | --replace-served-graph]. ' +
        'Imports the pedestrian graph from the allowlisted extract already on disk (ROUTING_EXTRACT_SOURCE, ' +
        'default the Seoul extract under .geo-build) and writes the graph manifest. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Routing graph builds are disabled in CI');

  const extractPath = routingExtract.path;
  for (const required of [extractPath, jarPath, servingConfigSource]) {
    try {
      await stat(required);
    } catch {
      throw new Error(`MISSING_PREREQUISITE: ${required}`);
    }
  }
  // A cached jar is checked against the allowlist pin before it is allowed to build.
  const jarIdentity = await verifyAllowedSourceFile('graphhopper-web-jar', jarPath);
  // So is the extract (M2-01ak): a pinned source is refused when its bytes differ. The Seoul
  // entry has no pin; its hash is recorded in the manifest, as before.
  const extractIdentity = await verifyAllowedSourceFile(routingExtract.sourceId, extractPath);
  const extractSha256 = extractIdentity.sha256;
  const profileConfigSha256 = await sha256File(servingConfigSource);
  const extractByteLength = extractIdentity.bytes;

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

  // Nothing is touched before this check: neither the graph nor the profile copy beside it.
  const refusal = await fullImportRefusal(routingGraphDirectory, replaceServedGraph);
  if (refusal !== null)
    throw new Error(
      `${refusal}: ${routingGraphDirectory} already holds a graph. Build the new one beside it ` +
        '(ROUTING_GRAPH_ROOT=<absolute dir outside .geo-build>) and switch with the blue/green ' +
        'procedure, or pass --replace-served-graph when replacing it in place is intended.',
    );
  await copyFile(servingConfigSource, routingGraphConfig);
  const importStarted = performance.now();
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
      extractSource: routingExtract.sourceId,
      extractRegion: manifest.extractRegion,
      importHeapMegabytes: routingExtract.importHeapMegabytes,
      // Engine start, import, /info and stop, then hashing: the wall time of the whole build.
      importMilliseconds: Math.round(performance.now() - importStarted),
      graphBuildId: graphBuildIdFromManifest(manifest),
      graphContentSha256: manifest.graphContentSha256,
      profileConfigSha256: manifest.profileConfigSha256,
      engineVersion: manifest.engineVersion,
      graphImportedAt: manifest.graphImportedAt,
      roadDataAt: manifest.roadDataAt,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
