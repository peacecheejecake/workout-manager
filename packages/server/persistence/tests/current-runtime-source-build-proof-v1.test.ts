import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentRuntimeV9ParentMembers,
  currentRuntimeV9ExtensionMembers,
} from '../src/current-runtime-installation-v9.js';
import { readFileSync } from 'node:fs';
import {
  parseCurrentRuntimeSourceBuildProofAssetV1,
  compileCurrentRuntimeSourceBuildProofV1,
  enumerateCurrentRuntimeSourceBuildImportsV1,
  currentRuntimeSourceBuildProofV1CompilerProfile as profile,
  parseCurrentRuntimeSourceBuildProofManifestV1,
  verifyCurrentRuntimeSourceBuildProofV1,
} from '../src/current-runtime-source-build-proof-v1.js';
vi.mock('../src/current-runtime-source-build-proof-v1-pin.js', () => ({
  currentRuntimeSourceBuildProofV1AssetSha256: null,
}));
const digest = (body: string) => createHash('sha256').update(body).digest('hex');
const directories: string[] = [];
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'source-build-proof-v1-'));
  directories.push(root);
  const contents = {
    'src/a.ts': "import { value } from './b.js'; export const result=value;\n",
    'src/b.ts': 'export const value=1;\n',
    'case.test.ts': "it('owned strict case', async()=>{});\n",
    'result.log': 'RUN v4.1.11 fixture\nTest Files  1 passed (1)\nTests  8 passed (8)\n',
  };
  Object.assign(contents, {
    'apps/api/src/current-runtime-repositories-registration-v1.ts':
      "export { value } from '../../../packages/server/persistence/src/current-runtime-source-build-proof-v1.js';",
    'packages/server/persistence/src/current-runtime-source-build-proof-v1.ts':
      "import './current-runtime-source-build-proof-v1-pin.js'; import './current-runtime-source-proof-v9-pin.js';",
    'packages/server/persistence/src/current-runtime-source-build-proof-v1-compiler.ts':
      "export { value } from './current-runtime-source-build-proof-v1.js';",
    'packages/server/persistence/src/current-runtime-source-proof-v9-pin.ts':
      'export const oldPin=1;',
  });
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'apps/api/src'), { recursive: true });
  mkdirSync(join(root, 'packages/server/persistence/src'), { recursive: true });
  for (const [path, body] of Object.entries(contents)) writeFileSync(join(root, path), body);
  const manifest = parseCurrentRuntimeSourceBuildProofManifestV1({
    proofVersion: 1,
    sourceBuildRevision: 1,
    profileVersion: 9,
    runtimeStep: 25,
    sourceDdlTip: 142,
    catalogDigest: profile.catalogDigest,
    files: Object.entries(contents).map(([path, body]) => ({
      path,
      sha256: digest(body),
      role: path.endsWith('.test.ts') ? 'fixture' : path.endsWith('.log') ? 'log' : 'source',
    })),
    sourceEntrypoints: [
      'src/a.ts',
      'packages/server/persistence/src/current-runtime-source-build-proof-v1.ts',
      'packages/server/persistence/src/current-runtime-source-build-proof-v1-compiler.ts',
      'apps/api/src/current-runtime-repositories-registration-v1.ts',
    ],
    workspaceImports: {},
    roots: [...profile.roots],
    helpers: [...profile.helpers],
    dynamic: profile.dynamic.map((entry) => ({ ...entry })),
    cases: [
      {
        runner: 'vitest',
        fixture: 'case.test.ts',
        label: 'owned strict case',
        log: 'result.log',
        suitePassed: 8,
        scope: 'same_body_suite',
      },
    ],
    limitations: [
      'historical_116_whole_file_not_final_body_execution',
      'suite_totals_are_not_individual_branch_traces',
      'unavailable_source_modes_are_not_positive_execution',
    ],
  });
  for (const member of [...currentRuntimeV9ParentMembers, ...currentRuntimeV9ExtensionMembers]) {
    const path = 'packages/server/persistence/migrations/' + member.filename;
    const body = readFileSync(path);
    mkdirSync(join(root, 'packages/server/persistence/migrations'), {
      recursive: true,
    });
    writeFileSync(join(root, path), body);
    manifest.files.push({ path, sha256: member.sha256, role: 'sql' });
  }
  function save() {
    const text = JSON.stringify(manifest);
    writeFileSync(join(root, 'manifest.json'), text);
    return digest(text);
  }
  return { root, manifest, save };
}
describe('closed source proof build compiler', () => {
  it('validates independently pinned actual file bytes and freezes a non-authoritative build asset', () => {
    const f = fixture();
    const result = compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save());
    expect(result).toMatchObject({
      profileVersion: 9,
      runtimeStep: 25,
      sourceDdlTip: 142,
      authority: 'none',
      approvalAllowed: false,
      restoreAuthority: 'none',
      buildProofVersion: 1,
      sourceBuildRevision: 1,
      currentFunctionalExecution: 'not_executed',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyCurrentRuntimeSourceBuildProofV1()).toMatchObject({
      state: 'unavailable',
      reason: 'compiled_asset_unavailable',
      sourceManifestSha256: null,
    });
  });
  it('rejects forged expected manifest hash before accepting its statuses', () => {
    const f = fixture();
    f.save();
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', '0'.repeat(64)),
    ).toThrow('SOURCE_DRIFT');
  });
  it('rechecks source drift for every compiler invocation without cached acceptance', () => {
    const f = fixture(),
      pin = f.save();
    compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', pin);
    writeFileSync(join(f.root, 'src/b.ts'), 'export const value=2;');
    expect(() => compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', pin)).toThrow(
      'SOURCE_DRIFT',
    );
  });
  it('rejects absent transitive source even when the manifest itself is pinned', () => {
    const f = fixture();
    f.manifest.files = f.manifest.files.filter((p) => p.path !== 'src/b.ts');
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects a symlink final source or parent directory', () => {
    const f = fixture();
    rmSync(join(f.root, 'src/b.ts'));
    symlinkSync(join(f.root, 'case.test.ts'), join(f.root, 'src/b.ts'));
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('SOURCE_UNAVAILABLE');
    rmSync(join(f.root, 'src'), { recursive: true });
    symlinkSync(tmpdir(), join(f.root, 'src'));
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('SOURCE_UNAVAILABLE');
  });
  it('rejects duplicate file membership, unknown roots and dynamic source identity forgery', () => {
    const f = fixture();
    const first = f.manifest.files[0];
    if (!first) throw Error('fixture');
    f.manifest.files.push({ ...first });
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    f.manifest.files.pop();
    f.manifest.roots[0] = 'public.forged()';
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    f.manifest.roots = [...profile.roots];
    const d = f.manifest.dynamic[0];
    if (!d) throw Error('fixture');
    d.sourceSha256 = '0'.repeat(64);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects forged suite totals, failed suites and missing exact case label', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'result.log'), 'Tests 8 passed (8) 1 failed');
    const log = f.manifest.files.find((p) => p.path === 'result.log');
    if (!log) throw Error('fixture');
    log.sha256 = digest('Tests 8 passed (8) 1 failed');
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    writeFileSync(join(f.root, 'result.log'), 'Tests 7 passed');
    log.sha256 = digest('Tests 7 passed');
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    writeFileSync(join(f.root, 'result.log'), 'RUN v4.1.11 fixture\nTests 8 passed');
    log.sha256 = digest('RUN v4.1.11 fixture\nTests 8 passed');
    const c = f.manifest.cases[0];
    if (!c) throw Error('fixture');
    c.label = 'fabricated';
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });

  it.each([
    ['Tests 4 passed | 11 skipped (15)', 4],
    ['Tests 8 passed | 1 failed (9)', 8],
  ])(
    'rejects mixed inline Vitest summary %s even with matching declared pass count',
    (summary, passed) => {
      const f = fixture(),
        log = f.manifest.files.find((file) => file.path === 'result.log'),
        entry = f.manifest.cases[0];
      if (!log || !entry) throw Error('fixture');
      const body = `RUN v4.1.11 fixture\n${summary}\n`;
      log.sha256 = digest(body);
      entry.suitePassed = Number(passed);
      writeFileSync(join(f.root, 'result.log'), body);
      expect(() =>
        compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
      ).toThrow('INVALID_EVIDENCE');
    },
  );
  it('accepts explicit zero inline fail/skip counts but rejects mismatched total', () => {
    const f = fixture(),
      log = f.manifest.files.find((file) => file.path === 'result.log');
    if (!log) throw Error('fixture');
    const body = 'RUN v4.1.11 fixture\nTests 8 passed | 0 failed | 0 skipped (8)\n';
    writeFileSync(join(f.root, 'result.log'), body);
    log.sha256 = digest(body);
    expect(
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()).authority,
    ).toBe('none');
    const wrong = body.replace('(8)', '(9)');
    writeFileSync(join(f.root, 'result.log'), wrong);
    log.sha256 = digest(wrong);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects unknown, getter, proxy, subclass and oversized plain input without invoking getters', () => {
    const f = fixture();
    let called = 0;
    const getter = { ...f.manifest };
    Object.defineProperty(getter, 'roots', {
      enumerable: true,
      get() {
        called++;
        return [];
      },
    });
    expect(() => parseCurrentRuntimeSourceBuildProofManifestV1(getter)).toThrow('INVALID_INPUT');
    expect(called).toBe(0);
    expect(() =>
      parseCurrentRuntimeSourceBuildProofManifestV1(
        new Proxy(
          {},
          {
            ownKeys() {
              throw Error('secret');
            },
          },
        ),
      ),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      parseCurrentRuntimeSourceBuildProofManifestV1({
        ...f.manifest,
        unknown: true,
      }),
    ).toThrow('INVALID_INPUT');
    class Derived extends Array<string> {}
    expect(() =>
      parseCurrentRuntimeSourceBuildProofManifestV1({
        ...f.manifest,
        roots: new Derived(),
      }),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      parseCurrentRuntimeSourceBuildProofManifestV1({
        ...f.manifest,
        unknown: 'x'.repeat(8388609),
      }),
    ).toThrow('INVALID_INPUT');
  });

  it('parses genuine Playwright syntax without converting it to a Vitest summary', () => {
    const f = fixture(),
      c = f.manifest.cases[0],
      log = f.manifest.files.find((p) => p.path === 'result.log');
    if (!c || !log) throw Error('fixture');
    c.runner = 'playwright';
    const body = 'Running 8 tests using 1 worker\n  8 passed (38.3s)\n';
    writeFileSync(join(f.root, 'result.log'), body);
    log.sha256 = digest(body);
    expect(
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()).evidenceScopes[0]
        ?.runner,
    ).toBe('playwright');
    c.runner = 'vitest';
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    c.runner = 'playwright';
    const failed = body + '  1 failed\n';
    writeFileSync(join(f.root, 'result.log'), failed);
    log.sha256 = digest(failed);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });

  it('includes a fixed literal lazy import and rejects a missing pinned destination', () => {
    const f = fixture(),
      entry = f.manifest.files.find((file) => file.path === 'src/a.ts');
    if (!entry) throw Error('fixture');
    const body = "export const load=()=>import('./b.js');";
    writeFileSync(join(f.root, 'src/a.ts'), body);
    entry.sha256 = digest(body);
    expect(
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()).authority,
    ).toBe('none');
    f.manifest.files = f.manifest.files.filter((file) => file.path !== 'src/b.ts');
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it.each([
    'import(path)',
    'import(`./b.js`)',
    'import(`./${path}.js`)',
    "import('./b.js', { with: { type: 'json' } })",
    "import('./b.js' + suffix)",
    "require('./b.js')",
    'const text=`${import(path)}`;',
  ])('rejects unbounded import expression %s', (source) => {
    expect(() => enumerateCurrentRuntimeSourceBuildImportsV1(source)).toThrow('INVALID_EVIDENCE');
  });
  it('ignores comments/string/regex noise and includes literal imports inside template expressions', () => {
    const source =
      "// import(variable)\n/* require('ignored') */ const note=\"import(variable)\"; const pattern=/import\\(variable\\)/; const text=`${import('./b.js')}`;";
    expect(enumerateCurrentRuntimeSourceBuildImportsV1(source)).toEqual(['./b.js']);
    expect(enumerateCurrentRuntimeSourceBuildImportsV1("import /* bounded */ ('./b.js')")).toEqual([
      './b.js',
    ]);
  });
  it('rejects traversal and unconfigured workspace import paths', () => {
    const f = fixture();
    const sourceEntrypoints = [...f.manifest.sourceEntrypoints];
    f.manifest.sourceEntrypoints = ['../outside'];
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_INPUT');
    f.manifest.sourceEntrypoints = sourceEntrypoints;
    writeFileSync(join(f.root, 'src/a.ts'), "import { value } from '@workout/fake/private';");
    const entry = f.manifest.files.find((p) => p.path === 'src/a.ts');
    if (!entry) throw Error('fixture');
    entry.sha256 = digest("import { value } from '@workout/fake/private';");
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
});

describe('revision one sole trust cut and mandatory self closure', () => {
  it('rejects omission of either new executable entrypoint', () => {
    for (const suffix of ['v1.ts', 'v1-compiler.ts']) {
      const f = fixture();
      f.manifest.sourceEntrypoints = f.manifest.sourceEntrypoints.filter(
        (p) => !p.endsWith(suffix),
      );
      expect(() =>
        compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
      ).toThrow('INVALID_EVIDENCE');
    }
  });
  it.each(['entrypoint', 'member', 'role'] as const)(
    'rejects missing or non-source Root registration %s',
    (mode) => {
      const f = fixture();
      const path = 'apps/api/src/current-runtime-repositories-registration-v1.ts';
      if (mode === 'entrypoint')
        f.manifest.sourceEntrypoints = f.manifest.sourceEntrypoints.filter((p) => p !== path);
      else if (mode === 'member')
        f.manifest.files = f.manifest.files.filter((p) => p.path !== path);
      else {
        const registration = f.manifest.files.find((p) => p.path === path);
        if (!registration) throw Error('fixture');
        registration.role = 'metadata';
      }
      expect(() =>
        compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
      ).toThrow('INVALID_EVIDENCE');
    },
  );
  it('pins Root selection bytes and follows its declared literal import closure', () => {
    const f = fixture();
    const path = 'apps/api/src/current-runtime-repositories-registration-v1.ts';
    const manifestSha256 = f.save();
    writeFileSync(join(f.root, path), "export const selectedSourceBuild='unregistered';");
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', manifestSha256),
    ).toThrow('SOURCE_DRIFT');
    const registration = f.manifest.files.find((p) => p.path === path);
    if (!registration) throw Error('fixture');
    const body = "export { value } from './missing-registration-target.js';";
    writeFileSync(join(f.root, path), body);
    registration.sha256 = digest(body);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects unsupported external imports from the declared Root registration', () => {
    const f = fixture();
    const path = 'apps/api/src/current-runtime-repositories-registration-v1.ts';
    const registration = f.manifest.files.find((p) => p.path === path);
    if (!registration) throw Error('fixture');
    const body = "import Fastify from 'fastify'; export const create=Fastify;";
    writeFileSync(join(f.root, path), body);
    registration.sha256 = digest(body);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('treats the historical V9 pin as an ordinary immutable transitive dependency', () => {
    const f = fixture();
    f.manifest.files = f.manifest.files.filter((p) => !p.path.endsWith('source-proof-v9-pin.ts'));
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects a second revision and never claims current functional or restore authority', () => {
    const f = fixture();
    expect(() =>
      parseCurrentRuntimeSourceBuildProofManifestV1({
        ...f.manifest,
        sourceBuildRevision: 2,
      }),
    ).toThrow('INVALID_INPUT');
    expect(verifyCurrentRuntimeSourceBuildProofV1()).toMatchObject({
      state: 'unavailable',
      authority: 'none',
      approvalAllowed: false,
      restoreAuthority: 'none',
      currentFunctionalExecution: 'not_executed',
    });
  });
});

describe('compiled revision one asset is structural evidence only', () => {
  it('preserves limits and refuses authority or execution claims', () => {
    const f = fixture();
    const asset = compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save());
    expect(parseCurrentRuntimeSourceBuildProofAssetV1(asset).currentFunctionalExecution).toBe(
      'not_executed',
    );
    for (const forged of [
      { authority: 'processing' },
      { approvalAllowed: true },
      { restoreAuthority: 'verified' },
      { currentFunctionalExecution: 'passed' },
      { compilerAlgorithm: 'source-bound-evidence-v9-static-imports-v1' },
      { sourceBuildRevision: 2 },
      { extra: true },
    ])
      expect(() => parseCurrentRuntimeSourceBuildProofAssetV1({ ...asset, ...forged })).toThrow(
        'INVALID_INPUT',
      );
  });
  it('rejects unsafe paths, missing self closure and an included pin', () => {
    const f = fixture();
    const asset = compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save());
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV1({
        ...asset,
        manifestPath: '../asset',
      }),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV1({
        ...asset,
        sourceFiles: asset.sourceFiles.filter((p) => !p.path.endsWith('v1-compiler.ts')),
      }),
    ).toThrow('INVALID_EVIDENCE');
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV1({
        ...asset,
        sourceFiles: asset.sourceFiles.filter(
          (p) => p.path !== 'apps/api/src/current-runtime-repositories-registration-v1.ts',
        ),
      }),
    ).toThrow('INVALID_EVIDENCE');
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV1({
        ...asset,
        sourceFiles: [
          ...asset.sourceFiles,
          {
            path: 'packages/server/persistence/src/current-runtime-source-build-proof-v1-pin.ts',
            sha256: '0'.repeat(64),
            role: 'source',
          },
        ],
      }),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects getters without invocation and proxy input without accepting it', () => {
    let calls = 0;
    const raw = {};
    Object.defineProperty(raw, 'assetVersion', {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    });
    expect(() => parseCurrentRuntimeSourceBuildProofAssetV1(raw)).toThrow('INVALID_INPUT');
    expect(calls).toBe(0);
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV1(
        new Proxy(
          {},
          {
            ownKeys() {
              throw Error('private');
            },
          },
        ),
      ),
    ).toThrow('INVALID_INPUT');
  });
});

it('preserves the exact 42/17/11/18/32 recipe and rejects missing or changed named SQL', () => {
  const f = fixture();
  const asset = compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save());
  expect([
    profile.roots.length,
    profile.helpers.length,
    profile.dynamic.length,
    profile.dynamic.reduce((sum, row) => sum + row.executeStatements, 0),
    asset.sourceFiles.filter((row) => row.role === 'sql').length,
  ]).toEqual([42, 17, 11, 18, 32]);
  const sql = f.manifest.files.find((row) => row.role === 'sql');
  if (!sql) throw Error('fixture');
  f.manifest.files = f.manifest.files.filter((row) => row.path !== sql.path);
  expect(() => compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save())).toThrow(
    'INVALID_EVIDENCE',
  );
});
it('rejects including the new pin as a hashed member instead of the sole trust cut', () => {
  const f = fixture();
  const path = 'packages/server/persistence/src/current-runtime-source-build-proof-v1-pin.ts';
  const body = 'export const pin=null;';
  writeFileSync(join(f.root, path), body);
  f.manifest.files.push({ path, sha256: digest(body), role: 'source' });
  expect(() => compileCurrentRuntimeSourceBuildProofV1(f.root, 'manifest.json', f.save())).toThrow(
    'INVALID_EVIDENCE',
  );
});
