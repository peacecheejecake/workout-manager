#!/usr/bin/env node
import { X509Certificate, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_CN = Object.freeze({
  backup: 'workout-manager-backup-v1',
  ledger: 'workout-manager-ledger-v1',
});
const CA_SHA256 = 'A91C92C96E38AEE51DCF4157AFC8F7A2C0DE1C73FB078FA801D209B2434BB7BD';
const CLIENT_AUTH_OID = '1.3.6.1.5.5.7.3.2';
const MAX_BYTES = 64 * 1024;
const MIN_REMAINING_MS = 7 * 24 * 60 * 60 * 1000;

function fail(code) {
  throw new Error(`ROTATION_${code}`);
}
function oneCn(subject) {
  const entries = subject.split('\n').filter((entry) => entry.startsWith('CN='));
  if (entries.length !== 1) fail('SUBJECT');
  return entries[0].slice(3);
}
function certificate(pem) {
  if (
    (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1 ||
    (pem.match(/-----END CERTIFICATE-----/g) ?? []).length !== 1
  )
    fail('CERT_FORMAT');
  try {
    return new X509Certificate(pem);
  } catch {
    fail('CERT_FORMAT');
  }
}
function publicKeyBytes(key) {
  return (key.type === 'public' ? key : createPublicKey(key)).export({
    type: 'spki',
    format: 'der',
  });
}

/** No I/O. Candidates must overlap valid existing leaves, but have later expiry. */
export function verifyRotation({
  anchorPem,
  current,
  candidate,
  expectedFingerprint = CA_SHA256,
  now = new Date(),
}) {
  const anchor = certificate(anchorPem);
  const fingerprint = createHash('sha256').update(anchor.raw).digest('hex').toUpperCase();
  if (fingerprint !== expectedFingerprint) fail('ANCHOR');
  if (!anchor.ca || !anchor.verify(anchor.publicKey)) fail('ANCHOR');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('CLOCK');
  const fingerprints = new Set();
  const publicKeys = new Set();
  const serials = new Set();
  const priorPublicKeys = new Set(
    Object.keys(EXPECTED_CN).map((kind) => {
      if (!current?.[kind]) fail('MISSING_ROLE');
      return publicKeyBytes(certificate(current[kind]).publicKey).toString('hex');
    }),
  );
  for (const [kind, cn] of Object.entries(EXPECTED_CN)) {
    if (!current?.[kind] || !candidate?.[kind]) fail('MISSING_ROLE');
    const oldCert = certificate(current[kind]);
    const nextCert = certificate(candidate[kind].cert);
    for (const cert of [oldCert, nextCert]) {
      if (
        oneCn(cert.subject) !== cn ||
        cert.ca ||
        !cert.verify(anchor.publicKey) ||
        cert.issuer !== anchor.subject
      )
        fail('IDENTITY');
      const start = Date.parse(cert.validFrom);
      const end = Date.parse(cert.validTo);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start >= end ||
        now.getTime() < start ||
        now.getTime() >= end
      )
        fail('VALIDITY');
      if (!cert.keyUsage?.includes(CLIENT_AUTH_OID)) fail('CLIENT_AUTH');
      if (serials.has(cert.serialNumber)) fail('REUSED_SERIAL');
      serials.add(cert.serialNumber);
    }
    if (
      Date.parse(nextCert.validFrom) > Date.parse(oldCert.validTo) ||
      Date.parse(nextCert.validTo) <= Date.parse(oldCert.validTo) ||
      Date.parse(nextCert.validTo) - now.getTime() < MIN_REMAINING_MS
    )
      fail('OVERLAP');
    let key;
    try {
      key = createPrivateKey(candidate[kind].key);
    } catch {
      fail('KEY_FORMAT');
    }
    const candidatePublicKey = publicKeyBytes(key);
    if (!candidatePublicKey.equals(publicKeyBytes(nextCert.publicKey))) fail('KEY_MISMATCH');
    if (priorPublicKeys.has(candidatePublicKey.toString('hex'))) fail('REUSED_KEY');
    const publicKeyFingerprint = createHash('sha256').update(candidatePublicKey).digest('hex');
    if (publicKeys.has(publicKeyFingerprint)) fail('REUSED_KEY');
    publicKeys.add(publicKeyFingerprint);
    if (nextCert.fingerprint256 === oldCert.fingerprint256) fail('REUSED_CERT');
    if (fingerprints.has(nextCert.fingerprint256)) fail('REUSED_CERT');
    fingerprints.add(nextCert.fingerprint256);
  }
  return { status: 'local_checks_passed', kinds: ['backup', 'ledger'] };
}

async function secureFile(path, directory = false) {
  const absolute = resolve(path);
  let cursor = absolute;
  for (;;) {
    const entry = await lstat(cursor);
    if (entry.isSymbolicLink() || entry.uid !== 0 || entry.gid !== 0) fail('PATH_OWNER');
    if (cursor === absolute) {
      if (
        directory
          ? !entry.isDirectory() || (entry.mode & 0o777) !== 0o700
          : !entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o777) !== 0o600
      )
        fail('PATH_MODE');
    } else if ((entry.mode & 0o022) !== 0) fail('PATH_WRITABLE');
    if (cursor === dirname(cursor)) break;
    cursor = dirname(cursor);
  }
  if ((await realpath(absolute)) !== absolute) fail('PATH_LINK');
  return absolute;
}
async function boundedRead(path) {
  await secureFile(path);
  const value = await readFile(path);
  if (value.length === 0 || value.length > MAX_BYTES) fail('FILE_SIZE');
  return value.toString('utf8');
}

export async function checkRotationDirectories(
  currentDir,
  candidateDir,
  { uid = process.getuid?.(), now = new Date() } = {},
) {
  if (process.platform !== 'linux' || uid !== 0) fail('ROOT_REQUIRED');
  const oldRoot = await secureFile(currentDir, true);
  const nextRoot = await secureFile(candidateDir, true);
  if (
    oldRoot === nextRoot ||
    nextRoot.startsWith(oldRoot + sep) ||
    oldRoot.startsWith(nextRoot + sep)
  )
    fail('PATH_COLLISION');
  const oldNames = (await readdir(oldRoot)).sort();
  const nextNames = (await readdir(nextRoot)).sort();
  if (
    JSON.stringify(oldNames) !== JSON.stringify(['backup.pem', 'ca.pem', 'ledger.pem']) ||
    JSON.stringify(nextNames) !==
      JSON.stringify(['backup.key', 'backup.pem', 'ledger.key', 'ledger.pem'])
  )
    fail('DIRECTORY_CONTENTS');
  const anchorPem = await boundedRead(join(oldRoot, 'ca.pem'));
  const current = {};
  const candidate = {};
  for (const kind of Object.keys(EXPECTED_CN)) {
    current[kind] = await boundedRead(join(oldRoot, `${kind}.pem`));
    candidate[kind] = {
      cert: await boundedRead(join(nextRoot, `${kind}.pem`)),
      key: await boundedRead(join(nextRoot, `${kind}.key`)),
    };
  }
  return verifyRotation({ anchorPem, current, candidate, now });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5 || process.argv[2] !== '--dry-run') fail('ARGUMENTS');
    await checkRotationDirectories(process.argv[3], process.argv[4]);
    process.stdout.write('ROTATION_LOCAL_CHECKS_PASSED\n');
  } catch (error) {
    const code = /^ROTATION_[A-Z_]+$/.test(error?.message)
      ? error.message
      : 'ROTATION_CHECK_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
