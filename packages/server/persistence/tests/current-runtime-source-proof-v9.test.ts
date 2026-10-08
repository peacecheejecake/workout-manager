import { afterEach, describe, expect, it } from 'vitest';
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
  compileCurrentRuntimeSourceProofV9,
  currentRuntimeSourceProofV9CompilerProfile as profile,
  parseCurrentRuntimeSourceProofManifestV9,
  verifyCurrentRuntimeSourceProofV9,
} from '../src/current-runtime-source-proof-v9.js';
const digest = (body: string) => createHash('sha256').update(body).digest('hex');
const directories: string[] = [];
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'source-proof-v9-'));
  directories.push(root);
  const contents = {
    'src/a.ts': "import { value } from './b.js'; export const result=value;\n",
    'src/b.ts': 'export const value=1;\n',
    'case.test.ts': "it('owned strict case', async()=>{});\n",
    'result.log': 'RUN v4.1.11 fixture\nTest Files  1 passed (1)\nTests  8 passed (8)\n',
  };
  mkdirSync(join(root, 'src'));
  for (const [path, body] of Object.entries(contents)) writeFileSync(join(root, path), body);
  const manifest = parseCurrentRuntimeSourceProofManifestV9({
    proofVersion: 1,
    profileVersion: 9,
    runtimeStep: 25,
    sourceDdlTip: 142,
    catalogDigest: profile.catalogDigest,
    files: Object.entries(contents).map(([path, body]) => ({
      path,
      sha256: digest(body),
      role: path.endsWith('.test.ts') ? 'fixture' : path.endsWith('.log') ? 'log' : 'source',
    })),
    sourceEntrypoints: ['src/a.ts'],
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
    mkdirSync(join(root, 'packages/server/persistence/migrations'), { recursive: true });
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
    const result = compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save());
    expect(result).toMatchObject({
      profileVersion: 9,
      runtimeStep: 25,
      sourceDdlTip: 142,
      authority: 'none',
      approvalAllowed: false,
      restoreAuthority: 'none',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyCurrentRuntimeSourceProofV9()).toMatchObject({
      state: 'unavailable',
      reason: 'compiled_asset_unavailable',
      sourceManifestSha256: null,
    });
  });
  it('rejects forged expected manifest hash before accepting its statuses', () => {
    const f = fixture();
    f.save();
    expect(() =>
      compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', '0'.repeat(64)),
    ).toThrow('SOURCE_DRIFT');
  });
  it('rechecks source drift for every compiler invocation without cached acceptance', () => {
    const f = fixture(),
      pin = f.save();
    compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', pin);
    writeFileSync(join(f.root, 'src/b.ts'), 'export const value=2;');
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', pin)).toThrow(
      'SOURCE_DRIFT',
    );
  });
  it('rejects absent transitive source even when the manifest itself is pinned', () => {
    const f = fixture();
    f.manifest.files = f.manifest.files.filter((p) => p.path !== 'src/b.ts');
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_EVIDENCE',
    );
  });
  it('rejects a symlink final source or parent directory', () => {
    const f = fixture();
    rmSync(join(f.root, 'src/b.ts'));
    symlinkSync(join(f.root, 'case.test.ts'), join(f.root, 'src/b.ts'));
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'SOURCE_UNAVAILABLE',
    );
    rmSync(join(f.root, 'src'), { recursive: true });
    symlinkSync(tmpdir(), join(f.root, 'src'));
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'SOURCE_UNAVAILABLE',
    );
  });
  it('rejects duplicate file membership, unknown roots and dynamic source identity forgery', () => {
    const f = fixture();
    const first = f.manifest.files[0];
    if (!first) throw Error('fixture');
    f.manifest.files.push({ ...first });
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_EVIDENCE',
    );
    f.manifest.files.pop();
    f.manifest.roots[0] = 'public.forged()';
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_EVIDENCE',
    );
    f.manifest.roots = [...profile.roots];
    const d = f.manifest.dynamic[0];
    if (!d) throw Error('fixture');
    d.sourceSha256 = '0'.repeat(64);
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_EVIDENCE',
    );
  });
  it('rejects forged suite totals, failed suites and missing exact case label', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'result.log'), 'Tests 8 passed (8) 1 failed');
    const log = f.manifest.files.find((p) => p.path === 'result.log');
    if (!log) throw Error('fixture');
    log.sha256 = digest('Tests 8 passed (8) 1 failed');
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_EVIDENCE',
    );
    writeFileSync(join(f.root, 'result.log'), 'Tests 7 passed');
    log.sha256 = digest('Tests 7 passed');
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_EVIDENCE',
    );
    writeFileSync(join(f.root, 'result.log'), 'RUN v4.1.11 fixture\nTests 8 passed');
    log.sha256 = digest('RUN v4.1.11 fixture\nTests 8 passed');
    const c = f.manifest.cases[0];
    if (!c) throw Error('fixture');
    c.label = 'fabricated';
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_EVIDENCE',
    );
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
    expect(() => parseCurrentRuntimeSourceProofManifestV9(getter)).toThrow('INVALID_INPUT');
    expect(called).toBe(0);
    expect(() =>
      parseCurrentRuntimeSourceProofManifestV9(
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
      parseCurrentRuntimeSourceProofManifestV9({ ...f.manifest, unknown: true }),
    ).toThrow('INVALID_INPUT');
    class Derived extends Array<string> {}
    expect(() =>
      parseCurrentRuntimeSourceProofManifestV9({ ...f.manifest, roots: new Derived() }),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      parseCurrentRuntimeSourceProofManifestV9({ ...f.manifest, unknown: 'x'.repeat(8388609) }),
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
      compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save()).evidenceScopes[0]
        ?.runner,
    ).toBe('playwright');
    c.runner = 'vitest';
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_EVIDENCE',
    );
    c.runner = 'playwright';
    const failed = body + '  1 failed\n';
    writeFileSync(join(f.root, 'result.log'), failed);
    log.sha256 = digest(failed);
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_EVIDENCE',
    );
  });
  it('rejects traversal and unconfigured workspace import paths', () => {
    const f = fixture();
    f.manifest.sourceEntrypoints = ['../outside'];
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_INPUT',
    );
    f.manifest.sourceEntrypoints = ['src/a.ts'];
    writeFileSync(join(f.root, 'src/a.ts'), "import { value } from '@workout/fake/private';");
    const entry = f.manifest.files.find((p) => p.path === 'src/a.ts');
    if (!entry) throw Error('fixture');
    entry.sha256 = digest("import { value } from '@workout/fake/private';");
    expect(() => compileCurrentRuntimeSourceProofV9(f.root, 'manifest.json', f.save())).toThrow(
      'INVALID_EVIDENCE',
    );
  });
});
