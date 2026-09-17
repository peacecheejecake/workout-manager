import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function boundedRead(path, limit) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw new Error('INPUT_SIZE_LIMIT');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('INPUT_SIZE_LIMIT');
  return bytes;
}
// Inventory the installed production dependency closure. No registry/network access.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export async function collectUiLicenseInventory({
  rootDirectory = root,
  entryManifest = join(rootDirectory, 'packages/experience/ui-spike/package.json'),
  checkedAt = new Date().toISOString(),
} = {}) {
  const visited = new Set();
  const packages = [];
  const locations = new Map();
  const unresolved = [];
  async function visit(manifest) {
    const resolved = await realpath(manifest);
    if (visited.has(resolved)) return;
    if (visited.size >= 2000) throw new Error('PACKAGE_LIMIT');
    visited.add(resolved);
    const data = JSON.parse((await boundedRead(resolved, 1024 * 1024)).toString('utf8'));
    if (typeof data.name !== 'string' || typeof data.version !== 'string')
      throw new Error('INVALID_PACKAGE_METADATA');
    const directory = dirname(resolved);
    const notices = [];
    for (const name of (await readdir(directory)).sort()) {
      if (!/^(license|licence|copying|notice)(\.[a-z0-9_-]+)?$/i.test(name)) continue;
      try {
        if (notices.length >= 64) throw new Error('NOTICE_COUNT_LIMIT');
        const path = await realpath(join(directory, name));
        const rel = relative(directory, path);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('NOTICE_OUTSIDE_PACKAGE');
        if ((await stat(path)).isDirectory()) continue;
        const content = await boundedRead(path, 2 * 1024 * 1024);
        notices.push({ file: name, sha256: createHash('sha256').update(content).digest('hex') });
      } catch (error) {
        if (error.code !== 'EISDIR') throw error;
      }
    }
    const entry = {
      name: data.name,
      version: data.version,
      license: typeof data.license === 'string' ? data.license : null,
      workspace: Boolean(data.private && data.name.startsWith('@workout/')),
      notices,
    };
    packages.push(entry);
    locations.set(entry, directory);
    const require = createRequire(resolved);
    const dependencies = {
      ...data.peerDependencies,
      ...data.dependencies,
      ...data.optionalDependencies,
    };
    for (const dependency of Object.keys(dependencies).sort()) {
      let found;
      for (const base of require.resolve.paths(dependency) ?? []) {
        const candidate = join(base, dependency, 'package.json');
        try {
          found = await realpath(candidate);
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (found) await visit(found);
      else
        unresolved.push({
          from: `${data.name}@${data.version}`,
          name: dependency,
          optional:
            Object.hasOwn(data.optionalDependencies ?? {}, dependency) ||
            (!Object.hasOwn(data.dependencies ?? {}, dependency) &&
              Boolean(data.peerDependenciesMeta?.[dependency]?.optional)),
        });
    }
  }
  await visit(entryManifest);
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const external = packages.filter((entry) => !entry.workspace);
  const report = {
    schemaVersion: 1,
    checkedAt,
    scope:
      'Installed production dependency closure of @workout/ui-spike; metadata and root notice files only. Not legal approval or a paid-extension/full-bundled-source audit.',
    lockfileSha256: createHash('sha256')
      .update(await boundedRead(join(rootDirectory, 'pnpm-lock.yaml'), 16 * 1024 * 1024))
      .digest('hex'),
    packageCount: packages.length,
    licenses: Object.fromEntries(
      [...new Set(external.map((entry) => entry.license ?? 'UNKNOWN'))]
        .sort()
        .map((license) => [
          license,
          external.filter((entry) => (entry.license ?? 'UNKNOWN') === license).length,
        ]),
    ),
    missingNoticeFiles: external
      .filter((entry) => entry.notices.length === 0)
      .map((entry) => `${entry.name}@${entry.version}`),
    unresolved,
    packages,
  };
  return { report, packageDirectories: packages.map((entry) => locations.get(entry)) };
}

async function main() {
  const { report } = await collectUiLicenseInventory();
  await writeFile(
    join(root, 'docs/implementation/research/ui-spike-license-inventory.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      packageCount: report.packageCount,
      licenses: report.licenses,
      unresolved: report.unresolved.length,
      missingNoticeFiles: report.missingNoticeFiles.length,
    }),
  );
  if (report.unresolved.some((entry) => !entry.optional)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
