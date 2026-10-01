#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { builtinModules } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const require = createRequire(import.meta.url);
const NODE_VERSION = '24.12.0';
const PG_VERSION = '8.23.0';
const ESBUILD_VERSION = '0.28.2';
const SHA256 = /^[a-f0-9]{64}$/;

function fail() {
  throw new Error('HOST_RUNTIME_PACKAGE_FAILED');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function regular(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail();
}

function nodeArchitecture(bytes) {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46') fail();
  if (bytes[4] !== 2 || bytes[5] !== 1 || ![2, 3].includes(bytes.readUInt16LE(16))) fail();
  const machine = bytes.readUInt16LE(18);
  if (machine === 62) return 'linux-x64';
  if (machine === 183) return 'linux-arm64';
  fail();
}

export function packageHostRuntime({ nodeBinary, nodeSha256, output }) {
  if (!SHA256.test(nodeSha256) || !nodeBinary || !output) fail();
  const destination = resolve(output);
  if (existsSync(destination)) fail();
  regular(nodeBinary);
  const nodeBytes = readFileSync(nodeBinary);
  if (digest(nodeBytes) !== nodeSha256) fail();
  const architecture = nodeArchitecture(nodeBytes);

  const packagePath = require.resolve('pg/package.json');
  const packageBytes = readFileSync(packagePath);
  if (JSON.parse(packageBytes.toString('utf8')).version !== PG_VERSION) fail();
  const bundler = join(
    repository,
    'node_modules',
    '.pnpm',
    `esbuild@${ESBUILD_VERSION}`,
    'node_modules',
    'esbuild',
    'bin',
    'esbuild',
  );
  regular(bundler);
  const entry = join(here, 'namespace-db-preflight.mjs');
  const fence = join(here, 'check-fence.mjs');
  const nativeStub = join(here, 'pg-native-disabled.cjs');
  regular(entry);
  regular(fence);
  regular(nativeStub);

  mkdirSync(destination, { mode: 0o700 });
  const binaryOut = join(destination, 'node');
  const scriptOut = join(destination, 'namespace-db-preflight.mjs');
  const metaOut = join(destination, 'bundle-meta.json');
  copyFileSync(nodeBinary, binaryOut, constants.COPYFILE_EXCL);
  chmodSync(binaryOut, 0o700);
  const result = spawnSync(
    bundler,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node24',
      '--packages=bundle',
      `--alias:pg-native=${nativeStub}`,
      '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      `--outfile=${scriptOut}`,
      `--metafile=${metaOut}`,
      '--log-level=error',
    ],
    {
      cwd: repository,
      timeout: 30_000,
      maxBuffer: 16_384,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      shell: false,
    },
  );
  if (result.error || result.status !== 0) fail();
  const metadata = JSON.parse(readFileSync(metaOut, 'utf8'));
  const inputs = Object.keys(metadata.inputs);
  if (!inputs.some((input) => /(?:^|\/)pg\/lib\/client\.js$/.test(input))) fail();
  const externals = Object.values(metadata.outputs).flatMap((value) => value.imports ?? []);
  const builtins = new Set(builtinModules);
  if (externals.some((item) => !item.external || !builtins.has(item.path.replace(/^node:/, ''))))
    fail();
  chmodSync(scriptOut, 0o700);
  const manifest = {
    schemaVersion: 1,
    nodeVersion: NODE_VERSION,
    architecture,
    nodeSha256,
    pgVersion: PG_VERSION,
    pgPackageJsonSha256: digest(packageBytes),
    esbuildVersion: ESBUILD_VERSION,
    sourceSha256: {
      preflight: digest(readFileSync(entry)),
      fence: digest(readFileSync(fence)),
      nativeStub: digest(readFileSync(nativeStub)),
    },
    bundleSha256: digest(readFileSync(scriptOut)),
  };
  writeFileSync(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) fail();
    packageHostRuntime({
      nodeBinary: process.argv[2],
      nodeSha256: process.argv[3],
      output: process.argv[4],
    });
    process.stdout.write('HOST_RUNTIME_PACKAGE_CREATED\n');
  } catch {
    process.stderr.write('HOST_RUNTIME_PACKAGE_FAILED\n');
    process.exitCode = 1;
  }
}
