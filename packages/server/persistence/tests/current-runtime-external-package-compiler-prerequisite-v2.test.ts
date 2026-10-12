import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileCurrentRuntimeExternalPackageCompilerPrerequisiteV2 as compile,
  parseCurrentRuntimeExternalPackageCompilerPrerequisiteV2Config as parseConfig,
  parseCurrentRuntimeWorkspaceResolverObservationV2 as parseObservation,
  type CurrentRuntimeWorkspaceResolverObservationV2,
} from '../src/current-runtime-external-package-compiler-prerequisite-v2.js';
import { currentRuntimeSourceBuildProofV1CompilerProfile as profile } from '../src/current-runtime-source-build-proof-v1-compiler.js';
import { parseCurrentRuntimeExternalPackageRegistrationV2 } from '../src/current-runtime-external-package-registration-v2.js';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const roots = ['fastify', 'jose', 'openid-client', 'pg', 'zod'] as const;
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(source = "import 'pg'; import 'pg'; import '@fixture/child';") {
  const root = mkdtempSync(join(tmpdir(), 'external-compiler-prerequisite-'));
  directories.push(root);
  const write = (path: string, body: string | Buffer) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const conditions = {
    import: ['node', 'import', 'default'],
    require: ['node', 'require', 'default'],
  };
  const packages = roots.map((name) => {
    const metadata = { name, version: '1.0.0', exports: './index.js' };
    const contents = {
      'index.js': 'export const synthetic=true;',
      'package.json': JSON.stringify(metadata),
    };
    const files = Object.entries(contents).map(([path, body]) => {
      write('packages/' + name + '/' + path, body);
      return { path, byteSize: Buffer.byteLength(body), sha256: digest(body) };
    });
    return {
      packageId: name + '@1.0.0',
      name,
      version: '1.0.0',
      root: 'packages/' + name,
      packageJsonSha256: digest(contents['package.json']),
      fileIndexSha256: digest(JSON.stringify(files)),
      exportsSha256: digest(JSON.stringify(metadata.exports)),
      importsSha256: null,
      files,
      dependencies: [],
      optionalDependencies: [],
      peers: [],
      lockIntegrity: 'sha512-' + 'A'.repeat(86) + '==',
    };
  });
  const resolutions = roots.flatMap((specifier) =>
    ['import', 'require'].map((mode) => ({
      state: 'resolved',
      issuerPackageId: null,
      issuerPath: null,
      specifier,
      mode,
      targetPackageId: specifier + '@1.0.0',
      targetPath: 'index.js',
      selection: 'exports',
      selectedKeys: [],
    })),
  );
  const regObservation = JSON.stringify({
    observationVersion: 2,
    nodeVersion: '24.12.0',
    conditions,
    resolutions,
  });
  write('registered-observation.json', regObservation);
  const registration = parseCurrentRuntimeExternalPackageRegistrationV2({
    registrationVersion: 2,
    nodeVersion: '24.12.0',
    conditions,
    roots: roots.map((specifier) => ({ specifier, packageId: specifier + '@1.0.0' })),
    packages,
    resolutions,
    observation: { path: 'registered-observation.json', sha256: digest(regObservation) },
    provenance: {
      source: 'synthetic_fixture',
      sriArchiveVerification: 'not_executed',
      astDynamicSemantics: 'not_verified',
    },
  });
  const registrationBytes = JSON.stringify(registration);
  write('registration.json', registrationBytes);
  const contents = {
    'src/entry.ts': source,
    'src/child.ts': "import './leaf.js';",
    'src/leaf.ts': "import 'zod';",
    'test.ts': 'synthetic',
    'log.txt': 'synthetic',
  };
  const files = Object.entries(contents).map(([path, body]) => {
    write(path, body);
    return {
      path,
      sha256: digest(body),
      role: path === 'test.ts' ? 'fixture' : path === 'log.txt' ? 'log' : 'source',
    };
  });
  const manifest = {
    proofVersion: 1,
    sourceBuildRevision: 1,
    profileVersion: 9,
    runtimeStep: 25,
    sourceDdlTip: 142,
    catalogDigest: profile.catalogDigest,
    files,
    sourceEntrypoints: ['src/entry.ts'],
    workspaceImports: { '@fixture/child': 'src/child.ts' },
    roots: [...profile.roots],
    helpers: [...profile.helpers],
    dynamic: [...profile.dynamic],
    cases: [
      {
        runner: 'vitest',
        fixture: 'test.ts',
        label: 'synthetic',
        log: 'log.txt',
        suitePassed: 1,
        scope: 'same_body_suite',
      },
    ],
    limitations: [
      'historical_116_whole_file_not_final_body_execution',
      'suite_totals_are_not_individual_branch_traces',
      'unavailable_source_modes_are_not_positive_execution',
    ],
  };
  const manifestBytes = JSON.stringify(manifest);
  write('manifest.json', manifestBytes);
  const records = [
    ...[0, 1].flatMap((importOrdinal) =>
      ['import', 'require'].map((mode) => ({
        sourcePath: 'src/entry.ts',
        sourceSha256: digest(source),
        importOrdinal,
        specifier: 'pg',
        mode,
        targetPackageId: 'pg@1.0.0',
        packageRoot: 'packages/pg',
        targetPath: 'index.js',
        targetSha256: digest(contentsForTarget()),
        targetByteSize: Buffer.byteLength(contentsForTarget()),
      })),
    ),
    ...['import', 'require'].map((mode) => ({
      sourcePath: 'src/leaf.ts',
      sourceSha256: digest(contents['src/leaf.ts']),
      importOrdinal: 0,
      specifier: 'zod',
      mode,
      targetPackageId: 'zod@1.0.0',
      packageRoot: 'packages/zod',
      targetPath: 'index.js',
      targetSha256: digest(contentsForTarget()),
      targetByteSize: Buffer.byteLength(contentsForTarget()),
    })),
  ];
  const observation = parseObservation({
    observationVersion: 2,
    nodeVersion: '24.12.0',
    conditions,
    manifestSha256: digest(manifestBytes),
    registrationSha256: digest(registrationBytes),
    records,
  });
  const config = {
    sourceRoot: root,
    manifestPath: 'manifest.json',
    independentlyPinnedManifestSha256: digest(manifestBytes),
    registrationRoot: root,
    registrationPath: 'registration.json',
    independentlyPinnedRegistrationSha256: digest(registrationBytes),
    workspaceResolverObservationPath: 'workspace-observation.json',
    independentlyPinnedWorkspaceResolverObservationSha256: '0'.repeat(64),
  };
  function save() {
    const body = JSON.stringify(observation);
    write('workspace-observation.json', body);
    config.independentlyPinnedWorkspaceResolverObservationSha256 = digest(body);
    return config;
  }
  save();
  return { root, write, manifest, observation, config, save, run: () => compile(save()) };
}
function contentsForTarget() {
  return 'export const synthetic=true;';
}
function first(observation: CurrentRuntimeWorkspaceResolverObservationV2) {
  const row = observation.records[0];
  if (!row) throw Error('fixture');
  return row;
}
it('binds every repeated pg/zod occurrence through workspace and relative JS-to-TS closure without authority', () => {
  const result = fixture().run();
  expect(result).toMatchObject({
    state: 'verified_records',
    sourceFileCount: 3,
    externalImportSites: 3,
    workspaceResolutionRecords: 6,
    fullTransitiveClosureComplete: false,
    astDynamicSemantics: 'not_verified',
    sriArchiveVerification: 'not_executed',
    currentFunctionalExecution: 'not_executed',
    authority: 'none',
    admissionAllowed: false,
  });
  expect(Object.isFrozen(result)).toBe(true);
});
it.each([
  'missing',
  'duplicate',
  'extra',
  'ordinal',
  'sourceSha256',
  'specifier',
  'targetPackageId',
  'packageRoot',
  'targetPath',
  'targetSha256',
  'targetByteSize',
  'manifestSha256',
  'registrationSha256',
])(
  'rejects missing or conflicting observation %s even with a refreshed independent record pin',
  (kind) => {
    const f = fixture(),
      row = first(f.observation);
    switch (kind) {
      case 'missing':
        f.observation.records.splice(0, 1);
        break;
      case 'duplicate':
        f.observation.records.push({ ...row });
        break;
      case 'extra':
        f.observation.records.push({ ...row, importOrdinal: 99 });
        break;
      case 'ordinal':
        row.importOrdinal = 98;
        break;
      case 'sourceSha256':
        row.sourceSha256 = 'f'.repeat(64);
        break;
      case 'specifier':
        row.specifier = 'zod';
        break;
      case 'targetPackageId':
        row.targetPackageId = 'zod@1.0.0';
        break;
      case 'packageRoot':
        row.packageRoot = 'packages/zod';
        break;
      case 'targetPath':
        row.targetPath = 'package.json';
        break;
      case 'targetSha256':
        row.targetSha256 = 'f'.repeat(64);
        break;
      case 'targetByteSize':
        row.targetByteSize++;
        break;
      case 'manifestSha256':
        f.observation.manifestSha256 = 'f'.repeat(64);
        break;
      case 'registrationSha256':
        f.observation.registrationSha256 = 'f'.repeat(64);
        break;
    }
    expect(() => f.run()).toThrow('RESOLUTION_MISMATCH');
  },
);
it.each(['manifest', 'registration', 'observation'])('requires independent %s pin', (kind) => {
  const f = fixture();
  if (kind === 'manifest') f.config.independentlyPinnedManifestSha256 = 'f'.repeat(64);
  if (kind === 'registration') f.config.independentlyPinnedRegistrationSha256 = 'f'.repeat(64);
  if (kind === 'observation')
    f.config.independentlyPinnedWorkspaceResolverObservationSha256 = 'f'.repeat(64);
  expect(() => compile(f.config)).toThrow('SOURCE_DRIFT');
});
it.each(['src/entry.ts', 'src/child.ts', 'src/leaf.ts', 'test.ts', 'packages/pg/index.js'])(
  'rejects actual input drift in %s',
  (path) => {
    const f = fixture();
    f.write(path, 'changed');
    expect(() => compile(f.config)).toThrow('SOURCE_DRIFT');
  },
);
it.each(['import(variable);', "import('pg' + suffix);", "require('pg');", 'import(`pg`);'])(
  'rejects unsupported dynamic or require syntax %s',
  (source) => {
    const f = fixture(source);
    expect(() => f.run()).toThrow('INVALID_EVIDENCE');
  },
);
it('rejects unresolved workspace destinations and missing source files', () => {
  const f = fixture();
  rmSync(join(f.root, 'src/child.ts'));
  expect(() => f.run()).toThrow('SOURCE_UNAVAILABLE');
});
it('rejects source symlinks', () => {
  const f = fixture();
  rmSync(join(f.root, 'src/child.ts'));
  symlinkSync(join(f.root, 'src/leaf.ts'), join(f.root, 'src/child.ts'));
  expect(() => f.run()).toThrow('SOURCE_UNAVAILABLE');
});
it('rejects source-free claims and unreachable surplus observation sites', () => {
  const f = fixture('export const synthetic=true;');
  expect(() => f.run()).toThrow('RESOLUTION_MISMATCH');
});
it('rejects source mapping that hides a registered external root', () => {
  const f = fixture();
  const body = JSON.stringify({
    ...f.manifest,
    workspaceImports: { ...f.manifest.workspaceImports, pg: 'src/child.ts' },
  });
  f.write('manifest.json', body);
  f.config.independentlyPinnedManifestSha256 = digest(body);
  f.observation.manifestSha256 = digest(body);
  expect(() => f.run()).toThrow('INVALID_EVIDENCE');
});
it.each(['../escape', '/absolute', 'a\\b', 'a\u0000b'])(
  'rejects unsafe observation path %s',
  (path) => {
    const f = fixture();
    expect(() => parseConfig({ ...f.config, workspaceResolverObservationPath: path })).toThrow(
      'INVALID_INPUT',
    );
  },
);
it('rejects proxies/getters/extras/cycles before invoking attacker code', () => {
  const f = fixture();
  let invoked = 0;
  const raw = { ...f.config };
  Object.defineProperty(raw, 'sourceRoot', {
    enumerable: true,
    get() {
      invoked++;
      return f.root;
    },
  });
  expect(() => parseConfig(raw)).toThrow('INVALID_INPUT');
  expect(() =>
    parseConfig(
      new Proxy(f.config, {
        ownKeys() {
          invoked++;
          return [];
        },
      }),
    ),
  ).toThrow('INVALID_INPUT');
  expect(invoked).toBe(0);
  expect(() => parseConfig({ ...f.config, admissionAllowed: true })).toThrow('INVALID_INPUT');
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => parseConfig(cyclic)).toThrow('INVALID_INPUT');
  expect(() => parseObservation({ ...f.observation, fullTransitiveClosureComplete: true })).toThrow(
    'INVALID_INPUT',
  );
});
it('rejects malformed UTF8 records and unregistered external imports', () => {
  const f = fixture();
  const bytes = Buffer.from([0xff]);
  f.write('workspace-observation.json', bytes);
  f.config.independentlyPinnedWorkspaceResolverObservationSha256 = digest(bytes);
  expect(() => compile(f.config)).toThrow('INVALID_INPUT');
  const g = fixture("import 'unknown-package';");
  expect(() => g.run()).toThrow('RESOLUTION_MISMATCH');
});

it('retains the existing lexer fixed-literal import boundary without claiming dynamic semantics', () => {
  const f = fixture("await import('pg'); import 'pg'; import '@fixture/child';");
  expect(f.run()).toMatchObject({ externalImportSites: 3, astDynamicSemantics: 'not_verified' });
});
it('does not count text in comments, strings, or regular expressions as import sites', () => {
  const f = fixture(
    "// import 'unknown';\nconst text = \"import 'unknown'\"; const regex = /import unknown/; import 'pg'; import 'pg'; import '@fixture/child';",
  );
  expect(f.run().externalImportSites).toBe(3);
});
it.each(['nodeVersion', 'conditions', 'extraRecordField', 'sparseRecords'])(
  'rejects observation protocol corruption %s',
  (kind) => {
    const f = fixture();
    const raw: Record<string, unknown> = { ...f.observation };
    if (kind === 'nodeVersion') raw.nodeVersion = '24.19.0';
    if (kind === 'conditions')
      raw.conditions = {
        import: ['browser', 'import', 'default'],
        require: ['node', 'require', 'default'],
      };
    if (kind === 'extraRecordField')
      raw.records = [
        { ...first(f.observation), authority: 'verified' },
        ...f.observation.records.slice(1),
      ];
    if (kind === 'sparseRecords') raw.records = Array(6);
    expect(() => parseObservation(raw)).toThrow('INVALID_INPUT');
  },
);
