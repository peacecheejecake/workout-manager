import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { readPinnedMapDataScript } from '../src/map-data-script-read.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'odbl-script-'));
  await mkdir(join(root, 'odbl-scripts'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it('returns exact manifest-pinned bytes and fails closed for changed bytes, indices and links', async () => {
  const bytes = Buffer.from('osmium tags-filter -R');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const scripts = { 'scripts/build-basemap.mjs': digest };
  await writeFile(join(root, 'odbl-scripts/0.txt'), bytes);
  expect(await readPinnedMapDataScript(root, scripts, '0')).toEqual(bytes);
  expect(await readPinnedMapDataScript(root, scripts, '../0')).toBeNull();
  expect(await readPinnedMapDataScript(root, scripts, '1')).toBeNull();
  expect(await readPinnedMapDataScript(root, { 'scripts/../secret': digest }, '0')).toBeNull();
  await writeFile(join(root, 'odbl-scripts/0.txt'), 'mutated');
  expect(await readPinnedMapDataScript(root, scripts, '0')).toBeNull();
  await rm(join(root, 'odbl-scripts/0.txt'));
  const foreign = join(root, 'foreign');
  await writeFile(foreign, bytes);
  await symlink(foreign, join(root, 'odbl-scripts/0.txt'));
  expect(await readPinnedMapDataScript(root, scripts, '0')).toBeNull();
});
