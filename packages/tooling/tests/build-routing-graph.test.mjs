import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { realpathSync } from 'node:fs';

import {
  DERIVATION_FILE,
  extractAcquisition,
  fullImportRefusal,
  routingExtractFrom,
  routingGraphRootFrom,
  writeRoutingGraphAttribution,
} from '../../../scripts/build-routing-graph.mts';
import {
  EDGE_FACTS_DIRECTORY,
  ROUTING_ATTRIBUTION_FILE,
  ROUTING_GRAPH_MANIFEST_FILE,
  hashGraphDirectory,
  verifyRoutingGraphAttribution,
} from '../../server/integrations/src/routing/index.ts';
import { allowedSource } from '../../../scripts/geo/sources.mjs';

/**
 * M2-01af: a rebuild never replaces the served graph in place by accident. The blue/green
 * procedure builds the new graph beside the served one (`ROUTING_GRAPH_ROOT`), and a full
 * import over a directory that already holds a graph manifest needs an explicit flag.
 */
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'build-routing-graph-'));
  scratch.push(path);
  return path;
}

describe('a full routing-graph import', () => {
  it('is refused over a directory that holds a graph manifest, unless replacing is explicit', async () => {
    const served = join(await directory(), 'foot');
    await mkdir(served, { recursive: true });
    await writeFile(join(served, 'edges'), 'graph bytes');
    // Graph files without a manifest are not a served graph: nothing verifies them.
    expect(await fullImportRefusal(served, false)).toBeNull();
    await writeFile(join(served, 'routing-graph-manifest.json'), '{}\n');
    expect(await fullImportRefusal(served, false)).toBe('FULL_IMPORT_OVER_EXISTING_GRAPH_REFUSED');
    expect(await fullImportRefusal(served, true)).toBeNull();
  });

  it('may build into a directory that does not exist yet or holds no graph', async () => {
    const root = await directory();
    expect(await fullImportRefusal(join(root, 'missing', 'foot'), false)).toBeNull();
    expect(await fullImportRefusal(root, false)).toBeNull();
  });
});

describe('ROUTING_GRAPH_ROOT', () => {
  const geoBuild = join(repositoryRoot, '.geo-build');

  it('defaults to the served layout and relocates only to an absolute directory outside .geo-build', () => {
    expect(routingGraphRootFrom(undefined)).toBe(join(geoBuild, 'routing-graph'));
    expect(routingGraphRootFrom('')).toBe(join(geoBuild, 'routing-graph'));
    expect(routingGraphRootFrom('/srv/routing/green')).toBe('/srv/routing/green');
    expect(() => routingGraphRootFrom('relative/green')).toThrow('ROUTING_GRAPH_ROOT_NOT_ABSOLUTE');
    for (const inside of [geoBuild, join(geoBuild, 'routing-graph'), `${geoBuild}/x/../green`])
      expect(() => routingGraphRootFrom(inside), inside).toThrow(
        'ROUTING_GRAPH_ROOT_INSIDE_GEO_BUILD',
      );
    // A sibling whose name merely starts with `.geo-build` is outside it.
    expect(routingGraphRootFrom(`${geoBuild}-green`)).toBe(`${geoBuild}-green`);
  });
});

describe('ROUTING_EXTRACT_SOURCE (M2-01ak)', () => {
  const geoBuild = join(repositoryRoot, '.geo-build');
  const served = join(geoBuild, 'routing-graph');

  it('defaults to the Seoul extract under .geo-build, the input of every earlier graph', () => {
    for (const unset of [undefined, '', 'osm-extract-seoul'])
      expect(routingExtractFrom(unset, served)).toEqual({
        sourceId: 'osm-extract-seoul',
        path: join(geoBuild, 'source', 'region.osm.pbf'),
        region: 'Seoul (BBBike city extract)',
        importHeapMegabytes: 2048,
      });
  });

  it('keeps the national extract in the relocated root, never in the shared .geo-build', () => {
    const korea = routingExtractFrom('osm-extract-south-korea', '/srv/routing/kr');
    expect(korea.path).toBe('/srv/routing/kr/extract/south-korea.osm.pbf');
    expect(korea.region).toMatch(/^South Korea/);
    expect(() => routingExtractFrom('osm-extract-south-korea', served)).toThrow(
      'ROUTING_EXTRACT_NEEDS_A_RELOCATED_ROOT',
    );
  });

  it('takes allowlist ids only, not paths or URLs', () => {
    for (const other of [
      'osm-extract-busan',
      '/tmp/other.osm.pbf',
      'https://download.geofabrik.de/asia/south-korea-latest.osm.pbf',
    ])
      expect(() => routingExtractFrom(other, '/srv/routing/kr'), other).toThrow(
        'ROUTING_EXTRACT_SOURCE_UNKNOWN',
      );
  });

  it('builds the national graph only from a dated, pinned allowlist entry', () => {
    const source = allowedSource('osm-extract-south-korea');
    // A dated file, not `-latest` (a redirect the download refuses to follow).
    expect(source.url).toMatch(
      /^https:\/\/download\.geofabrik\.de\/asia\/south-korea-\d{6}\.osm\.pbf$/,
    );
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(source.license).toBe('ODbL-1.0');
    expect(source.attribution).toBe('© OpenStreetMap contributors');
  });
});

describe('ROUTING_GRAPH_ROOT is judged by where it leads (M2-01ak review round 1)', () => {
  // A fixture, not this checkout's .geo-build, so the refusals are exercised in any checkout,
  // CI included: `workspace/.geo-build` is a link to `main/.geo-build`, as in a worktree.
  async function fixture() {
    const base = realpathSync(await directory());
    const real = join(base, 'main', '.geo-build');
    await mkdir(real, { recursive: true });
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    const geoBuild = join(workspace, '.geo-build');
    await symlink(real, geoBuild);
    return { base, real, geoBuild };
  }

  it('refuses the real path behind a linked .geo-build', async () => {
    const { real, geoBuild } = await fixture();
    expect(() => routingGraphRootFrom(join(real, 'routing-graph'), geoBuild)).toThrow(
      'ROUTING_GRAPH_ROOT_INSIDE_GEO_BUILD',
    );
    expect(() => routingGraphRootFrom(join(geoBuild, 'green'), geoBuild)).toThrow(
      'ROUTING_GRAPH_ROOT_INSIDE_GEO_BUILD',
    );
  });

  it('refuses another link that aliases .geo-build', async () => {
    const { base, real, geoBuild } = await fixture();
    await mkdir(join(base, 'elsewhere'));
    await symlink(real, join(base, 'elsewhere', 'geo-link'));
    expect(() =>
      routingGraphRootFrom(join(base, 'elsewhere', 'geo-link', 'green'), geoBuild),
    ).toThrow('ROUTING_GRAPH_ROOT_INSIDE_GEO_BUILD');
  });

  it('refuses another spelling of the same name on a case-insensitive volume', async () => {
    const { base, geoBuild } = await fixture();
    for (const spelling of [
      join(base, 'workspace', '.GEO-BUILD', 'green'),
      join(base, 'MAIN', '.Geo-Build', 'routing-graph'),
    ])
      expect(() => routingGraphRootFrom(spelling, geoBuild), spelling).toThrow(
        'ROUTING_GRAPH_ROOT_INSIDE_GEO_BUILD',
      );
  });

  it('refuses a dangling link whose target would be created inside .geo-build', async () => {
    const { base, real, geoBuild } = await fixture();
    await mkdir(join(base, 'elsewhere'));
    // The target does not exist yet: realpath of the link fails, and a later mkdir through it
    // would create the directory inside .geo-build.
    await symlink(join(real, 'newdir'), join(base, 'elsewhere', 'dangling'));
    expect(() =>
      routingGraphRootFrom(join(base, 'elsewhere', 'dangling', 'green'), geoBuild),
    ).toThrow('ROUTING_GRAPH_ROOT_INSIDE_GEO_BUILD');
    // A dangling link that leads outside is still accepted.
    await symlink(join(base, 'outside-new'), join(base, 'elsewhere', 'dangling-out'));
    const outside = join(base, 'elsewhere', 'dangling-out', 'green');
    expect(routingGraphRootFrom(outside, geoBuild)).toBe(outside);
  });

  it('still accepts a sibling outside it, existing or not', async () => {
    const { base, geoBuild } = await fixture();
    const sibling = join(base, 'workspace', '.geo-build-routing', 'kr');
    expect(routingGraphRootFrom(sibling, geoBuild)).toBe(sibling);
    await mkdir(sibling, { recursive: true });
    expect(routingGraphRootFrom(sibling, geoBuild)).toBe(sibling);
  });
});

/**
 * M0-06b-odbl: the build writes the graph's ODbL notice and alteration method INTO the graph
 * directory before it is hashed, from the facts the manifest records and the derivation record
 * — and checks the result the way a distribution would.
 */
describe('the routing graph ODbL notice', () => {
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
  };
  const derivation = {
    schemaVersion: 1,
    extractSha256: facts.extractSha256,
    osmium: 'osmium version 1.19.1',
    militaryPerimeterBarriers: {
      tool: 'scripts/geo/MilitaryPerimeterBarriers.java',
      toolSha256: 'f5c555245e3c57ce24d3038c7943c07cdd54b0119d625b51d22efaa07a7954a9',
      summary: { waysGivenBarriers: 2764, barrierNodes: 4220 },
      changesSha256: 'cda8e30e28134622c183fa8cab8d8b4893994b4bdeb3cc0cda54b4f3e76fbec5',
      derivedExtractSha256: '623b6705a8985b0a507471598ae5236b059e11fb9b6fdd5586acd894b4b5a48a',
      extractMaxNodeId: 14_140_850_977,
      keptHeaderOptions: ['timestamp=2026-09-01T20:20:50Z'],
    },
    timeConditionalWays: 77,
    source: {
      sourceId: 'osm-extract-south-korea',
      url: 'https://download.geofabrik.de/asia/south-korea-260901.osm.pbf',
      lastModified: 'Wed, 02 Sep 2026 05:13:33 GMT',
      etag: null,
      recordedBy: 'acquisition-record',
    },
  };

  /** A graph directory as the import leaves it, then the notice, the hash and the manifest. */
  async function builtGraph({ withNotice = true } = {}) {
    const graph = join(await directory(), 'foot');
    await mkdir(join(graph, EDGE_FACTS_DIRECTORY), { recursive: true });
    await writeFile(join(graph, 'edges'), 'edge-bytes');
    await writeFile(join(graph, EDGE_FACTS_DIRECTORY, DERIVATION_FILE), JSON.stringify(derivation));
    if (withNotice) await writeRoutingGraphAttribution(graph, facts);
    await writeFile(
      join(graph, ROUTING_GRAPH_MANIFEST_FILE),
      JSON.stringify({
        schemaVersion: 1,
        ...facts,
        graphContentSha256: await hashGraphDirectory(graph),
        builtAt: '2026-09-26T07:03:33.885Z',
      }),
    );
    return graph;
  }

  it('writes a notice the distribution check accepts, covered by the graph hash', async () => {
    const graph = await builtGraph();
    await expect(verifyRoutingGraphAttribution(graph)).resolves.toBeUndefined();
    const notice = await readFile(join(graph, ROUTING_ATTRIBUTION_FILE), 'utf8');
    const [firstParagraph] = notice.split(/\n\s*\n/);
    expect(firstParagraph).toContain('https://www.openstreetmap.org/copyright');
    expect(firstParagraph).toContain('https://opendatacommons.org/licenses/odbl/1-0/');
    // The alteration method, from the derivation record: the military perimeter barriers.
    expect(notice).toContain('scripts/geo/MilitaryPerimeterBarriers.java SHA-256 f5c55524');
    expect(notice).toContain('derived extract SHA-256 623b6705');
    expect(notice).toContain('https://download.geofabrik.de/asia/south-korea-260901.osm.pbf');
    expect(notice).toContain('Last-Modified Wed, 02 Sep 2026 05:13:33 GMT (acquisition-record)');
    expect(notice).toContain('graphhopper 10.0');
    expect(notice).toContain(facts.profileConfigSha256);
    // Editing the notice afterwards changes the graph: it no longer verifies at all.
    await writeFile(join(graph, ROUTING_ATTRIBUTION_FILE), notice.replace('10.0', '9.0'));
    await expect(verifyRoutingGraphAttribution(graph)).rejects.toThrow('GRAPH_CONTENT_CHANGED');
  });

  it('fails the distribution check for a graph built without the notice', async () => {
    const graph = await builtGraph({ withNotice: false });
    await expect(verifyRoutingGraphAttribution(graph)).rejects.toThrow('ODBL_NOTICE_MISSING');
  });

  it('records the extract acquisition only from the record the downloader left', async () => {
    const root = await directory();
    const extract = join(root, 'south-korea.osm.pbf');
    await writeFile(extract, 'extract-bytes');
    const sha256 = 'a'.repeat(64);
    expect(await extractAcquisition('osm-extract-south-korea', extract, sha256)).toEqual({
      sourceId: 'osm-extract-south-korea',
      url: allowedSource('osm-extract-south-korea').url,
      lastModified: null,
      etag: null,
      recordedBy: 'none',
    });
    await writeFile(
      `${extract}.acquisition.json`,
      JSON.stringify({
        sourceId: 'osm-extract-south-korea',
        url: allowedSource('osm-extract-south-korea').url,
        sha256,
        lastModified: 'Wed, 02 Sep 2026 05:13:33 GMT',
        etag: '"11122b4b-65a7918cd6a87"',
      }),
    );
    expect(await extractAcquisition('osm-extract-south-korea', extract, sha256)).toMatchObject({
      lastModified: 'Wed, 02 Sep 2026 05:13:33 GMT',
      recordedBy: 'acquisition-record',
    });
  });
});
