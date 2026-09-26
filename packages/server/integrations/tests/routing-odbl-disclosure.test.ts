import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  carriesOdblNotice,
  odblLicenceUrl,
  osmCopyrightUrl,
  routingDataDisclosureSchema,
} from '@workout/contracts/map-data-licence';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DERIVATION_FILE,
  EDGE_FACTS_DIRECTORY,
  ROUTING_ATTRIBUTION_FILE,
  ROUTING_GRAPH_MANIFEST_FILE,
  graphBuildIdFromManifest,
  hashGraphDirectory,
  loadVerifiedRoutingGraph,
  renderRoutingAttribution,
  routingDataDisclosure,
  verifyRoutingGraphAttribution,
  type DerivationFile,
  type RoutingGraphManifest,
} from '../src/routing/index.js';

/**
 * ODbL §4.2 / §4.6 for the routing graph (M0-06b-odbl): the notice inside the graph directory
 * and the public disclosure the API serves, both from the graph's own verified files.
 */
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const facts = {
  engine: 'graphhopper',
  engineVersion: '10.0',
  engineArtifactSha256: 'e5a1268f2cd6b1e4ef849b9237e98b651bf3c31adf4a3766c6d9f5feb241bb41',
  profileId: 'foot-v1',
  profileConfigSha256: '9b6fa80a6aa83f49ac0ebc115871858864aa431602b3d30e4c43d2917364ef8c',
  profileName: 'foot',
  extractSha256: '848daadc56b2c2a808b30b2778f834c2802097ab382805c9fd42f248f4d6284b',
  extractRegion: 'South Korea (Geofabrik extract 2026-09-01)',
  extractByteLength: 286_403_403,
  graphImportedAt: '2026-09-26T07:03:27.000Z',
  roadDataAt: '2026-09-01T20:20:50.000Z',
} as const;

const derivation: DerivationFile = {
  schemaVersion: 1,
  extractSha256: facts.extractSha256,
  source: {
    sourceId: 'osm-extract-south-korea',
    url: 'https://download.geofabrik.de/asia/south-korea-260901.osm.pbf',
    lastModified: null,
    etag: null,
    recordedBy: 'none',
  },
  osmium: 'osmium version 1.19.1',
  militaryPerimeterBarriers: {
    tool: 'scripts/geo/MilitaryPerimeterBarriers.java',
    toolSha256: 'f5c555245e3c57ce24d3038c7943c07cdd54b0119d625b51d22efaa07a7954a9',
    summary: { militaryPolygonsAfterUnion: 1993, waysGivenBarriers: 2764, barrierNodes: 4220 },
    changesSha256: 'cda8e30e28134622c183fa8cab8d8b4893994b4bdeb3cc0cda54b4f3e76fbec5',
    derivedExtractSha256: '623b6705a8985b0a507471598ae5236b059e11fb9b6fdd5586acd894b4b5a48a',
    extractMaxNodeId: 14_140_850_977,
    keptHeaderOptions: ['timestamp=2026-09-01T20:20:50Z'],
  },
  timeConditionalWays: 77,
};

/**
 * A graph directory as the build leaves it: `notice` decides what `ATTRIBUTION.txt` holds
 * when the directory is hashed (`rendered`, `none` or a hand-written text).
 */
async function graph(
  notice: 'rendered' | 'none' | string,
  derivationFile: DerivationFile | null = derivation,
): Promise<{ directory: string; manifest: RoutingGraphManifest }> {
  const root = await mkdtemp(join(tmpdir(), 'routing-odbl-'));
  scratch.push(root);
  const directory = join(root, 'foot');
  await mkdir(join(directory, EDGE_FACTS_DIRECTORY), { recursive: true });
  await writeFile(join(directory, 'edges'), 'edge-bytes');
  if (derivationFile !== null)
    await writeFile(
      join(directory, EDGE_FACTS_DIRECTORY, DERIVATION_FILE),
      JSON.stringify(derivationFile),
    );
  if (notice !== 'none')
    await writeFile(
      join(directory, ROUTING_ATTRIBUTION_FILE),
      notice === 'rendered' ? renderRoutingAttribution(facts, derivationFile) : notice,
    );
  const manifest: RoutingGraphManifest = {
    schemaVersion: 1,
    ...facts,
    graphContentSha256: await hashGraphDirectory(directory),
    builtAt: '2026-09-26T07:03:33.885Z',
  };
  await writeFile(join(directory, ROUTING_GRAPH_MANIFEST_FILE), JSON.stringify(manifest));
  return { directory, manifest };
}

describe('the notice inside a routing graph', () => {
  it('names the OSM copyright page and the licence URI in its first paragraph', () => {
    const [notice] = renderRoutingAttribution(facts, derivation).split(/\n\s*\n/);
    expect(notice).toContain(osmCopyrightUrl);
    expect(notice).toContain(odblLicenceUrl);
    expect(carriesOdblNotice(notice ?? '')).toBe(true);
  });

  it('states the alteration method from the manifest facts and the derivation record', () => {
    const text = renderRoutingAttribution(facts, derivation);
    for (const value of [
      facts.extractSha256,
      facts.engineArtifactSha256,
      facts.profileConfigSha256,
      'graphhopper 10.0',
      'landuse=military / military=* perimeter',
      derivation.militaryPerimeterBarriers?.toolSha256 ?? '',
      derivation.militaryPerimeterBarriers?.changesSha256 ?? '',
      derivation.militaryPerimeterBarriers?.derivedExtractSha256 ?? '',
      'barrierNodes=4220',
      'time-conditional way list: 77 ways',
      'extract URL https://download.geofabrik.de/asia/south-korea-260901.osm.pbf',
    ])
      expect(text, value).toContain(value);
    expect(renderRoutingAttribution(facts, null)).toContain(
      'derivation: none recorded; the graph was imported from the extract unchanged',
    );
  });

  it('passes the distribution check only when it is exactly what the facts render to', async () => {
    await expect(
      verifyRoutingGraphAttribution((await graph('rendered')).directory),
    ).resolves.toBeUndefined();
    await expect(
      verifyRoutingGraphAttribution((await graph('none')).directory),
    ).rejects.toMatchObject({ code: 'ODBL_NOTICE_MISSING' });
    await expect(
      verifyRoutingGraphAttribution(
        (await graph('rendered', { ...derivation, source: undefined })).directory,
      ),
    ).rejects.toMatchObject({ code: 'ODBL_NOTICE_MISSING' });
    // A notice without the licence URI, hashed into the graph: the graph verifies, the notice not.
    const withoutLicence = renderRoutingAttribution(facts, derivation).replaceAll(
      odblLicenceUrl,
      '',
    );
    await expect(
      verifyRoutingGraphAttribution((await graph(withoutLicence)).directory),
    ).rejects.toMatchObject({ code: 'ODBL_ATTRIBUTION_STALE' });
  });
});

describe('the public disclosure of a verified graph', () => {
  it('describes the graph being served, from its manifest and derivation', async () => {
    const { directory, manifest } = await graph('rendered');
    const disclosure = await routingDataDisclosure(await loadVerifiedRoutingGraph(directory));
    expect(routingDataDisclosureSchema.parse(disclosure)).toEqual(disclosure);
    expect(disclosure.graph).toEqual({
      graphBuildId: graphBuildIdFromManifest(manifest),
      graphContentSha256: manifest.graphContentSha256,
      graphImportedAt: manifest.graphImportedAt,
      roadDataAt: manifest.roadDataAt,
    });
    expect(disclosure.engine.engineArtifactSha256).toBe(facts.engineArtifactSha256);
    expect(disclosure.profile.profileConfigSha256).toBe(facts.profileConfigSha256);
    expect(disclosure.extract).toEqual({
      sha256: facts.extractSha256,
      region: facts.extractRegion,
      byteLength: facts.extractByteLength,
      acquisition: derivation.source,
    });
    expect(disclosure.derivation?.militaryPerimeterBarriers?.derivedExtractSha256).toBe(
      derivation.militaryPerimeterBarriers?.derivedExtractSha256,
    );
    expect(disclosure.artifactNotice).toBe('verified');
    // No filesystem path of the deployment reaches the public document.
    expect(JSON.stringify(disclosure)).not.toContain(directory);
  });

  it('says so when the graph itself carries no notice, or a different one', async () => {
    const missing = await graph('none');
    expect(
      (await routingDataDisclosure(await loadVerifiedRoutingGraph(missing.directory)))
        .artifactNotice,
    ).toBe('missing');
    const other = await graph('Map data by someone else.\n');
    expect(
      (await routingDataDisclosure(await loadVerifiedRoutingGraph(other.directory))).artifactNotice,
    ).toBe('mismatch');
  });

  it('carries a graph built before any derivation, and the recorded extract source', async () => {
    const plain = await graph('rendered', null);
    expect(
      (await routingDataDisclosure(await loadVerifiedRoutingGraph(plain.directory))).derivation,
    ).toBeNull();
    const source = {
      sourceId: 'osm-extract-south-korea',
      url: 'https://download.geofabrik.de/asia/south-korea-260901.osm.pbf',
      lastModified: 'Wed, 02 Sep 2026 05:13:33 GMT',
      etag: null,
      recordedBy: 'acquisition-record',
    } as const;
    const recorded = await graph('rendered', { ...derivation, source });
    const disclosure = await routingDataDisclosure(
      await loadVerifiedRoutingGraph(recorded.directory),
    );
    expect(disclosure.extract.acquisition).toEqual(source);
    expect(disclosure.artifactNotice).toBe('verified');
  });
});
