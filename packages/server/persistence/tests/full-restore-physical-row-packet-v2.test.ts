import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  createFullRestorePhysicalRowPacketParserV2,
  fullRestorePhysicalRowPacketCodecV2,
  FullRestorePhysicalRowPacketErrorV2,
} from '../src/full-restore-physical-row-packet-v2.js';
import { fullRestorePhysicalCodecV2 } from '../src/full-restore-physical-codec-v2.js';
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function registration() {
  return {
    schemaVersion: 2,
    physicalCodec: fullRestorePhysicalRowPacketCodecV2,
    schema: 'public',
    relation: 'synthetic',
    columnsSha256: 'a'.repeat(64),
    orderingKey: ['id'],
    columns: [
      {
        schemaVersion: 2,
        physicalCodec: fullRestorePhysicalCodecV2,
        schema: 'public',
        relation: 'synthetic',
        column: 'id',
        pgType: 'int64',
        nullable: false,
        maxBytes: 4096,
        maxElements: 0,
      },
      {
        schemaVersion: 2,
        physicalCodec: fullRestorePhysicalCodecV2,
        schema: 'public',
        relation: 'synthetic',
        column: 'payload',
        pgType: 'jsonb',
        nullable: true,
        maxBytes: 4096,
        maxElements: 0,
      },
    ],
    maxRows: 10,
    maxBytes: 65536,
    maxRowBytes: 32768,
  };
}
function row(key = '9223372036854775807', value: unknown = { kind: 'sql_null' }) {
  return {
    rowVersion: 2,
    columns: [
      { column: 'id', value: { kind: 'int64', value: key } },
      { column: 'payload', value },
    ],
  };
}
function packet(text = JSON.stringify([row()])) {
  const bytes = new Uint8Array(Buffer.from(text));
  return {
    bytes,
    facts: {
      schemaVersion: 2,
      physicalCodec: fullRestorePhysicalRowPacketCodecV2,
      schema: 'public',
      relation: 'synthetic',
      columnsSha256: 'a'.repeat(64),
      orderingKey: ['id'],
      state: text === '[]' ? 'explicit_empty' : 'present',
      rowCount: text === '[]' ? 0 : 1,
      byteLength: bytes.byteLength,
      rowsSha256: hash(bytes),
    },
  };
}
function parse(text: string, count = 1) {
  const input = packet(text);
  return createFullRestorePhysicalRowPacketParserV2(registration()).validate(input.bytes, {
    ...input.facts,
    rowCount: count,
  });
}
function rejects(work: () => unknown, code: string) {
  expect(work).toThrow(code);
}

describe('physical tagged row packet V2', () => {
  it('keeps exact UTF8 bytes, spaces and raw SHA rather than hashing reserialization', () => {
    const text =
      '[ { "columns": [ { "value": { "value":"9223372036854775807", "kind":"int64" }, "column":"id" }, { "column":"payload", "value":{"kind":"sql_null"} } ], "rowVersion":2 } ]';
    const input = packet(text);
    const result = createFullRestorePhysicalRowPacketParserV2(registration()).validate(
      input.bytes,
      input.facts,
    );
    expect(result.rowsSha256).toBe(hash(text));
    expect(result.byteLength).toBe(Buffer.byteLength(text));
    expect(new TextDecoder().decode(result.copyOriginalUtf8())).toBe(text);
    expect(result.rowsSha256).not.toBe(hash(JSON.stringify(JSON.parse(text))));
    input.bytes.fill(0);
    result.copyOriginalUtf8().fill(0);
    expect(hash(result.copyOriginalUtf8())).toBe(hash(text));
    expect(Object.isFrozen(result.rows[0]?.columns)).toBe(true);
    expect(Object.isFrozen(result.rows[0]?.columns[0]?.value)).toBe(true);
  });
  it('distinguishes SQL NULL from opaque JSONB null and preserves huge numeric spelling', () => {
    const opaque =
      '{"large":9007199254740993,"decimal":1.23000,"exponent":1e400,"nested":[null,"한글"]}';
    const result = parse(
      JSON.stringify([row('1', { kind: 'jsonb', text: opaque, sha256: hash(opaque) })]),
    );
    expect(result.rows[0]?.columns[1]?.value).toEqual({
      kind: 'jsonb',
      text: opaque,
      sha256: hash(opaque),
    });
    expect(
      parse(JSON.stringify([row('1', { kind: 'jsonb', text: 'null', sha256: hash('null') })]))
        .rows[0]?.columns[1]?.value.kind,
    ).toBe('jsonb');
    expect(parse(JSON.stringify([row('1')])).rows[0]?.columns[1]?.value.kind).toBe('sql_null');
    rejects(() => parse(JSON.stringify([row('1', null)])), 'PACKET_VALUE_INVALID');
  });
  it('reuses scalar numericdecimal wrappers without narrowing into JS Number', () => {
    const trusted = registration();
    const payloadColumn = trusted.columns[1];
    if (!payloadColumn) throw new Error('fixture_payload_column_required');
    trusted.columns[1] = { ...payloadColumn, pgType: 'numericdecimal' };
    const value = '123456789012345678901234567890.0000010000';
    const input = packet(JSON.stringify([row('1', { kind: 'numericdecimal', value })]));
    const result = createFullRestorePhysicalRowPacketParserV2(trusted).validate(
      input.bytes,
      input.facts,
    );
    expect(result.rows[0]?.columns[1]?.value).toEqual({ kind: 'numericdecimal', value });
  });
  it('rejects duplicate, missing, extra and reordered registered columns', () => {
    const raw = row();
    for (const columns of [
      raw.columns.slice(0, 1),
      [...raw.columns, raw.columns[0]],
      [raw.columns[0], raw.columns[0]],
      [...raw.columns].reverse(),
      [raw.columns[0], { column: 'extra', value: { kind: 'sql_null' } }],
    ])
      rejects(() => parse(JSON.stringify([{ ...raw, columns }])), 'PACKET_COLUMNS_INVALID');
  });
  it('rejects duplicate escaped JSON keys and lossy outer numeric tokens before JSON.parse', () => {
    const text = JSON.stringify([row()]);
    rejects(
      () => parse(text.replace('"rowVersion":2', '"rowVersion":2,"rowVersion":2')),
      'PACKET_JSON_INVALID',
    );
    rejects(
      () => parse(text.replace('"column":"id"', '"column":"id","\\u0063olumn":"id"')),
      'PACKET_JSON_INVALID',
    );
    rejects(
      () => parse(text.replace('"rowVersion":2', '"rowVersion":2.0000000000000001')),
      'PACKET_VALUE_INVALID',
    );
    rejects(
      () => parse(text.replace('"rowVersion":2', '"rowVersion":9007199254740993')),
      'PACKET_VALUE_INVALID',
    );
  });
  it('checks scalar type/range/nullability/digest errors using finite packet errors', () => {
    for (const raw of [
      { ...row(), columns: [{ column: 'id', value: { kind: 'sql_null' } }, row().columns[1]] },
      row('9223372036854775808'),
      row('1', { kind: 'text', value: 'wrong type' }),
      row('1', { kind: 'jsonb', text: 'null', sha256: '0'.repeat(64) }),
      row('1', { kind: 'jsonb', text: '{bad}', sha256: hash('{bad}') }),
    ])
      rejects(() => parse(JSON.stringify([raw])), 'PACKET_VALUE_INVALID');
  });
  it('requires exact explicit-empty bytes/count/hash/state and refuses present-empty', () => {
    const input = packet('[]');
    const parser = createFullRestorePhysicalRowPacketParserV2(registration());
    expect(parser.validate(input.bytes, input.facts).rowCount).toBe(0);
    rejects(
      () => parser.validate(input.bytes, { ...input.facts, state: 'present' }),
      'PACKET_FACTS_INVALID',
    );
    const whitespace = packet('[ ]');
    rejects(
      () =>
        parser.validate(whitespace.bytes, {
          ...whitespace.facts,
          state: 'explicit_empty',
          rowCount: 0,
        }),
      'PACKET_FACTS_INVALID',
    );
    rejects(
      () => parser.validate(input.bytes, { ...input.facts, rowCount: 1 }),
      'PACKET_FACTS_INVALID',
    );
  });
  it('rejects relation/hash/key/facts mismatch and archive descriptors/rank authority fields', () => {
    const input = packet();
    const parser = createFullRestorePhysicalRowPacketParserV2(registration());
    for (const patch of [
      { relation: 'foreign' },
      { columnsSha256: 'b'.repeat(64) },
      { orderingKey: ['payload'] },
      { rowsSha256: '0'.repeat(64) },
      { byteLength: input.bytes.byteLength + 1 },
      { rowCount: 2 },
      { physicalCodec: 'postgres-row-jsonb-utc-v1' },
      { columns: registration().columns },
      { rank: 1 },
      { nativeOrderVerified: true },
    ])
      rejects(
        () => parser.validate(input.bytes, { ...input.facts, ...patch }),
        'PACKET_FACTS_INVALID',
      );
    rejects(() => parse(JSON.stringify([{ ...row(), rank: 1 }])), 'PACKET_COLUMNS_INVALID');
  });
  it('rejects unsafe/getter/sparse/duplicate registration without invoking accessors', () => {
    const getter = vi.fn(() => 10);
    const unsafe = Object.defineProperty(registration(), 'maxRows', {
      enumerable: true,
      get: getter,
    });
    rejects(
      () => createFullRestorePhysicalRowPacketParserV2(unsafe),
      'PACKET_REGISTRATION_INVALID',
    );
    for (const raw of [
      { ...registration(), maxRows: Number.MAX_SAFE_INTEGER + 1 },
      { ...registration(), columns: [registration().columns[0], registration().columns[0]] },
      { ...registration(), columns: new Array(2) },
      { ...registration(), orderingKey: ['missing'] },
      { ...registration(), orderingKey: ['payload'] },
      {
        ...registration(),
        columns: registration().columns.map((c) => ({ ...c, relation: 'other' })),
      },
      {
        ...registration(),
        columns: registration().columns.map((c) => ({ ...c, pgType: 'unsupported' })),
      },
    ])
      rejects(() => createFullRestorePhysicalRowPacketParserV2(raw), 'PACKET_REGISTRATION_INVALID');
    const input = packet();
    const facts = Object.defineProperty({ ...input.facts }, 'rowsSha256', {
      enumerable: true,
      get: getter,
    });
    rejects(
      () => createFullRestorePhysicalRowPacketParserV2(registration()).validate(input.bytes, facts),
      'PACKET_FACTS_INVALID',
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it('copies registration so subsequent caller mutation cannot change columns or bounds', () => {
    const trusted = registration();
    const parser = createFullRestorePhysicalRowPacketParserV2(trusted);
    const idColumn = trusted.columns[0];
    if (!idColumn) throw new Error('fixture_id_column_required');
    idColumn.column = 'mutated';
    trusted.orderingKey[0] = 'payload';
    trusted.maxRows = 0;
    const input = packet();
    expect(parser.validate(input.bytes, input.facts).columnNames).toEqual(['id', 'payload']);
  });
  it('checks actual whole/row/count/depth caps and escaped/multibyte UTF8 costs', () => {
    const text = JSON.stringify([
      row('1', {
        kind: 'jsonb',
        text: JSON.stringify('한'.repeat(100)),
        sha256: hash(JSON.stringify('한'.repeat(100))),
      }),
    ]);
    const input = packet(text);
    rejects(
      () =>
        createFullRestorePhysicalRowPacketParserV2({
          ...registration(),
          maxBytes: input.bytes.byteLength - 1,
          maxRowBytes: input.bytes.byteLength - 1,
        }).validate(input.bytes, input.facts),
      'PACKET_BOUND_EXCEEDED',
    );
    rejects(
      () =>
        createFullRestorePhysicalRowPacketParserV2({ ...registration(), maxRowBytes: 50 }).validate(
          input.bytes,
          input.facts,
        ),
      'PACKET_BOUND_EXCEEDED',
    );
    const many = packet(JSON.stringify([row('1'), row('2')]));
    rejects(
      () =>
        createFullRestorePhysicalRowPacketParserV2({ ...registration(), maxRows: 1 }).validate(
          many.bytes,
          { ...many.facts, rowCount: 2 },
        ),
      'PACKET_BOUND_EXCEEDED',
    );
    rejects(() => parse('['.repeat(65) + ']'.repeat(65)), 'PACKET_BOUND_EXCEEDED');
  });
  it('rejects malformed UTF8/BOM/JSON and Buffer/partial/shared/resizable byte storage', () => {
    const parser = createFullRestorePhysicalRowPacketParserV2(registration());
    const input = packet();
    rejects(() => parser.validate(Buffer.from(input.bytes), input.facts), 'PACKET_INPUT_INVALID');
    const large = new Uint8Array(input.bytes.byteLength + 2);
    large.set(input.bytes, 1);
    rejects(() => parser.validate(large.subarray(1, -1), input.facts), 'PACKET_INPUT_INVALID');
    rejects(
      () =>
        parser.validate(new Uint8Array(new SharedArrayBuffer(input.bytes.byteLength)), input.facts),
      'PACKET_INPUT_INVALID',
    );
    const resizable: unknown = Reflect.construct(ArrayBuffer, [
      input.bytes.byteLength,
      { maxByteLength: 65536 },
    ]);
    if (!(resizable instanceof ArrayBuffer)) throw new Error('fixture_array_buffer_required');
    rejects(() => parser.validate(new Uint8Array(resizable), input.facts), 'PACKET_INPUT_INVALID');
    const extra = new Uint8Array(input.bytes);
    Object.defineProperty(extra, 'private', { value: 'secret' });
    rejects(() => parser.validate(extra, input.facts), 'PACKET_INPUT_INVALID');
    for (const bytes of [new Uint8Array([255, 255]), new Uint8Array([239, 187, 191, 91, 93])])
      rejects(
        () =>
          parser.validate(bytes, {
            ...input.facts,
            byteLength: bytes.byteLength,
            rowsSha256: hash(bytes),
          }),
        'PACKET_ENCODING_INVALID',
      );
    rejects(() => parse('[{bad}]'), 'PACKET_JSON_INVALID');
  });
  it('rejects exact physical key duplicates without certifying native order/equality/domain', () => {
    rejects(
      () =>
        parse(
          JSON.stringify([
            row('1'),
            row('1', { kind: 'jsonb', text: 'null', sha256: hash('null') }),
          ]),
          2,
        ),
      'PACKET_DUPLICATE_KEY',
    );
    const result = parse(JSON.stringify([row('2'), row('1')]), 2);
    expect(result).toMatchObject({
      authority: 'none',
      admissionAllowed: false,
      nativeOrderVerification: 'not_checked',
      nativeUniquenessVerification: 'not_checked',
      nativeCanonicalVerification: 'not_checked',
      domainValidation: 'not_checked',
    });
    expect(result.rows).toHaveLength(2);
    expect(result).toBeInstanceOf(Object);
    expect(new FullRestorePhysicalRowPacketErrorV2('PACKET_VALUE_INVALID').message).toBe(
      'PACKET_VALUE_INVALID',
    );
  });
});
