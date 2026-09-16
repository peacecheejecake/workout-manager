import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inventory the installed production dependency closure. No registry/network access.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const visited = new Set();
const packages = [];
const unresolved = [];
async function visit(manifest) {
  const resolved = await realpath(manifest);
  if (visited.has(resolved)) return;
  visited.add(resolved);
  const data = JSON.parse(await readFile(resolved, 'utf8'));
  const directory = dirname(resolved);
  const notices = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!/^(license|licence|copying|notice)(\.[a-z0-9_-]+)?$/i.test(name)) continue;
    try {
      const content = await readFile(join(directory, name));
      notices.push({ file: name, sha256: createHash('sha256').update(content).digest('hex') });
    } catch (error) {
      if (error.code !== 'EISDIR') throw error;
    }
  }
  packages.push({
    name: data.name,
    version: data.version,
    license: typeof data.license === 'string' ? data.license : null,
    workspace: Boolean(data.private && data.name.startsWith('@workout/')),
    notices,
  });
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
          Boolean(data.peerDependenciesMeta?.[dependency]?.optional),
      });
  }
}
await visit(join(root, 'packages/experience/ui-spike/package.json'));
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const external = packages.filter((entry) => !entry.workspace);
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  scope:
    'Installed production dependency closure of @workout/ui-spike; metadata and root notice files only. Not legal approval or a paid-extension/full-bundled-source audit.',
  lockfileSha256: createHash('sha256')
    .update(await readFile(join(root, 'pnpm-lock.yaml')))
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
await writeFile(
  join(root, 'docs/implementation/research/ui-spike-license-inventory.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    packageCount: report.packageCount,
    licenses: report.licenses,
    unresolved: unresolved.length,
    missingNoticeFiles: report.missingNoticeFiles.length,
  }),
);
if (unresolved.some((entry) => !entry.optional)) process.exitCode = 1;
