import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import {
  MAX_PGOUTPUT_BYTES,
  MAX_PGOUTPUT_MESSAGES,
  makeLocalReplayRecordEnvelope,
  peekSuppressionPgoutput,
} from './restore-suppression-pgoutput.js';
import type { SuppressionRemoteStore } from './restore-suppression-coordinator.js';
import {
  encodeSuppressionHeadV7,
  decodeSuppressionHeadV7,
} from './restore-suppression-replay-v7.js';
import {
  encodeSuppressionHeadV8,
  decodeSuppressionHeadV8,
} from './restore-suppression-replay-v8.js';
import {
  decryptReplaySegmentV7,
  decryptReplaySegmentV8,
  encryptReplaySegment,
  encryptReplaySegmentV7,
  encryptReplaySegmentV8,
  makeLocalReplayRecordEnvelopeV7,
  makeLocalReplayRecordEnvelopeV8,
  suppressionSourceBindingV7Schema,
  suppressionSourceBindingV8Schema,
  type SuppressionSourceBindingV7,
  type SuppressionSourceBindingV8,
} from './restore-suppression-segment.js';

const LOCK_CLASS = 0x574d4c44; // WMLD; all cooperative exporters use this database-wide lock.
const LOCK_OBJECT = 1;
const digest = /^[a-f0-9]{64}$/;
const lsn = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;

export type VerifiedRemoteSegment = {
  sha256: string;
  byteLength: number;
  versionId: string;
  segmentId: string;
};

export type ExportedSuppressionSegment = {
  clusterId: string;
  slotName: string;
  fromLsn: string;
  throughLsn: string;
  localHash: string;
  remote: VerifiedRemoteSegment;
};

export type SuppressionSlotPosition = {
  clusterId: string;
  throughLsn: string;
};

type Slot = {
  plugin: string;
  slot_type: string;
  database: string | null;
  current_database: string;
  active: boolean;
  temporary: boolean;
  confirmed_flush_lsn: string | null;
  wal_status: string | null;
};

type SourceBinding = SuppressionSourceBindingV7 | SuppressionSourceBindingV8;
export type SuppressionRelationProfile = SourceBinding['relationProfile'];

function fail(): never {
  throw new Error('SUPPRESSION_EXPORT_FAILED');
}

/**
 * The installed restore_suppression_event record domain, read from the catalog: SQL145
 * rewrites both event CHECKs with the record-8 album branch and adds the record-8 unique
 * index. All three present -> 'suppression-physical-v8'; none -> 'suppression-physical-v7';
 * a partial installation fails closed. This is a codec selector, not export authority.
 */
export async function readSuppressionRelationProfileIn(
  client: Pick<PoolClient, 'query'>,
): Promise<SuppressionRelationProfile> {
  const result = await client.query<{ checks: number; album_checks: number; album_index: boolean }>(
    `SELECT count(*)::int AS checks,
       count(*) FILTER (WHERE pg_get_constraintdef(c.oid) LIKE '%gallery_album_deleted%')::int AS album_checks,
       to_regclass('public.restore_suppression_event_gallery_album_once') IS NOT NULL AS album_index
     FROM pg_constraint c
     WHERE c.conrelid='public.restore_suppression_event'::regclass
       AND c.conname IN ('restore_suppression_event_kind_target_check','restore_suppression_event_record_version_check')`,
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || row.checks !== 2) return fail();
  if (row.album_checks === 2 && row.album_index) return 'suppression-physical-v8';
  if (row.album_checks === 0 && !row.album_index) return 'suppression-physical-v7';
  return fail();
}

function normalizedLsn(value: string): string {
  if (!lsn.test(value)) return fail();
  const [high, low] = value.split('/');
  if (!high || !low) return fail();
  return `${BigInt(`0x${high}`).toString(16).toUpperCase()}/${BigInt(`0x${low}`).toString(16).toUpperCase()}`;
}

function lsnValue(value: string): bigint {
  const [high, low] = normalizedLsn(value).split('/');
  if (!high || !low) return fail();
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
}

async function slotState(client: PoolClient, slotName: string): Promise<Slot> {
  const result = await client.query<Slot>(
    `SELECT plugin,slot_type,database,current_database(),active,temporary,
            confirmed_flush_lsn::text,wal_status
       FROM pg_replication_slots WHERE slot_name=$1`,
    [slotName],
  );
  const slot = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !slot ||
    slot.plugin !== 'pgoutput' ||
    slot.slot_type !== 'logical' ||
    slot.database !== slot.current_database ||
    slot.active ||
    slot.temporary ||
    !slot.confirmed_flush_lsn ||
    !['reserved', 'extended'].includes(slot.wal_status ?? '')
  )
    return fail();
  return slot;
}

/** Read the physical slot state; this is not a remote-head assertion. */
export async function readSuppressionSlotPosition(input: {
  pool: Pool;
  slotName: string;
}): Promise<SuppressionSlotPosition> {
  if (!/^wm_suppression_[a-z0-9_]{1,40}$/.test(input.slotName)) return fail();
  const client = await input.pool.connect();
  try {
    const cluster = await client.query<{ system_identifier: string }>(
      'SELECT system_identifier::text FROM pg_control_system()',
    );
    const slot = await slotState(client, input.slotName);
    if (!cluster.rows[0]?.system_identifier) return fail();
    return {
      clusterId: cluster.rows[0].system_identifier,
      throughLsn: normalizedLsn(slot.confirmed_flush_lsn ?? ''),
    };
  } catch {
    return fail();
  } finally {
    client.release();
  }
}

/** Recover a published, authenticated segment whose slot ACK was interrupted. */
export async function reconcileSuppressionSlot(input: {
  pool: Pool;
  slotName: string;
  expectedClusterId: string;
  fromLsn: string;
  throughLsn: string;
  previousHash: string | null;
  localHash: string;
}): Promise<void> {
  return reconcileSlot(input);
}
export async function reconcileSuppressionSlotV7(
  input: Parameters<typeof reconcileSuppressionSlot>[0] & { source: SuppressionSourceBindingV7 },
): Promise<void> {
  const source = suppressionSourceBindingV7Schema.parse(input.source);
  if (source.slotName !== input.slotName) return fail();
  return reconcileSlot({ ...input, source });
}
/** Record-8 successor: only for an installed SQL145 record domain (no fallback to V7). */
export async function reconcileSuppressionSlotV8(
  input: Parameters<typeof reconcileSuppressionSlot>[0] & { source: SuppressionSourceBindingV8 },
): Promise<void> {
  const source = suppressionSourceBindingV8Schema.parse(input.source);
  if (source.slotName !== input.slotName) return fail();
  return reconcileSlot({ ...input, source });
}
async function reconcileSlot(
  input: Parameters<typeof reconcileSuppressionSlot>[0] & { source?: SourceBinding },
): Promise<void> {
  if (
    !/^wm_suppression_[a-z0-9_]{1,40}$/.test(input.slotName) ||
    !/^[1-9]\d{0,19}$/.test(input.expectedClusterId) ||
    !lsn.test(input.fromLsn) ||
    !lsn.test(input.throughLsn) ||
    !digest.test(input.localHash) ||
    (input.previousHash !== null && !digest.test(input.previousHash))
  )
    return fail();
  const client = await input.pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1,$2) AS acquired',
      [LOCK_CLASS, LOCK_OBJECT],
    );
    if (lock.rows[0]?.acquired !== true) return fail();
    locked = true;
    const cluster = await client.query<{ system_identifier: string }>(
      'SELECT system_identifier::text FROM pg_control_system()',
    );
    if (cluster.rows[0]?.system_identifier !== input.expectedClusterId) return fail();
    const fromLsn = normalizedLsn(input.fromLsn);
    const throughLsn = normalizedLsn(input.throughLsn);
    if (lsnValue(throughLsn) <= lsnValue(fromLsn)) return fail();
    if (input.source) await assertSourceBinding(client, input.source);
    const before = await slotState(client, input.slotName);
    if (normalizedLsn(before.confirmed_flush_lsn ?? '') !== fromLsn) return fail();
    const peek = await client.query<{ data: Buffer }>(
      `SELECT data FROM pg_logical_slot_peek_binary_changes(
        $1,$2::pg_lsn,$3,'proto_version','1',
        'publication_names','workout_restore_suppression_events')`,
      [input.slotName, throughLsn, MAX_PGOUTPUT_MESSAGES + 1],
    );
    if (peek.rows.length > MAX_PGOUTPUT_MESSAGES) return fail();
    const messages = peek.rows.map((row) => row.data);
    if (messages.reduce((total, data) => total + data.length, 0) > MAX_PGOUTPUT_BYTES)
      return fail();
    const common = {
      clusterId: input.expectedClusterId,
      fromLsn,
      previousHash: input.previousHash,
      messages,
    };
    const envelope = sourceEnvelope(input.source, common);
    if (envelope.throughLsn !== throughLsn || envelope.sha256 !== input.localHash) return fail();
    const afterPeek = await slotState(client, input.slotName);
    if (normalizedLsn(afterPeek.confirmed_flush_lsn ?? '') !== fromLsn) return fail();
    const advanced = await client.query<{ slot_name: string; end_lsn: string }>(
      'SELECT slot_name,end_lsn::text FROM pg_replication_slot_advance($1,$2::pg_lsn)',
      [input.slotName, throughLsn],
    );
    if (
      advanced.rows[0]?.slot_name !== input.slotName ||
      normalizedLsn(advanced.rows[0]?.end_lsn ?? '') !== throughLsn
    )
      return fail();
    const after = await slotState(client, input.slotName);
    if (normalizedLsn(after.confirmed_flush_lsn ?? '') !== throughLsn) return fail();
  } catch {
    return fail();
  } finally {
    if (locked) {
      try {
        const released = await client.query<{ released: boolean }>(
          'SELECT pg_advisory_unlock($1,$2) AS released',
          [LOCK_CLASS, LOCK_OBJECT],
        );
        if (released.rows[0]?.released === true) client.release();
        else client.release(true);
      } catch {
        client.release(true);
      }
    } else client.release();
  }
}

type EnvelopeInput = Parameters<typeof makeLocalReplayRecordEnvelope>[0];
function sourceEnvelope(source: SourceBinding | undefined, common: EnvelopeInput) {
  if (!source) return makeLocalReplayRecordEnvelope(common);
  return source.relationProfile === 'suppression-physical-v8'
    ? makeLocalReplayRecordEnvelopeV8({ ...common, source })
    : makeLocalReplayRecordEnvelopeV7({ ...common, source });
}

async function assertSourceBinding(client: PoolClient, source: SourceBinding): Promise<void> {
  // The binding's relation profile must be exactly the installed record domain.
  if ((await readSuppressionRelationProfileIn(client)) !== source.relationProfile) return fail();
  const actual = await client.query<{
    database_name: string;
    database_oid: number;
    registry_fingerprint: string;
  }>(
    `SELECT current_database() AS database_name,(SELECT oid FROM pg_database WHERE datname=current_database()) AS database_oid,
         encode(sha256(convert_to((SELECT jsonb_agg(jsonb_build_object('version',version,'checksum',checksum) ORDER BY version)::text FROM public.schema_migrations),'UTF8')),'hex') AS registry_fingerprint`,
  );
  const row = actual.rows[0];
  if (
    actual.rows.length !== 1 ||
    !row ||
    row.database_name !== source.databaseName ||
    row.database_oid !== source.databaseOid ||
    row.registry_fingerprint !== source.registryFingerprint
  )
    return fail();
}

function verifiedRemote(value: unknown, sha256: string, byteLength: number): VerifiedRemoteSegment {
  if (typeof value !== 'object' || value === null) return fail();
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).sort().join(',') !==
      ['sha256', 'byteLength', 'versionId', 'segmentId'].sort().join(',') ||
    result['sha256'] !== sha256 ||
    result['byteLength'] !== byteLength ||
    typeof result['versionId'] !== 'string' ||
    result['versionId'].length < 1 ||
    result['versionId'] === 'null' ||
    typeof result['segmentId'] !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(result['segmentId'])
  )
    return fail();
  return {
    sha256,
    byteLength,
    versionId: result['versionId'],
    segmentId: result['segmentId'],
  };
}

/**
 * One bounded committed pgoutput prefix. The callback must verify exact remote,
 * versioned bytes before resolving. No plaintext or record metadata reaches it.
 * This does not prove a backup baseline, independent tail, or restore readiness.
 */
export async function exportSuppressionSegment(input: {
  pool: Pool;
  slotName: string;
  expectedClusterId: string;
  expectedFromLsn: string;
  previousHash: string | null;
  key: Uint8Array;
  keyId: string;
  storeVerifiedCiphertext: (bytes: Buffer) => Promise<unknown>;
}): Promise<ExportedSuppressionSegment> {
  return exportSegment(input);
}
export async function exportSuppressionSegmentV7(
  input: Parameters<typeof exportSuppressionSegment>[0] & {
    source: SuppressionSourceBindingV7;
  },
): Promise<ExportedSuppressionSegment & { source: SuppressionSourceBindingV7 }> {
  const source = suppressionSourceBindingV7Schema.parse(input.source);
  if (source.slotName !== input.slotName) return fail();
  const exported = await exportSegment({ ...input, source });
  return { ...exported, source };
}
/** Record-8 successor: only for an installed SQL145 record domain (no fallback to V7). */
export async function exportSuppressionSegmentV8(
  input: Parameters<typeof exportSuppressionSegment>[0] & {
    source: SuppressionSourceBindingV8;
  },
): Promise<ExportedSuppressionSegment & { source: SuppressionSourceBindingV8 }> {
  const source = suppressionSourceBindingV8Schema.parse(input.source);
  if (source.slotName !== input.slotName) return fail();
  const exported = await exportSegment({ ...input, source });
  return { ...exported, source };
}
async function exportSegment(
  input: Parameters<typeof exportSuppressionSegment>[0] & {
    source?: SourceBinding;
  },
): Promise<ExportedSuppressionSegment> {
  if (
    !/^wm_suppression_[a-z0-9_]{1,40}$/.test(input.slotName) ||
    !/^[1-9]\d{0,19}$/.test(input.expectedClusterId) ||
    !lsn.test(input.expectedFromLsn) ||
    (input.previousHash !== null && !digest.test(input.previousHash))
  )
    return fail();

  const client = await input.pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1,$2) AS acquired',
      [LOCK_CLASS, LOCK_OBJECT],
    );
    if (lock.rows[0]?.acquired !== true) return fail();
    locked = true;

    const identity = await client.query<{ system_identifier: string }>(
      'SELECT system_identifier::text FROM pg_control_system()',
    );
    if (identity.rows[0]?.system_identifier !== input.expectedClusterId) return fail();
    if (input.source) await assertSourceBinding(client, input.source);
    const before = await slotState(client, input.slotName);
    const fromLsn = normalizedLsn(input.expectedFromLsn);
    if (normalizedLsn(before.confirmed_flush_lsn ?? '') !== fromLsn) return fail();

    const messages = await peekSuppressionPgoutput(client, input.slotName);
    const common = {
      clusterId: input.expectedClusterId,
      fromLsn,
      previousHash: input.previousHash,
      messages,
    };
    const envelope = sourceEnvelope(input.source, common);
    const segment =
      envelope.localRecordVersion === 3
        ? encryptReplaySegmentV8({ envelope, key: input.key, keyId: input.keyId })
        : envelope.localRecordVersion === 2
          ? encryptReplaySegmentV7({ envelope, key: input.key, keyId: input.keyId })
          : encryptReplaySegment({ envelope, key: input.key, keyId: input.keyId });
    const outbound = Buffer.from(segment.bytes);
    const remote = verifiedRemote(
      await input.storeVerifiedCiphertext(outbound),
      segment.sha256,
      segment.byteLength,
    );
    if (
      outbound.length !== segment.byteLength ||
      createHash('sha256').update(outbound).digest('hex') !== segment.sha256
    )
      return fail();

    // A competing non-cooperative reader invalidates this attempt. Operators
    // must additionally reserve this dedicated slot to this exporter identity.
    const afterUpload = await slotState(client, input.slotName);
    if (normalizedLsn(afterUpload.confirmed_flush_lsn ?? '') !== fromLsn) return fail();

    // pg_replication_slot_advance has an explicit upper target. Do not use
    // get_changes with a row count: PostgreSQL may exceed that count at commit.
    const advanced = await client.query<{ slot_name: string; end_lsn: string }>(
      'SELECT slot_name,end_lsn::text FROM pg_replication_slot_advance($1,$2::pg_lsn)',
      [input.slotName, envelope.throughLsn],
    );
    if (
      advanced.rows.length !== 1 ||
      advanced.rows[0]?.slot_name !== input.slotName ||
      normalizedLsn(advanced.rows[0].end_lsn) !== envelope.throughLsn
    )
      return fail();
    const afterAdvance = await slotState(client, input.slotName);
    if (normalizedLsn(afterAdvance.confirmed_flush_lsn ?? '') !== envelope.throughLsn)
      return fail();
    return {
      clusterId: input.expectedClusterId,
      slotName: input.slotName,
      fromLsn,
      throughLsn: envelope.throughLsn,
      localHash: envelope.sha256,
      remote,
    };
  } catch {
    return fail();
  } finally {
    if (locked) {
      try {
        const release = await client.query<{ released: boolean }>(
          'SELECT pg_advisory_unlock($1,$2) AS released',
          [LOCK_CLASS, LOCK_OBJECT],
        );
        if (release.rows[0]?.released !== true) client.release(true);
        else client.release();
      } catch {
        client.release(true);
      }
    } else {
      client.release();
    }
  }
}

type AuthenticatedExportInput<S extends SourceBinding> = {
  pool: Pool;
  source: S;
  expectedClusterId: string;
  encryptionKey: Uint8Array;
  keyId: string;
  headAuthenticationKey: Uint8Array;
  store: SuppressionRemoteStore;
  expectedHeadVersionId: string;
  expectedHeadSha256: string;
};
type HeadCodec<S extends SourceBinding> = {
  parseSource: (value: unknown) => S;
  decodeHead: (bytes: Uint8Array, key: Uint8Array) => ReturnType<typeof decodeSuppressionHeadV7>;
  encodeHead: (value: unknown, key: Uint8Array) => Buffer;
  decrypt: (input: { bytes: Uint8Array; key: Uint8Array; expectedKeyId: string }) => {
    sha256: string;
    source: S;
    clusterId: string;
    fromLsn: string;
    throughLsn: string;
    previousHash: string | null;
  };
  reconcile: (
    input: Parameters<typeof reconcileSuppressionSlot>[0] & { source: S },
  ) => Promise<void>;
  exportSegment: (
    input: Parameters<typeof exportSuppressionSegment>[0] & { source: S },
  ) => Promise<ExportedSuppressionSegment & { source: S }>;
};
const headCodecV7: HeadCodec<SuppressionSourceBindingV7> = {
  parseSource: (value) => suppressionSourceBindingV7Schema.parse(value),
  decodeHead: decodeSuppressionHeadV7,
  encodeHead: encodeSuppressionHeadV7,
  decrypt: decryptReplaySegmentV7,
  reconcile: reconcileSuppressionSlotV7,
  exportSegment: exportSuppressionSegmentV7,
};
const headCodecV8: HeadCodec<SuppressionSourceBindingV8> = {
  parseSource: (value) => suppressionSourceBindingV8Schema.parse(value),
  // Head formats differ only in their literal format/profile and HMAC domain.
  decodeHead: (bytes, key) =>
    decodeSuppressionHeadV8(bytes, key) as unknown as ReturnType<typeof decodeSuppressionHeadV7>,
  encodeHead: encodeSuppressionHeadV8,
  decrypt: decryptReplaySegmentV8,
  reconcile: reconcileSuppressionSlotV8,
  exportSegment: exportSuppressionSegmentV8,
};

/** Publish authenticated V7 head before ACK. Local crypto does not certify a remote witness. */
export async function exportAuthenticatedSuppressionSegmentV7(
  input: AuthenticatedExportInput<SuppressionSourceBindingV7>,
): Promise<ExportedSuppressionSegment & { source: SuppressionSourceBindingV7 }> {
  return exportAuthenticated(input, headCodecV7);
}
/** Record-8 successor (SQL145 domain): V8 segments and format-3 heads; V7 never chosen. */
export async function exportAuthenticatedSuppressionSegmentV8(
  input: AuthenticatedExportInput<SuppressionSourceBindingV8>,
): Promise<ExportedSuppressionSegment & { source: SuppressionSourceBindingV8 }> {
  return exportAuthenticated(input, headCodecV8);
}
/**
 * Explicit selection from the installed record domain: the caller's binding must name the
 * profile the source database has installed, otherwise nothing is read or exported.
 */
export async function exportAuthenticatedSuppressionSegmentForInstalledDomain(
  input: AuthenticatedExportInput<SourceBinding>,
): Promise<ExportedSuppressionSegment & { source: SourceBinding }> {
  const client = await input.pool.connect();
  let profile: SuppressionRelationProfile;
  try {
    profile = await readSuppressionRelationProfileIn(client);
  } finally {
    client.release();
  }
  if (input.source.relationProfile !== profile) return fail();
  return input.source.relationProfile === 'suppression-physical-v8'
    ? exportAuthenticatedSuppressionSegmentV8({ ...input, source: input.source })
    : exportAuthenticatedSuppressionSegmentV7({ ...input, source: input.source });
}
async function exportAuthenticated<S extends SourceBinding>(
  input: AuthenticatedExportInput<S>,
  codec: HeadCodec<S>,
): Promise<ExportedSuppressionSegment & { source: S }> {
  const source = codec.parseSource(input.source);
  if (
    !(input.encryptionKey instanceof Uint8Array) ||
    input.encryptionKey.byteLength !== 32 ||
    !(input.headAuthenticationKey instanceof Uint8Array) ||
    input.headAuthenticationKey.byteLength !== 32 ||
    Buffer.from(input.encryptionKey).equals(Buffer.from(input.headAuthenticationKey)) ||
    !digest.test(input.expectedHeadSha256) ||
    input.expectedHeadVersionId.length < 1 ||
    input.expectedHeadVersionId.length > 1000
  )
    return fail();
  const encryptionKey = Buffer.from(input.encryptionKey);
  const headAuthenticationKey = Buffer.from(input.headAuthenticationKey);
  const object = await input.store.readHead();
  if (
    !object ||
    object.versionId !== input.expectedHeadVersionId ||
    !(object.bytes instanceof Uint8Array) ||
    object.bytes.length > 128 * 1024 ||
    createHash('sha256').update(object.bytes).digest('hex') !== input.expectedHeadSha256
  )
    return fail();
  const head = codec.decodeHead(object.bytes, headAuthenticationKey);
  if (
    JSON.stringify(head.source) !== JSON.stringify(source) ||
    head.clusterId !== input.expectedClusterId
  )
    return fail();
  const position = await readSuppressionSlotPosition({
    pool: input.pool,
    slotName: source.slotName,
  });
  if (position.clusterId !== head.clusterId) return fail();
  if (position.throughLsn !== head.throughLsn) {
    const last = head.segments.at(-1);
    if (!last || position.throughLsn !== last.fromLsn) return fail();
    const stored = await input.store.readSegment(last.segmentId, last.versionId);
    if (
      !stored ||
      stored.versionId !== last.versionId ||
      stored.bytes.length !== last.byteLength ||
      createHash('sha256').update(stored.bytes).digest('hex') !== last.sha256
    )
      return fail();
    const envelope = codec.decrypt({
      bytes: stored.bytes,
      key: encryptionKey,
      expectedKeyId: input.keyId,
    });
    if (
      envelope.sha256 !== last.localHash ||
      JSON.stringify(envelope.source) !== JSON.stringify(source) ||
      envelope.clusterId !== head.clusterId ||
      envelope.fromLsn !== last.fromLsn ||
      envelope.throughLsn !== last.throughLsn ||
      envelope.previousHash !== last.previousHash
    )
      return fail();
    await codec.reconcile({
      pool: input.pool,
      slotName: source.slotName,
      expectedClusterId: head.clusterId,
      fromLsn: last.fromLsn,
      throughLsn: last.throughLsn,
      previousHash: last.previousHash,
      localHash: last.localHash,
      source,
    });
  }
  return codec.exportSegment({
    pool: input.pool,
    source,
    slotName: source.slotName,
    expectedClusterId: head.clusterId,
    expectedFromLsn: head.throughLsn,
    previousHash: head.finalLocalHash,
    key: encryptionKey,
    keyId: input.keyId,
    storeVerifiedCiphertext: async (bytes) => {
      const envelope = codec.decrypt({
        bytes,
        key: encryptionKey,
        expectedKeyId: input.keyId,
      });
      const stored = await input.store.putImmutableSegment(bytes);
      const remote = verifiedRemote(
        {
          ...stored,
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        createHash('sha256').update(bytes).digest('hex'),
        bytes.length,
      );
      const readback = await input.store.readSegment(remote.segmentId, remote.versionId);
      if (!readback || readback.versionId !== remote.versionId || !readback.bytes.equals(bytes))
        return fail();
      const next = codec.encodeHead(
        {
          ...head,
          throughLsn: envelope.throughLsn,
          finalLocalHash: envelope.sha256,
          segments: [
            ...head.segments,
            {
              ...remote,
              fromLsn: envelope.fromLsn,
              throughLsn: envelope.throughLsn,
              previousHash: envelope.previousHash,
              localHash: envelope.sha256,
            },
          ],
        },
        headAuthenticationKey,
      );
      const changed = await input.store.compareAndSetHead(object.versionId, next);
      const after = await input.store.readHead();
      if (
        typeof changed.versionId !== 'string' ||
        changed.versionId.length < 1 ||
        changed.versionId.length > 1000 ||
        !after ||
        after.versionId !== changed.versionId ||
        !after.bytes.equals(next)
      )
        return fail();
      return remote;
    },
  });
}
