import { createHash } from 'node:crypto';

import type { SuppressionRemoteStore } from '@workout/server-persistence/restore-suppression-coordinator';
import type { exportAuthenticatedSuppressionSegmentForInstalledDomain } from '@workout/server-persistence/restore-suppression-exporter';
import {
  readSuppressionRelationProfileIn,
  type SuppressionRelationProfile,
} from '@workout/server-persistence/restore-suppression-exporter';
import { peekSuppressionPgoutput } from '@workout/server-persistence/restore-suppression-pgoutput';
import {
  decodeSuppressionHeadV7,
  encodeSuppressionHeadV7,
} from '@workout/server-persistence/restore-suppression-replay-v7';
import {
  decodeSuppressionHeadV8,
  encodeSuppressionHeadV8,
} from '@workout/server-persistence/restore-suppression-replay-v8';
import type { Pool } from 'pg';

import type { SuppressionVersionedObjectClient } from '../../../deploy/lightsail/backup/ledger-remote-store.mjs';
import type {
  SuppressionLedgerOnceConfig,
  SuppressionLedgerSourceBinding,
} from './suppression-ledger-config.js';
import {
  readSuppressionHeadWitness,
  writeSuppressionHeadWitness,
  type SuppressionHeadWitness,
} from './suppression-ledger-witness.js';

/** Finite failure codes; nothing else (SQL, S3, key paths, LSNs) reaches a log. */
export const suppressionLedgerFailureCodes = [
  'SUPPRESSION_LEDGER_CONFIG_FAILED',
  'SUPPRESSION_LEDGER_SOURCE_MISMATCH',
  'SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED',
  'SUPPRESSION_LEDGER_HEAD_INVALID',
  'SUPPRESSION_LEDGER_HEAD_EXISTS',
  'SUPPRESSION_LEDGER_BOOTSTRAP_FAILED',
  'SUPPRESSION_LEDGER_EXPORT_FAILED',
] as const;
export type SuppressionLedgerFailureCode = (typeof suppressionLedgerFailureCodes)[number];
export type SuppressionLedgerOutcome =
  'exported' | 'no_new_records' | 'reconciled' | 'bootstrap_created' | 'bootstrap_completed';

export class SuppressionLedgerFailure extends Error {
  constructor(readonly code: SuppressionLedgerFailureCode) {
    super(code);
  }
}
function fail(code: SuppressionLedgerFailureCode): never {
  throw new SuppressionLedgerFailure(code);
}
async function step<T>(code: SuppressionLedgerFailureCode, work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SuppressionLedgerFailure) throw error;
    return fail(code);
  }
}

/** Read-only view of the live source; it neither locks nor advances the slot. */
export type SuppressionSourceInspection = {
  clusterId: string;
  databaseName: string;
  databaseOid: number;
  registryFingerprint: string;
  relationProfile: SuppressionRelationProfile;
  confirmedFlushLsn: string;
  pendingMessages: number;
};

function normalizedLsn(value: string): string {
  if (!/^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/.test(value))
    return fail('SUPPRESSION_LEDGER_SOURCE_MISMATCH');
  const [high = '', low = ''] = value.split('/');
  return `${BigInt(`0x${high}`).toString(16).toUpperCase()}/${BigInt(`0x${low}`).toString(16).toUpperCase()}`;
}

export async function inspectSuppressionSource(
  pool: Pool,
  slotName: string,
): Promise<SuppressionSourceInspection> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{
      cluster_id: string;
      database_name: string;
      database_oid: string;
      registry_fingerprint: string;
    }>(
      `SELECT (SELECT system_identifier::text FROM pg_control_system()) AS cluster_id,
         current_database() AS database_name,
         (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
         encode(sha256(convert_to((SELECT jsonb_agg(jsonb_build_object('version',version,'checksum',checksum) ORDER BY version)::text FROM public.schema_migrations),'UTF8')),'hex') AS registry_fingerprint`,
    );
    const relationProfile = await readSuppressionRelationProfileIn(client);
    const slot = await client.query<{
      plugin: string;
      slot_type: string;
      database: string | null;
      current_database: string;
      active: boolean;
      temporary: boolean;
      confirmed_flush_lsn: string | null;
      wal_status: string | null;
    }>(
      `SELECT plugin,slot_type,database,current_database(),active,temporary,
              confirmed_flush_lsn::text,wal_status
         FROM pg_replication_slots WHERE slot_name=$1`,
      [slotName],
    );
    const row = identity.rows[0];
    const state = slot.rows[0];
    if (
      identity.rows.length !== 1 ||
      !row ||
      slot.rows.length !== 1 ||
      !state ||
      state.plugin !== 'pgoutput' ||
      state.slot_type !== 'logical' ||
      state.database !== state.current_database ||
      state.active ||
      state.temporary ||
      !state.confirmed_flush_lsn ||
      !['reserved', 'extended'].includes(state.wal_status ?? '')
    )
      return fail('SUPPRESSION_LEDGER_SOURCE_MISMATCH');
    const messages = await peekSuppressionPgoutput(client, slotName);
    return {
      clusterId: row.cluster_id,
      databaseName: row.database_name,
      databaseOid: Number(row.database_oid),
      registryFingerprint: row.registry_fingerprint,
      relationProfile,
      confirmedFlushLsn: normalizedLsn(state.confirmed_flush_lsn),
      pendingMessages: messages.length,
    };
  } finally {
    client.release();
  }
}

export type SuppressionLedgerRunInput = {
  config: SuppressionLedgerOnceConfig;
  pool: Pool;
  store: SuppressionRemoteStore;
  client: SuppressionVersionedObjectClient;
  encryptionKey: Buffer;
  headAuthenticationKey: Buffer;
  inspectSource: (pool: Pool, slotName: string) => Promise<SuppressionSourceInspection>;
  exportForInstalledDomain: typeof exportAuthenticatedSuppressionSegmentForInstalledDomain;
};
export type SuppressionLedgerRunResult = {
  outcome: SuppressionLedgerOutcome;
  relationProfile: SuppressionRelationProfile;
};

/** Refuses unless the live source is exactly the configured binding and installed domain. */
async function checkedSource(
  input: SuppressionLedgerRunInput,
): Promise<SuppressionSourceInspection> {
  const source = input.config.source;
  const live = await step('SUPPRESSION_LEDGER_SOURCE_MISMATCH', () =>
    input.inspectSource(input.pool, input.config.slotName),
  );
  if (
    live.clusterId !== input.config.expectedClusterId ||
    live.databaseName !== source.databaseName ||
    live.databaseOid !== source.databaseOid ||
    live.registryFingerprint !== source.registryFingerprint ||
    live.relationProfile !== source.relationProfile
  )
    return fail('SUPPRESSION_LEDGER_SOURCE_MISMATCH');
  return live;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: SuppressionLedgerSourceBinding) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

type DecodedHead = {
  source: SuppressionLedgerSourceBinding;
  clusterId: string;
  throughLsn: string;
  segments: readonly { fromLsn: string }[];
};
function decodeHead(
  profile: SuppressionRelationProfile,
  bytes: Uint8Array,
  key: Buffer,
): DecodedHead {
  return profile === 'suppression-physical-v8'
    ? decodeSuppressionHeadV8(bytes, key)
    : decodeSuppressionHeadV7(bytes, key);
}
function initialHead(
  source: SuppressionLedgerSourceBinding,
  clusterId: string,
  lsn: string,
  key: Buffer,
): Buffer {
  const body = {
    source,
    clusterId,
    fromLsn: lsn,
    throughLsn: lsn,
    previousHash: null,
    finalLocalHash: null,
    segments: [],
  };
  return source.relationProfile === 'suppression-physical-v8'
    ? encodeSuppressionHeadV8({ formatVersion: 3, ...body }, key)
    : encodeSuppressionHeadV7({ formatVersion: 2, ...body }, key);
}

function witnessFor(
  config: SuppressionLedgerOnceConfig,
  head: { versionId: string; sha256: string } | null,
  pendingHeadSha256: string | null,
): SuppressionHeadWitness {
  return {
    schemaVersion: 1,
    captureId: config.source.captureId,
    relationProfile: config.source.relationProfile,
    headVersionId: head?.versionId ?? null,
    headSha256: head?.sha256 ?? null,
    pendingHeadSha256,
  };
}

/**
 * Resolves the exact expected head: the pinned one, or a head this worker had committed to
 * publish (pending sha256) and is now adopted. Anything else is refused.
 */
async function expectedHead(
  input: SuppressionLedgerRunInput,
): Promise<{ versionId: string; sha256: string; bytes: Buffer }> {
  const { config } = input;
  const witness = await step('SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED', () =>
    readSuppressionHeadWitness(config.headWitnessPath),
  );
  if (
    !witness ||
    witness.captureId !== config.source.captureId ||
    witness.relationProfile !== config.source.relationProfile
  )
    return fail('SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED');
  const remote = await step('SUPPRESSION_LEDGER_HEAD_INVALID', () => input.store.readHead());
  if (!remote) return fail('SUPPRESSION_LEDGER_HEAD_INVALID');
  const digest = sha256(remote.bytes);
  if (witness.headVersionId === remote.versionId && witness.headSha256 === digest)
    return { versionId: remote.versionId, sha256: digest, bytes: remote.bytes };
  if (witness.pendingHeadSha256 !== digest || witness.headVersionId === remote.versionId)
    return fail('SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED');
  await step('SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED', () =>
    writeSuppressionHeadWitness(
      config.headWitnessPath,
      witnessFor(config, { versionId: remote.versionId, sha256: digest }, null),
    ),
  );
  return { versionId: remote.versionId, sha256: digest, bytes: remote.bytes };
}

/** One bounded export through the authenticated installed-domain exporter (V7 or V8). */
export async function runSuppressionLedgerExport(
  input: SuppressionLedgerRunInput,
): Promise<SuppressionLedgerRunResult> {
  const { config } = input;
  const relationProfile = config.source.relationProfile;
  const live = await checkedSource(input);
  const expected = await expectedHead(input);
  const head = await step('SUPPRESSION_LEDGER_HEAD_INVALID', () =>
    decodeHead(relationProfile, expected.bytes, input.headAuthenticationKey),
  );
  if (
    canonical(head.source) !== canonical(config.source) ||
    head.clusterId !== config.expectedClusterId
  )
    return fail('SUPPRESSION_LEDGER_HEAD_INVALID');
  if (live.confirmedFlushLsn === head.throughLsn && live.pendingMessages === 0)
    return { outcome: 'no_new_records', relationProfile };
  const reconciling = live.confirmedFlushLsn !== head.throughLsn;
  if (reconciling && live.confirmedFlushLsn !== head.segments.at(-1)?.fromLsn)
    return fail('SUPPRESSION_LEDGER_HEAD_INVALID');

  // The pending sha256 is durably recorded before the conditional head write.
  const store: SuppressionRemoteStore = {
    readHead: () => input.store.readHead(),
    readSegment: (id, version) => input.store.readSegment(id, version),
    putImmutableSegment: (bytes) => input.store.putImmutableSegment(bytes),
    async compareAndSetHead(expectedVersionId, bytes) {
      const next = sha256(bytes);
      const current = { versionId: expected.versionId, sha256: expected.sha256 };
      writeSuppressionHeadWitness(config.headWitnessPath, witnessFor(config, current, next));
      const changed = await input.store.compareAndSetHead(expectedVersionId, bytes);
      writeSuppressionHeadWitness(
        config.headWitnessPath,
        witnessFor(config, { versionId: changed.versionId, sha256: next }, null),
      );
      return changed;
    },
  };
  try {
    await input.exportForInstalledDomain({
      pool: input.pool,
      source: config.source,
      expectedClusterId: config.expectedClusterId,
      encryptionKey: input.encryptionKey,
      keyId: config.encryptionKeyId,
      headAuthenticationKey: input.headAuthenticationKey,
      store,
      expectedHeadVersionId: expected.versionId,
      expectedHeadSha256: expected.sha256,
    });
    return { outcome: 'exported', relationProfile };
  } catch {
    // An interrupted ACK is reconciled by the exporter before it looks for new records; with
    // nothing new the export itself then refuses. Only that exact state is a success.
    if (reconciling) {
      const after = await step('SUPPRESSION_LEDGER_EXPORT_FAILED', () => checkedSource(input));
      if (after.confirmedFlushLsn === head.throughLsn && after.pendingMessages === 0)
        return { outcome: 'reconciled', relationProfile };
    }
    return fail('SUPPRESSION_LEDGER_EXPORT_FAILED');
  }
}

/**
 * Operator one-shot: creates the initial signed head (format 2 for V7, format 3 for V8) at the
 * slot's confirmed position. Refuses when any head version exists; resumes only its own
 * interrupted creation (pending witness whose sha256 equals the remote head bytes).
 */
export async function bootstrapSuppressionLedgerHead(
  input: SuppressionLedgerRunInput,
): Promise<SuppressionLedgerRunResult> {
  const { config } = input;
  const relationProfile = config.source.relationProfile;
  const headKey = `${config.remote.prefix}/head.bin`;
  const live = await checkedSource(input);
  const witness = await step('SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED', () =>
    readSuppressionHeadWitness(config.headWitnessPath),
  );
  if (witness) {
    if (
      witness.headVersionId !== null ||
      witness.captureId !== config.source.captureId ||
      witness.relationProfile !== relationProfile
    )
      return fail('SUPPRESSION_LEDGER_HEAD_EXISTS');
    const remote = await step('SUPPRESSION_LEDGER_HEAD_EXISTS', () => input.store.readHead());
    if (!remote) return fail('SUPPRESSION_LEDGER_HEAD_EXISTS');
    const digest = sha256(remote.bytes);
    if (digest !== witness.pendingHeadSha256) return fail('SUPPRESSION_LEDGER_HEAD_EXISTS');
    const versions = await step('SUPPRESSION_LEDGER_BOOTSTRAP_FAILED', () =>
      input.client.versions(headKey),
    );
    if (versions.length !== 1 || versions[0] !== remote.versionId)
      return fail('SUPPRESSION_LEDGER_HEAD_EXISTS');
    await step('SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED', () =>
      writeSuppressionHeadWitness(
        config.headWitnessPath,
        witnessFor(config, { versionId: remote.versionId, sha256: digest }, null),
      ),
    );
    return { outcome: 'bootstrap_completed', relationProfile };
  }
  const existing = await step('SUPPRESSION_LEDGER_BOOTSTRAP_FAILED', async () => {
    if ((await input.client.versioning()) !== 'Enabled') throw new Error('versioning');
    if ((await input.client.location()) !== config.remote.region) throw new Error('region');
    return input.client.versions(headKey);
  });
  if (existing.length !== 0) return fail('SUPPRESSION_LEDGER_HEAD_EXISTS');
  const bytes = await step('SUPPRESSION_LEDGER_BOOTSTRAP_FAILED', () =>
    initialHead(
      config.source,
      config.expectedClusterId,
      live.confirmedFlushLsn,
      input.headAuthenticationKey,
    ),
  );
  const digest = sha256(bytes);
  await step('SUPPRESSION_LEDGER_HEAD_EXISTS', () =>
    writeSuppressionHeadWitness(config.headWitnessPath, witnessFor(config, null, digest), {
      create: true,
    }),
  );
  const created = await step('SUPPRESSION_LEDGER_BOOTSTRAP_FAILED', async () => {
    const put = await input.client.putIfAbsent(headKey, bytes);
    const readBack = await input.store.readHead();
    const versions = await input.client.versions(headKey);
    if (
      !readBack ||
      readBack.versionId !== put.versionId ||
      !readBack.bytes.equals(bytes) ||
      versions.length !== 1 ||
      versions[0] !== put.versionId
    )
      throw new Error('readback');
    return put.versionId;
  });
  await step('SUPPRESSION_LEDGER_HEAD_WITNESS_FAILED', () =>
    writeSuppressionHeadWitness(
      config.headWitnessPath,
      witnessFor(config, { versionId: created, sha256: digest }, null),
    ),
  );
  // Slot position is not re-read as authority: the exporter refuses a head that is not at it.
  return { outcome: 'bootstrap_created', relationProfile };
}
