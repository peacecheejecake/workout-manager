import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { collectUiLicenseInventory } from '../../../scripts/audit-ui-licenses.mjs';
import { generateUiNotices } from '../../../scripts/generate-ui-notices.mjs';

const temporary = [];
const hash = (text) => createHash('sha256').update(text).digest('hex');
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(dependencies = { 'synthetic-notice-package': '1.0.0' }) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'ui-notices-'));
  temporary.push(rootDirectory);
  const entryManifest = join(rootDirectory, 'package.json');
  await writeFile(
    entryManifest,
    JSON.stringify({ name: '@workout/fixture', version: '1', private: true, dependencies }),
  );
  await writeFile(join(rootDirectory, 'pnpm-lock.yaml'), 'synthetic lockfile\n');
  return { rootDirectory, entryManifest, outputDirectory: join(rootDirectory, 'output') };
}
async function pkg(
  f,
  name,
  files = {
    LICENSE: 'Complete synthetic license\nCopyright example\n',
    NOTICE: 'Complete attribution\n',
  },
  version = '1.0.0',
) {
  const directory = join(f.rootDirectory, 'node_modules', name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name, version, license: 'MIT' }),
  );
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  return directory;
}
async function supplements(f) {
  const { report, packageDirectories } = await collectUiLicenseInventory();
  for (const [name, version, paths] of [
    ['echarts', '6.1.0', ['LICENSE', 'NOTICE', 'licenses/LICENSE-d3']],
    ['murmurhash-js', '1.0.0', ['README.md']],
  ]) {
    const index = report.packages.findIndex(
      (entry) => entry.name === name && entry.version === version,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const files = {};
    for (const path of paths) files[path] = await readFile(join(packageDirectories[index], path));
    await pkg(f, name, files, version);
  }
}
describe('installed UI notice distribution', () => {
  it('retains complete root bodies and produces deterministic relative-path manifests', async () => {
    const f = await fixture();
    await pkg(f, 'synthetic-notice-package');
    const first = await generateUiNotices(f);
    const text = await readFile(join(f.outputDirectory, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(text).toContain('synthetic-notice-package@1.0.0');
    expect(text).toContain('Complete synthetic license\nCopyright example\n');
    expect(text).toContain('Complete attribution\n');
    expect(first.bundleSha256).toBe(hash(text));
    expect(first.lockfileSha256).toBe(hash('synthetic lockfile\n'));
    expect(JSON.stringify(first)).not.toContain(f.rootDirectory);
    expect(first).not.toHaveProperty('checkedAt');
    const second = await generateUiNotices({
      ...f,
      outputDirectory: join(f.rootDirectory, 'second'),
    });
    expect(second).toEqual(first);
    expect(await readFile(join(f.rootDirectory, 'second', 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toBe(
      text,
    );
  });
  it('includes pinned ECharts attribution and the complete README license section without changing historical evidence', async () => {
    const historical = resolve('docs/implementation/research/ui-spike-license-inventory.json');
    const before = await readFile(historical);
    const f = await fixture({ echarts: '6.1.0', 'murmurhash-js': '1.0.0' });
    await supplements(f);
    const manifest = await generateUiNotices(f);
    const text = await readFile(join(f.outputDirectory, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    const d3 = await readFile(
      join(f.rootDirectory, 'node_modules/echarts/licenses/LICENSE-d3'),
      'utf8',
    );
    const readme = await readFile(
      join(f.rootDirectory, 'node_modules/murmurhash-js/README.md'),
      'utf8',
    );
    expect(text).toContain(d3);
    expect(text).toContain(readme.slice(readme.indexOf('## License (MIT)')));
    expect(text).toContain('Gary Court');
    expect(
      manifest.packages.find((p) => p.name === 'echarts').notices.map((n) => n.path),
    ).toContain('licenses/LICENSE-d3');
    expect(await readFile(historical)).toEqual(before);
    await writeFile(join(f.rootDirectory, 'node_modules/echarts/licenses/LICENSE-d3'), 'changed');
    await expect(generateUiNotices(f)).rejects.toThrow('SUPPLEMENTAL_NOTICE_CHANGED');
    expect(await readFile(join(f.outputDirectory, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toBe(text);
  });
  it('fails before output creation for missing required dependencies or missing root notices', async () => {
    const f = await fixture();
    await expect(generateUiNotices(f)).rejects.toThrow('REQUIRED_DEPENDENCY_MISSING');
    await expect(readFile(join(f.outputDirectory, 'manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await pkg(f, 'synthetic-notice-package', {});
    await expect(generateUiNotices(f)).rejects.toThrow('EXTERNAL_NOTICE_MISSING');
    await expect(readFile(join(f.outputDirectory, 'manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('does not downgrade required dependencies to optional peers', async () => {
    const f = await fixture();
    const data = JSON.parse(await readFile(f.entryManifest, 'utf8'));
    data.peerDependenciesMeta = { 'synthetic-notice-package': { optional: true } };
    await writeFile(f.entryManifest, JSON.stringify(data));
    await expect(generateUiNotices(f)).rejects.toThrow('REQUIRED_DEPENDENCY_MISSING');
    delete data.dependencies;
    data.optionalDependencies = { 'synthetic-notice-package': '1' };
    await writeFile(f.entryManifest, JSON.stringify(data));
    expect((await generateUiNotices(f)).packages).toEqual([]);
  });
  it('rejects escaped notice symlinks and oversized files before inventory reads', async () => {
    const f = await fixture();
    const directory = await pkg(f, 'synthetic-notice-package', {});
    await writeFile(join(f.rootDirectory, 'outside'), 'outside');
    await symlink(join(f.rootDirectory, 'outside'), join(directory, 'LICENSE'));
    await expect(generateUiNotices(f)).rejects.toThrow('NOTICE_OUTSIDE_PACKAGE');
    await rm(join(directory, 'LICENSE'));
    await writeFile(join(directory, 'LICENSE'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(generateUiNotices(f)).rejects.toThrow('INPUT_SIZE_LIMIT');
  });
  it('fails closed if a pinned supplemental file is missing or its package version changes', async () => {
    const f = await fixture({ echarts: '6.1.0' });
    const directory = await pkg(f, 'echarts', { LICENSE: 'root' }, '6.1.0');
    await expect(generateUiNotices(f)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'echarts', version: '6.1.1' }),
    );
    await expect(generateUiNotices(f)).rejects.toThrow('SUPPLEMENTAL_VERSION_CHANGED');
  });
});
