import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  basemapWorkRootFrom,
  parseArguments,
  pruneDeployments,
  publishStagedBuild,
  verifyStagedBuild,
  withDistributionLock,
} from '../../../scripts/build-basemap.mjs';
import {
  DISCLOSURE_FILE,
  MAP_DATA_LICENCE_PAGE,
  ODBL_LICENCE_URL,
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  basemapAttributionText,
  basemapStyleAttribution,
  assertBasemapDisclosure,
  createBasemapDisclosure,
  renderBasemapAttribution,
  resolveAcquisition,
} from '../../../scripts/geo/odbl.mjs';
import {
  basemapDataDisclosureSchema,
  basemapDisclosureFile,
  mapDataLicencePagePath,
  odblLicenceUrl,
  osmAttribution,
  osmCopyrightUrl,
} from '../../contracts/src/map-data-licence.ts';

const created = [];

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'workout-geo-build-'));
  created.push(directory);
  return directory;
}

/** A staged build with every artifact the style references. */
async function stageComplete(root, { tileBody = 'tile' } = {}) {
  await mkdir(join(root, 'tiles', '10', '1'), { recursive: true });
  await writeFile(join(root, 'tiles', '10', '1', '2.pbf'), tileBody);
  await mkdir(join(root, 'glyphs', 'Noto Sans Regular'), { recursive: true });
  for (const range of ['0-255', '256-511', '8192-8447'])
    await writeFile(join(root, 'glyphs', 'Noto Sans Regular', `${range}.pbf`), 'glyph');
  await writeFile(join(root, 'glyphs', 'OFL.txt'), 'license');
  for (const name of ['sprite.json', 'sprite.png', 'sprite@2x.json', 'sprite@2x.png'])
    await writeFile(join(root, name), 'sprite');
  await writeFile(
    join(root, 'style.json'),
    JSON.stringify({
      version: 8,
      glyphs: '/map/basemap/abc/glyphs/{fontstack}/{range}.pbf',
      sources: {
        basemap: {
          tiles: ['/map/basemap/abc/tiles/{z}/{x}/{y}.pbf'],
          attribution: basemapStyleAttribution,
        },
      },
    }),
  );
  await writeFile(
    join(root, 'tiles.json'),
    JSON.stringify({
      tiles: ['/map/basemap/abc/tiles/{z}/{x}/{y}.pbf'],
      attribution: basemapStyleAttribution,
      attributionText: basemapAttributionText,
    }),
  );
  const disclosure = sampleDisclosure();
  await writeFile(join(root, DISCLOSURE_FILE), JSON.stringify(disclosure));
  await writeFile(join(root, 'ATTRIBUTION.txt'), renderBasemapAttribution(disclosure));
}

/** A deployment record as the build writes it, for deployment `abc`. */
function sampleDisclosure(overrides = {}) {
  return createBasemapDisclosure({
    buildId: 'ec81f3367889',
    deploymentId: 'abc',
    region: 'Seoul (BBBike city extract)',
    source: {
      sha256: '7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea',
      bytes: 51_884_841,
      acquisition: {
        sourceId: 'osm-extract-seoul',
        url: 'https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf',
        lastModified: 'Sat, 19 Sep 2026 16:20:02 GMT',
        etag: '"2533873529"',
        recordedBy: 'download-response',
      },
    },
    alterationMethod: {
      description: 'Layer-by-layer osmium tag filter.',
      layerFilters: [{ layer: 'roads', expressions: ['w/highway'] }],
      osmiumExportFormat: 'geojsonseq (--add-unique-id=type_id)',
      tippecanoeArguments: ['--force', '--output', '<stage>/basemap.mbtiles'],
      minzoom: 9,
      maxzoom: 15,
      glyphRanges: ['0-255'],
      scripts: { 'scripts/build-basemap.mjs': 'a'.repeat(64) },
    },
    toolVersions: {
      osmium: 'osmium version 1.19.1',
      tippecanoe: 'tippecanoe v2',
      node: 'v24.12.0',
    },
    ...overrides,
  });
}

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('basemap build arguments', () => {
  it('requires the explicit opt-in', () => {
    expect(parseArguments([])).toBeNull();
    expect(parseArguments(['--reuse'])).toBeNull();
    expect(parseArguments(['--execute'])).toEqual({ reuse: false, basePath: '/map/basemap' });
  });

  it('accepts only a same-origin absolute serving prefix', () => {
    expect(parseArguments(['--execute', '--base-path=/tiles/public'])?.basePath).toBe(
      '/tiles/public',
    );
    for (const argument of [
      '--base-path=https://cdn.example/map',
      '--base-path=//cdn.example/map',
      '--base-path=map',
      '--base-path=/map/../etc',
    ]) {
      expect(parseArguments(['--execute', argument])).toBeNull();
    }
  });
});

describe('staged build verification', () => {
  it('accepts a complete staged build', async () => {
    const root = await workspace();
    await stageComplete(root);
    await expect(verifyStagedBuild(root, 1)).resolves.toBeUndefined();
  });

  it('refuses a build with no tiles', async () => {
    const root = await workspace();
    await stageComplete(root);
    await expect(verifyStagedBuild(root, 0)).rejects.toThrow('STAGED_BUILD_HAS_NO_TILES');
  });

  it('refuses a build whose glyph download failed', async () => {
    const root = await workspace();
    await stageComplete(root);
    await rm(join(root, 'glyphs', 'Noto Sans Regular', '0-255.pbf'));
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow('STAGED_BUILD_INCOMPLETE');
  });

  it('refuses a zero-length artifact', async () => {
    const root = await workspace();
    await stageComplete(root);
    await writeFile(join(root, 'sprite.png'), '');
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow('STAGED_BUILD_INCOMPLETE: sprite.png');
  });

  it('refuses a staged style that points at another host', async () => {
    const root = await workspace();
    await stageComplete(root);
    await writeFile(
      join(root, 'style.json'),
      JSON.stringify({ version: 8, sprite: 'https://cdn.example/sprite' }),
    );
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow('EXTERNAL_STYLE_REFERENCE');
  });

  it('refuses a staged style whose backslash a URL parser would resolve off-origin', async () => {
    const root = await workspace();
    await stageComplete(root);
    // `new URL('\\\\outside.example/sprite', origin)` is `https://outside.example/sprite`,
    // so a scheme/`//` check alone would pass this document.
    await writeFile(
      join(root, 'style.json'),
      JSON.stringify({ version: 8, sprite: '/\\outside.example/sprite' }),
    );
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow('EXTERNAL_STYLE_REFERENCE');
  });
});

/**
 * ODbL §4.2 / §4.6 on the deployment (M0-06b-odbl): an artifact without the licence URI, a
 * notice nobody generated from the build record, or a record of another deployment is
 * refused before anything is published.
 */
describe('ODbL notice and alteration method in a staged deployment', () => {
  const mutateJson = async (path, change) =>
    writeFile(path, JSON.stringify(change(JSON.parse(await readFile(path, 'utf8')))));

  it('names both the OSM copyright page and the licence URI in every attribution it writes', () => {
    for (const text of [basemapStyleAttribution, basemapAttributionText]) {
      expect(text).toContain(OSM_COPYRIGHT_URL);
      expect(text).toContain(ODBL_LICENCE_URL);
    }
    const notice = renderBasemapAttribution(sampleDisclosure());
    const [firstParagraph] = notice.split(/\n\s*\n/);
    expect(firstParagraph).toContain(OSM_COPYRIGHT_URL);
    expect(firstParagraph).toContain(ODBL_LICENCE_URL);
    // The alteration method, from the record: extract, date, filters, tippecanoe, scripts.
    expect(notice).toContain('https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf');
    expect(notice).toContain('7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea');
    expect(notice).toContain('Last-Modified Sat, 19 Sep 2026 16:20:02 GMT (download-response)');
    expect(notice).toContain('layer roads: osmium tags-filter w/highway');
    expect(notice).toContain('tippecanoe --force --output <stage>/basemap.mbtiles');
    expect(notice).toContain(`script scripts/build-basemap.mjs SHA-256 ${'a'.repeat(64)}`);
  });

  it('agrees with the contract: the same URIs, and a record the page accepts', () => {
    expect([OSM_COPYRIGHT_URL, ODBL_LICENCE_URL, OSM_ATTRIBUTION]).toEqual([
      osmCopyrightUrl,
      odblLicenceUrl,
      osmAttribution,
    ]);
    expect([DISCLOSURE_FILE, MAP_DATA_LICENCE_PAGE]).toEqual([
      basemapDisclosureFile,
      mapDataLicencePagePath,
    ]);
    expect(basemapDataDisclosureSchema.parse(sampleDisclosure())).toEqual(sampleDisclosure());
  });

  it('rejects records whose required public disclosure fields are absent or invalid', async () => {
    const changes = [
      (record) => {
        delete record.source.acquisition.recordedBy;
      },
      (record) => {
        record.source.acquisition.recordedBy = 'unknown';
      },
      (record) => {
        delete record.source.acquisition.lastModified;
      },
      (record) => {
        delete record.source.acquisition.etag;
      },
      (record) => {
        record.source.acquisition.sourceId = 'Invalid ID';
      },
      (record) => {
        record.source.sha256 = [record.source.sha256];
      },
      (record) => {
        record.source.bytes = Number.MAX_SAFE_INTEGER + 1;
      },
      (record) => {
        record.source.acquisition.url = 'https://';
      },
      (record) => {
        record.alterationMethod.maxzoom = 25;
      },
      (record) => {
        record.alterationMethod.layerFilters[0].layer = 'Roads';
      },
      (record) => {
        delete record.toolVersions.node;
      },
      (record) => {
        record.extra = 'not in the public schema';
      },
    ];
    for (const change of changes) {
      const disclosure = sampleDisclosure();
      change(disclosure);
      expect(basemapDataDisclosureSchema.safeParse(disclosure).success).toBe(false);
      expect(() => assertBasemapDisclosure(disclosure)).toThrow('ODBL_DISCLOSURE_INVALID');
      const root = await workspace();
      await stageComplete(root);
      await writeFile(join(root, DISCLOSURE_FILE), JSON.stringify(disclosure));
      await writeFile(join(root, 'ATTRIBUTION.txt'), renderBasemapAttribution(disclosure));
      await expect(verifyStagedBuild(root, 1)).rejects.toThrow('ODBL_DISCLOSURE_INVALID');
    }
  });

  it('refuses an ATTRIBUTION.txt without the licence URI', async () => {
    const root = await workspace();
    await stageComplete(root);
    const path = join(root, 'ATTRIBUTION.txt');
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll(ODBL_LICENCE_URL, ''));
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow(
      'ODBL_NOTICE_MISSING: ATTRIBUTION.txt has no ODbL 1.0 licence URI',
    );
  });

  it('refuses a tiles.json or style source whose attribution lacks the licence URI', async () => {
    for (const [file, change, message] of [
      [
        'tiles.json',
        (json) => ({ ...json, attribution: '© OpenStreetMap contributors ' + OSM_COPYRIGHT_URL }),
        'tiles.json attribution',
      ],
      [
        'tiles.json',
        (json) => ({ ...json, attributionText: OSM_COPYRIGHT_URL }),
        'tiles.json attributionText',
      ],
      [
        'style.json',
        (json) => ({
          ...json,
          sources: { basemap: { ...json.sources.basemap, attribution: OSM_COPYRIGHT_URL } },
        }),
        'style.json source basemap attribution',
      ],
    ]) {
      const root = await workspace();
      await stageComplete(root);
      await mutateJson(join(root, file), change);
      await expect(verifyStagedBuild(root, 1), file).rejects.toThrow(
        `ODBL_NOTICE_MISSING: ${message}`,
      );
    }
  });

  it('refuses a deployment without its alteration record', async () => {
    const root = await workspace();
    await stageComplete(root);
    await rm(join(root, DISCLOSURE_FILE));
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow(
      `STAGED_BUILD_INCOMPLETE: ${DISCLOSURE_FILE}`,
    );
  });

  it('refuses a self-consistent notice with missing alteration method facts', async () => {
    for (const change of [
      (method) => ({ ...method, layerFilters: [] }),
      (method) => ({ ...method, tippecanoeArguments: [] }),
      (method) => ({ ...method, scripts: {} }),
    ]) {
      const root = await workspace();
      await stageComplete(root);
      const disclosure = sampleDisclosure();
      disclosure.alterationMethod = change(disclosure.alterationMethod);
      await writeFile(join(root, DISCLOSURE_FILE), JSON.stringify(disclosure));
      await writeFile(join(root, 'ATTRIBUTION.txt'), renderBasemapAttribution(disclosure));
      await expect(verifyStagedBuild(root, 1)).rejects.toThrow('ODBL_DISCLOSURE_INVALID');
    }
  });

  it('refuses a notice that is not the rendering of the record, even one that names the licence', async () => {
    const root = await workspace();
    await stageComplete(root);
    const path = join(root, 'ATTRIBUTION.txt');
    // Still carries both URIs; only a hand edit of the method below them.
    await writeFile(path, (await readFile(path, 'utf8')).replace('w/highway', 'w/footway'));
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow('ODBL_ATTRIBUTION_STALE');
  });

  it("refuses another deployment's record", async () => {
    const root = await workspace();
    await stageComplete(root);
    const foreign = sampleDisclosure({ deploymentId: 'other' });
    await writeFile(join(root, DISCLOSURE_FILE), JSON.stringify(foreign));
    await writeFile(join(root, 'ATTRIBUTION.txt'), renderBasemapAttribution(foreign));
    await expect(verifyStagedBuild(root, 1)).rejects.toThrow('ODBL_DISCLOSURE_FOREIGN');
  });

  it('takes the extract date from the artifacts that recorded it, never from nowhere', () => {
    const allowlistedUrl = 'https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf';
    const sha256 = '7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea';
    const reused = { sourceId: 'osm-extract-seoul', url: null, sha256, reusedFromDisk: true };
    const downloaded = {
      sourceId: 'osm-extract-seoul',
      url: allowlistedUrl,
      sha256,
      lastModified: 'Sat, 19 Sep 2026 16:20:02 GMT',
      etag: '"1"',
      reusedFromDisk: false,
    };
    expect(
      resolveAcquisition({ download: downloaded, record: null, earlierRuns: [], allowlistedUrl })
        .recordedBy,
    ).toBe('download-response');
    const record = {
      sourceId: 'osm-extract-seoul',
      url: allowlistedUrl,
      lastModified: 'D',
      etag: null,
    };
    expect(
      resolveAcquisition({ download: reused, record, earlierRuns: [], allowlistedUrl }),
    ).toMatchObject({ lastModified: 'D', recordedBy: 'acquisition-record' });
    const runs = [
      { source: { ...downloaded, lastModified: 'older' } },
      { source: { ...downloaded, sha256: 'f'.repeat(64), lastModified: 'other bytes' } },
      { source: { ...reused } },
    ];
    expect(
      resolveAcquisition({ download: reused, record: null, earlierRuns: runs, allowlistedUrl }),
    ).toMatchObject({ lastModified: 'older', recordedBy: 'earlier-build-report' });
    expect(
      resolveAcquisition({ download: reused, record: null, earlierRuns: [], allowlistedUrl }),
    ).toEqual({
      sourceId: 'osm-extract-seoul',
      url: allowlistedUrl,
      lastModified: null,
      etag: null,
      recordedBy: 'none',
    });
  });

  it('does not disclose an acquisition URL or date that differs from the allowed source', () => {
    const allowlistedUrl = 'https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf';
    const tokenUrl = `${allowlistedUrl}?token=private`;
    const sha256 = '7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea';
    const reused = { sourceId: 'osm-extract-seoul', url: null, sha256, reusedFromDisk: true };
    const expected = {
      sourceId: reused.sourceId,
      url: allowlistedUrl,
      lastModified: null,
      etag: null,
      recordedBy: 'none',
    };
    const record = {
      sourceId: reused.sourceId,
      url: tokenUrl,
      lastModified: 'Sat, 19 Sep 2026 16:20:02 GMT',
      etag: 'secret',
    };
    const earlierRuns = [
      {
        source: {
          ...reused,
          url: tokenUrl,
          reusedFromDisk: false,
          lastModified: record.lastModified,
          etag: record.etag,
        },
      },
    ];
    expect(resolveAcquisition({ download: reused, record, earlierRuns, allowlistedUrl })).toEqual(
      expected,
    );
    expect(
      resolveAcquisition({
        download: {
          ...reused,
          url: tokenUrl,
          reusedFromDisk: false,
          lastModified: record.lastModified,
        },
        record: null,
        earlierRuns: [],
        allowlistedUrl,
      }),
    ).toEqual(expected);
  });

  it('builds a relocated scratch deployment only outside .geo-build', async () => {
    const shared = await workspace();
    expect(basemapWorkRootFrom(undefined, shared)).toMatchObject({
      workRoot: shared,
      relocated: false,
    });
    const elsewhere = await workspace();
    expect(basemapWorkRootFrom(elsewhere, shared)).toEqual({
      workRoot: elsewhere,
      reportPath: join(elsewhere, 'basemap-build-report.json'),
      relocated: true,
    });
    expect(() => basemapWorkRootFrom(join(shared, 'inside'), shared)).toThrow(
      'BASEMAP_WORK_ROOT_INSIDE_GEO_BUILD',
    );
    expect(() => basemapWorkRootFrom('relative/dir', shared)).toThrow(
      'BASEMAP_WORK_ROOT_NOT_ABSOLUTE',
    );
  });
});

describe('publishing a staged build', () => {
  it('renames the staged directory into a fresh deployment and writes the pointer', async () => {
    const distributionRoot = await workspace();
    const stagingRoot = join(distributionRoot, '.staging-abc-1');
    await stageComplete(stagingRoot);
    const pointer = await publishStagedBuild({
      distributionRoot,
      stagingRoot,
      deploymentId: 'abc-1',
      buildId: 'abc',
    });
    expect(pointer.deploymentId).toBe('abc-1');
    expect(pointer.buildId).toBe('abc');
    expect(pointer.previousDeploymentId).toBeNull();
    expect((await stat(join(distributionRoot, 'abc-1'))).isDirectory()).toBe(true);
    await expect(stat(stagingRoot)).rejects.toThrow();
    const written = JSON.parse(await readFile(join(distributionRoot, 'current.json'), 'utf8'));
    expect(written.deploymentId).toBe('abc-1');
  });

  it('never replaces a published deployment, so rollback reaches the old bytes', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-1'));
    await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-1'),
      deploymentId: 'abc-1',
      buildId: 'abc',
    });
    await writeFile(join(distributionRoot, 'abc-1', 'marker.txt'), 'first');
    // Same build id, second publish: the earlier deployment must be untouched.
    await stageComplete(join(distributionRoot, '.staging-2'));
    await writeFile(join(distributionRoot, '.staging-2', 'marker.txt'), 'second');
    const pointer = await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-2'),
      deploymentId: 'abc-2',
      buildId: 'abc',
    });
    expect(pointer.previousDeploymentId).toBe('abc-1');
    expect(pointer.deploymentId).not.toBe(pointer.previousDeploymentId);
    expect(await readFile(join(distributionRoot, 'abc-1', 'marker.txt'), 'utf8')).toBe('first');
    expect(await readFile(join(distributionRoot, 'abc-2', 'marker.txt'), 'utf8')).toBe('second');
    // Rolling the pointer back yields the OLD content, not the new content.
    const rolledBack = join(distributionRoot, pointer.previousDeploymentId, 'marker.txt');
    expect(await readFile(rolledBack, 'utf8')).toBe('first');
  });

  it('refuses to publish onto an existing deployment id', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-1'));
    await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-1'),
      deploymentId: 'abc-1',
      buildId: 'abc',
    });
    await stageComplete(join(distributionRoot, '.staging-2'));
    await expect(
      publishStagedBuild({
        distributionRoot,
        stagingRoot: join(distributionRoot, '.staging-2'),
        deploymentId: 'abc-1',
        buildId: 'abc',
      }),
    ).rejects.toThrow('DEPLOYMENT_ID_ALREADY_PUBLISHED');
    // The deployed copy is still there and still complete.
    await expect(verifyStagedBuild(join(distributionRoot, 'abc-1'), 1)).resolves.toBeUndefined();
  });

  it('leaves the deployed copy intact when the publish fails', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-1'));
    const first = await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-1'),
      deploymentId: 'abc-1',
      buildId: 'abc',
    });
    await writeFile(join(distributionRoot, 'abc-1', 'marker.txt'), 'deployed');
    await expect(
      publishStagedBuild({
        distributionRoot,
        // A staging directory that does not exist makes the rename fail.
        stagingRoot: join(distributionRoot, '.staging-missing'),
        deploymentId: 'abc-2',
        buildId: 'abc',
      }),
    ).rejects.toThrow();
    expect(await readFile(join(distributionRoot, 'abc-1', 'marker.txt'), 'utf8')).toBe('deployed');
    const pointer = JSON.parse(await readFile(join(distributionRoot, 'current.json'), 'utf8'));
    // The pointer still names the working deployment.
    expect(pointer.deploymentId).toBe(first.deploymentId);
  });

  it('keeps the current and previous deployments and removes older ones', async () => {
    const distributionRoot = await workspace();
    for (const id of ['abc-1', 'abc-2', 'abc-3']) {
      await stageComplete(join(distributionRoot, `.staging-${id}`));
      await publishStagedBuild({
        distributionRoot,
        stagingRoot: join(distributionRoot, `.staging-${id}`),
        deploymentId: id,
        buildId: 'abc',
        prune: false,
      });
    }
    const removed = await pruneDeployments(distributionRoot);
    expect(removed).toEqual(['abc-1']);
    expect((await stat(join(distributionRoot, 'abc-2'))).isDirectory()).toBe(true);
    expect((await stat(join(distributionRoot, 'abc-3'))).isDirectory()).toBe(true);
  });

  it('never prunes the live deployment, even from a stale view of the pointer', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-a'));
    // Publish A, then B. A prune driven by A's (now stale) pointer used to delete B.
    await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-a'),
      deploymentId: 'abc-a',
      buildId: 'abc',
      prune: false,
    });
    await stageComplete(join(distributionRoot, '.staging-b'));
    await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-b'),
      deploymentId: 'abc-b',
      buildId: 'abc',
      prune: false,
    });
    const removed = await pruneDeployments(distributionRoot);
    const pointer = JSON.parse(await readFile(join(distributionRoot, 'current.json'), 'utf8'));
    expect(pointer.deploymentId).toBe('abc-b');
    expect(removed).toEqual([]);
    // The live deployment and its predecessor both survive.
    expect((await stat(join(distributionRoot, 'abc-b'))).isDirectory()).toBe(true);
    expect((await stat(join(distributionRoot, 'abc-a'))).isDirectory()).toBe(true);
  });

  it('leaves another build staging directory and the lock alone', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-live'));
    await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-live'),
      deploymentId: 'abc-live',
      buildId: 'abc',
      prune: false,
    });
    // A concurrent build's staging directory, mid-write.
    await stageComplete(join(distributionRoot, '.staging-other-7788'));
    const removed = await pruneDeployments(distributionRoot);
    expect(removed).toEqual([]);
    expect((await stat(join(distributionRoot, '.staging-other-7788'))).isDirectory()).toBe(true);
  });

  it('refuses to publish while another publish holds the lock', async () => {
    const distributionRoot = await workspace();
    await stageComplete(join(distributionRoot, '.staging-1'));
    await withDistributionLock(distributionRoot, async () => {
      await expect(
        publishStagedBuild({
          distributionRoot,
          stagingRoot: join(distributionRoot, '.staging-1'),
          deploymentId: 'abc-1',
          buildId: 'abc',
        }),
      ).rejects.toThrow('DISTRIBUTION_LOCKED');
    });
    // The lock is released afterwards, so the same publish now succeeds.
    const pointer = await publishStagedBuild({
      distributionRoot,
      stagingRoot: join(distributionRoot, '.staging-1'),
      deploymentId: 'abc-1',
      buildId: 'abc',
    });
    expect(pointer.deploymentId).toBe('abc-1');
  });
});
