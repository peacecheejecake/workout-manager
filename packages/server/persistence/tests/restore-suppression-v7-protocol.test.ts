import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { Client, Pool } from 'pg';
import { exportAuthenticatedSuppressionSegmentV7 } from '../src/restore-suppression-exporter.js';
import {
  makeLocalReplayRecordEnvelopeV7,
  encryptReplaySegmentV7,
  decryptReplaySegmentV7,
  decryptReplaySegment,
  encryptReplaySegment,
  type SuppressionSourceBindingV7,
} from '../src/restore-suppression-segment.js';
import { suppressionRecordColumnNamesV7 } from '../src/restore-suppression-records-v7.js';
import { decodeSuppressionPgoutputRecords } from '../src/restore-suppression-pgoutput.js';
import {
  encodeSuppressionHeadV7,
  decodeSuppressionHeadV7,
  createSuppressionReplayVerifierV7,
  type SuppressionHeadV7,
} from '../src/restore-suppression-replay-v7.js';
const key = Buffer.alloc(32, 11),
  auth = Buffer.alloc(32, 22);
const id = '12345678-abcd-4123-8123-123456789abc',
  athlete = '22345678-abcd-4123-8123-123456789abc';
const source: SuppressionSourceBindingV7 = {
  databaseName: 'synthetic_archive',
  databaseOid: 1234,
  slotName: 'wm_suppression_test',
  publication: 'workout_restore_suppression_events',
  relationProfile: 'suppression-physical-v7',
  captureId: id,
  registryFingerprint: 'a'.repeat(64),
};
function u16(n: number) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
function u64(n: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}
const cstring = (s: string) => Buffer.from(`${s}\0`);
const uuidColumns = new Set([
  'event_id',
  'target_id',
  'share_id',
  'share_cause_event_id',
  'course_share_id',
  'course_share_audit_id',
  'actual_previous_revision_id',
  'actual_deleted_revision_id',
  'healthkit_claim_epoch',
  'healthkit_operation_id',
]);
const intColumns = new Set([
  'record_version',
  'activity_revision',
  'source_revision',
  'resource_access_revision',
  'gallery_access_revision',
  'consent_previous_revision',
  'consent_revision',
  'check_in_revision',
  'share_granted_access_revision',
  'share_revoked_access_revision',
  'course_share_epoch',
  'course_share_course_revision',
  'actual_deletion_revision',
  'healthkit_consent_revision',
  'healthkit_registry_previous_revision',
  'healthkit_registry_revision',
  'race_previous_revision',
  'race_deleted_revision',
]);
function physical(overrides: Record<string, string | null> = {}, old = false) {
  return new Map(
    suppressionRecordColumnNamesV7().map((name) => [
      name,
      overrides[name] ??
        {
          event_id: old ? '32345678-abcd-4123-8123-123456789abc' : id,
          record_version: old ? '1' : '7',
          athlete_id: athlete,
          kind: old ? 'tenant_erased' : 'manual_review_source_suppressed_v2',
          occurred_at: '2026-10-01 12:34:56.123456+00',
          manual_review_v2_source_identity: old
            ? null
            : JSON.stringify({ kind: 'race-event', sourceId: id, revision: 2 }),
          manual_review_v2_version_scope: old ? null : 'exact_identity',
        }[name] ??
        null,
    ]),
  );
}
function messages(rows = [physical()], commit = 0x110n) {
  const names = suppressionRecordColumnNamesV7();
  const relation = Buffer.concat([
    Buffer.from('R'),
    u32(42),
    cstring('public'),
    cstring('restore_suppression_event'),
    Buffer.from('d'),
    u16(names.length),
    ...names.flatMap((name) => [
      Buffer.from([0]),
      cstring(name),
      u32(
        uuidColumns.has(name)
          ? 2950
          : intColumns.has(name)
            ? 23
            : name.endsWith('_granted')
              ? 16
              : name === 'occurred_at' || name === 'course_share_audit_occurred_at'
                ? 1184
                : name === 'healthkit_object_scopes' || name === 'manual_review_v2_source_identity'
                  ? 3802
                  : 25,
      ),
      u32(0xffffffff),
    ]),
  ]);
  return [
    Buffer.concat([Buffer.from('B'), u64(commit), u64(0n), u32(1)]),
    relation,
    ...rows.map((row) =>
      Buffer.concat([
        Buffer.from('I'),
        u32(42),
        Buffer.from('N'),
        u16(names.length),
        ...names.flatMap((name) => {
          const v = row.get(name);
          return v === null || v === undefined
            ? [Buffer.from('n')]
            : [Buffer.from('t'), u32(Buffer.byteLength(v)), Buffer.from(v)];
        }),
      ]),
    ),
    Buffer.concat([Buffer.from('C'), Buffer.from([0]), u64(commit), u64(commit + 0x10n), u64(0n)]),
  ];
}
function envelope(rows = [physical()]) {
  return makeLocalReplayRecordEnvelopeV7({
    clusterId: '1234567',
    source,
    fromLsn: '0/100',
    previousHash: null,
    messages: messages(rows),
  });
}
function fixture() {
  const value = envelope([physical({}, true), physical()]);
  const encrypted = encryptReplaySegmentV7({ envelope: value, key, keyId: 'synthetic-key' });
  const head: SuppressionHeadV7 = {
    formatVersion: 2,
    source,
    clusterId: value.clusterId,
    fromLsn: value.fromLsn,
    throughLsn: value.throughLsn,
    previousHash: null,
    finalLocalHash: value.sha256,
    segments: [
      {
        segmentId: 'synthetic-segment',
        versionId: 'immutable-version',
        sha256: encrypted.sha256,
        byteLength: encrypted.byteLength,
        fromLsn: value.fromLsn,
        throughLsn: value.throughLsn,
        previousHash: null,
        localHash: value.sha256,
      },
    ],
  };
  const bytes = encodeSuppressionHeadV7(head, auth);
  const witness = {
    source,
    clusterId: head.clusterId,
    fromLsn: head.fromLsn,
    throughLsn: head.throughLsn,
    previousHash: null,
    finalLocalHash: value.sha256,
    headVersionId: 'head-version',
    headSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const store = {
    readHead: async () => ({ bytes, versionId: 'head-version' }),
    readSegment: async () => ({ bytes: encrypted.bytes, versionId: 'immutable-version' }),
  };
  return { value, encrypted, head, bytes, witness, store };
}
it('decodes exact V7 physical rows and roundtrips real AESGCM mixed legacy/new records and microseconds', () => {
  const f = fixture();
  expect(
    decryptReplaySegmentV7({ bytes: f.encrypted.bytes, key, expectedKeyId: 'synthetic-key' }),
  ).toEqual(f.value);
  expect(f.value.transactions[0]?.records.map((r) => r.schemaVersion)).toEqual([1, 7]);
  expect(f.value.transactions[0]?.records[1]?.occurredAt).toBe('2026-10-01 12:34:56.123456+00');
  expect(f.encrypted.bytes.includes(Buffer.from(athlete))).toBe(false);
  expect(f.encrypted.bytes.subarray(0, 8).toString()).toBe('WMLEDG02');
  expect(() => decodeSuppressionPgoutputRecords(messages(), '0/100')).toThrow();
  expect(() =>
    decryptReplaySegment({ bytes: f.encrypted.bytes, key, expectedKeyId: 'synthetic-key' }),
  ).toThrow();
});
it('preserves WMLEDG01 and rejects it in explicit V7 decoder', () => {
  const old = {
    localRecordVersion: 1 as const,
    clusterId: '1234567',
    fromLsn: '0/100',
    throughLsn: '0/120',
    previousHash: null,
    transactions: [
      {
        commitLsn: '0/110',
        endLsn: '0/120',
        records: [
          {
            schemaVersion: 1 as const,
            eventId: id,
            athleteId: athlete,
            occurredAt: '2026-10-01 12:34:56.123456+00',
            kind: 'tenant_erased' as const,
          },
        ],
      },
    ],
  };
  const e = { ...old, sha256: createHash('sha256').update(JSON.stringify(old)).digest('hex') };
  const encrypted = encryptReplaySegment({ envelope: e, key, keyId: 'old' });
  expect(decryptReplaySegment({ bytes: encrypted.bytes, key, expectedKeyId: 'old' })).toEqual(e);
  expect(() =>
    decryptReplaySegmentV7({ bytes: encrypted.bytes, key, expectedKeyId: 'old' }),
  ).toThrow();
});
it.each(['key', 'tag', 'header'] as const)('rejects ciphertext %s tamper', (mode) => {
  const f = fixture(),
    bytes = Buffer.from(f.encrypted.bytes);
  if (mode === 'tag') bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
  if (mode === 'header') bytes[20] = (bytes[20] ?? 0) ^ 1;
  expect(() =>
    decryptReplaySegmentV7({
      bytes,
      key: mode === 'key' ? auth : key,
      expectedKeyId: 'synthetic-key',
    }),
  ).toThrow();
});
it('validates HMAC head and immutable objects then returns an opaque factory-bound blocked apply', async () => {
  const f = fixture();
  expect(decodeSuppressionHeadV7(f.bytes, auth)).toEqual(f.head);
  const factory = createSuppressionReplayVerifierV7({
    witness: f.witness,
    encryptionKey: key,
    keyId: 'synthetic-key',
    headAuthenticationKey: auth,
  });
  const verified = await factory.prepareVerifiedSuppressionChainV7(f.store);
  expect(verified).toEqual({
    status: 'verified_local_chain',
    eventCount: 2,
    segmentCount: 1,
    authority: 'none',
    admissionAllowed: false,
    originalEventStage: 'unavailable',
  });
  expect(factory.replayVerifiedSuppressionChainV7In(verified)).toEqual({
    status: 'blocked',
    reason: 'original_event_stage_unavailable',
    eventCount: 2,
    authority: 'none',
    admissionAllowed: false,
  });
  expect(() => factory.replayVerifiedSuppressionChainV7In({ ...verified })).toThrow();
  const other = createSuppressionReplayVerifierV7({
    witness: f.witness,
    encryptionKey: key,
    keyId: 'synthetic-key',
    headAuthenticationKey: auth,
  });
  expect(() => other.replayVerifiedSuppressionChainV7In(verified)).toThrow();
});
it.each(['database', 'slot', 'capture', 'registry', 'cluster', 'version', 'headHash'] as const)(
  'rejects independently expected %s binding mismatch',
  async (mode) => {
    const f = fixture(),
      witness = { ...f.witness, source: { ...source } };
    if (mode === 'database') witness.source.databaseOid++;
    if (mode === 'slot') witness.source.slotName = 'wm_suppression_other';
    if (mode === 'capture') witness.source.captureId = athlete;
    if (mode === 'registry') witness.source.registryFingerprint = 'b'.repeat(64);
    if (mode === 'cluster') witness.clusterId = '7654321';
    if (mode === 'version') witness.headVersionId = 'wrong';
    if (mode === 'headHash') witness.headSha256 = 'b'.repeat(64);
    const factory = createSuppressionReplayVerifierV7({
      witness,
      encryptionKey: key,
      keyId: 'synthetic-key',
      headAuthenticationKey: auth,
    });
    await expect(factory.prepareVerifiedSuppressionChainV7(f.store)).rejects.toThrow();
  },
);
it('rejects wrong immutable object version or bytes and wrong auth key without apply', async () => {
  const f = fixture(),
    factory = createSuppressionReplayVerifierV7({
      witness: f.witness,
      encryptionKey: key,
      keyId: 'synthetic-key',
      headAuthenticationKey: auth,
    });
  await expect(
    factory.prepareVerifiedSuppressionChainV7({
      ...f.store,
      readSegment: async () => ({ bytes: f.encrypted.bytes, versionId: 'latest' }),
    }),
  ).rejects.toThrow();
  await expect(
    factory.prepareVerifiedSuppressionChainV7({
      ...f.store,
      readSegment: async () => ({
        bytes: Buffer.alloc(f.encrypted.byteLength),
        versionId: 'immutable-version',
      }),
    }),
  ).rejects.toThrow();
  expect(() => decodeSuppressionHeadV7(f.bytes, key)).toThrow();
  await expect(
    createSuppressionReplayVerifierV7({
      witness: f.witness,
      encryptionKey: key,
      keyId: 'synthetic-key',
      headAuthenticationKey: key,
    }).prepareVerifiedSuppressionChainV7(f.store),
  ).rejects.toThrow();
});
it('rejects signed reordered/gapped manifests, duplicate original events, unknown identity and partial commit', () => {
  const f = fixture();
  expect(() =>
    encodeSuppressionHeadV7(
      { ...f.head, segments: [{ ...f.head.segments[0], fromLsn: '0/101' }] },
      auth,
    ),
  ).toThrow();
  expect(() => envelope([physical(), physical()])).toThrow();
  expect(() =>
    envelope([
      physical({
        manual_review_v2_source_identity: JSON.stringify({ kind: 'invented', sourceId: id }),
      }),
    ]),
  ).toThrow();
  expect(() =>
    makeLocalReplayRecordEnvelopeV7({
      clusterId: '1234567',
      source,
      fromLsn: '0/100',
      previousHash: null,
      messages: messages().slice(0, -1),
    }),
  ).toThrow();
});
it('clones trusted witness and keys into verifier lifetime before asynchronous untrusted reads', async () => {
  const f = fixture(),
    witness = { ...f.witness, source: { ...source } },
    encryptionKey = Buffer.from(key),
    authenticationKey = Buffer.from(auth);
  const verifier = createSuppressionReplayVerifierV7({
    witness,
    encryptionKey,
    keyId: 'synthetic-key',
    headAuthenticationKey: authenticationKey,
  });
  witness.source.databaseOid++;
  encryptionKey.fill(0);
  authenticationKey.fill(0);
  expect((await verifier.prepareVerifiedSuppressionChainV7(f.store)).eventCount).toBe(2);
});

it('uses exactly one injected verification instant for mixed legacy/V7 future checks', async () => {
  const f = fixture();
  let calls = 0;
  const verifier = createSuppressionReplayVerifierV7({
    witness: f.witness,
    encryptionKey: key,
    keyId: 'synthetic-key',
    headAuthenticationKey: auth,
    now: () => {
      calls++;
      return Date.parse('2026-10-01T12:34:55Z');
    },
  });
  await expect(verifier.prepareVerifiedSuppressionChainV7(f.store)).rejects.toThrow();
  expect(calls).toBe(1);
  const accepted = createSuppressionReplayVerifierV7({
    witness: f.witness,
    encryptionKey: key,
    keyId: 'synthetic-key',
    headAuthenticationKey: auth,
    now: () => {
      calls++;
      return Date.parse('2026-10-01T12:34:57Z');
    },
  });
  await expect(accepted.prepareVerifiedSuppressionChainV7(f.store)).resolves.toMatchObject({
    eventCount: 2,
  });
  expect(calls).toBe(2);
});
it.each([NaN, Infinity, 8640000000000001])(
  'rejects invalid injected verification instant %s before remote reads',
  async (now) => {
    const f = fixture();
    let reads = 0;
    const verifier = createSuppressionReplayVerifierV7({
      witness: f.witness,
      encryptionKey: key,
      keyId: 'synthetic-key',
      headAuthenticationKey: auth,
      now: () => now,
    });
    await expect(
      verifier.prepareVerifiedSuppressionChainV7({
        ...f.store,
        readHead: async () => {
          reads++;
          return null;
        },
      }),
    ).rejects.toThrow();
    expect(reads).toBe(0);
  },
);

// Real crypto with finite in-memory transport/SQL adapters; not an actual PG or remote-stage proof.
function exporterFixture(
  failure: 'none' | 'cipher_readback' | 'head_cas' | 'head_readback' | 'source',
) {
  const pool = new Pool();
  const client = Object.assign(new Client(), { release: vi.fn() });
  vi.spyOn(pool, 'connect').mockImplementation(() => Promise.resolve(client));
  const order: string[] = [];
  let position = '0/100';
  vi.spyOn(client, 'query').mockImplementation(async (query: unknown) => {
    if (typeof query !== 'string') throw new Error('unexpected synthetic query');
    let rows: Record<string, unknown>[];
    if (query.includes('pg_control_system')) rows = [{ system_identifier: '1234567' }];
    else if (query.includes('pg_try_advisory_lock')) rows = [{ acquired: true }];
    else if (query.includes('pg_advisory_unlock')) rows = [{ released: true }];
    else if (query.includes('registry_fingerprint'))
      rows = [
        {
          database_name: source.databaseName,
          database_oid: failure === 'source' ? 1 : source.databaseOid,
          registry_fingerprint: source.registryFingerprint,
        },
      ];
    else if (query.includes('pg_replication_slots'))
      rows = [
        {
          plugin: 'pgoutput',
          slot_type: 'logical',
          database: source.databaseName,
          current_database: source.databaseName,
          active: false,
          temporary: false,
          confirmed_flush_lsn: position,
          wal_status: 'reserved',
        },
      ];
    else if (query.includes('pg_logical_slot_peek_binary_changes'))
      rows = messages().map((data) => ({ data }));
    else if (query.includes('pg_replication_slot_advance')) {
      order.push('ack');
      position = '0/120';
      rows = [{ slot_name: source.slotName, end_lsn: position }];
    } else throw new Error('unexpected synthetic query');
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
  });
  let headBytes = encodeSuppressionHeadV7(
    {
      formatVersion: 2,
      source,
      clusterId: '1234567',
      fromLsn: '0/100',
      throughLsn: '0/100',
      previousHash: null,
      finalLocalHash: null,
      segments: [],
    },
    auth,
  );
  const initialHash = createHash('sha256').update(headBytes).digest('hex');
  let headVersion = 'head-0';
  let cipher = Buffer.alloc(0);
  const store = {
    readHead: async () => {
      order.push('read_head');
      return {
        bytes:
          failure === 'head_readback' && headVersion === 'head-1'
            ? Buffer.from('corrupt')
            : headBytes,
        versionId: headVersion,
      };
    },
    putImmutableSegment: async (bytes: Buffer) => {
      order.push('put_cipher');
      cipher = Buffer.from(bytes);
      return { segmentId: 'synthetic-export', versionId: 'cipher-1' };
    },
    readSegment: async () => {
      order.push('read_cipher');
      return {
        bytes: failure === 'cipher_readback' ? Buffer.from('corrupt') : cipher,
        versionId: 'cipher-1',
      };
    },
    compareAndSetHead: async (expected: string, bytes: Buffer) => {
      order.push('cas_head');
      expect(expected).toBe('head-0');
      if (failure === 'head_cas') throw new Error('synthetic CAS conflict');
      headBytes = Buffer.from(bytes);
      headVersion = 'head-1';
      return { versionId: headVersion };
    },
  };
  const run = () =>
    exportAuthenticatedSuppressionSegmentV7({
      pool,
      source,
      expectedClusterId: '1234567',
      encryptionKey: key,
      keyId: 'synthetic-key',
      headAuthenticationKey: auth,
      store,
      expectedHeadVersionId: 'head-0',
      expectedHeadSha256: initialHash,
    });
  return { run, order, client, pool, position: () => position };
}
it('publishes and exact-readbacks immutable ciphertext and authenticated head before slot ACK', async () => {
  const f = exporterFixture('none');
  try {
    const result = await f.run();
    expect(result.throughLsn).toBe('0/120');
    expect(f.order).toEqual([
      'read_head',
      'put_cipher',
      'read_cipher',
      'cas_head',
      'read_head',
      'ack',
    ]);
    expect(f.position()).toBe('0/120');
    expect(f.client.release).toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.pool.end();
  }
});
it.each(['cipher_readback', 'head_cas', 'head_readback', 'source'] as const)(
  'does not ACK on %s mismatch or uncertain publication',
  async (failure) => {
    const f = exporterFixture(failure);
    try {
      await expect(f.run()).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
      expect(f.order).not.toContain('ack');
      expect(f.position()).toBe('0/100');
    } finally {
      vi.restoreAllMocks();
      await f.pool.end();
    }
  },
);

it('reads verified original envelopes only through the factory callback with exact microseconds and no stage authority', async () => {
  const f = fixture(),
    now = Date.parse('2026-10-08T00:00:00Z');
  const factory = createSuppressionReplayVerifierV7({
    witness: f.witness,
    encryptionKey: key,
    keyId: 'synthetic-key',
    headAuthenticationKey: auth,
    now: () => now,
  });
  const handle = await factory.prepareVerifiedSuppressionChainV7(f.store);
  const result = factory.withVerifiedSuppressionChainV7(handle, (envelopes, limits) => {
    expect(envelopes).toEqual([f.value]);
    expect(envelopes[0]?.transactions[0]?.records.map((record) => record.schemaVersion)).toEqual([
      1, 7,
    ]);
    expect(envelopes[0]?.transactions[0]?.records[1]?.occurredAt).toBe(
      '2026-10-01 12:34:56.123456+00',
    );
    expect(limits).toEqual({
      authority: 'none',
      admissionAllowed: false,
      originalEventStage: 'unavailable',
      witnessFreshness: 'not_rechecked',
      verificationInstant: now,
      eventCount: 2,
      segmentCount: 1,
    });
    return envelopes[0]?.sha256;
  });
  expect(result).toBe(f.value.sha256);
  expect(factory.replayVerifiedSuppressionChainV7In(handle)).toMatchObject({
    status: 'blocked',
    reason: 'original_event_stage_unavailable',
  });
});
it('copied, forged and foreign factory handles cannot execute tail callbacks', async () => {
  const f = fixture(),
    config = {
      witness: f.witness,
      encryptionKey: key,
      keyId: 'synthetic-key',
      headAuthenticationKey: auth,
    };
  const factory = createSuppressionReplayVerifierV7(config),
    other = createSuppressionReplayVerifierV7(config);
  const handle = await factory.prepareVerifiedSuppressionChainV7(f.store);
  let callbacks = 0;
  for (const unknownHandle of [
    undefined,
    null,
    {},
    { ...handle },
    { ...handle, authority: 'restore' },
  ])
    expect(() =>
      Reflect.apply(factory.withVerifiedSuppressionChainV7, factory, [
        unknownHandle,
        () => callbacks++,
      ]),
    ).toThrow('RESTORE_V7_CHAIN_INVALID');
  expect(() => other.withVerifiedSuppressionChainV7(handle, () => callbacks++)).toThrow(
    'RESTORE_V7_CHAIN_INVALID',
  );
  expect(callbacks).toBe(0);
});
it('callback mutations and remote ciphertext buffer mutations cannot change the verified factory snapshot', async () => {
  const f = fixture(),
    factory = createSuppressionReplayVerifierV7({
      witness: f.witness,
      encryptionKey: key,
      keyId: 'synthetic-key',
      headAuthenticationKey: auth,
    });
  const handle = await factory.prepareVerifiedSuppressionChainV7(f.store);
  factory.withVerifiedSuppressionChainV7(handle, (envelopes) => {
    const record = envelopes[0]?.transactions[0]?.records[0];
    if (!record) throw new Error('fixture record missing');
    Object.defineProperty(record, 'occurredAt', { value: 'tampered', writable: true });
    Object.defineProperty(envelopes, '0', { value: null, writable: true });
  });
  f.encrypted.bytes.fill(0);
  f.bytes.fill(0);
  expect(factory.withVerifiedSuppressionChainV7(handle, (envelopes) => envelopes)).toEqual([
    f.value,
  ]);
  expect(factory.withVerifiedSuppressionChainV7(handle, (envelopes) => envelopes)).toEqual([
    f.value,
  ]);
});
it('callback revalidation uses the prepared instant and does not invent monotonic witness freshness', async () => {
  const f = fixture();
  let clockCalls = 0;
  const factory = createSuppressionReplayVerifierV7({
    witness: f.witness,
    encryptionKey: key,
    keyId: 'synthetic-key',
    headAuthenticationKey: auth,
    now: () => {
      if (++clockCalls > 1) throw new Error('freshness policy not provided');
      return Date.parse('2026-10-08T00:00:00Z');
    },
  });
  const handle = await factory.prepareVerifiedSuppressionChainV7(f.store);
  expect(
    factory.withVerifiedSuppressionChainV7(handle, (_, limits) => limits.witnessFreshness),
  ).toBe('not_rechecked');
  expect(clockCalls).toBe(1);
});
it('supports awaited callback results and preserves callback errors without partial replay or remote re-read', async () => {
  const f = fixture(),
    readHead = vi.fn(f.store.readHead),
    readSegment = vi.fn(f.store.readSegment);
  const factory = createSuppressionReplayVerifierV7({
    witness: f.witness,
    encryptionKey: key,
    keyId: 'synthetic-key',
    headAuthenticationKey: auth,
  });
  const handle = await factory.prepareVerifiedSuppressionChainV7({ readHead, readSegment });
  const result = await factory.withVerifiedSuppressionChainV7(handle, async (envelopes) => {
    await Promise.resolve();
    return envelopes[0]?.transactions[0]?.records.length;
  });
  expect(result).toBe(2);
  const domainError = new Error('bounded caller operation failed');
  expect(() =>
    factory.withVerifiedSuppressionChainV7(handle, () => {
      throw domainError;
    }),
  ).toThrow(domainError);
  await expect(
    factory.withVerifiedSuppressionChainV7(handle, async () => {
      throw domainError;
    }),
  ).rejects.toBe(domainError);
  expect(readHead).toHaveBeenCalledTimes(1);
  expect(readSegment).toHaveBeenCalledTimes(1);
});

it('rejects invalid callback boundary before exposing any verified original records', async () => {
  const f = fixture(),
    factory = createSuppressionReplayVerifierV7({
      witness: f.witness,
      encryptionKey: key,
      keyId: 'synthetic-key',
      headAuthenticationKey: auth,
    });
  const handle = await factory.prepareVerifiedSuppressionChainV7(f.store);
  for (const callback of [null, undefined, {}, 'caller JSON'])
    expect(() =>
      Reflect.apply(factory.withVerifiedSuppressionChainV7, factory, [handle, callback]),
    ).toThrow('RESTORE_V7_CHAIN_INVALID');
});
