import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeSuppressionPgoutputRecords,
  decodeSuppressionPgoutputRecordsV7,
  decodeSuppressionPgoutputRecordsV8,
} from '../src/restore-suppression-pgoutput.js';
import { validateSuppressionRecord } from '../src/restore-suppression-records.js';
import {
  decodeSuppressionRecordColumnsV7,
  suppressionRecordColumnNamesV7,
} from '../src/restore-suppression-records-v7.js';
import {
  decodeSuppressionRecordColumnsV8,
  suppressionRecordColumnNamesV8,
  validateSuppressionRecordV8,
} from '../src/restore-suppression-records-v8.js';
import {
  decodeRestoreSuppressionPhysicalRowV7,
  encodeRestoreSuppressionPhysicalRowV7,
} from '../src/restore-suppression-physical-row-v7.js';
import {
  decodeRestoreSuppressionPhysicalRowV8,
  encodeRestoreSuppressionPhysicalRowV8,
} from '../src/restore-suppression-physical-row-v8.js';
import {
  decryptReplaySegmentV7,
  decryptReplaySegmentV8,
  encryptReplaySegmentV8,
  makeLocalReplayRecordEnvelopeV7,
  makeLocalReplayRecordEnvelopeV8,
  type SuppressionSourceBindingV8,
} from '../src/restore-suppression-segment.js';
import {
  createSuppressionReplayVerifierV8,
  decodeSuppressionHeadV8,
  encodeSuppressionHeadV8,
  type SuppressionHeadV8,
} from '../src/restore-suppression-replay-v8.js';
import { decodeSuppressionHeadV7 } from '../src/restore-suppression-replay-v7.js';
import { validateLegacySuppressionRecordsForV7 } from '../src/restore-suppression-replay.js';

// Synthetic SQL145 record-8 rows: structural codec evidence only, never an authenticated event.
const athlete = '0d1e2f30-4a5b-4c6d-8e7f-8091a2b3c4d5';
const album = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const media = '2b3c4d5e-6f70-4b8c-9dae-1f2a3b4c5d6e';
const eventId = (n: number) => `3c4d5e6f-7081-4c9d-8ebf-${n.toString().padStart(12, '0')}`;
const stamp = '2026-10-01 01:02:03.123456+00';
const names = suppressionRecordColumnNamesV8();
function row(values: Record<string, string | null>): Map<string, string | null> {
  const map = new Map<string, string | null>(names.map((name) => [name, null]));
  for (const [key, value] of Object.entries(values)) map.set(key, value);
  return map;
}
const albumRow = (overrides: Record<string, string | null> = {}, n = 1) =>
  row({
    event_id: eventId(n),
    record_version: '8',
    athlete_id: athlete,
    kind: 'gallery_album_deleted',
    occurred_at: stamp,
    target_id: album,
    gallery_access_revision: '3',
    ...overrides,
  });
const mediaRow = (n = 2) =>
  row({
    event_id: eventId(n),
    record_version: '1',
    athlete_id: athlete,
    kind: 'gallery_media_deleted',
    occurred_at: stamp,
    target_id: media,
    gallery_access_revision: '2',
  });
const manualV7Row = (n = 3) =>
  row({
    event_id: eventId(n),
    record_version: '7',
    athlete_id: athlete,
    kind: 'manual_review_source_suppressed_v2',
    occurred_at: stamp,
    manual_review_v2_source_identity: JSON.stringify({
      kind: 'nutrition-plan-version',
      sourceId: media,
      versionId: album,
    }),
    manual_review_v2_version_scope: 'exact_identity',
  });
const albumRecord = {
  schemaVersion: 8,
  eventId: eventId(1),
  athleteId: athlete,
  kind: 'gallery_album_deleted',
  occurredAt: stamp,
  targetId: album,
  galleryAccessRevision: 3,
} as const;

// pgoutput protocol 1 synthetic frames over the unchanged 46-column V7 relation.
const u16 = (v: number) => Buffer.from([v >> 8, v & 255]);
const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v);
  return b;
};
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(v);
  return b;
};
const cstring = (v: string) => Buffer.concat([Buffer.from(v), Buffer.from([0])]);
const uuidColumns = new Set([
  'event_id',
  'target_id',
  'share_id',
  'course_share_id',
  'share_cause_event_id',
  'course_share_audit_id',
  'actual_previous_revision_id',
  'actual_deleted_revision_id',
  'healthkit_claim_epoch',
  'healthkit_operation_id',
]);
const textColumns = new Set([
  'athlete_id',
  'kind',
  'source_kind',
  'source_id',
  'source_content_hash',
  'share_cause_kind',
  'course_share_revoke_reason',
  'manual_review_source_kind',
  'manual_review_source_id',
  'manual_review_version_scope',
  'manual_review_version_key',
  'manual_review_v2_version_scope',
]);
const oid = (name: string) =>
  uuidColumns.has(name)
    ? 2950
    : textColumns.has(name)
      ? 25
      : name === 'occurred_at' || name === 'course_share_audit_occurred_at'
        ? 1184
        : name === 'consent_previous_granted' || name === 'consent_granted'
          ? 16
          : name === 'healthkit_object_scopes' || name === 'manual_review_v2_source_identity'
            ? 3802
            : 23;
function frames(rows: readonly ReadonlyMap<string, string | null>[], commit = 0x110n): Buffer[] {
  return [
    Buffer.concat([Buffer.from('B'), u64(commit), u64(0n), u32(1)]),
    Buffer.concat([
      Buffer.from('R'),
      u32(42),
      cstring('public'),
      cstring('restore_suppression_event'),
      Buffer.from('d'),
      u16(names.length),
      ...names.flatMap((name) => [
        Buffer.from([0]),
        cstring(name),
        u32(oid(name)),
        u32(0xffffffff),
      ]),
    ]),
    ...rows.map((r) =>
      Buffer.concat([
        Buffer.from('I'),
        u32(42),
        Buffer.from('N'),
        u16(names.length),
        ...names.flatMap((name) => {
          const v = r.get(name);
          return v === null || v === undefined
            ? [Buffer.from('n')]
            : [Buffer.from('t'), u32(Buffer.byteLength(v)), Buffer.from(v)];
        }),
      ]),
    ),
    Buffer.concat([Buffer.from('C'), Buffer.from([0]), u64(commit), u64(commit + 0x10n), u64(0n)]),
  ];
}

describe('record 8 column codec', () => {
  it('keeps the unchanged installed116 roster', () => {
    expect(names).toEqual(suppressionRecordColumnNamesV7());
    expect(names).toHaveLength(46);
  });
  it('decodes the exact SQL145 branch with original microseconds', () => {
    expect(decodeSuppressionRecordColumnsV8(albumRow())).toEqual(albumRecord);
    expect(validateSuppressionRecordV8(albumRecord)).toEqual(albumRecord);
  });
  it('decodes records 1-7 exactly as the unchanged V7 decoder', () => {
    for (const r of [mediaRow(), manualV7Row()])
      expect(decodeSuppressionRecordColumnsV8(r)).toEqual(decodeSuppressionRecordColumnsV7(r));
  });
  it('older decoders fail closed on record 8', () => {
    expect(() => decodeSuppressionRecordColumnsV7(albumRow())).toThrow('PGOUTPUT_UNKNOWN_EVENT');
    const legacy = new Map(
      [...albumRow()].filter(
        ([name]) =>
          name !== 'manual_review_v2_source_identity' && name !== 'manual_review_v2_version_scope',
      ),
    );
    expect(() => validateSuppressionRecord(legacy)).toThrow('PGOUTPUT_UNKNOWN_EVENT');
  });
  it.each([
    ['unknown version 9', { record_version: '9' }, 'PGOUTPUT_UNKNOWN_EVENT'],
    ['version 0', { record_version: '0' }, 'PGOUTPUT_UNKNOWN_EVENT'],
    ['album kind on version 1', { record_version: '1' }, 'PGOUTPUT_UNKNOWN_EVENT'],
    ['album kind on version 7', { record_version: '7' }, 'PGOUTPUT_UNKNOWN_EVENT'],
    ['media kind on version 8', { kind: 'gallery_media_deleted' }, 'PGOUTPUT_UNKNOWN_EVENT'],
    ['extra column', { resource_access_revision: '2' }, 'PGOUTPUT_UNEXPECTED_FIELD'],
    ['extra v2 column', { manual_review_v2_version_scope: 'x' }, 'PGOUTPUT_UNEXPECTED_FIELD'],
    ['revision 1', { gallery_access_revision: '1' }, 'PGOUTPUT_INVALID_RECORD'],
    ['revision max', { gallery_access_revision: '2147483647' }, 'PGOUTPUT_INVALID_RECORD'],
    ['revision padded', { gallery_access_revision: '03' }, 'PGOUTPUT_INVALID_RECORD'],
    ['missing revision', { gallery_access_revision: null }, 'PGOUTPUT_INVALID_RECORD'],
    ['missing target', { target_id: null }, 'PGOUTPUT_INVALID_RECORD'],
    ['upper-case target', { target_id: album.toUpperCase() }, 'PGOUTPUT_INVALID_RECORD'],
    ['bad instant', { occurred_at: '2026-02-30 00:00:00+00' }, 'PGOUTPUT_INVALID_RECORD'],
    ['control athlete', { athlete_id: 'a\u0001' }, 'PGOUTPUT_INVALID_RECORD'],
  ] as const)('rejects %s', (_name, overrides, code) => {
    expect(() => decodeSuppressionRecordColumnsV8(albumRow(overrides))).toThrow(code);
  });
  it('rejects a changed roster', () => {
    const missing = albumRow();
    missing.delete('manual_review_v2_version_scope');
    expect(() => decodeSuppressionRecordColumnsV8(missing)).toThrow('PGOUTPUT_SCHEMA_CHANGED');
    const extra = albumRow();
    extra.set('album_extra', null);
    expect(() => decodeSuppressionRecordColumnsV8(extra)).toThrow('PGOUTPUT_SCHEMA_CHANGED');
  });
  it('rejects non-plain or extra-field DTOs', () => {
    expect(() => validateSuppressionRecordV8({ ...albumRecord, extra: 1 })).toThrow();
    expect(() => validateSuppressionRecordV8({ ...albumRecord, schemaVersion: 7 })).toThrow();
    expect(() => validateSuppressionRecordV8(Object.create({ ...albumRecord }))).toThrow();
    const accessor = { ...albumRecord };
    Object.defineProperty(accessor, 'targetId', { get: () => album, enumerable: true });
    expect(() => validateSuppressionRecordV8(accessor)).toThrow();
  });
});

describe('record 8 physical row', () => {
  it('round-trips the album branch through the 46-column row', () => {
    const encoded = encodeRestoreSuppressionPhysicalRowV8(albumRecord);
    expect(Object.keys(encoded)).toHaveLength(46);
    expect(encoded).toMatchObject({
      record_version: 8,
      target_id: album,
      gallery_access_revision: 3,
      occurred_at: '2026-10-01T01:02:03.123456Z',
      resource_access_revision: null,
    });
    expect(decodeRestoreSuppressionPhysicalRowV8(encoded)).toEqual(albumRecord);
  });
  it('delegates records 1-7 to the unchanged V7 codec byte-for-byte', () => {
    for (const r of [mediaRow(), manualV7Row()]) {
      const record = decodeSuppressionRecordColumnsV7(r);
      const v7 = encodeRestoreSuppressionPhysicalRowV7(record);
      expect(JSON.stringify(encodeRestoreSuppressionPhysicalRowV8(record))).toBe(
        JSON.stringify(v7),
      );
      expect(decodeRestoreSuppressionPhysicalRowV8(v7)).toEqual(
        decodeRestoreSuppressionPhysicalRowV7(v7),
      );
    }
  });
  it('V7 physical codec fails closed on record 8', () => {
    const encoded = encodeRestoreSuppressionPhysicalRowV8(albumRecord);
    expect(() => decodeRestoreSuppressionPhysicalRowV7(encoded)).toThrow();
    expect(() => encodeRestoreSuppressionPhysicalRowV7(albumRecord)).toThrow();
  });
  it.each([
    ['extra non-null column', { share_id: album }],
    ['media kind', { kind: 'gallery_media_deleted' }],
    ['offset instant', { occurred_at: '2026-10-01T01:02:03.123456+00:00' }],
    ['string revision', { gallery_access_revision: '3' }],
    ['revision 1', { gallery_access_revision: 1 }],
    ['unknown key', { surprise: null }],
  ])('rejects %s', (_name, overrides) => {
    expect(() =>
      decodeRestoreSuppressionPhysicalRowV8({
        ...encodeRestoreSuppressionPhysicalRowV8(albumRecord),
        ...overrides,
      }),
    ).toThrow();
  });
  it('rejects a missing column and an unknown record version', () => {
    const { target_id: _drop, ...missing } = encodeRestoreSuppressionPhysicalRowV8(albumRecord);
    void _drop;
    expect(() => decodeRestoreSuppressionPhysicalRowV8(missing)).toThrow();
    expect(() =>
      decodeRestoreSuppressionPhysicalRowV8({
        ...encodeRestoreSuppressionPhysicalRowV8(albumRecord),
        record_version: 9,
      }),
    ).toThrow();
  });
});

describe('record 8 pgoutput and V8 envelope', () => {
  const rows = [mediaRow(2), albumRow({}, 1)];
  it('decodes mixed legacy and record 8 under the unchanged profile only through V8', () => {
    expect(decodeSuppressionPgoutputRecordsV8(frames(rows), '0/100')).toEqual([
      { commitLsn: '0/110', endLsn: '0/120', records: rows.map(decodeSuppressionRecordColumnsV8) },
    ]);
    expect(() => decodeSuppressionPgoutputRecordsV7(frames(rows), '0/100')).toThrow(
      'PGOUTPUT_UNKNOWN_EVENT',
    );
    expect(() => decodeSuppressionPgoutputRecords(frames(rows), '0/100')).toThrow();
  });
  const source: SuppressionSourceBindingV8 = {
    databaseName: 'synthetic_db',
    databaseOid: 16384,
    slotName: 'wm_suppression_v8_unit',
    publication: 'workout_restore_suppression_events',
    relationProfile: 'suppression-physical-v8',
    captureId: eventId(90),
    registryFingerprint: 'a'.repeat(64),
  };
  const key = Buffer.alloc(32, 7);
  const auth = Buffer.alloc(32, 9);
  it('V7 envelope can never carry record 8; V8 envelope round-trips through AES-GCM', () => {
    expect(() =>
      makeLocalReplayRecordEnvelopeV7({
        clusterId: '1234567',
        fromLsn: '0/100',
        previousHash: null,
        source: { ...source, relationProfile: 'suppression-physical-v7' },
        messages: frames(rows),
      }),
    ).toThrow('PGOUTPUT_UNKNOWN_EVENT');
    expect(() =>
      makeLocalReplayRecordEnvelopeV8({
        clusterId: '1234567',
        fromLsn: '0/100',
        previousHash: null,
        source: { ...source, relationProfile: 'suppression-physical-v7' } as never,
        messages: frames(rows),
      }),
    ).toThrow('INVALID_ENCRYPTED_SEGMENT');
    const envelope = makeLocalReplayRecordEnvelopeV8({
      clusterId: '1234567',
      fromLsn: '0/100',
      previousHash: null,
      source,
      messages: frames(rows),
    });
    expect(envelope.localRecordVersion).toBe(3);
    const encrypted = encryptReplaySegmentV8({ envelope, key, keyId: 'synthetic-key' });
    expect(encrypted.bytes.subarray(0, 8).toString()).toBe('WMLEDG03');
    expect(
      decryptReplaySegmentV8({ bytes: encrypted.bytes, key, expectedKeyId: 'synthetic-key' }),
    ).toEqual(envelope);
    expect(() =>
      decryptReplaySegmentV7({ bytes: encrypted.bytes, key, expectedKeyId: 'synthetic-key' }),
    ).toThrow('INVALID_ENCRYPTED_SEGMENT');
  });
  it('the V7 semantic guard rejects record 8', () => {
    expect(() => validateLegacySuppressionRecordsForV7([albumRecord], Date.now())).toThrow();
  });

  function fixture(chainRows: readonly ReadonlyMap<string, string | null>[]) {
    const value = makeLocalReplayRecordEnvelopeV8({
      clusterId: '1234567',
      fromLsn: '0/100',
      previousHash: null,
      source,
      messages: frames(chainRows),
    });
    const encrypted = encryptReplaySegmentV8({ envelope: value, key, keyId: 'synthetic-key' });
    const head: SuppressionHeadV8 = {
      formatVersion: 3,
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
    const bytes = encodeSuppressionHeadV8(head, auth);
    const verifier = createSuppressionReplayVerifierV8({
      witness: {
        source,
        clusterId: head.clusterId,
        fromLsn: head.fromLsn,
        throughLsn: head.throughLsn,
        previousHash: null,
        finalLocalHash: value.sha256,
        headVersionId: 'head-version',
        headSha256: createHash('sha256').update(bytes).digest('hex'),
      },
      encryptionKey: key,
      keyId: 'synthetic-key',
      headAuthenticationKey: auth,
    });
    const store = {
      readHead: async () => ({ bytes, versionId: 'head-version' }),
      readSegment: async () => ({ bytes: encrypted.bytes, versionId: 'immutable-version' }),
    };
    return { head, bytes, verifier, store };
  }
  function recorder(result: unknown = 'deleted') {
    const calls: { sql: string; values: unknown[] }[] = [];
    return {
      calls,
      client: {
        query: async (sql: string, values: unknown[] = []) => {
          calls.push({ sql, values });
          return { rows: [{ result }] };
        },
      } as never,
    };
  }
  it('V8 head is a distinct authenticated format', () => {
    const f = fixture(rows);
    expect(decodeSuppressionHeadV8(f.bytes, auth)).toEqual(f.head);
    expect(() => decodeSuppressionHeadV7(f.bytes, auth)).toThrow('RESTORE_V7_CHAIN_INVALID');
    expect(() => encodeSuppressionHeadV8({ ...f.head, formatVersion: 2 }, auth)).toThrow();
  });
  it('replays legacy and record 8 in source order through the exact SQL functions', async () => {
    const f = fixture(rows);
    const prepared = await f.verifier.prepareVerifiedSuppressionChainV8(f.store);
    expect(prepared).toMatchObject({ eventCount: 2, originalEventStage: 'exact_replay' });
    const r = recorder();
    expect(await f.verifier.replayVerifiedSuppressionChainV8In(r.client, prepared)).toEqual({
      status: 'replayed',
      eventCount: 2,
      authority: 'none',
      admissionAllowed: false,
    });
    expect(r.calls).toEqual([
      { sql: "SELECT set_config('app.athlete_id',$1,true)", values: [athlete] },
      {
        sql: 'SELECT public.replay_gallery_media_deletion_exact($1,$2,$3,$4,$5)',
        values: [athlete, media, eventId(2), stamp, 2],
      },
      { sql: "SELECT set_config('app.athlete_id',$1,true)", values: [athlete] },
      {
        sql: 'SELECT public.replay_gallery_album_deletion_exact_v1($1,$2,$3,$4,$5) AS result',
        values: [athlete, album, eventId(1), stamp, 3],
      },
    ]);
  });
  it.each(['recorded_absent', 'already_applied', 'already_applied_by_erasure'])(
    'accepts the %s outcome',
    async (outcome) => {
      const f = fixture([albumRow()]);
      const prepared = await f.verifier.prepareVerifiedSuppressionChainV8(f.store);
      await expect(
        f.verifier.replayVerifiedSuppressionChainV8In(recorder(outcome).client, prepared),
      ).resolves.toMatchObject({ status: 'replayed', eventCount: 1 });
    },
  );
  it('refuses an unexpected SQL outcome', async () => {
    const f = fixture([albumRow()]);
    const prepared = await f.verifier.prepareVerifiedSuppressionChainV8(f.store);
    await expect(
      f.verifier.replayVerifiedSuppressionChainV8In(recorder('applied').client, prepared),
    ).rejects.toThrow('RESTORE_REPLAY_INVALID_RESULT');
  });
  it('blocks a chain holding a record 7 event before any SQL', async () => {
    const f = fixture([albumRow(), manualV7Row()]);
    const prepared = await f.verifier.prepareVerifiedSuppressionChainV8(f.store);
    expect(prepared.originalEventStage).toBe('unavailable');
    const r = recorder();
    expect(await f.verifier.replayVerifiedSuppressionChainV8In(r.client, prepared)).toMatchObject({
      status: 'blocked',
      reason: 'original_event_stage_unavailable',
    });
    expect(r.calls).toEqual([]);
  });
  it('refuses forged handles and non-canonical tenants before SQL', async () => {
    const f = fixture([albumRow()]);
    const prepared = await f.verifier.prepareVerifiedSuppressionChainV8(f.store);
    const r = recorder();
    await expect(
      f.verifier.replayVerifiedSuppressionChainV8In(r.client, { ...prepared }),
    ).rejects.toThrow('RESTORE_V8_CHAIN_INVALID');
    const synthetic = fixture([albumRow({ athlete_id: 'synthetic' })]);
    await expect(
      synthetic.verifier.prepareVerifiedSuppressionChainV8(synthetic.store),
    ).rejects.toThrow();
    expect(r.calls).toEqual([]);
  });
});
