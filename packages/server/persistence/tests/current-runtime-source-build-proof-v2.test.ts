import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentRuntimeV10ParentMembers,
  currentRuntimeV10ExtensionMembers,
} from '../src/current-runtime-installation-v10.js';
import { readFileSync } from 'node:fs';
import {
  parseCurrentRuntimeSourceBuildProofAssetV2,
  compileCurrentRuntimeSourceBuildProofV2,
  enumerateCurrentRuntimeSourceBuildImportsV2,
  currentRuntimeSourceBuildProofV2CompilerProfile as profile,
  parseCurrentRuntimeSourceBuildProofManifestV2,
  verifyCurrentRuntimeSourceBuildProofV2,
  currentRuntimeSourceBuildProofV2CatalogDigest,
} from '../src/current-runtime-source-build-proof-v2.js';
const pin = vi.hoisted(() => ({ sha256: null as string | null }));
vi.mock('../src/current-runtime-source-build-proof-v2-pin.js', () => ({
  get currentRuntimeSourceBuildProofV2AssetSha256() {
    return pin.sha256;
  },
}));
const digest = (body: string) => createHash('sha256').update(body).digest('hex');
const directories: string[] = [];
afterEach(() => {
  pin.sha256 = null;
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'source-build-proof-v2-'));
  directories.push(root);
  const contents = {
    'src/a.ts': "import { value } from './b.js'; export const result=value;\n",
    'src/b.ts': 'export const value=1;\n',
    'case.test.ts': "it('owned strict case', async()=>{});\n",
    'result.log': 'RUN v4.1.11 fixture\nTest Files  1 passed (1)\nTests  8 passed (8)\n',
  };
  Object.assign(contents, {
    'apps/api/src/current-runtime-repositories-registration-v2.ts':
      "export { value } from '../../../packages/server/persistence/src/current-runtime-source-build-proof-v2.js';",
    'packages/server/persistence/src/current-runtime-source-build-proof-v2.ts':
      "import './current-runtime-source-build-proof-v2-pin.js'; import './current-runtime-source-build-proof-v1-pin.js';",
    'packages/server/persistence/src/current-runtime-source-build-proof-v2-compiler.ts':
      "export { value } from './current-runtime-source-build-proof-v2.js';",
    'packages/server/persistence/src/current-runtime-source-build-proof-v1-pin.ts':
      'export const oldPin=1;',
  });
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'apps/api/src'), { recursive: true });
  mkdirSync(join(root, 'packages/server/persistence/src'), { recursive: true });
  for (const [path, body] of Object.entries(contents)) writeFileSync(join(root, path), body);
  const manifest = parseCurrentRuntimeSourceBuildProofManifestV2({
    proofVersion: 2,
    sourceBuildRevision: 1,
    profileVersion: 10,
    runtimeStep: 26,
    sourceDdlTip: 146,
    catalogDigest: profile.catalogDigest,
    files: Object.entries(contents).map(([path, body]) => ({
      path,
      sha256: digest(body),
      role: path.endsWith('.test.ts') ? 'fixture' : path.endsWith('.log') ? 'log' : 'source',
    })),
    sourceEntrypoints: [
      'src/a.ts',
      'packages/server/persistence/src/current-runtime-source-build-proof-v2.ts',
      'packages/server/persistence/src/current-runtime-source-build-proof-v2-compiler.ts',
      'apps/api/src/current-runtime-repositories-registration-v2.ts',
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
  for (const member of [...currentRuntimeV10ParentMembers, ...currentRuntimeV10ExtensionMembers]) {
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
    const result = compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save());
    expect(result).toMatchObject({
      profileVersion: 10,
      runtimeStep: 26,
      sourceDdlTip: 146,
      authority: 'none',
      approvalAllowed: false,
      restoreAuthority: 'none',
      buildProofVersion: 2,
      sourceBuildRevision: 1,
      currentFunctionalExecution: 'not_executed',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyCurrentRuntimeSourceBuildProofV2()).toMatchObject({
      state: 'unavailable',
      reason: 'compiled_asset_unavailable',
      sourceManifestSha256: null,
    });
  });
  it('rejects forged expected manifest hash before accepting its statuses', () => {
    const f = fixture();
    f.save();
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', '0'.repeat(64)),
    ).toThrow('SOURCE_DRIFT');
  });
  it('rechecks source drift for every compiler invocation without cached acceptance', () => {
    const f = fixture(),
      pin = f.save();
    compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', pin);
    writeFileSync(join(f.root, 'src/b.ts'), 'export const value=2;');
    expect(() => compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', pin)).toThrow(
      'SOURCE_DRIFT',
    );
  });
  it('rejects absent transitive source even when the manifest itself is pinned', () => {
    const f = fixture();
    f.manifest.files = f.manifest.files.filter((p) => p.path !== 'src/b.ts');
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects a symlink final source or parent directory', () => {
    const f = fixture();
    rmSync(join(f.root, 'src/b.ts'));
    symlinkSync(join(f.root, 'case.test.ts'), join(f.root, 'src/b.ts'));
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('SOURCE_UNAVAILABLE');
    rmSync(join(f.root, 'src'), { recursive: true });
    symlinkSync(tmpdir(), join(f.root, 'src'));
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('SOURCE_UNAVAILABLE');
  });
  it('rejects duplicate file membership, unknown roots and dynamic source identity forgery', () => {
    const f = fixture();
    const first = f.manifest.files[0];
    if (!first) throw Error('fixture');
    f.manifest.files.push({ ...first });
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    f.manifest.files.pop();
    f.manifest.roots[0] = 'public.forged()';
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    f.manifest.roots = [...profile.roots];
    const d = f.manifest.dynamic[0];
    if (!d) throw Error('fixture');
    d.sourceSha256 = '0'.repeat(64);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects forged suite totals, failed suites and missing exact case label', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'result.log'), 'Tests 8 passed (8) 1 failed');
    const log = f.manifest.files.find((p) => p.path === 'result.log');
    if (!log) throw Error('fixture');
    log.sha256 = digest('Tests 8 passed (8) 1 failed');
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    writeFileSync(join(f.root, 'result.log'), 'Tests 7 passed');
    log.sha256 = digest('Tests 7 passed');
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    writeFileSync(join(f.root, 'result.log'), 'RUN v4.1.11 fixture\nTests 8 passed');
    log.sha256 = digest('RUN v4.1.11 fixture\nTests 8 passed');
    const c = f.manifest.cases[0];
    if (!c) throw Error('fixture');
    c.label = 'fabricated';
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
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
        compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
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
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()).authority,
    ).toBe('none');
    const wrong = body.replace('(8)', '(9)');
    writeFileSync(join(f.root, 'result.log'), wrong);
    log.sha256 = digest(wrong);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
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
    expect(() => parseCurrentRuntimeSourceBuildProofManifestV2(getter)).toThrow('INVALID_INPUT');
    expect(called).toBe(0);
    expect(() =>
      parseCurrentRuntimeSourceBuildProofManifestV2(
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
      parseCurrentRuntimeSourceBuildProofManifestV2({
        ...f.manifest,
        unknown: true,
      }),
    ).toThrow('INVALID_INPUT');
    class Derived extends Array<string> {}
    expect(() =>
      parseCurrentRuntimeSourceBuildProofManifestV2({
        ...f.manifest,
        roots: new Derived(),
      }),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      parseCurrentRuntimeSourceBuildProofManifestV2({
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
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()).evidenceScopes[0]
        ?.runner,
    ).toBe('playwright');
    c.runner = 'vitest';
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    c.runner = 'playwright';
    const failed = body + '  1 failed\n';
    writeFileSync(join(f.root, 'result.log'), failed);
    log.sha256 = digest(failed);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
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
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()).authority,
    ).toBe('none');
    f.manifest.files = f.manifest.files.filter((file) => file.path !== 'src/b.ts');
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
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
    expect(() => enumerateCurrentRuntimeSourceBuildImportsV2(source)).toThrow('INVALID_EVIDENCE');
  });
  it('ignores comments/string/regex noise and includes literal imports inside template expressions', () => {
    const source =
      "// import(variable)\n/* require('ignored') */ const note=\"import(variable)\"; const pattern=/import\\(variable\\)/; const text=`${import('./b.js')}`;";
    expect(enumerateCurrentRuntimeSourceBuildImportsV2(source)).toEqual(['./b.js']);
    expect(enumerateCurrentRuntimeSourceBuildImportsV2("import /* bounded */ ('./b.js')")).toEqual([
      './b.js',
    ]);
  });
  it('rejects traversal and unconfigured workspace import paths', () => {
    const f = fixture();
    const sourceEntrypoints = [...f.manifest.sourceEntrypoints];
    f.manifest.sourceEntrypoints = ['../outside'];
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_INPUT');
    f.manifest.sourceEntrypoints = sourceEntrypoints;
    writeFileSync(join(f.root, 'src/a.ts'), "import { value } from '@workout/fake/private';");
    const entry = f.manifest.files.find((p) => p.path === 'src/a.ts');
    if (!entry) throw Error('fixture');
    entry.sha256 = digest("import { value } from '@workout/fake/private';");
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
});

describe('revision one sole trust cut and mandatory self closure', () => {
  it('rejects omission of either new executable entrypoint', () => {
    for (const suffix of ['v2.ts', 'v2-compiler.ts']) {
      const f = fixture();
      f.manifest.sourceEntrypoints = f.manifest.sourceEntrypoints.filter(
        (p) => !p.endsWith(suffix),
      );
      expect(() =>
        compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
      ).toThrow('INVALID_EVIDENCE');
    }
  });
  it.each(['entrypoint', 'member', 'role'] as const)(
    'rejects missing or non-source Root registration %s',
    (mode) => {
      const f = fixture();
      const path = 'apps/api/src/current-runtime-repositories-registration-v2.ts';
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
        compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
      ).toThrow('INVALID_EVIDENCE');
    },
  );
  it('pins Root selection bytes and follows its declared literal import closure', () => {
    const f = fixture();
    const path = 'apps/api/src/current-runtime-repositories-registration-v2.ts';
    const manifestSha256 = f.save();
    writeFileSync(join(f.root, path), "export const selectedSourceBuild='unregistered';");
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', manifestSha256),
    ).toThrow('SOURCE_DRIFT');
    const registration = f.manifest.files.find((p) => p.path === path);
    if (!registration) throw Error('fixture');
    const body = "export { value } from './missing-registration-target.js';";
    writeFileSync(join(f.root, path), body);
    registration.sha256 = digest(body);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects unsupported external imports from the declared Root registration', () => {
    const f = fixture();
    const path = 'apps/api/src/current-runtime-repositories-registration-v2.ts';
    const registration = f.manifest.files.find((p) => p.path === path);
    if (!registration) throw Error('fixture');
    const body = "import Fastify from 'fastify'; export const create=Fastify;";
    writeFileSync(join(f.root, path), body);
    registration.sha256 = digest(body);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('treats the historical v1 pin as an ordinary immutable transitive dependency', () => {
    const f = fixture();
    f.manifest.files = f.manifest.files.filter(
      (p) =>
        p.path !== 'packages/server/persistence/src/current-runtime-source-build-proof-v1-pin.ts',
    );
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects a second revision and never claims current functional or restore authority', () => {
    const f = fixture();
    expect(() =>
      parseCurrentRuntimeSourceBuildProofManifestV2({
        ...f.manifest,
        sourceBuildRevision: 2,
      }),
    ).toThrow('INVALID_INPUT');
    expect(verifyCurrentRuntimeSourceBuildProofV2()).toMatchObject({
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
    const asset = compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save());
    expect(parseCurrentRuntimeSourceBuildProofAssetV2(asset).currentFunctionalExecution).toBe(
      'not_executed',
    );
    for (const forged of [
      { authority: 'processing' },
      { approvalAllowed: true },
      { restoreAuthority: 'verified' },
      { currentFunctionalExecution: 'passed' },
      { compilerAlgorithm: 'source-bound-evidence-v9-static-imports-v1' },
      { sourceBuildRevision: 2 },
      { assetVersion: 1 },
      { buildProofVersion: 1 },
      { profileVersion: 9 },
      { runtimeStep: 25 },
      { sourceDdlTip: 142 },
      { extra: true },
    ])
      expect(() => parseCurrentRuntimeSourceBuildProofAssetV2({ ...asset, ...forged })).toThrow(
        'INVALID_INPUT',
      );
  });
  it('rejects unsafe paths, missing self closure and an included pin', () => {
    const f = fixture();
    const asset = compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save());
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV2({
        ...asset,
        manifestPath: '../asset',
      }),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV2({
        ...asset,
        sourceFiles: asset.sourceFiles.filter((p) => !p.path.endsWith('v2-compiler.ts')),
      }),
    ).toThrow('INVALID_EVIDENCE');
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV2({
        ...asset,
        sourceFiles: asset.sourceFiles.filter(
          (p) => p.path !== 'apps/api/src/current-runtime-repositories-registration-v2.ts',
        ),
      }),
    ).toThrow('INVALID_EVIDENCE');
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV2({
        ...asset,
        sourceFiles: [
          ...asset.sourceFiles,
          {
            path: 'packages/server/persistence/src/current-runtime-source-build-proof-v2-pin.ts',
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
        return 2;
      },
    });
    expect(() => parseCurrentRuntimeSourceBuildProofAssetV2(raw)).toThrow('INVALID_INPUT');
    expect(calls).toBe(0);
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV2(
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

it('preserves the exact 42/17/11/18/33 recipe and rejects missing or changed named SQL', () => {
  const f = fixture();
  const asset = compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save());
  expect([
    profile.roots.length,
    profile.helpers.length,
    profile.dynamic.length,
    profile.dynamic.reduce((sum, row) => sum + row.executeStatements, 0),
    asset.sourceFiles.filter((row) => row.role === 'sql').length,
  ]).toEqual([42, 17, 11, 18, 33]);
  const sql = f.manifest.files.find((row) => row.role === 'sql');
  if (!sql) throw Error('fixture');
  f.manifest.files = f.manifest.files.filter((row) => row.path !== sql.path);
  expect(() => compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save())).toThrow(
    'INVALID_EVIDENCE',
  );
});
it('rejects including the new pin as a hashed member instead of the sole trust cut', () => {
  const f = fixture();
  const path = 'packages/server/persistence/src/current-runtime-source-build-proof-v2-pin.ts';
  const body = 'export const pin=null;';
  writeFileSync(join(f.root, path), body);
  f.manifest.files.push({ path, sha256: digest(body), role: 'source' });
  expect(() => compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save())).toThrow(
    'INVALID_EVIDENCE',
  );
});

describe('profile26 successor specifics', () => {
  const sql146 =
    'packages/server/persistence/migrations/146_race_event_local_date_approval_guard.sql';
  it('requires the 146 extension SQL pinned as sql with the installer SHA', () => {
    const f = fixture();
    const row = f.manifest.files.find((file) => file.path === sql146);
    expect(row).toMatchObject({ role: 'sql' });
    if (!row) throw Error('fixture');
    row.role = 'dependency';
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
    f.manifest.files = f.manifest.files.filter((file) => file.path !== sql146);
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects a compiled asset that omits or changes a named V10 SQL member', () => {
    const f = fixture();
    const asset = compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save());
    expect(asset.sourceFiles.some((file) => file.path === sql146 && file.role === 'sql')).toBe(
      true,
    );
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV2({
        ...asset,
        sourceFiles: asset.sourceFiles.filter((file) => file.path !== sql146),
      }),
    ).toThrow('INVALID_EVIDENCE');
    expect(() =>
      parseCurrentRuntimeSourceBuildProofAssetV2({
        ...asset,
        sourceFiles: asset.sourceFiles.map((file) =>
          file.path === sql146 ? { ...file, sha256: '0'.repeat(64) } : file,
        ),
      }),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('rejects a profile25 v1 manifest tuple and the v1 self-entrypoints as v2 closure', () => {
    const f = fixture();
    for (const forged of [
      { proofVersion: 1 },
      { profileVersion: 9 },
      { runtimeStep: 25 },
      { sourceDdlTip: 142 },
      { catalogDigest: '127a416fb0435ed46225efc82db503d33597dcb01e006f15fb5a7ac3b4c170ed' },
    ])
      expect(() =>
        parseCurrentRuntimeSourceBuildProofManifestV2({ ...f.manifest, ...forged }),
      ).toThrow('INVALID_INPUT');
    f.manifest.sourceEntrypoints = f.manifest.sourceEntrypoints.map((p) =>
      p.replace('-v2', '-v1').replace('registration-v2', 'registration-v1'),
    );
    expect(() =>
      compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save()),
    ).toThrow('INVALID_EVIDENCE');
  });
  it('derives the roster from the closure instead of a fixed size and pins the profile tuple', () => {
    const f = fixture();
    const extra = 'src/c.ts';
    writeFileSync(join(f.root, extra), 'export const extra=1;\n');
    const a = f.manifest.files.find((file) => file.path === 'src/a.ts');
    if (!a) throw Error('fixture');
    const body = "import './c.js'; import { value } from './b.js'; export const result=value;\n";
    writeFileSync(join(f.root, 'src/a.ts'), body);
    a.sha256 = digest(body);
    f.manifest.files.push({
      path: extra,
      sha256: digest('export const extra=1;\n'),
      role: 'source',
    });
    const before = f.manifest.files.filter(
      (file) => file.role !== 'fixture' && file.role !== 'log',
    );
    const asset = compileCurrentRuntimeSourceBuildProofV2(f.root, 'manifest.json', f.save());
    expect(asset.sourceFiles).toHaveLength(before.length);
    expect(asset).toMatchObject({
      assetVersion: 2,
      buildProofVersion: 2,
      sourceBuildRevision: 1,
      catalogDigest: currentRuntimeSourceBuildProofV2CatalogDigest,
      compilerAlgorithm: 'source-bound-evidence-build-v1-static-imports-v1',
    });
    expect(profile.sourceEntrypoints).toEqual([
      'packages/server/persistence/src/current-runtime-source-build-proof-v2.ts',
      'packages/server/persistence/src/current-runtime-source-build-proof-v2-compiler.ts',
      'apps/api/src/current-runtime-repositories-registration-v2.ts',
    ]);
    expect(profile.excludedGeneratedInputs).toEqual([
      'packages/server/persistence/src/current-runtime-source-build-proof-v2-pin.ts',
    ]);
    expect(profile.catalogDigest).toBe(currentRuntimeSourceBuildProofV2CatalogDigest);
  });
  it('reports a pinned but absent compiled asset as compiled_asset_unavailable', () => {
    pin.sha256 = 'a'.repeat(64);
    expect(verifyCurrentRuntimeSourceBuildProofV2()).toMatchObject({
      state: 'unavailable',
      reason: 'compiled_asset_unavailable',
      sourceManifestSha256: null,
      profileVersion: 10,
      runtimeStep: 26,
      sourceDdlTip: 146,
      buildProofVersion: 2,
      authority: 'none',
    });
  });
});
