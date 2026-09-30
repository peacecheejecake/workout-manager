import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';

import type { SuppressionRemoteConfig } from '../../../deploy/lightsail/backup/ledger-remote-store.mjs';

export interface SuppressionLedgerOnceConfig {
  remote: SuppressionRemoteConfig;
  connectionString: string;
  slotName: string;
  expectedClusterId: string;
  encryptionKeyId: string;
  encryptionKeyPath: string;
  headAuthenticationKeyPath: string;
}

function invalid(): never {
  throw new Error('SUPPRESSION_LEDGER_CONFIG_FAILED');
}

function securePath(value: string | undefined): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) invalid();
  if (value === parse(value).root) invalid();
  let part = value;
  while (true) {
    const stat = lstatSync(part);
    if (stat.isSymbolicLink()) invalid();
    const parent = dirname(part);
    if (parent === part) break;
    part = parent;
  }
  return value;
}

/** Read an exact binary key without following symlinks or accepting group/other access. */
export function readSuppressionLedgerKey(path: string): Buffer {
  const checked = securePath(path);
  const fd = openSync(checked, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.uid !== process.getuid?.() ||
      before.size !== 32
    )
      invalid();
    const key = Buffer.alloc(32);
    let offset = 0;
    while (offset < key.length) {
      const count = readSync(fd, key, offset, key.length - offset, null);
      if (count === 0) invalid();
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, null) !== 0) invalid();
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      invalid();
    return key;
  } finally {
    closeSync(fd);
  }
}

export function parseSuppressionLedgerOnceConfig(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SuppressionLedgerOnceConfig {
  if (
    args.length !== 1 ||
    args[0] !== '--run-once' ||
    env['SUPPRESSION_LEDGER_EXPORT_ENABLED'] !== 'true'
  )
    invalid();
  const bucket = env['SUPPRESSION_LEDGER_BUCKET'];
  const prefix = env['SUPPRESSION_LEDGER_PREFIX'];
  const owner = env['SUPPRESSION_LEDGER_BUCKET_OWNER'];
  const region = env['SUPPRESSION_LEDGER_REGION'];
  const slotName = env['SUPPRESSION_LEDGER_SLOT_NAME'];
  const expectedClusterId = env['SUPPRESSION_LEDGER_CLUSTER_ID'];
  const encryptionKeyId = env['SUPPRESSION_LEDGER_ENCRYPTION_KEY_ID'];
  const connectionString = env['SUPPRESSION_LEDGER_DATABASE_URL'];
  if (
    !bucket ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !prefix ||
    !/^(?:[a-z0-9-]+\/)*deletion-ledger\/v1$/.test(prefix) ||
    !owner ||
    !/^\d{12}$/.test(owner) ||
    region !== 'ap-northeast-2' ||
    !slotName ||
    !/^wm_suppression_[a-z0-9_]{1,40}$/.test(slotName) ||
    !expectedClusterId ||
    !/^[1-9]\d{0,19}$/.test(expectedClusterId) ||
    !encryptionKeyId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(encryptionKeyId) ||
    !connectionString
  )
    invalid();
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    invalid();
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.pathname ||
    url.pathname === '/' ||
    url.hash ||
    url.search ||
    url.username.includes('%')
  )
    invalid();
  const encryptionKeyPath = securePath(env['SUPPRESSION_LEDGER_ENCRYPTION_KEY_FILE']);
  const headAuthenticationKeyPath = securePath(env['SUPPRESSION_LEDGER_HEAD_HMAC_KEY_FILE']);
  if (encryptionKeyPath === headAuthenticationKeyPath) invalid();
  return {
    remote: { schemaVersion: 1, bucket, prefix, region, expectedBucketOwner: owner },
    connectionString,
    slotName,
    expectedClusterId,
    encryptionKeyId,
    encryptionKeyPath,
    headAuthenticationKeyPath,
  };
}
