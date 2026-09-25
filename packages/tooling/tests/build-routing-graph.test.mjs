import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { fullImportRefusal, routingGraphRootFrom } from '../../../scripts/build-routing-graph.mts';

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
