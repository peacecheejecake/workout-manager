import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let root;
afterEach(async () => {
  delete process.env.BASEMAP_DIST_DIR;
  vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
});

it('serves only active basemap script bytes matching disclosure hash', async () => {
  root = await mkdtemp(join(tmpdir(), 'odbl-basemap-route-'));
  process.env.BASEMAP_DIST_DIR = root;
  const deploymentId = 'abc123abc123-public';
  const directory = join(root, deploymentId);
  await mkdir(join(directory, 'odbl-scripts'), { recursive: true });
  const bytes = Buffer.from('osmium tags-filter -R w/highway\n');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const disclosure = {
    schemaVersion: 1,
    kind: 'basemap-tiles',
    licence: {
      name: 'ODbL-1.0',
      url: 'https://opendatacommons.org/licenses/odbl/1-0/',
      copyrightUrl: 'https://www.openstreetmap.org/copyright',
      attribution: '© OpenStreetMap contributors',
    },
    buildId: 'abc123abc123',
    deploymentId,
    region: 'Fixture',
    source: {
      sha256: 'a'.repeat(64),
      bytes: 10,
      acquisition: {
        sourceId: 'fixture',
        url: 'https://example.test/source.pbf',
        lastModified: null,
        etag: null,
        recordedBy: 'none',
      },
    },
    alterationMethod: {
      description: 'Fixture filter',
      layerFilters: [{ layer: 'roads', expressions: ['w/highway'] }],
      osmiumExportFormat: 'geojsonseq',
      tippecanoeArguments: ['--minimum-zoom', '9'],
      minzoom: 9,
      maxzoom: 15,
      glyphRanges: [],
      scripts: { 'scripts/build-basemap.mjs': digest },
    },
    toolVersions: { osmium: null, tippecanoe: null, node: 'v24.12.0' },
  };
  await writeFile(join(root, 'current.json'), JSON.stringify({ deploymentId }));
  await writeFile(join(directory, 'odbl-disclosure.json'), JSON.stringify(disclosure));
  await writeFile(join(directory, 'odbl-scripts/0.txt'), bytes);
  const { GET } = await import('../../../apps/web/app/map/basemap/[...path]/route.ts');
  const request = new Request(`http://localhost/map/basemap/${deploymentId}/odbl-scripts/0.txt`);
  const context = { params: Promise.resolve({ path: [deploymentId, 'odbl-scripts', '0.txt'] }) };
  expect(Buffer.from(await (await GET(request, context)).arrayBuffer())).toEqual(bytes);
  await writeFile(join(directory, 'odbl-scripts/0.txt'), 'changed');
  expect((await GET(request, context)).status).toBe(404);
  await writeFile(join(directory, 'odbl-scripts/0.txt'), bytes);
  await writeFile(join(root, 'current.json'), JSON.stringify({ deploymentId: 'other-deployment' }));
  expect((await GET(request, context)).status).toBe(404);
  expect(
    (
      await GET(request, {
        params: Promise.resolve({ path: [deploymentId, 'odbl-scripts', '..'] }),
      })
    ).status,
  ).toBe(404);
});
