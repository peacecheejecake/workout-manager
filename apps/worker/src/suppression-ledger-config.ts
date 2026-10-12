import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';

import {
  suppressionSourceBindingV7Schema,
  suppressionSourceBindingV8Schema,
  type SuppressionSourceBindingV7,
  type SuppressionSourceBindingV8,
} from '@workout/server-persistence/restore-suppression-segment';

import type { SuppressionRemoteConfig } from '../../../deploy/lightsail/backup/ledger-remote-store.mjs';

/*
 * Suppression ledger export worker configuration contract (profile26 V7 / profile27 V8).
 *
 * The worker exports only through the authenticated installed-domain exporter
 * (`exportAuthenticatedSuppressionSegmentForInstalledDomain`). The legacy v1 coordinator is
 * never used. Every value below is required; nothing is inferred, defaulted or retried with a
 * different profile. Any invalid, missing or extra-ambiguous value fails with the finite code
 * SUPPRESSION_LEDGER_CONFIG_FAILED before any key file, database or S3 resource is opened.
 *
 * Commands (exactly one argument):
 *   --run-once        export one bounded segment (or a verified no-op) and exit.
 *   --bootstrap-head  one-shot operator command: create the initial signed head (format 2 for
 *                     suppression-physical-v7, format 3 for suppression-physical-v8) at the
 *                     slot's confirmed_flush_lsn, with no segments. Refuses if any version of
 *                     the head object exists or a head witness file is already complete.
 *
 * Gates:
 *   SUPPRESSION_LEDGER_EXPORT_ENABLED=true              required for both commands.
 *   SUPPRESSION_LEDGER_HEAD_BOOTSTRAP=create-initial-head
 *                                                      required for --bootstrap-head and
 *                                                      forbidden (must be unset) for --run-once.
 *
 * Remote (private versioned bucket):
 *   SUPPRESSION_LEDGER_BUCKET, SUPPRESSION_LEDGER_PREFIX (…/deletion-ledger/v1),
 *   SUPPRESSION_LEDGER_BUCKET_OWNER (12 digits), SUPPRESSION_LEDGER_REGION=ap-northeast-2.
 *
 * Source database and slot:
 *   SUPPRESSION_LEDGER_DATABASE_URL            postgres URL; its database path must equal
 *                                              SUPPRESSION_LEDGER_SOURCE_DATABASE_NAME.
 *   SUPPRESSION_LEDGER_SLOT_NAME               wm_suppression_<a-z0-9_>{1,40}.
 *   SUPPRESSION_LEDGER_CLUSTER_ID              pg_control_system().system_identifier.
 *
 * Source binding (from the separately trusted capture/registry manifest; compared exactly with
 * the live catalog before any slot read, and with the authenticated head):
 *   SUPPRESSION_LEDGER_SOURCE_DATABASE_NAME    current_database().
 *   SUPPRESSION_LEDGER_SOURCE_DATABASE_OID     pg_database.oid, decimal 1..4294967295.
 *   SUPPRESSION_LEDGER_CAPTURE_ID              lowercase UUID of the capture.
 *   SUPPRESSION_LEDGER_REGISTRY_FINGERPRINT    64 lowercase hex: sha256 of the schema_migrations
 *                                              (version, checksum) registry.
 *   SUPPRESSION_LEDGER_RELATION_PROFILE        suppression-physical-v7 (profile26-era record
 *                                              domain) or suppression-physical-v8 (SQL145
 *                                              profile27 domain). It must equal the installed
 *                                              domain; a mismatch is refused, never downgraded.
 *
 * Keys and head reference:
 *   SUPPRESSION_LEDGER_ENCRYPTION_KEY_ID       segment key id.
 *   SUPPRESSION_LEDGER_ENCRYPTION_KEY_FILE     absolute, 0600, owner-only, exactly 32 bytes.
 *   SUPPRESSION_LEDGER_HEAD_HMAC_KEY_FILE      absolute, 0600, owner-only, exactly 32 bytes,
 *                                              distinct path and bytes from the encryption key.
 *   SUPPRESSION_LEDGER_HEAD_WITNESS_FILE       absolute path of the local head witness (0600,
 *                                              owner-only, no symlinks) in an existing
 *                                              directory writable by the worker. It pins the
 *                                              exact head versionId and sha256 the next run
 *                                              must find; it is written by --bootstrap-head and
 *                                              replaced atomically after each head publish.
 *
 * Logs carry only kind, runId, release, a finite outcome/reason code and the relation profile.
 */

export type SuppressionLedgerCommand = 'run-once' | 'bootstrap-head';
export type SuppressionLedgerSourceBinding =
  SuppressionSourceBindingV7 | SuppressionSourceBindingV8;

export interface SuppressionLedgerOnceConfig {
  command: SuppressionLedgerCommand;
  remote: SuppressionRemoteConfig;
  connectionString: string;
  slotName: string;
  expectedClusterId: string;
  encryptionKeyId: string;
  encryptionKeyPath: string;
  headAuthenticationKeyPath: string;
  headWitnessPath: string;
  source: SuppressionLedgerSourceBinding;
}

/** Every environment variable the worker reads (the remote S3 SDK credentials excepted). */
export const suppressionLedgerEnvironmentNames = [
  'SUPPRESSION_LEDGER_EXPORT_ENABLED',
  'SUPPRESSION_LEDGER_HEAD_BOOTSTRAP',
  'SUPPRESSION_LEDGER_BUCKET',
  'SUPPRESSION_LEDGER_PREFIX',
  'SUPPRESSION_LEDGER_BUCKET_OWNER',
  'SUPPRESSION_LEDGER_REGION',
  'SUPPRESSION_LEDGER_DATABASE_URL',
  'SUPPRESSION_LEDGER_SLOT_NAME',
  'SUPPRESSION_LEDGER_CLUSTER_ID',
  'SUPPRESSION_LEDGER_SOURCE_DATABASE_NAME',
  'SUPPRESSION_LEDGER_SOURCE_DATABASE_OID',
  'SUPPRESSION_LEDGER_CAPTURE_ID',
  'SUPPRESSION_LEDGER_REGISTRY_FINGERPRINT',
  'SUPPRESSION_LEDGER_RELATION_PROFILE',
  'SUPPRESSION_LEDGER_ENCRYPTION_KEY_ID',
  'SUPPRESSION_LEDGER_ENCRYPTION_KEY_FILE',
  'SUPPRESSION_LEDGER_HEAD_HMAC_KEY_FILE',
  'SUPPRESSION_LEDGER_HEAD_WITNESS_FILE',
] as const;

function invalid(): never {
  throw new Error('SUPPRESSION_LEDGER_CONFIG_FAILED');
}

export function securePath(value: string | undefined): string {
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

function witnessPath(value: string | undefined): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) invalid();
  const parsed = parse(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parsed.base) || parsed.base.includes('.tmp-'))
    invalid();
  securePath(dirname(value));
  if (!lstatSync(dirname(value)).isDirectory()) invalid();
  return value;
}

function sourceBinding(
  env: Readonly<Record<string, string | undefined>>,
  slotName: string,
): SuppressionLedgerSourceBinding {
  const oid = env['SUPPRESSION_LEDGER_SOURCE_DATABASE_OID'];
  if (!oid || !/^[1-9]\d{0,9}$/.test(oid) || Number(oid) > 4294967295) invalid();
  const candidate = {
    databaseName: env['SUPPRESSION_LEDGER_SOURCE_DATABASE_NAME'],
    databaseOid: Number(oid),
    slotName,
    publication: 'workout_restore_suppression_events',
    relationProfile: env['SUPPRESSION_LEDGER_RELATION_PROFILE'],
    captureId: env['SUPPRESSION_LEDGER_CAPTURE_ID'],
    registryFingerprint: env['SUPPRESSION_LEDGER_REGISTRY_FINGERPRINT'],
  };
  if (candidate.relationProfile === 'suppression-physical-v8') {
    const parsed = suppressionSourceBindingV8Schema.safeParse(candidate);
    if (!parsed.success) invalid();
    return parsed.data;
  }
  if (candidate.relationProfile === 'suppression-physical-v7') {
    const parsed = suppressionSourceBindingV7Schema.safeParse(candidate);
    if (!parsed.success) invalid();
    return parsed.data;
  }
  return invalid();
}

export function parseSuppressionLedgerOnceConfig(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SuppressionLedgerOnceConfig {
  if (args.length !== 1 || env['SUPPRESSION_LEDGER_EXPORT_ENABLED'] !== 'true') invalid();
  const bootstrapGate = env['SUPPRESSION_LEDGER_HEAD_BOOTSTRAP'];
  let command: SuppressionLedgerCommand;
  if (args[0] === '--run-once' && bootstrapGate === undefined) command = 'run-once';
  else if (args[0] === '--bootstrap-head' && bootstrapGate === 'create-initial-head')
    command = 'bootstrap-head';
  else invalid();
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
  const source = sourceBinding(env, slotName);
  // The connection must name exactly the bound database; no implicit default database.
  if (url.pathname !== `/${source.databaseName}`) invalid();
  const encryptionKeyPath = securePath(env['SUPPRESSION_LEDGER_ENCRYPTION_KEY_FILE']);
  const headAuthenticationKeyPath = securePath(env['SUPPRESSION_LEDGER_HEAD_HMAC_KEY_FILE']);
  const headWitnessPath = witnessPath(env['SUPPRESSION_LEDGER_HEAD_WITNESS_FILE']);
  if (new Set([encryptionKeyPath, headAuthenticationKeyPath, headWitnessPath]).size !== 3)
    invalid();
  return {
    command,
    remote: { schemaVersion: 1, bucket, prefix, region, expectedBucketOwner: owner },
    connectionString,
    slotName,
    expectedClusterId,
    encryptionKeyId,
    encryptionKeyPath,
    headAuthenticationKeyPath,
    headWitnessPath,
    source,
  };
}
