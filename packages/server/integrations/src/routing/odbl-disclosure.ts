import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  carriesOdblNotice,
  extractAcquisitionSchema,
  mapDataLicence,
  mapDataLicencePagePath,
  odblLicenceUrl,
  osmAttribution,
  osmCopyrightUrl,
  routingDataDisclosureSchema,
  type ExtractAcquisition,
  type RoutingDataDisclosure,
  type RoutingDerivation,
} from '@workout/contracts/map-data-licence';
import { z } from 'zod';

import { EDGE_FACTS_DIRECTORY } from './edge-facts.js';
import {
  ROUTING_GRAPH_MANIFEST_FILE,
  graphBuildIdFromManifest,
  loadVerifiedRoutingGraph,
  type RoutingGraphManifest,
} from './graph-manifest.js';

/**
 * ODbL §4.2 / §4.6 for the pedestrian routing graph (M0-06b-odbl).
 *
 * The graph is a derived database of the OSM extract. The build writes `ATTRIBUTION.txt`
 * INTO the graph directory before the graph is hashed, so the manifest's content hash
 * covers it and a changed notice is a changed graph. Its text is rendered from the same
 * facts the manifest records (engine, profile, extract) and from the derivation record the
 * build wrote (`edge-facts/derivation.json`, M2-01ay's military perimeter barriers), never
 * typed in. Only the graph content hash and build id are absent from it: a file inside the
 * graph cannot carry the hash of the graph; they are in the manifest beside it.
 *
 * The API's public disclosure is built from the same verified files, so the page shows the
 * graph that is actually being served.
 *
 * This is how self-hosted-map-adr.md §6 reads the licence; it is not legal review.
 */
export const ROUTING_ATTRIBUTION_FILE = 'ATTRIBUTION.txt';
/** How the imported data was derived from the pinned extract (M2-01ay), in `edge-facts`. */
export const DERIVATION_FILE = 'derivation.json';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** `edge-facts/derivation.json` as the build writes it. */
export const derivationFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  extractSha256: sha256Schema,
  osmium: z.string().min(1).max(200).nullable().optional(),
  militaryPerimeterBarriers: z
    .strictObject({
      tool: z.string().regex(/^scripts\/[A-Za-z0-9/_.-]{1,120}$/),
      toolSha256: sha256Schema,
      summary: z.record(z.string().regex(/^[A-Za-z]{1,64}$/), z.number().int().nonnegative()),
      changesSha256: sha256Schema,
      derivedExtractSha256: sha256Schema,
      extractMaxNodeId: z.number().int().nonnegative(),
      keptHeaderOptions: z.array(z.string().min(1).max(300)).max(16),
    })
    .optional(),
  timeConditionalWays: z.number().int().nonnegative().optional(),
  /** Recorded from M0-06b-odbl on: where the extract came from, as its acquisition recorded it. */
  source: extractAcquisitionSchema.optional(),
});
export type DerivationFile = z.infer<typeof derivationFileSchema>;

/** Everything the notice states: the manifest less what depends on the finished graph. */
export type RoutingAttributionFacts = Omit<
  RoutingGraphManifest,
  'schemaVersion' | 'graphContentSha256' | 'builtAt'
>;

export function derivationFromFile(file: DerivationFile): RoutingDerivation {
  const barriers = file.militaryPerimeterBarriers;
  return {
    osmium: file.osmium ?? null,
    militaryPerimeterBarriers:
      barriers === undefined
        ? null
        : {
            tool: barriers.tool,
            toolSha256: barriers.toolSha256,
            summary: { ...barriers.summary },
            changesSha256: barriers.changesSha256,
            derivedExtractSha256: barriers.derivedExtractSha256,
            keptHeaderOptions: [...barriers.keptHeaderOptions],
          },
    timeConditionalWays: file.timeConditionalWays ?? null,
  };
}

/**
 * The graph's `ATTRIBUTION.txt`. The first paragraph is the notice (ODbL §4.2); the rest is
 * the alteration method (§4.6 option (b)).
 */
export function renderRoutingAttribution(
  facts: RoutingAttributionFacts,
  derivation: DerivationFile | null,
): string {
  const recorded = derivation === null ? null : derivationFromFile(derivation);
  const source = derivation?.source ?? null;
  const barriers = recorded?.militaryPerimeterBarriers ?? null;
  const lines = [
    'Pedestrian routing graph built by Workout Manager from an OpenStreetMap extract.',
    `Map data ${osmAttribution} (${osmCopyrightUrl}), available under the Open Database License 1.0 (${odblLicenceUrl}).`,
    '',
    'The graph is a derived database of that data; ODbL attribution and share-alike apply to redistribution,',
    'and route geometry shown to a person carries the same attribution.',
    '',
    'Alteration method (ODbL 4.6), generated from this graph build:',
    `- extract ${facts.extractRegion}: SHA-256 ${facts.extractSha256}, ${facts.extractByteLength} bytes, road data ${facts.roadDataAt}`,
    source === null
      ? '- extract URL and Last-Modified: not recorded by this build'
      : `- extract URL ${source.url} (allowlist ${source.sourceId}), Last-Modified ${source.lastModified ?? 'not recorded'} (${source.recordedBy})`,
    ...(barriers === null
      ? ['- derivation: none recorded; the graph was imported from the extract unchanged']
      : [
          `- derivation 1: barrier nodes where a walkable way crosses the merged landuse=military / military=* perimeter (${barriers.tool} SHA-256 ${barriers.toolSha256}, ${recorded?.osmium ?? 'osmium version not recorded'})`,
          `  osmChange SHA-256 ${barriers.changesSha256}, derived extract SHA-256 ${barriers.derivedExtractSha256}`,
          `  counts ${Object.entries(barriers.summary)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}`,
          `  kept PBF header options ${barriers.keptHeaderOptions.join(', ') || 'none'}`,
        ]),
    recorded?.timeConditionalWays === null || recorded === null
      ? '- time-conditional way list: none'
      : `- time-conditional way list: ${recorded.timeConditionalWays} ways (edge-facts), warnings only, no rerouting`,
    `- import: ${facts.engine} ${facts.engineVersion} (artifact SHA-256 ${facts.engineArtifactSha256}), profile ${facts.profileId} "${facts.profileName}" (configuration SHA-256 ${facts.profileConfigSha256}), imported ${facts.graphImportedAt}`,
    `- graph content hash and build id: ${ROUTING_GRAPH_MANIFEST_FILE} in this directory`,
    `Public page: ${mapDataLicencePagePath}`,
    '',
  ];
  return lines.join('\n');
}

async function readDerivationFile(graphDirectory: string): Promise<DerivationFile | null> {
  let raw: string;
  try {
    raw = await readFile(join(graphDirectory, EDGE_FACTS_DIRECTORY, DERIVATION_FILE), 'utf8');
  } catch {
    return null;
  }
  return derivationFileSchema.parse(JSON.parse(raw));
}

export class RoutingAttributionError extends Error {
  constructor(
    readonly code: 'ODBL_NOTICE_MISSING' | 'ODBL_ATTRIBUTION_STALE',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'RoutingAttributionError';
  }
}

/** What the graph directory's own notice says against what its facts render to. */
async function attributionState(
  graphDirectory: string,
  expected: string,
): Promise<RoutingDataDisclosure['artifactNotice']> {
  let actual: string;
  try {
    actual = await readFile(join(graphDirectory, ROUTING_ATTRIBUTION_FILE), 'utf8');
  } catch {
    return 'missing';
  }
  return actual === expected && carriesOdblNotice(actual) ? 'verified' : 'mismatch';
}

/**
 * The distribution check for a graph directory: the graph verifies against its manifest, and
 * its `ATTRIBUTION.txt` exists, names the licence and is exactly what the graph's facts render
 * to. A graph built before M0-06b-odbl fails it (`ODBL_NOTICE_MISSING`) and must be re-imported
 * before it is distributed.
 */
export async function verifyRoutingGraphAttribution(graphDirectory: string): Promise<void> {
  const verified = await loadVerifiedRoutingGraph(graphDirectory);
  const expected = renderRoutingAttribution(
    verified.manifest,
    await readDerivationFile(graphDirectory),
  );
  const state = await attributionState(graphDirectory, expected);
  if (state === 'missing')
    throw new RoutingAttributionError('ODBL_NOTICE_MISSING', `no ${ROUTING_ATTRIBUTION_FILE}`);
  if (state === 'mismatch')
    throw new RoutingAttributionError(
      'ODBL_ATTRIBUTION_STALE',
      `${ROUTING_ATTRIBUTION_FILE} is not the rendering of this graph's manifest and derivation`,
    );
}

/**
 * The public disclosure of a graph that has already been verified (a `RoutingDeployment`):
 * its manifest, and the derivation record inside the directory whose hash was checked.
 */
export async function routingDataDisclosure(verified: {
  readonly manifest: RoutingGraphManifest;
  readonly graphDirectory: string;
}): Promise<RoutingDataDisclosure> {
  const { manifest } = verified;
  const derivation = await readDerivationFile(verified.graphDirectory);
  const expected = renderRoutingAttribution(manifest, derivation);
  const acquisition: ExtractAcquisition | null = derivation?.source ?? null;
  return routingDataDisclosureSchema.parse({
    schemaVersion: 1,
    kind: 'routing-graph',
    licence: mapDataLicence,
    graph: {
      graphBuildId: graphBuildIdFromManifest(manifest),
      graphContentSha256: manifest.graphContentSha256,
      graphImportedAt: manifest.graphImportedAt,
      roadDataAt: manifest.roadDataAt,
    },
    engine: {
      engine: manifest.engine,
      engineVersion: manifest.engineVersion,
      engineArtifactSha256: manifest.engineArtifactSha256,
    },
    profile: {
      profileId: manifest.profileId,
      profileName: manifest.profileName,
      profileConfigSha256: manifest.profileConfigSha256,
    },
    extract: {
      sha256: manifest.extractSha256,
      region: manifest.extractRegion,
      byteLength: manifest.extractByteLength,
      acquisition,
    },
    derivation: derivation === null ? null : derivationFromFile(derivation),
    artifactNotice: await attributionState(verified.graphDirectory, expected),
  } satisfies RoutingDataDisclosure);
}
