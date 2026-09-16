import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/experience/ui-spike/package.json'));
const source = dirname(require.resolve('maplibre-gl/package.json'));
const target = resolve('public/dist/maplibre');
await mkdir(target, { recursive: true });
// v6 worker imports its shared ESM sibling. Both must be served from the same origin.
for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  await copyFile(join(source, 'dist', file), join(target, file));
}
await copyFile(join(source, 'LICENSE.txt'), join(target, 'LICENSE.txt'));
