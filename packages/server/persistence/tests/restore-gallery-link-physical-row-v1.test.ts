import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGalleryLinkPhysicalPacketParserV1 } from '../src/restore-gallery-link-physical-row-v1.js';
const event = '11111111-1111-1111-1111-111111111111';
const media = '22222222-2222-2222-2222-222222222222';
const album = '33333333-3333-3333-3333-333333333333';
const headerLayout = [
  ['source_event_id', 'uuid', false, 36],
  ['athlete_id', 'text', false, 800],
  ['kind', 'text', false, 20],
  ['idempotency_key', 'text', false, 128],
  ['request_digest', 'text', false, 64],
  ['album_id', 'uuid', true, 36],
  ['deleted_revision', 'int32', true, 11],
  ['occurred_at', 'timestamptzUTC6', false, 36],
  ['affected_count', 'int32', false, 11],
] as const;
const childLayout = [
  ['source_event_id', 'uuid', false, 36],
  ['athlete_id', 'text', false, 800],
  ['kind', 'text', false, 20],
  ['idempotency_key', 'text', false, 128],
  ['media_item_id', 'uuid', false, 36],
  ['expected_access_revision', 'int32', false, 11],
  ['access_revision', 'int32', false, 11],
  ['album_id', 'uuid', true, 36],
  ['course_id', 'uuid', true, 36],
  ['course_revision', 'int32', true, 11],
  ['revision_id', 'uuid', true, 36],
] as const;
function config(child = false) {
  const relation = child ? 'gallery_link_postimage_draft' : 'gallery_link_event_draft';
  return {
    schemaVersion: 2,
    physicalCodec: 'postgres-tagged-row-packet-v2',
    schema: 'public',
    relation,
    columnsSha256: 'a'.repeat(64),
    orderingKey: ['athlete_id', 'kind', 'idempotency_key', ...(child ? ['media_item_id'] : [])],
    columns: (child ? childLayout : headerLayout).map(([column, pgType, nullable, maxBytes]) => ({
      schemaVersion: 2,
      physicalCodec: 'postgres-lossless-physical-value-v2',
      schema: 'public',
      relation,
      column,
      pgType,
      nullable,
      maxBytes,
      maxElements: 0,
    })),
    maxRows: 100,
    maxBytes: 16777216,
    maxRowBytes: 4194304,
  };
}
function values(child = false): Record<string, string | null> {
  return child
    ? {
        source_event_id: event,
        athlete_id: 'synthetic-owner',
        kind: 'membership_postimage',
        idempotency_key: 'synthetic:key',
        media_item_id: media,
        expected_access_revision: '1',
        access_revision: '2',
        album_id: null,
        course_id: null,
        course_revision: null,
        revision_id: null,
      }
    : {
        source_event_id: event,
        athlete_id: 'synthetic-owner',
        kind: 'membership_postimage',
        idempotency_key: 'synthetic:key',
        request_digest: 'b'.repeat(64),
        album_id: null,
        deleted_revision: null,
        occurred_at: '2026-10-10T00:00:00.123456Z',
        affected_count: '1',
      };
}
function row(child = false, data = values(child)) {
  return {
    rowVersion: 2,
    columns: (child ? childLayout : headerLayout).map(([column, type]) => ({
      column,
      value: data[column] === null ? { kind: 'sql_null' } : { kind: type, value: data[column] },
    })),
  };
}
function wire(child = false, rows: unknown[] = [row(child)], text?: string) {
  const bytes = new TextEncoder().encode(text ?? JSON.stringify(rows));
  const c = config(child);
  return {
    bytes,
    facts: {
      schemaVersion: 2,
      physicalCodec: 'postgres-tagged-row-packet-v2',
      schema: 'public',
      relation: c.relation,
      columnsSha256: c.columnsSha256,
      orderingKey: c.orderingKey,
      state: rows.length ? 'present' : 'explicit_empty',
      rowCount: rows.length,
      byteLength: bytes.length,
      rowsSha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
function decode(child = false, data = values(child)) {
  const w = wire(child, [row(child, data)]);
  return createGalleryLinkPhysicalPacketParserV1(config(child)).validate(w.bytes, w.facts);
}
describe('draft Gallery native family packet', () => {
  it('decodes header9 and child11 separately without authority', () => {
    const h = decode();
    const c = decode(true);
    expect(h.family).toBe('header');
    expect(c.family).toBe('child');
    if (h.family === 'header') expect(h.rows[0]?.source_event_id).toBe(event);
    if (c.family === 'child') {
      const { source_event_id: omitted, ...expected } = values(true);
      expect(omitted).toBe(event);
      expect(c.rows[0]).toEqual({
        source_event_id: event,
        child: { ...expected, expected_access_revision: 1, access_revision: 2 },
      });
    }
    expect(c).toMatchObject({
      authority: 'none',
      authenticated: false,
      admissionAllowed: false,
      nativeOrderVerification: 'not_checked',
      sourceCommitVerification: 'not_checked',
      groupClosureVerification: 'not_checked',
    });
  });
  it('retains original packet whitespace and exact SHA independently of DTO JSON', () => {
    const text = ' \n' + JSON.stringify([row()]) + '\t ';
    const w = wire(false, [row()], text);
    const p = createGalleryLinkPhysicalPacketParserV1(config()).validate(w.bytes, w.facts);
    expect(p.rowsSha256).toBe(w.facts.rowsSha256);
    expect(p.copyOriginalUtf8()).toEqual(w.bytes);
    w.bytes.fill(0);
    expect(new TextDecoder().decode(p.copyOriginalUtf8())).toBe(text);
    const copy = p.copyOriginalUtf8();
    copy.fill(0);
    expect(new TextDecoder().decode(p.copyOriginalUtf8())).toBe(text);
  });
  it('accepts explicit empty transfer without certifying complete group', () => {
    const w = wire(false, []);
    const p = createGalleryLinkPhysicalPacketParserV1(config()).validate(w.bytes, w.facts);
    expect(p.rowCount).toBe(0);
    expect(p.groupClosureVerification).toBe('not_checked');
  });
  it('keeps int32 group count above transfer cap', () => {
    const p = decode(false, {
      ...values(),
      kind: 'album_deleted',
      album_id: album,
      deleted_revision: '2',
      affected_count: '2147483647',
    });
    expect(p.family === 'header' && p.rows[0]?.affected_count).toBe(2147483647);
  });
  it.each([
    '4714-11-24T00:00:00.000000Z BC',
    '0001-02-29T12:34:56.000001Z BC',
    '10000-01-01T00:00:00.000001Z',
    '294276-12-31T23:59:59.999999Z',
  ])('retains finite UTC6 %s', (occurred_at) => {
    const p = decode(false, { ...values(), occurred_at });
    expect(p.family === 'header' && p.rows[0]?.occurred_at).toBe(occurred_at);
  });
  it.each([
    'infinity',
    '-infinity',
    '4714-11-23T23:59:59.999999Z BC',
    '294277-01-01T00:00:00.000000Z',
    '0000-01-01T00:00:00.000000Z',
    '2025-02-29T00:00:00.000000Z',
    '2026-10-10T00:00:00.123Z',
    '2026-10-10T00:00:00.123456+00:00',
  ])('rejects nonfinite or invalid UTC6 %s', (occurred_at) =>
    expect(() => decode(false, { ...values(), occurred_at })).toThrow(),
  );
  it.each(['01', '+1', '-0', '1e0', '2147483648', '-1'])(
    'rejects noncanonical/domain int32 %s',
    (affected_count) => expect(() => decode(false, { ...values(), affected_count })).toThrow(),
  );
  it('preserves saved unavailable course tuple without availability invention', () => {
    const p = decode(true, {
      ...values(true),
      course_id: album,
      course_revision: '7',
      revision_id: event,
    });
    expect(p.family === 'child' && p.rows[0]?.child.course_revision).toBe(7);
    expect(p.rows[0]).not.toHaveProperty('available');
  });
  it.each([{ course_id: album }, { course_revision: '2' }, { revision_id: event }])(
    'rejects partial nullable course tuple %j',
    (partial) => expect(() => decode(true, { ...values(true), ...partial })).toThrow(),
  );
  it('rejects revision gaps and album deletion attached membership', () => {
    expect(() => decode(true, { ...values(true), access_revision: '3' })).toThrow();
    expect(() =>
      decode(true, { ...values(true), kind: 'album_deleted', album_id: album }),
    ).toThrow();
  });
  it.each(['UPPER-UUID', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', event.replaceAll('-', '')])(
    'rejects nonnative UUID %s',
    (source_event_id) => {
      expect(() => decode(false, { ...values(), source_event_id })).toThrow();
    },
  );
  it('rejects wrong schema/type/nullability/key/columns and legacy suppression relation', () => {
    for (const mutate of [
      (c: ReturnType<typeof config>) => {
        c.schema = 'identity_private';
      },
      (c: ReturnType<typeof config>) => {
        const first = c.columns[0];
        if (!first) throw Error('fixture');
        first.pgType = 'text';
      },
      (c: ReturnType<typeof config>) => {
        const first = c.columns[0];
        if (!first) throw Error('fixture');
        first.nullable = true;
      },
      (c: ReturnType<typeof config>) => {
        c.orderingKey.reverse();
      },
      (c: ReturnType<typeof config>) => {
        c.columns.reverse();
      },
      (c: ReturnType<typeof config>) => {
        c.relation = 'restore_suppression_event';
      },
    ]) {
      const c = config();
      mutate(c);
      expect(() => createGalleryLinkPhysicalPacketParserV1(c)).toThrow();
    }
  });
  it('rejects registration and facts accessors without invoking getter', () => {
    let calls = 0;
    const c = config();
    Object.defineProperty(c, 'relation', {
      enumerable: true,
      get() {
        calls++;
        return 'gallery_link_event_draft';
      },
    });
    expect(() => createGalleryLinkPhysicalPacketParserV1(c)).toThrow();
    const w = wire();
    Object.defineProperty(w.facts, 'relation', {
      enumerable: true,
      get() {
        calls++;
        return 'gallery_link_event_draft';
      },
    });
    expect(() =>
      createGalleryLinkPhysicalPacketParserV1(config()).validate(w.bytes, w.facts),
    ).toThrow();
    expect(calls).toBe(0);
  });
  it('rejects Buffer, subview, shared buffer, array and exotic raw-byte shape', () => {
    const w = wire();
    for (const bytes of [
      Buffer.from(w.bytes),
      w.bytes.subarray(1),
      new Uint8Array(new SharedArrayBuffer(w.bytes.length)),
      Array.from(w.bytes),
      Object.create(w.bytes),
    ])
      expect(() =>
        createGalleryLinkPhysicalPacketParserV1(config()).validate(bytes, w.facts),
      ).toThrow();
  });
  it('rejects byte/SHA drift and malformed UTF8/BOM', () => {
    const w = wire();
    const drift = new Uint8Array(w.bytes);
    drift[1] = 0;
    expect(() =>
      createGalleryLinkPhysicalPacketParserV1(config()).validate(drift, w.facts),
    ).toThrow();
    for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xef, 0xbb, 0xbf, 91, 93])]) {
      const facts = {
        ...w.facts,
        byteLength: bytes.length,
        rowsSha256: createHash('sha256').update(bytes).digest('hex'),
      };
      expect(() =>
        createGalleryLinkPhysicalPacketParserV1(config()).validate(bytes, facts),
      ).toThrow();
    }
  });
  it('rejects duplicate JSON keys, duplicate row PK, reordered or extra columns', () => {
    const w = wire(
      false,
      [row()],
      JSON.stringify([row()]).replace('"rowVersion":2', '"rowVersion":2,"rowVersion":2'),
    );
    expect(() =>
      createGalleryLinkPhysicalPacketParserV1(config()).validate(w.bytes, w.facts),
    ).toThrow();
    const duplicate = wire(false, [row(), row()]);
    expect(() =>
      createGalleryLinkPhysicalPacketParserV1(config()).validate(duplicate.bytes, duplicate.facts),
    ).toThrow();
    for (const columns of [
      [...row().columns].reverse(),
      [...row().columns, { column: 'token', value: { kind: 'text', value: 'synthetic' } }],
    ]) {
      const packet = wire(false, [{ rowVersion: 2, columns }]);
      expect(() =>
        createGalleryLinkPhysicalPacketParserV1(config()).validate(packet.bytes, packet.facts),
      ).toThrow();
    }
  });
  it('rejects exotic registration/facts and native byte accessor without getter invocation', () => {
    const c: unknown = Object.assign(Object.create(null), config());
    expect(() => createGalleryLinkPhysicalPacketParserV1(c)).toThrow();
    const w = wire();
    const facts: unknown = Object.assign(Object.create(null), w.facts);
    expect(() =>
      createGalleryLinkPhysicalPacketParserV1(config()).validate(w.bytes, facts),
    ).toThrow();
    let calls = 0;
    Object.defineProperty(w.bytes, 'byteLength', {
      get() {
        calls++;
        return 1;
      },
    });
    expect(() =>
      createGalleryLinkPhysicalPacketParserV1(config()).validate(w.bytes, w.facts),
    ).toThrow();
    expect(calls).toBe(0);
  });
  it('captures independent descriptors without subsequent caller mutation', () => {
    const c = config();
    const parser = createGalleryLinkPhysicalPacketParserV1(c);
    c.relation = 'restore_suppression_event';
    c.orderingKey.reverse();
    const first = c.columns[0];
    if (!first) throw Error('fixture');
    first.pgType = 'text';
    const w = wire();
    expect(parser.validate(w.bytes, w.facts).family).toBe('header');
  });
  it('rejects per-transfer rows101 and narrowed byte bound without capping group count', () => {
    const w = wire(
      false,
      Array.from({ length: 101 }, (_, i) =>
        row(false, { ...values(), idempotency_key: `synthetic:${i}` }),
      ),
    );
    expect(() =>
      createGalleryLinkPhysicalPacketParserV1(config()).validate(w.bytes, w.facts),
    ).toThrow();
    const c = { ...config(), maxBytes: 2, maxRowBytes: 2 };
    const one = wire();
    expect(() =>
      createGalleryLinkPhysicalPacketParserV1(c).validate(one.bytes, one.facts),
    ).toThrow();
  });
});
