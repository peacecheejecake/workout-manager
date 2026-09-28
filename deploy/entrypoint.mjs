import { spawn } from 'node:child_process';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webEnvironmentKeys = [
  'NODE_ENV',
  'API_ORIGIN',
  'BASEMAP_DIST_DIR',
  'WORKOUT_IDENTITY_WEB_PORT',
  'WORKOUT_IDENTITY_GARMIN_PORT',
  'PATH',
  'HOME',
  'TZ',
  'LANG',
];

export function buildWebEnvironment(source) {
  return Object.fromEntries(
    webEnvironmentKeys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  );
}

async function start() {
  const storage = process.env.PRIVATE_RESOURCE_STORAGE_ROOT;
  if (
    !storage ||
    !isAbsolute(storage) ||
    resolve(storage) === '/' ||
    process.env.NODE_ENV !== 'production'
  ) {
    process.stderr.write('Production runtime configuration is incomplete.\n');
    process.exit(1);
  }
  if (process.env.API_ORIGIN !== 'http://127.0.0.1:4300' || process.env.PORT !== '4300') {
    process.stderr.write('Internal API binding configuration is invalid.\n');
    process.exit(1);
  }
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  if (!publicOrigin || !publicOrigin.startsWith('https://')) {
    process.stderr.write('PUBLIC_ORIGIN must use HTTPS.\n');
    process.exit(1);
  }

  try {
    const canonical = await realpath(storage);
    const info = await stat(canonical);
    const mounts = await readFile('/proc/self/mountinfo', 'utf8');
    const mountpoints = new Set(mounts.split('\n').map((line) => line.split(' ')[4]));
    if (!info.isDirectory() || canonical !== storage || !mountpoints.has(storage)) {
      throw new Error('mount absent');
    }
    await access(storage, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    process.stderr.write('PRIVATE_RESOURCE_STORAGE_ROOT must be a mounted directory.\n');
    process.exit(1);
  }

  const api = spawn(process.execPath, ['/app/apps/api/dist/start.mjs'], { stdio: 'inherit' });
  const web = spawn(
    process.execPath,
    [
      '/app/apps/web/node_modules/next/dist/bin/next',
      'start',
      '--hostname',
      '0.0.0.0',
      '--port',
      '3100',
    ],
    {
      cwd: '/app/apps/web',
      stdio: 'inherit',
      env: buildWebEnvironment(process.env),
    },
  );
  let ending = false;
  function stop() {
    if (ending) return;
    ending = true;
    api.kill('SIGTERM');
    web.kill('SIGTERM');
    setTimeout(() => {
      api.kill('SIGKILL');
      web.kill('SIGKILL');
    }, 10000).unref();
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  api.once('exit', (code) => {
    stop();
    process.exitCode = code || 1;
  });
  web.once('exit', (code) => {
    stop();
    process.exitCode = code || 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await start();
}
