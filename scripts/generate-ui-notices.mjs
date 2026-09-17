import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectUiLicenseInventory } from './audit-ui-licenses.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const scope =
  'Installed production dependencies and installed peers of @workout/ui-spike. Not an exact tree-shaken bundle inventory, full-app license clearance, or map/provider data permission.';
const supplemental = {
  echarts: {
    version: '6.1.0',
    path: 'licenses/LICENSE-d3',
    sha256: 'e1211892da0b0e0585b7aebe8f98c1274fba15bafe47fa1f4ee8a7a502c06304',
  },
  'murmurhash-js': {
    version: '1.0.0',
    path: 'README.md',
    sha256: 'e137ced8967fc334ec9b5fc5c8500992f9e49d2e9cc0f6e2439e46af2f2481a4',
    bodySha256: '00309875dc165cf120f89b6d04ff97b9958bbc7b9db1a26457a602dcf4e35937',
  },
};
async function notice(directory, path) {
  if (
    typeof path !== 'string' ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((part) => part === '..' || part === '' || part === '.')
  )
    throw new Error('INVALID_NOTICE_PATH');
  const base = await realpath(directory);
  const resolved = await realpath(join(base, path));
  const rel = relative(base, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('NOTICE_OUTSIDE_PACKAGE');
  const info = await stat(resolved);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('INVALID_NOTICE_SIZE');
  const bytes = await readFile(resolved);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('INVALID_NOTICE_SIZE');
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), sha256: hash(bytes) };
}
export async function generateUiNotices({
  rootDirectory = root,
  entryManifest = join(rootDirectory, 'packages/experience/ui-spike/package.json'),
  outputDirectory = join(process.cwd(), 'public/dist/notices'),
} = {}) {
  const { report, packageDirectories } = await collectUiLicenseInventory({
    rootDirectory,
    entryManifest,
  });
  if (report.unresolved.some((entry) => !entry.optional))
    throw new Error('REQUIRED_DEPENDENCY_MISSING');
  if (report.packages.length > 2000) throw new Error('PACKAGE_LIMIT');
  const packages = [];
  const sections = [`THIRD-PARTY NOTICES\n\n${scope}\n`];
  for (const [index, entry] of report.packages.entries()) {
    if (entry.workspace) continue;
    const directory = packageDirectories[index];
    if (!directory || entry.notices.length > 64) throw new Error('INVALID_NOTICE_INVENTORY');
    const notices = [];
    for (const original of entry.notices) {
      const read = await notice(directory, original.file);
      if (read.sha256 !== original.sha256) throw new Error('NOTICE_CHANGED_DURING_READ');
      notices.push({
        path: original.file,
        sha256: read.sha256,
        sourceSha256: read.sha256,
        text: read.text,
      });
    }
    const extra = Object.hasOwn(supplemental, entry.name) ? supplemental[entry.name] : undefined;
    if (extra) {
      if (entry.version !== extra.version) throw new Error('SUPPLEMENTAL_VERSION_CHANGED');
      const read = await notice(directory, extra.path);
      if (read.sha256 !== extra.sha256) throw new Error('SUPPLEMENTAL_NOTICE_CHANGED');
      let text = read.text;
      if (extra.bodySha256) {
        const heading = '## License (MIT)';
        const start = text.indexOf(heading);
        if (
          start < 0 ||
          text.indexOf(heading, start + heading.length) !== -1 ||
          hash(text.slice(start + heading.length).trim()) !== extra.bodySha256
        )
          throw new Error('SUPPLEMENTAL_BODY_CHANGED');
        text = text.slice(start);
      }
      notices.push({ path: extra.path, sha256: hash(text), sourceSha256: read.sha256, text });
    }
    if (!notices.length || notices.some((entry) => !entry.text.trim()))
      throw new Error('EXTERNAL_NOTICE_MISSING');
    notices.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    sections.push(
      `\n===== ${entry.name}@${entry.version} =====\nDeclared license: ${entry.license ?? 'UNKNOWN'}\n`,
    );
    for (const source of notices)
      sections.push(
        `\n--- ${source.path} ---\n${source.text}${source.text.endsWith('\n') ? '' : '\n'}`,
      );
    packages.push({
      name: entry.name,
      version: entry.version,
      license: entry.license,
      notices: notices.map(({ path, sha256, sourceSha256 }) => ({ path, sha256, sourceSha256 })),
    });
  }
  const bundle = sections.join('');
  if (Buffer.byteLength(bundle) > 32 * 1024 * 1024) throw new Error('BUNDLE_TOO_LARGE');
  const manifest = {
    schemaVersion: 1,
    scope,
    lockfileSha256: report.lockfileSha256,
    packages,
    bundleSha256: hash(bundle),
  };
  // Complete validation precedes any output mutation. Build callers must stop on failure.
  await mkdir(outputDirectory, { recursive: true });
  const suffix = randomUUID();
  const textTemp = join(outputDirectory, `.notices-${suffix}.tmp`);
  const manifestTemp = join(outputDirectory, `.manifest-${suffix}.tmp`);
  try {
    await writeFile(textTemp, bundle, { flag: 'wx' });
    await writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(textTemp, join(outputDirectory, 'THIRD_PARTY_NOTICES.txt'));
    await rename(manifestTemp, join(outputDirectory, 'manifest.json'));
  } finally {
    await Promise.all([rm(textTemp, { force: true }), rm(manifestTemp, { force: true })]);
  }
  return manifest;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--output-directory' && args[1]))
    throw new Error('Usage: generate-ui-notices.mjs [--output-directory PATH]');
  const manifest = await generateUiNotices(args[1] ? { outputDirectory: resolve(args[1]) } : {});
  console.log(
    JSON.stringify({ packageCount: manifest.packages.length, bundleSha256: manifest.bundleSha256 }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
