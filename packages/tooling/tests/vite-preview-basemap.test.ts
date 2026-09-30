import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadConfigFromFile, preview, type PreviewServer } from 'vite';

const configFile = resolve(import.meta.dirname, '../../../apps/mobile-web/vite.config.ts');
const staleBytes = 'stale disclosure script must never be served';
let previewServer: PreviewServer | undefined;
let rawServer: Server | undefined;
let tempRoot: string | undefined;
const originalOrigin = process.env['BASEMAP_ORIGIN'];

afterEach(async () => {
  await new Promise<void>((resolveClose, reject) => {
    if (!previewServer?.httpServer.listening) return resolveClose();
    previewServer.httpServer.close((error) => (error ? reject(error) : resolveClose()));
  });
  previewServer = undefined;
  await new Promise<void>((resolveClose, reject) => {
    if (!rawServer?.listening) return resolveClose();
    rawServer.close((error) => (error ? reject(error) : resolveClose()));
  });
  rawServer = undefined;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
  if (originalOrigin === undefined) delete process.env['BASEMAP_ORIGIN'];
  else process.env['BASEMAP_ORIGIN'] = originalOrigin;
});

test('preview refuses both copied and raw-origin basemap disclosure files while dev retains its proxy', async () => {
  rawServer = createServer((_request, response) => response.end(staleBytes));
  await new Promise<void>((resolveListen, reject) => {
    rawServer?.once('error', reject).listen(0, '127.0.0.1', resolveListen);
  });
  const rawAddress = rawServer.address();
  if (!rawAddress || typeof rawAddress === 'string') throw new Error('raw origin failed to listen');
  process.env['BASEMAP_ORIGIN'] = `http://127.0.0.1:${rawAddress.port}`;

  const devConfig = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile);
  expect(devConfig?.config.server?.proxy?.['/map/basemap']).toEqual({
    target: process.env['BASEMAP_ORIGIN'],
  });

  tempRoot = await mkdtemp(join(tmpdir(), 'wm-vite-preview-'));
  const copiedPath = join(tempRoot, 'dist/map/basemap/odbl-scripts/0.txt');
  await mkdir(join(tempRoot, 'dist/map/basemap/odbl-scripts'), { recursive: true });
  await writeFile(copiedPath, staleBytes);
  await writeFile(join(tempRoot, 'dist/index.html'), '<html>preview shell</html>');
  previewServer = await preview({
    configFile,
    root: tempRoot,
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  const previewAddress = previewServer.httpServer.address();
  if (!previewAddress || typeof previewAddress === 'string')
    throw new Error('preview failed to listen');
  const origin = `http://127.0.0.1:${previewAddress.port}`;

  for (const path of [
    '/map/basemap/odbl-scripts/0.txt',
    '/map/basemap%2Fodbl-scripts%2F0.txt',
    '/map/basemap',
  ]) {
    const response = await fetch(`${origin}${path}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(staleBytes);
  }
  const shell = await fetch(origin);
  expect(shell.status).toBe(200);
  expect(await shell.text()).toContain('preview shell');
});
