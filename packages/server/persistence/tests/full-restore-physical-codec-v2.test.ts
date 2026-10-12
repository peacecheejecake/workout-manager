import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createFullRestorePhysicalCodecV2,
  fullRestorePhysicalCodecV2,
  type FullRestorePhysicalDescriptorV2,
} from '../src/full-restore-physical-codec-v2.js';
function descriptor(
  pgType: FullRestorePhysicalDescriptorV2['pgType'],
  changes: Partial<FullRestorePhysicalDescriptorV2> = {},
) {
  return {
    schemaVersion: 2,
    physicalCodec: fullRestorePhysicalCodecV2,
    schema: 'public',
    relation: 'synthetic',
    column: 'value',
    pgType,
    nullable: true,
    maxBytes: 4096,
    maxElements: 100,
    ...changes,
  };
}
function codec(
  pgType: FullRestorePhysicalDescriptorV2['pgType'],
  changes: Partial<FullRestorePhysicalDescriptorV2> = {},
) {
  return createFullRestorePhysicalCodecV2(descriptor(pgType, changes));
}
function jsonb(text: string) {
  return { kind: 'jsonb', text, sha256: createHash('sha256').update(text).digest('hex') };
}
describe('postgres-lossless-physical-value-v2', () => {
  it('keeps every scalar representation without lossy numeric conversion', () => {
    const values = [
      { kind: 'text', value: '줄바꿈\n"한글"' },
      { kind: 'name', value: 'column_name' },
      { kind: 'uuid', value: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      { kind: 'int32', value: '-2147483648' },
      { kind: 'int64', value: '9223372036854775807' },
      { kind: 'numericdecimal', value: '123456789012345678901234567890.0000010000' },
      { kind: 'boolean', value: false },
      { kind: 'date', value: '2024-02-29' },
      { kind: 'timestamptzUTC6', value: '2026-10-09T23:59:59.999999Z' },
      { kind: 'bytea', hex: '0000ff80' },
      { kind: 'float8sendbits', sendBits: '8000000000000000' },
    ] as const;
    for (const value of values) expect(codec(value.kind).validate(value).value).toEqual(value);
  });
  it('separates SQL NULL, JSONB null, empty text and explicit empty arrays', () => {
    expect(codec('jsonb').validate({ kind: 'sql_null' }).value).toEqual({ kind: 'sql_null' });
    expect(codec('jsonb').validate(jsonb('null')).value).toEqual(jsonb('null'));
    expect(codec('text').validate({ kind: 'text', value: '' }).value).toEqual({
      kind: 'text',
      value: '',
    });
    expect(
      codec('uuid[]').validate({ kind: 'uuid[]', dimensions: [], elements: [] }).value,
    ).toEqual({ kind: 'uuid[]', dimensions: [], elements: [] });
    expect(() => codec('text', { nullable: false }).validate({ kind: 'sql_null' })).toThrow(
      'PHYSICAL_TYPE_MISMATCH',
    );
  });
  it('owns opaque UTF8 bytes and preserves numeric spelling without domain/native authority', () => {
    const input = jsonb('{"large":9007199254740993,"decimal":1.23000,"nested":[null,"한글"]}');
    const result = codec('jsonb').validate(input);
    input.text = 'null';
    input.sha256 = '0'.repeat(64);
    const first = result.copyOpaqueJsonbUtf8();
    expect(first).not.toBeNull();
    first?.fill(0);
    expect(new TextDecoder().decode(result.copyOpaqueJsonbUtf8() ?? new Uint8Array())).toContain(
      '9007199254740993',
    );
    expect(result).toMatchObject({
      processingAuthority: 'none',
      admission: false,
      nativeCanonicalVerification: 'not_checked',
      domainValidation: 'not_checked',
    });
    expect(Object.isFrozen(result.value)).toBe(true);
  });
  it('preserves dimensions, negative lower bounds, null elements and inet prefixes', () => {
    const input = {
      kind: 'inet[]',
      dimensions: [
        { lowerBound: -5, length: 2 },
        { lowerBound: 3, length: 2 },
      ],
      elements: ['192.0.2.1/24', null, '2001:db8::1/64', '192.0.2.2/32'],
    };
    const result = codec('inet[]').validate(input);
    input.dimensions[0] = { lowerBound: 0, length: 1 };
    input.elements[0] = 'bad';
    expect(result.value).toEqual({
      kind: 'inet[]',
      dimensions: [
        { lowerBound: -5, length: 2 },
        { lowerBound: 3, length: 2 },
      ],
      elements: ['192.0.2.1/24', null, '2001:db8::1/64', '192.0.2.2/32'],
    });
    expect(Object.isFrozen(result.value)).toBe(true);
    if (result.value.kind === 'inet[]') expect(Object.isFrozen(result.value.elements)).toBe(true);
  });
  it('retains distinct NaN payloads, signed zero and infinities as native send bits', () => {
    for (const sendBits of [
      '0000000000000000',
      '8000000000000000',
      '7ff0000000000000',
      'fff0000000000000',
      '7ff8000000000001',
      '7ff8000000000002',
    ]) {
      expect(codec('float8sendbits').validate({ kind: 'float8sendbits', sendBits }).value).toEqual({
        kind: 'float8sendbits',
        sendBits,
      });
    }
    expect(() =>
      codec('float8sendbits').validate({ kind: 'float8sendbits', sendBits: 'NaN' }),
    ).toThrow();
  });
  it('validates integer range, decimal format, calendar and exact UTC microseconds', () => {
    for (const [kind, value] of [
      ['int32', '2147483648'],
      ['int64', '9223372036854775808'],
      ['int64', '01'],
      ['numericdecimal', '1e3'],
      ['date', '2023-02-29'],
      ['date', '0000-01-01'],
      ['timestamptzUTC6', '2026-10-09T23:59:59.999Z'],
      ['timestamptzUTC6', '2026-10-09T23:59:59.999999+00:00'],
    ] as const) {
      expect(() => codec(kind).validate({ kind, value })).toThrow('PHYSICAL_VALUE_INVALID');
    }
    for (const value of ['infinity', '-infinity', '0001-01-01 BC', '10000-01-01'])
      expect(codec('date').validate({ kind: 'date', value }).value).toEqual({
        kind: 'date',
        value,
      });
  });
  it('rejects physical type mismatch, unknown keys/version and archive-configured authority', () => {
    expect(() => codec('text').validate({ kind: 'name', value: 'a' })).toThrow(
      'PHYSICAL_TYPE_MISMATCH',
    );
    expect(() => codec('text').validate({ kind: 'text', value: 'a', authority: true })).toThrow(
      'PHYSICAL_VALUE_INVALID',
    );
    expect(() =>
      createFullRestorePhysicalCodecV2({ ...descriptor('text'), schemaVersion: 1 }),
    ).toThrow('PHYSICAL_DESCRIPTOR_INVALID');
    expect(() =>
      createFullRestorePhysicalCodecV2({ ...descriptor('text'), trusted: true }),
    ).toThrow('PHYSICAL_DESCRIPTOR_INVALID');
    expect(() =>
      codec('int64').validate({ kind: 'int64', value: Number('9007199254740993') }),
    ).toThrow('PHYSICAL_VALUE_INVALID');
  });
  it('rejects getter/cycle/proxy inputs without executing getters or throwing raw errors', () => {
    let called = 0;
    const input = {
      kind: 'text',
      get value() {
        called++;
        return 'a';
      },
    };
    expect(() => codec('text').validate(input)).toThrow('PHYSICAL_VALUE_INVALID');
    expect(called).toBe(0);
    const cycle: Record<string, unknown> = { kind: 'text' };
    cycle.value = cycle;
    expect(() => codec('text').validate(cycle)).toThrow('PHYSICAL_VALUE_INVALID');
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private');
        },
      },
    );
    expect(() => createFullRestorePhysicalCodecV2(proxy)).toThrow('PHYSICAL_DESCRIPTOR_INVALID');
  });
  it('enforces UTF8 bounds, name byte bound, scalar syntax and well-formed Unicode', () => {
    expect(() => codec('text', { maxBytes: 3 }).validate({ kind: 'text', value: '한글' })).toThrow(
      'PHYSICAL_BOUND_EXCEEDED',
    );
    expect(() => codec('name').validate({ kind: 'name', value: '한'.repeat(22) })).toThrow(
      'PHYSICAL_VALUE_INVALID',
    );
    for (const value of ['\ud800', '\udc00', 'a\0b'])
      expect(() => codec('text').validate({ kind: 'text', value })).toThrow(
        'PHYSICAL_VALUE_INVALID',
      );
    expect(() => codec('bytea').validate({ kind: 'bytea', hex: '0ff' })).toThrow(
      'PHYSICAL_VALUE_INVALID',
    );
    expect(() => codec('bytea', { maxBytes: 1 }).validate({ kind: 'bytea', hex: '0011' })).toThrow(
      'PHYSICAL_BOUND_EXCEEDED',
    );
  });
  it('rejects array layout/count/prefix/overflow errors without flattening', () => {
    for (const value of [
      { dimensions: [{ lowerBound: 1, length: 2 }], elements: [null] },
      { dimensions: [], elements: [null] },
      { dimensions: [{ lowerBound: 2147483647, length: 2 }], elements: [null, null] },
      { dimensions: [{ lowerBound: 1, length: 1 }], elements: ['192.0.2.1/33'] },
    ])
      expect(() => codec('inet[]').validate({ kind: 'inet[]', ...value })).toThrow();
    expect(() =>
      codec('uuid[]', { maxElements: 1 }).validate({
        kind: 'uuid[]',
        dimensions: [{ lowerBound: 1, length: 2 }],
        elements: [null, null],
      }),
    ).toThrow('PHYSICAL_BOUND_EXCEEDED');
    expect(() =>
      codec('uuid[]').validate({
        kind: 'uuid[]',
        dimensions: [{ lowerBound: 1, length: 1 }],
        elements: [['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']],
      }),
    ).toThrow('PHYSICAL_VALUE_INVALID');
  });
  it('rejects opaque malformed/duplicate escaped keys, BOM, NUL, surrogates and wrong digests', () => {
    for (const text of [
      '{"a":1,"\\u0061":2}',
      '{"nested":{"a":1,"a":2}}',
      '\ufeffnull',
      'NaN',
      '01',
      '[1,]',
      '{"x":"\\u0000"}',
      '{"x":"\\ud800"}',
      '{} trailing',
      '{"x":truefalse}',
    ]) {
      expect(() => codec('jsonb').validate(jsonb(text))).toThrow('PHYSICAL_JSONB_INVALID');
    }
    expect(() => codec('jsonb').validate({ ...jsonb('null'), sha256: '0'.repeat(64) })).toThrow(
      'PHYSICAL_DIGEST_MISMATCH',
    );
    expect(() => codec('jsonb', { maxBytes: 3 }).validate(jsonb('null'))).toThrow(
      'PHYSICAL_BOUND_EXCEEDED',
    );
  });
  it('matches PostgreSQL Julian day zero and exclusive finite date end by exact day', () => {
    for (const value of ['4714-11-24 BC', '4714-11-25 BC', '5874897-12-30', '5874897-12-31']) {
      expect(codec('date').validate({ kind: 'date', value }).value).toEqual({
        kind: 'date',
        value,
      });
    }
    for (const value of [
      '4714-01-01 BC',
      '4714-11-23 BC',
      '4715-11-24 BC',
      '5874898-01-01',
      '5874898-06-02',
    ]) {
      expect(() => codec('date').validate({ kind: 'date', value })).toThrow(
        'PHYSICAL_VALUE_INVALID',
      );
    }
  });
  it('matches the exact UTC timestamp microsecond boundaries without Date coercion', () => {
    for (const value of [
      '4714-11-24T00:00:00.000000Z BC',
      '4714-11-24T00:00:00.000001Z BC',
      '294276-12-31T23:59:59.999998Z',
      '294276-12-31T23:59:59.999999Z',
    ]) {
      expect(codec('timestamptzUTC6').validate({ kind: 'timestamptzUTC6', value }).value).toEqual({
        kind: 'timestamptzUTC6',
        value,
      });
    }
    for (const value of [
      '4714-11-23T23:59:59.999999Z BC',
      '294277-01-01T00:00:00.000000Z',
      '294276-12-31T24:00:00.000000Z',
    ]) {
      expect(() => codec('timestamptzUTC6').validate({ kind: 'timestamptzUTC6', value })).toThrow(
        'PHYSICAL_VALUE_INVALID',
      );
    }
  });
  it('captures independent descriptor values without mutation or borrowed byte buffers', () => {
    const configuration = descriptor('jsonb');
    const registered = createFullRestorePhysicalCodecV2(configuration);
    configuration.pgType = 'text';
    configuration.maxBytes = 1;
    const result = registered.validate(jsonb('{"x":12345678901234567890}'));
    expect(result.descriptor.pgType).toBe('jsonb');
    expect(Object.isFrozen(result.descriptor)).toBe(true);
    expect(() => registered.validate({ kind: 'text', value: 'x' })).toThrow(
      'PHYSICAL_TYPE_MISMATCH',
    );
    expect(() =>
      codec('jsonb').validate({
        kind: 'jsonb',
        text: new Uint8Array([110, 117, 108, 108]),
        sha256: jsonb('null').sha256,
      }),
    ).toThrow('PHYSICAL_VALUE_INVALID');
    expect(() =>
      codec('float8sendbits', { maxBytes: 7 }).validate({
        kind: 'float8sendbits',
        sendBits: '8000000000000000',
      }),
    ).toThrow('PHYSICAL_BOUND_EXCEEDED');
  });
  it('bounds opaque nesting and accepts lexical non-lossy numbers without claiming PG canonical spelling', () => {
    expect(() => codec('jsonb').validate(jsonb('['.repeat(66) + '0' + ']'.repeat(66)))).toThrow(
      'PHYSICAL_JSONB_INVALID',
    );
    const text = ' { "a" : 1e400, "b": -0.000 } ';
    expect(codec('jsonb').validate(jsonb(text)).value).toEqual(jsonb(text));
  });
});
