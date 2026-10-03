import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyRotation } from './roles-anywhere-rotation-check.mjs';

const script = fileURLToPath(new URL('./roles-anywhere-rotation-check.mjs', import.meta.url));
function openssl(...args) {
  execFileSync('openssl', args, { stdio: 'ignore' });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wm-rotation-test-'));
  const caKey = join(dir, 'ca.key');
  const caPem = join(dir, 'ca.pem');
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKey,
    '-out',
    caPem,
    '-days',
    '90',
    '-subj',
    '/CN=synthetic-ca',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  );
  const ext = join(dir, 'leaf.ext');
  writeFileSync(
    ext,
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n',
  );
  function leaf(kind, generation, days, cn = `workout-manager-${kind}-v1`, extension = ext) {
    const key = join(dir, `${kind}-${generation}.key`);
    const csr = join(dir, `${kind}-${generation}.csr`);
    const cert = join(dir, `${kind}-${generation}.pem`);
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      csr,
      '-subj',
      `/CN=${cn}`,
    );
    openssl(
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      caPem,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      String(days),
      '-extfile',
      extension,
    );
    return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
  }
  const anchorPem = readFileSync(caPem, 'utf8');
  const expectedFingerprint = new X509Certificate(anchorPem).fingerprint256.replaceAll(':', '');
  const current = {
    backup: leaf('backup', 'old', 10).cert,
    ledger: leaf('ledger', 'old', 10).cert,
  };
  const candidate = { backup: leaf('backup', 'new', 30), ledger: leaf('ledger', 'new', 30) };
  return { dir, anchorPem, expectedFingerprint, current, candidate, leaf, ext };
}

test('both separate replacements pass local cryptographic checks with synthetic CA', () => {
  const f = fixture();
  try {
    assert.deepEqual(verifyRotation(f), {
      status: 'local_checks_passed',
      kinds: ['backup', 'ledger'],
    });
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('rejects wrong anchor, CN, swapped key, missing clientAuth, expiration and short renewal', () => {
  const f = fixture();
  try {
    const check = (overrides, code) =>
      assert.throws(() => verifyRotation({ ...f, ...overrides }), new RegExp(`ROTATION_${code}`));
    check({ expectedFingerprint: '0'.repeat(64) }, 'ANCHOR');
    check(
      { candidate: { ...f.candidate, backup: f.leaf('backup', 'wrong', 30, 'wrong-cn') } },
      'IDENTITY',
    );
    check(
      {
        candidate: {
          ...f.candidate,
          backup: { ...f.candidate.backup, key: f.candidate.ledger.key },
        },
      },
      'KEY_MISMATCH',
    );
    const noEku = join(f.dir, 'no-eku.ext');
    writeFileSync(
      noEku,
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n',
    );
    check(
      { candidate: { ...f.candidate, backup: f.leaf('backup', 'noeku', 30, undefined, noEku) } },
      'CLIENT_AUTH',
    );
    check({ now: new Date(Date.now() + 11 * 86400000) }, 'VALIDITY');
    check({ candidate: { ...f.candidate, backup: f.leaf('backup', 'short', 2) } }, 'OVERLAP');
    check({ candidate: { ...f.candidate, backup: f.candidate.ledger } }, 'IDENTITY');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('CLI fails closed and emits no input or private key on failure', () => {
  const result = spawnSync(
    process.execPath,
    [script, '--dry-run', '/not-found', '/also-not-found'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^ROTATION_(ROOT_REQUIRED|CHECK_FAILED)\n$/);
  assert.doesNotMatch(result.stderr, /not-found/);
});
