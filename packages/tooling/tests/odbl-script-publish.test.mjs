import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { publishOdblScripts } from '../../../scripts/geo/publish-odbl-scripts.mjs';

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'odbl-publish-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it('copies exact manifest-pinned script bytes for basemap, geo datasets and routing', async () => {
  const inputs = [
    ['basemap', ['scripts/build-basemap.mjs', 'scripts/geo/style.mjs']],
    ['geo', ['scripts/build-geo-datasets.mjs']],
    ['routing', ['scripts/build-routing-graph.mts', 'scripts/geo/MilitaryPerimeterBarriers.java']],
  ];
  for (const [kind, paths] of inputs) {
    const scripts = {};
    for (const path of paths) {
      const bytes = Buffer.from(`${path}\n\0exact bytes`);
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), bytes);
      scripts[path] = createHash('sha256').update(bytes).digest('hex');
    }
    const destination = join(root, `artifact-${kind}`);
    await publishOdblScripts(root, destination, scripts);
    const entries = Object.entries(scripts).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const [index, [path, digest]] of entries.entries()) {
      const copied = await readFile(join(destination, 'odbl-scripts', `${index}.txt`));
      expect(copied).toEqual(await readFile(join(root, path)));
      expect(createHash('sha256').update(copied).digest('hex')).toBe(digest);
    }
  }
});

it('refuses a changed source hash and traversal entry before publishing', async () => {
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/build-basemap.mjs'), 'mutated');
  await expect(
    publishOdblScripts(root, join(root, 'artifact'), {
      'scripts/build-basemap.mjs': 'a'.repeat(64),
    }),
  ).rejects.toThrow('ODBL_SCRIPT_HASH_MISMATCH');
  await expect(
    publishOdblScripts(root, join(root, 'artifact'), { 'scripts/../secret': 'a'.repeat(64) }),
  ).rejects.toThrow('ODBL_SCRIPT_PATH_INVALID');
});
