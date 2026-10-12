import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCurrentRuntimeExternalPackageRegistrationV2,
  verifyCurrentRuntimeExternalPackageRegistrationV2In,
  type CurrentRuntimeExternalPackageRegistrationV2,
} from '../src/current-runtime-external-package-registration-v2.js';
const roots = ['fastify', 'jose', 'openid-client', 'pg', 'zod'] as const;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'external-package-registration-'));
  directories.push(root);
  const conditions = {
    import: ['node', 'import', 'default'],
    require: ['node', 'require', 'default'],
  };
  const packages = roots.map((name) => {
    const packageRoot = 'packages/' + name;
    mkdirSync(join(root, packageRoot), { recursive: true });
    const metadata = {
      name,
      version: '1.0.0',
      exports: {
        '.': { node: { import: './index.js', require: './index.cjs' }, default: './index.js' },
      },
    };
    const contents = {
      'package.json': JSON.stringify(metadata),
      'index.js': 'export const synthetic=true;',
      'index.cjs': 'module.exports={synthetic:true};',
    };
    const files = Object.entries(contents)
      .map(([path, body]) => {
        writeFileSync(join(root, packageRoot, path), body);
        return { path, byteSize: Buffer.byteLength(body), sha256: digest(body) };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      packageId: name + '@1.0.0',
      name,
      version: '1.0.0',
      root: packageRoot,
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
  const resolutions = roots.flatMap((name) =>
    ['import', 'require'].map((mode) => ({
      state: 'resolved',
      issuerPackageId: null,
      specifier: name,
      mode,
      targetPackageId: name + '@1.0.0',
      targetPath: mode === 'import' ? 'index.js' : 'index.cjs',
      selection: 'exports',
      selectedKeys: ['.', 'node', mode],
      issuerPath: null,
    })),
  );
  const registration = parseCurrentRuntimeExternalPackageRegistrationV2({
    registrationVersion: 2,
    nodeVersion: '24.12.0',
    conditions,
    roots: roots.map((specifier) => ({ specifier, packageId: specifier + '@1.0.0' })),
    packages,
    resolutions,
    observation: { path: 'observed.json', sha256: '0'.repeat(64) },
    provenance: {
      source: 'synthetic_fixture',
      sriArchiveVerification: 'not_executed',
      astDynamicSemantics: 'not_verified',
    },
  });
  function save(mirror = true) {
    if (mirror) {
      const body = JSON.stringify({
        observationVersion: 2,
        nodeVersion: registration.nodeVersion,
        conditions: registration.conditions,
        resolutions: registration.resolutions,
      });
      writeFileSync(join(root, 'observed.json'), body);
      registration.observation.sha256 = digest(body);
    }
    const bytes = JSON.stringify(registration);
    writeFileSync(join(root, 'registration.json'), bytes);
    return digest(bytes);
  }
  function verify(mirror = true) {
    return verifyCurrentRuntimeExternalPackageRegistrationV2In(
      root,
      'registration.json',
      save(mirror),
    );
  }
  function updateMetadata(name: string, update: (metadata: Record<string, unknown>) => void) {
    const p = registration.packages.find((p) => p.name === name);
    if (!p) throw Error('fixture');
    const member = join(root, p.root, 'package.json');
    const metadata: Record<string, unknown> = JSON.parse(readFileSync(member, 'utf8'));
    update(metadata);
    const body = JSON.stringify(metadata);
    writeFileSync(member, body);
    p.packageJsonSha256 = digest(body);
    const pin = p.files.find((f) => f.path === 'package.json');
    if (!pin) throw Error('fixture');
    pin.byteSize = Buffer.byteLength(body);
    pin.sha256 = digest(body);
    p.fileIndexSha256 = digest(JSON.stringify(p.files));
    p.exportsSha256 =
      metadata.exports === undefined ? null : digest(JSON.stringify(metadata.exports));
    p.importsSha256 =
      metadata.imports === undefined ? null : digest(JSON.stringify(metadata.imports));
  }
  return { root, registration, save, verify, updateMetadata };
}
it('matches actual whole synthetic package bytes and independently supplied resolution records without authority', () => {
  const f = fixture(),
    r = f.verify();
  expect(r).toMatchObject({
    registrationVersion: 2,
    packageCount: 5,
    provenance: 'synthetic_fixture',
    sriArchiveVerification: 'not_executed',
    astDynamicSemantics: 'not_verified',
    authority: 'none',
    admissionAllowed: false,
    resolutionEvidence: 'independently_supplied_record_correspondence',
  });
  expect(Object.isFrozen(r)).toBe(true);
  expect(r.totalBytes).toBeGreaterThan(0);
});
it('does not use order as identity for packages or resolution records', () => {
  const f = fixture();
  f.registration.packages.reverse();
  f.registration.roots.reverse();
  f.registration.resolutions.reverse();
  expect(f.verify().packageCount).toBe(5);
});
it('rejects wrong independent registration SHA', () => {
  const f = fixture();
  f.save();
  expect(() =>
    verifyCurrentRuntimeExternalPackageRegistrationV2In(
      f.root,
      'registration.json',
      'f'.repeat(64),
    ),
  ).toThrow('SOURCE_DRIFT');
});
it.each(['index.js', 'package.json'])('rejects actual source changes in %s', (member) => {
  const f = fixture();
  const pin = f.save();
  writeFileSync(join(f.root, 'packages/fastify', member), 'changed');
  expect(() =>
    verifyCurrentRuntimeExternalPackageRegistrationV2In(f.root, 'registration.json', pin),
  ).toThrow('SOURCE_DRIFT');
});
it('rejects extra actual files instead of hashing only declared inputs', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'packages/fastify', 'unregistered.js'), 'hidden');
  expect(() => f.verify()).toThrow('INVALID_REGISTRATION');
});
it('rejects deleted package files with finite errors', () => {
  const f = fixture();
  rmSync(join(f.root, 'packages/fastify/index.js'));
  expect(() => f.verify()).toThrow('INVALID_REGISTRATION');
});
it('rejects file and ancestor symlinks', () => {
  const f = fixture();
  rmSync(join(f.root, 'packages/fastify/index.js'));
  symlinkSync(
    join(f.root, 'packages/fastify/index.cjs'),
    join(f.root, 'packages/fastify/index.js'),
  );
  expect(() => f.verify()).toThrow('SOURCE_UNAVAILABLE');
  const g = fixture();
  rmSync(join(g.root, 'packages/fastify'), { recursive: true });
  symlinkSync(join(g.root, 'packages/jose'), join(g.root, 'packages/fastify'));
  expect(() => g.verify()).toThrow('SOURCE_UNAVAILABLE');
});
it.each([
  'duplicatePackage',
  'duplicateFile',
  'duplicateRoot',
  'duplicateResolution',
  'unknownRoot',
  'unknownTarget',
  'orphanPackage',
  'overlappingRoot',
])('rejects %s closed roster corruption', (kind) => {
  const f = fixture(),
    p = f.registration.packages[0],
    row = f.registration.resolutions[0],
    root = f.registration.roots[0];
  if (!p || !row || !root) throw Error('fixture');
  switch (kind) {
    case 'duplicatePackage':
      f.registration.packages.push({ ...p });
      break;
    case 'duplicateFile':
      p.files.push({ ...required(p.files[0]) });
      p.fileIndexSha256 = digest(JSON.stringify(p.files));
      break;
    case 'duplicateRoot':
      f.registration.roots[1] = { ...root };
      break;
    case 'duplicateResolution':
      f.registration.resolutions.push({ ...row });
      break;
    case 'unknownRoot':
      root.packageId = 'unknown';
      break;
    case 'unknownTarget':
      if (row.state !== 'resolved') throw Error('fixture');
      row.targetPackageId = 'unknown';
      break;
    case 'orphanPackage':
      f.registration.packages.push({ ...p, packageId: 'orphan', root: 'orphan' });
      break;
    case 'overlappingRoot':
      required(f.registration.packages[1]).root = p.root + '/nested';
      break;
  }
  expect(() => f.verify()).toThrow();
});
it.each(['dependencies', 'optionalDependencies', 'peers'] as const)(
  'requires resolved declared %s and both mode records',
  (kind) => {
    const f = fixture(),
      p = f.registration.packages.find((p) => p.name === 'fastify');
    if (!p) throw Error('fixture');
    f.updateMetadata('fastify', (m) => {
      m[kind === 'peers' ? 'peerDependencies' : kind] = { jose: '^1.0.0' };
    });
    expect(() => f.verify()).toThrow('INVALID_REGISTRATION');
    p[kind] = [{ state: 'resolved', name: 'jose', range: '^1.0.0', targetPackageId: 'jose@1.0.0' }];
    expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
    f.registration.resolutions.push(
      ...(['import', 'require'] as const).map((mode) => ({
        state: 'resolved' as const,
        issuerPackageId: p.packageId,
        specifier: 'jose',
        mode,
        targetPackageId: 'jose@1.0.0',
        targetPath: mode === 'import' ? 'index.js' : 'index.cjs',
        selection: 'exports' as const,
        selectedKeys: ['.', 'node', mode],
        issuerPath: 'index.js',
      })),
    );
    expect(f.verify().packageCount).toBe(5);
    const resolved = required(p[kind][0]);
    if (resolved.state !== 'resolved') throw Error('fixture');
    resolved.targetPackageId = 'missing';
    expect(() => f.verify()).toThrow('INVALID_REGISTRATION');
  },
);
it('binds exact dependency range and selected target package identity', () => {
  const f = fixture();
  f.updateMetadata('fastify', (m) => {
    m.dependencies = { jose: '^1.0.0' };
  });
  required(f.registration.packages[0]).dependencies = [
    { state: 'resolved', name: 'jose', range: '^2.0.0', targetPackageId: 'jose@1.0.0' },
  ];
  expect(() => f.verify()).toThrow('INVALID_REGISTRATION');
});
it('rejects absent import or require root observation', () => {
  const f = fixture();
  f.registration.resolutions = f.registration.resolutions.filter(
    (r) => !(r.specifier === 'fastify' && r.mode === 'require'),
  );
  expect(() => f.verify()).toThrow('INVALID_INPUT');
});
it('rejects an independently pinned but different observation', () => {
  const f = fixture();
  f.save();
  const observation = JSON.parse(readFileSync(join(f.root, 'observed.json'), 'utf8'));
  observation.resolutions[0].targetPath = 'index.cjs';
  const b = JSON.stringify(observation);
  writeFileSync(join(f.root, 'observed.json'), b);
  f.registration.observation.sha256 = digest(b);
  expect(() => f.verify(false)).toThrow('RESOLUTION_MISMATCH');
});
it.each(['browser', 'unknown', 'wrongMode', 'differentSubpath'])(
  'rejects unknown or wrong conditional branch %s even with matching observation records',
  (branch) => {
    const f = fixture();
    const row = required(f.registration.resolutions[0]);
    if (row.state !== 'resolved') throw Error('fixture');
    if (branch === 'wrongMode') row.selectedKeys = ['.', 'node', 'require'];
    else if (branch === 'differentSubpath') row.specifier = 'fastify/unknown';
    else row.selectedKeys = ['.', branch, 'import'];
    expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
  },
);
it('supports actual main-file selection only when no exports overrides it', () => {
  const f = fixture();
  f.updateMetadata('fastify', (m) => {
    delete m.exports;
    m.main = 'index.js';
  });
  for (const row of f.registration.resolutions.filter((r) => r.specifier === 'fastify')) {
    if (row.state !== 'resolved') throw Error('fixture');
    row.selection = 'main';
    row.selectedKeys = [];
    row.targetPath = 'index.js';
  }
  expect(f.verify().packageCount).toBe(5);
});
it('denies package private import aliases and wildcard guesses until explicitly registered by a supported recipe', () => {
  const f = fixture();
  const row = required(f.registration.resolutions[0]);
  if (row.state !== 'resolved') throw Error('fixture');
  row.selection = 'imports';
  expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
});
it.each(['../escape', '/absolute', 'file:///escape', 'a\\b', 'a\u0000b'])(
  'rejects unsafe package root %s',
  (root) => {
    const f = fixture();
    const raw = {
      ...f.registration,
      packages: f.registration.packages.map((p, i) => (i === 0 ? { ...p, root } : p)),
    };
    expect(() => parseCurrentRuntimeExternalPackageRegistrationV2(raw)).toThrow('INVALID_INPUT');
  },
);
it('rejects getters/proxies/extras/sparse arrays before getters or traps can produce a registration', () => {
  const f = fixture();
  let invoked = 0;
  const raw = { ...f.registration };
  Object.defineProperty(raw, 'roots', {
    enumerable: true,
    get() {
      invoked++;
      return f.registration.roots;
    },
  });
  expect(() => parseCurrentRuntimeExternalPackageRegistrationV2(raw)).toThrow('INVALID_INPUT');
  expect(invoked).toBe(0);
  expect(() =>
    parseCurrentRuntimeExternalPackageRegistrationV2(
      new Proxy(f.registration, {
        ownKeys() {
          invoked++;
          throw Error('private');
        },
      }),
    ),
  ).toThrow('INVALID_INPUT');
  expect(invoked).toBe(0);
  expect(() =>
    parseCurrentRuntimeExternalPackageRegistrationV2({ ...f.registration, admissionAllowed: true }),
  ).toThrow('INVALID_INPUT');
  const sparse = Array(5);
  expect(() =>
    parseCurrentRuntimeExternalPackageRegistrationV2({ ...f.registration, roots: sparse }),
  ).toThrow('INVALID_INPUT');
});
it('rejects oversized declarations and malformed UTF8 without exposing raw paths/errors', () => {
  const f = fixture();
  const p = required(f.registration.packages[0]);
  required(p.files[0]).byteSize = 16777217;
  expect(() => f.verify()).toThrow('INVALID_INPUT');
  const g = fixture();
  writeFileSync(join(g.root, 'registration.json'), Buffer.from([0xff]));
  const sha = digest(Buffer.from([0xff]));
  expect(() =>
    verifyCurrentRuntimeExternalPackageRegistrationV2In(g.root, 'registration.json', sha),
  ).toThrow('INVALID_INPUT');
});
it('does not accept SRI/AST/execution authority claims as substitutes for evidence', () => {
  const f = fixture();
  for (const changes of [
    { sriArchiveVerification: 'verified' },
    { astDynamicSemantics: 'verified' },
    { source: 'caller_proof' },
  ])
    expect(() =>
      parseCurrentRuntimeExternalPackageRegistrationV2({
        ...f.registration,
        provenance: { ...f.registration.provenance, ...changes },
      }),
    ).toThrow('INVALID_INPUT');
});
it('rejects extra or getter-backed nested package records', () => {
  const f = fixture();
  const raw: CurrentRuntimeExternalPackageRegistrationV2 = { ...f.registration };
  Object.defineProperty(required(raw.packages[0]), 'name', {
    enumerable: true,
    get() {
      throw Error('private getter');
    },
  });
  expect(() => parseCurrentRuntimeExternalPackageRegistrationV2(raw)).toThrow('INVALID_INPUT');
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('fixture');
  return value;
}

it.each(['peers', 'optionalDependencies'] as const)(
  'binds explicit absent %s to declarations and actual both-mode missing facts',
  (kind) => {
    const f = fixture(),
      p = required(f.registration.packages.find((p) => p.name === 'pg'));
    f.updateMetadata('pg', (m) => {
      m[kind === 'peers' ? 'peerDependencies' : kind] = { 'native-peer': '>=1' };
      if (kind === 'peers') m.peerDependenciesMeta = { 'native-peer': { optional: true } };
    });
    p[kind] = [{ state: 'absent', name: 'native-peer', range: '>=1' }];
    const missing = (mode: 'import' | 'require') => ({
      state: 'absent' as const,
      issuerPackageId: p.packageId,
      issuerPath: 'index.js',
      specifier: 'native-peer',
      mode,
      code: mode === 'import' ? ('ERR_MODULE_NOT_FOUND' as const) : ('MODULE_NOT_FOUND' as const),
    });
    f.registration.resolutions.push(missing('import'));
    expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
    f.registration.resolutions.push(missing('require'));
    expect(f.verify().admissionAllowed).toBe(false);
    const row = required(
      f.registration.resolutions.find((r) => r.state === 'absent' && r.mode === 'require'),
    );
    if (row.state !== 'absent') throw Error('fixture');
    row.code = 'ERR_MODULE_NOT_FOUND';
    expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
  },
);
it('rejects required peer absence and optional metadata false', () => {
  const f = fixture(),
    p = required(f.registration.packages.find((p) => p.name === 'pg'));
  f.updateMetadata('pg', (m) => {
    m.peerDependencies = { native: '1' };
    m.peerDependenciesMeta = { native: { optional: false } };
  });
  p.peers = [{ state: 'absent', name: 'native', range: '1' }];
  expect(() => f.verify()).toThrow('INVALID_REGISTRATION');
});
it('required dependency never accepts absent union', () => {
  const f = fixture(),
    p = required(f.registration.packages[0]);
  expect(() =>
    parseCurrentRuntimeExternalPackageRegistrationV2({
      ...f.registration,
      packages: [
        { ...p, dependencies: [{ state: 'absent', name: 'x', range: '1' }] },
        ...f.registration.packages.slice(1),
      ],
    }),
  ).toThrow('INVALID_INPUT');
});
function setFiles(f: ReturnType<typeof fixture>, name: string, contents: Record<string, string>) {
  const p = required(f.registration.packages.find((p) => p.name === name));
  const files = p.files.filter((x) => x.path === 'package.json');
  for (const old of p.files.filter((x) => x.path !== 'package.json'))
    rmSync(join(f.root, p.root, old.path));
  for (const [path, body] of Object.entries(contents)) {
    mkdirSync(join(f.root, p.root, path, '..'), { recursive: true });
    writeFileSync(join(f.root, p.root, path), body);
    files.push({ path, byteSize: Buffer.byteLength(body), sha256: digest(body) });
  }
  p.files = files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  p.fileIndexSha256 = digest(JSON.stringify(p.files));
}
function setTargets(
  f: ReturnType<typeof fixture>,
  name: string,
  target: string,
  selection: 'main' | 'exports',
  keys: string[] = [],
) {
  for (const r of f.registration.resolutions.filter((r) => r.specifier === name)) {
    if (r.state !== 'resolved') throw Error('fixture');
    r.targetPath = target;
    r.selection = selection;
    r.selectedKeys = keys;
  }
}
it.each([
  { main: './index.js', files: { 'index.js': 'ok' }, target: 'index.js' },
  { main: 'index', files: { 'index.js': 'ok' }, target: 'index.js' },
  { main: 'dir', files: { 'dir/index.js': 'ok' }, target: 'dir/index.js' },
  { main: 'missing', files: { 'index.js': 'fallback' }, target: 'index.js' },
])('legacy main actual own file priority $main', ({ main, files, target }) => {
  const f = fixture();
  f.updateMetadata('fastify', (m) => {
    delete m.exports;
    m.main = main;
  });
  setFiles(f, 'fastify', files);
  setTargets(f, 'fastify', target, 'main');
  expect(f.verify().packageCount).toBe(5);
  setTargets(f, 'fastify', 'index.cjs', 'main');
  expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
});
it('legacy main priority cannot select another existing file', () => {
  const f = fixture();
  f.updateMetadata('fastify', (m) => {
    delete m.exports;
    m.main = 'file';
  });
  setFiles(f, 'fastify', { file: 'exact', 'file.js': 'wrong' });
  setTargets(f, 'fastify', 'file.js', 'main');
  expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
  setTargets(f, 'fastify', 'file', 'main');
  expect(f.verify().packageCount).toBe(5);
});
it('wildcard exact specificity and condition order bind actual indexed bytes', () => {
  const f = fixture();
  f.updateMetadata('fastify', (m) => {
    m.exports = {
      '.': './index.js',
      './lib/*': './lib/*.js',
      './lib/*.js': { default: './special/*.js', node: './other/*.js' },
    };
  });
  setFiles(f, 'fastify', {
    'index.js': 'root',
    'special/a.js': 'selected',
    'lib/a.js.js': 'wrong',
    'other/a.js': 'later',
  });
  setTargets(f, 'fastify', 'index.js', 'exports', ['.']);
  const p = required(f.registration.packages.find((p) => p.name === 'fastify'));
  f.registration.resolutions.push({
    state: 'resolved',
    issuerPackageId: p.packageId,
    issuerPath: 'index.js',
    specifier: 'fastify/lib/a.js',
    mode: 'import',
    targetPackageId: p.packageId,
    targetPath: 'special/a.js',
    selection: 'exports',
    selectedKeys: ['./lib/*.js', 'default'],
  });
  expect(f.verify().packageCount).toBe(5);
  const row = required(f.registration.resolutions.at(-1));
  if (row.state !== 'resolved') throw Error('fixture');
  row.selectedKeys = ['./lib/*.js', 'node'];
  row.targetPath = 'other/a.js';
  expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
});
it('wildcard exact key wins and escaping replacement is rejected', () => {
  const f = fixture();
  f.updateMetadata('fastify', (m) => {
    m.exports = { '.': './index.js', './lib/*': './lib/*.js', './lib/a': './exact.js' };
  });
  setFiles(f, 'fastify', { 'index.js': 'root', 'exact.js': 'selected', 'lib/a.js': 'wrong' });
  setTargets(f, 'fastify', 'index.js', 'exports', ['.']);
  const p = required(f.registration.packages.find((p) => p.name === 'fastify'));
  const row = {
    state: 'resolved' as const,
    issuerPackageId: p.packageId,
    issuerPath: 'index.js',
    specifier: 'fastify/lib/a',
    mode: 'import' as const,
    targetPackageId: p.packageId,
    targetPath: 'exact.js',
    selection: 'exports' as const,
    selectedKeys: ['./lib/a'],
  };
  f.registration.resolutions.push(row);
  expect(f.verify().packageCount).toBe(5);
  row.specifier = 'fastify/lib/../a';
  row.selectedKeys = ['./lib/*'];
  expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
});

it('legacy subpath require extension has no fabricated ESM extension fallback', () => {
  const f = fixture();
  f.updateMetadata('fastify', (m) => {
    delete m.exports;
    m.main = 'index.js';
  });
  setFiles(f, 'fastify', { 'index.js': 'root', 'lib/serializer.js': 'existing' });
  setTargets(f, 'fastify', 'index.js', 'main');
  const p = required(f.registration.packages.find((p) => p.name === 'fastify'));
  const row = {
    state: 'resolved' as const,
    issuerPackageId: p.packageId,
    issuerPath: 'index.js',
    specifier: 'fastify/lib/serializer',
    mode: 'require' as 'require' | 'import',
    targetPackageId: p.packageId,
    targetPath: 'lib/serializer.js',
    selection: 'legacy_subpath' as const,
    selectedKeys: [],
  };
  f.registration.resolutions.push(row);
  expect(f.verify().packageCount).toBe(5);
  row.mode = 'import';
  expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
});
it('nested package scope main needs separate recipe and never implicit approval', () => {
  const f = fixture();
  f.updateMetadata('fastify', (m) => {
    delete m.exports;
    m.main = 'dir';
  });
  setFiles(f, 'fastify', { 'dir/package.json': '{}', 'dir/index.js': 'own' });
  setTargets(f, 'fastify', 'dir/index.js', 'main');
  expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
});
it('absent facts cannot name foreign issuer or an existing required root', () => {
  const f = fixture();
  f.registration.resolutions.push({
    state: 'absent',
    issuerPackageId: 'missing',
    issuerPath: 'index.js',
    specifier: 'fastify',
    mode: 'require',
    code: 'MODULE_NOT_FOUND',
  });
  expect(() => f.verify()).toThrow('RESOLUTION_MISMATCH');
});
