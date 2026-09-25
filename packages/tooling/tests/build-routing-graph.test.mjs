import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { realpathSync } from 'node:fs';

import {
  fullImportRefusal,
  routingExtractFrom,
  routingGraphRootFrom,
} from '../../../scripts/build-routing-graph.mts';
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
