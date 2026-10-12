import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createFullRestoreRowBytesValidatorV1,
  FullRestoreRowBytesError,
  type FullRestoreRowV1,
  type FullRestoreRowPortsV1,
} from '../src/full-restore-row-bytes-v1.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (text: string) => new TextEncoder().encode(text);
const relation = () => ({
  schema: 'public',
  relation: 'synthetic_rows',
  physicalCodec: 'postgres-row-jsonb-utc-v1',
  columnsSha256: 'a'.repeat(64),
  orderingKey: ['id'],
  maxRows: 3,
  maxBytes: 1000,
  maxRowBytes: 200,
});
type Row = FullRestoreRowV1 & { readonly id: string; readonly value: string | null };
const validateRow = (row: FullRestoreRowV1): row is Row =>
  Object.keys(row).length === 2 &&
  typeof row.id === 'string' &&
  (row.value === null || typeof row.value === 'string');
const ports = (): FullRestoreRowPortsV1<Row> =>
  Object.freeze({
    validateRow,
    compareNativeKeys: (a: Row, b: Row) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1),
  });
function facts(bytes: Uint8Array, count: number, state: 'present' | 'explicit_empty' = 'present') {
  const { maxRows: _rows, maxBytes: _bytes, maxRowBytes: _row, ...identity } = relation();
  return { ...identity, state, rowCount: count, byteLength: bytes.length, rowsSha256: sha(bytes) };
}
function parser(p = ports(), configuration: unknown = relation()) {
  return createFullRestoreRowBytesValidatorV1(configuration, p);
}
function rejects(work: () => unknown, code: string) {
  expect(work).toThrow(FullRestoreRowBytesError);
  expect(work).toThrow(code);
}
const one = () => encode('[ {"value":"한글\\n🌍", "id":"9007199254740993"} ]');

describe('full restore archived row bytes V1', () => {
  it('preserves exact source bytes and immutable rows, without authority or admission', () => {
    const bytes = one(),
      original = bytes.slice();
    const result = parser().validate(bytes, facts(bytes, 1));
    bytes.fill(0);
    const copy = result.copyCanonicalBytes();
    copy.fill(1);
    expect(result.copyCanonicalBytes()).toEqual(original);
    expect(result.rowsSha256).toBe(sha(original));
    expect(result.rows[0]).toEqual({ value: '한글\n🌍', id: '9007199254740993' });
    expect(Object.isFrozen(result.rows[0])).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true);
    expect(result).toMatchObject({ authority: 'none', admissionAllowed: false, rowCount: 1 });
  });
  it('does not accept callback mutation of the original byte buffer as altered canonical content', () => {
    const bytes = one(),
      original = bytes.slice(),
      expected = facts(bytes, 1);
    const callbackPorts = Object.freeze({
      ...ports(),
      validateRow: (row: FullRestoreRowV1): row is Row => {
        bytes.fill(0);
        return validateRow(row);
      },
    });
    const result = parser(callbackPorts).validate(bytes, expected);
    expect(result.copyCanonicalBytes()).toEqual(original);
    expect(result.rowsSha256).toBe(sha(original));
    expect(result.rows[0]?.id).toBe('9007199254740993');
  });
  it('only accepts the exact explicit empty [] bytes', () => {
    const bytes = encode('[]');
    expect(parser().validate(bytes, facts(bytes, 0, 'explicit_empty')).rows).toEqual([]);
    for (const value of ['[ ]', 'null', '[]\n']) {
      const malformed = encode(value);
      rejects(
        () => parser().validate(malformed, facts(malformed, 0, 'explicit_empty')),
        'ROW_BYTES_FACTS_MISMATCH',
      );
    }
    rejects(() => parser().validate(bytes, facts(bytes, 0)), 'ROW_BYTES_FACTS_MISMATCH');
  });
  it('rejects wrong digest, byte count, row count and relation identity', () => {
    const bytes = one();
    for (const patch of [
      { rowsSha256: 'b'.repeat(64) },
      { byteLength: bytes.length + 1 },
      { rowCount: 2 },
      { relation: 'foreign' },
      { orderingKey: ['value'] },
    ])
      rejects(
        () => parser().validate(bytes, { ...facts(bytes, 1), ...patch }),
        'ROW_BYTES_FACTS_MISMATCH',
      );
  });
  it('rejects invalid UTF8 and BOM before callbacks', () => {
    const validator = vi.fn();
    const p = Object.freeze({
      ...ports(),
      validateRow: (row: FullRestoreRowV1): row is Row => {
        validator();
        return validateRow(row);
      },
    });
    for (const bytes of [new Uint8Array([0xff, 0xfe]), new Uint8Array([0xef, 0xbb, 0xbf, 91, 93])])
      rejects(() => parser(p).validate(bytes, facts(bytes, 1)), 'ROW_BYTES_ENCODING_INVALID');
    expect(validator).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON, non-array roots, null rows, unknown columns and nonfinite numbers', () => {
    const invalidCases: readonly (readonly [string, string])[] = [
      ['[{]', 'ROW_BYTES_JSON_INVALID'],
      ['[{"id":"1","\\u0069d":"2","value":null}]', 'ROW_BYTES_JSON_INVALID'],
      ['[{"id":"1","value":{"a":1,"\\u0061":2}}]', 'ROW_BYTES_JSON_INVALID'],
      ['{}', 'ROW_BYTES_FACTS_MISMATCH'],
      ['[null]', 'ROW_BYTES_ROW_INVALID'],
      ['[{"id":"1","value":null,"extra":1}]', 'ROW_BYTES_ROW_INVALID'],
      ['[{"id":"1","value":1e999}]', 'ROW_BYTES_ROW_INVALID'],
      ['[{"id":"1","value":"\\ud800"}]', 'ROW_BYTES_ROW_INVALID'],
      ['[{"id":"1","value":"\\u0000"}]', 'ROW_BYTES_ROW_INVALID'],
    ];
    for (const [text, code] of invalidCases) {
      const bytes = encode(text);
      rejects(() => parser().validate(bytes, facts(bytes, 1)), code);
    }
  });
  it('rejects reverse order and duplicate native primary keys without coercion', () => {
    for (const ids of [
      ['2', '1'],
      ['1', '1'],
    ]) {
      const bytes = encode(JSON.stringify(ids.map((id) => ({ id, value: null }))));
      rejects(() => parser().validate(bytes, facts(bytes, 2)), 'ROW_BYTES_ORDER_INVALID');
    }
    const bytes = encode(
      '[{"id":"9007199254740992","value":null},{"id":"9007199254740993","value":null}]',
    );
    expect(parser().validate(bytes, facts(bytes, 2)).rowCount).toBe(2);
  });
  it('refuses silently rounded archived numeric tokens before invoking trusted row validation', () => {
    const validate = vi.fn();
    const p = Object.freeze({
      validateRow: (row: FullRestoreRowV1): row is FullRestoreRowV1 => {
        validate();
        return typeof row.id === 'string';
      },
      compareNativeKeys: (): -1 => -1,
    });
    for (const token of ['9007199254740993', '1.00000000000000000001', '1e-400']) {
      const bytes = encode(`[{"id":"1","value":${token}}]`);
      rejects(
        () => createFullRestoreRowBytesValidatorV1(relation(), p).validate(bytes, facts(bytes, 1)),
        'ROW_BYTES_ROW_INVALID',
      );
    }
    expect(validate).not.toHaveBeenCalled();
    const bytes = encode('[{"id":"1","value":1.00}]');
    expect(
      createFullRestoreRowBytesValidatorV1(relation(), p).validate(bytes, facts(bytes, 1)).rows[0]
        ?.value,
    ).toBe(1);
  });
  it('uses independently trusted native comparator for composite microsecond keys', () => {
    const compare = vi.fn((a: Row, b: Row): -1 | 0 | 1 =>
      a.id === b.id ? 0 : a.id < b.id ? -1 : 1,
    );
    const bytes = encode(
      '[{"id":"2026-10-09T00:00:00.000001Z/a","value":null},{"id":"2026-10-09T00:00:00.000002Z/a","value":null}]',
    );
    expect(
      parser(Object.freeze({ validateRow, compareNativeKeys: compare })).validate(
        bytes,
        facts(bytes, 2),
      ).rowCount,
    ).toBe(2);
    expect(compare).toHaveBeenCalledTimes(1);
  });
  it('enforces relation rows/bytes and individual row/depth bounds', () => {
    const bytes = one();
    rejects(
      () => parser(ports(), { ...relation(), maxBytes: 2 }).validate(bytes, facts(bytes, 1)),
      'ROW_BYTES_BOUND_EXCEEDED',
    );
    rejects(
      () => parser(ports(), { ...relation(), maxRows: 0 }).validate(bytes, facts(bytes, 1)),
      'ROW_BYTES_BOUND_EXCEEDED',
    );
    rejects(
      () => parser(ports(), { ...relation(), maxRowBytes: 10 }).validate(bytes, facts(bytes, 1)),
      'ROW_BYTES_BOUND_EXCEEDED',
    );
    const deep = encode('['.repeat(65) + '0' + ']'.repeat(65));
    rejects(() => parser().validate(deep, facts(deep, 1)), 'ROW_BYTES_BOUND_EXCEEDED');
    const excess = encode('[{}, {}, {}, {}]');
    rejects(() => parser().validate(excess, facts(excess, 3)), 'ROW_BYTES_BOUND_EXCEEDED');
  });
  it('rejects buffer subclasses, partial views, shared/resizable/detached and arbitrary inputs', () => {
    const bytes = one();
    const detached = one();
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const resizableBuffer: unknown = Reflect.construct(ArrayBuffer, [4, { maxByteLength: 8 }]);
    if (!(resizableBuffer instanceof ArrayBuffer)) throw Error('INVALID_SYNTHETIC_FIXTURE');
    const resizable = new Uint8Array(resizableBuffer);
    for (const bad of [
      Buffer.from(bytes),
      bytes.subarray(1),
      new Uint8Array(new SharedArrayBuffer(4)),
      detached,
      resizable,
      [1, 2],
      null,
    ])
      rejects(() => parser().validate(bad, facts(bytes, 1)), 'ROW_BYTES_INPUT_INVALID');
  });
  it('does not invoke hostile bytes or trusted-registration getters', () => {
    const bytes = one(),
      get = vi.fn(() => {
        throw Error('PRIVATE');
      });
    Object.defineProperty(bytes, 'buffer', { get });
    rejects(() => parser().validate(bytes, facts(one(), 1)), 'ROW_BYTES_INPUT_INVALID');
    const registration = Object.freeze({
      get validateRow() {
        return get();
      },
      compareNativeKeys: ports().compareNativeKeys,
    });
    rejects(() => parser(registration), 'ROW_BYTES_PORTS_INVALID');
    expect(get).not.toHaveBeenCalled();
  });
  it('rejects missing, mutable and throwing ports without exposing callback messages', () => {
    rejects(() => parser({ ...ports() }), 'ROW_BYTES_PORTS_INVALID');
    const missing = { ...ports() };
    Reflect.deleteProperty(missing, 'validateRow');
    rejects(() => parser(Object.freeze(missing)), 'ROW_BYTES_PORTS_INVALID');
    const bytes = one(),
      throwing = Object.freeze({
        ...ports(),
        validateRow: (_: FullRestoreRowV1): _ is Row => {
          throw Error('SECRET_ROW');
        },
      });
    rejects(() => parser(throwing).validate(bytes, facts(bytes, 1)), 'ROW_BYTES_PORT_FAILED');
  });
  it('prevents validators/comparators from mutating accepted rows', () => {
    const bytes = one();
    const mutation = Object.freeze({
      ...ports(),
      validateRow: (row: FullRestoreRowV1): row is Row => {
        Object.defineProperty(row, 'id', { value: 'changed' });
        return true;
      },
    });
    rejects(() => parser(mutation).validate(bytes, facts(bytes, 1)), 'ROW_BYTES_PORT_FAILED');
  });
  it('rejects comparator invalid values and unknown registry metadata', () => {
    const bytes = encode('[{"id":"1","value":null},{"id":"2","value":null}]');
    const invalid = { ...ports() };
    Object.defineProperty(invalid, 'compareNativeKeys', { value: () => Number.NaN });
    Object.freeze(invalid);
    rejects(
      () =>
        createFullRestoreRowBytesValidatorV1(relation(), invalid).validate(bytes, facts(bytes, 2)),
      'ROW_BYTES_ORDER_INVALID',
    );
    rejects(
      () => parser(ports(), { ...relation(), extra: true }),
      'ROW_BYTES_CONFIGURATION_INVALID',
    );
  });
});
