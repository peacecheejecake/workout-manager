import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packageHostRuntime } from './host-runtime-pack.mjs';

function fixture(machine = 62) {
  const root = mkdtempSync(join(tmpdir(), 'wm-runtime-pack-test-'));
  const binary = join(root, 'node');
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(machine, 18);
  writeFileSync(binary, bytes);
  return {
    root,
    binary,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    output: join(root, 'release'),
  };
}

test('creates an offline bundle with pinned Linux architecture, pg and source hashes', () => {
  const item = fixture();
  try {
    const manifest = packageHostRuntime({
      nodeBinary: item.binary,
      nodeSha256: item.sha256,
      output: item.output,
    });
    assert.equal(manifest.nodeVersion, '24.12.0');
    assert.equal(manifest.architecture, 'linux-x64');
    assert.equal(manifest.pgVersion, '8.23.0');
    assert.equal(manifest.nodeSha256, item.sha256);
    assert.deepEqual(
      JSON.parse(readFileSync(join(item.output, 'manifest.json'), 'utf8')),
      manifest,
    );
    const bundle = readFileSync(join(item.output, 'namespace-db-preflight.mjs'));
    assert.equal(createHash('sha256').update(bundle).digest('hex'), manifest.bundleSha256);
    const imported = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const module = await import(process.argv[1]); if (typeof module.probeDatabase !== "function" || typeof module.runNamespaceParent !== "function") process.exit(1);',
        join(item.output, 'namespace-db-preflight.mjs'),
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.throws(
      () =>
        packageHostRuntime({
          nodeBinary: item.binary,
          nodeSha256: item.sha256,
          output: item.output,
        }),
      /HOST_RUNTIME_PACKAGE_FAILED/,
    );
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('rejects a wrong checksum or non-ELF runtime before creating output', () => {
  const item = fixture();
  try {
    assert.throws(
      () =>
        packageHostRuntime({
          nodeBinary: item.binary,
          nodeSha256: '0'.repeat(64),
          output: item.output,
        }),
      /HOST_RUNTIME_PACKAGE_FAILED/,
    );
    writeFileSync(item.binary, 'not ELF');
    const changed = createHash('sha256').update('not ELF').digest('hex');
    assert.throws(
      () =>
        packageHostRuntime({ nodeBinary: item.binary, nodeSha256: changed, output: item.output }),
      /HOST_RUNTIME_PACKAGE_FAILED/,
    );
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});
