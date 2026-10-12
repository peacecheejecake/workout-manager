import { expect, it } from 'vitest';
import { postgresInstantMicros } from '../src/postgres-instant.js';

// All twelve pairs independently observed by Root on actual PostgreSQL 17.6.
it.each([
  ['2026-10-09T00:00:00.1234567Z', '2026-10-09T00:00:00.123457Z'],
  ['2026-10-09T00:00:00.1234565Z', '2026-10-09T00:00:00.123456Z'],
  ['2026-10-09T00:00:00.1234575Z', '2026-10-09T00:00:00.123458Z'],
  ['2026-10-09T23:59:59.9999999Z', '2026-10-10T00:00:00.000000Z'],
  ['2026-12-31T23:59:59.9999995Z', '2027-01-01T00:00:00.000000Z'],
  ['2024-02-29T23:59:59.9999999Z', '2024-03-01T00:00:00.000000Z'],
  ['2026-10-09T09:00:00.1234565+09:00', '2026-10-09T00:00:00.123456Z'],
  ['2026-10-08T23:59:59.9999999-00:01', '2026-10-09T00:01:00.000000Z'],
  ['1969-12-31T23:59:59.9999995Z', '1970-01-01T00:00:00.000000Z'],
  ['1969-12-31T23:59:59.0000005Z', '1969-12-31T23:59:59.000000Z'],
  ['1969-12-31T23:59:59.0000015Z', '1969-12-31T23:59:59.000002Z'],
  ['2026-10-09T00:00:00.12345650000000001Z', '2026-10-09T00:00:00.123457Z'],
])('preserves PostgreSQL fractional correspondence %s', (original, physical) => {
  const parsed = postgresInstantMicros(original);
  expect(parsed).not.toBeNull();
  expect(parsed).toBe(postgresInstantMicros(physical));
  expect(parsed).not.toBe(
    postgresInstantMicros(
      physical.replace(/(\d)Z$/, (digit) => `${digit[0] === '9' ? '8' : '9'}Z`),
    ),
  );
});
it('retains epoch zero, exact seconds and negative epoch microseconds as distinct facts', () => {
  expect(postgresInstantMicros('1970-01-01T00:00:00Z')).toBe(0n);
  expect(postgresInstantMicros('1970-01-01T00:00:00.000001Z')).toBe(1n);
  expect(postgresInstantMicros('1969-12-31T23:59:59.999999Z')).toBe(-1n);
  expect(postgresInstantMicros('0001-01-01T00:00:00Z')).toBe(-62135596800000000n);
  expect(postgresInstantMicros('9999-12-31T23:59:59.999999Z')).toBe(253402300799999999n);
});
it.each([
  null,
  undefined,
  0,
  false,
  {},
  [],
  new Date(0),
  '0000-01-01T00:00:00Z',
  '2026-02-29T00:00:00Z',
  '2026-10-09T24:00:00Z',
  '2026-10-09T00:00:60Z',
  '2026-10-09T00:00:00',
  '2026-10-09T00:00:00+16:00',
  '2026-10-09T00:00:00-16:00',
  '2026-10-09T00:00:00+09:60',
  '2026-10-09T00:00:00.NaNZ',
  ' 2026-10-09T00:00:00Z',
])('rejects invalid or unsupported instant %# without coercing unknown', (value) => {
  expect(postgresInstantMicros(value)).toBeNull();
});
it('does not invoke unknown input accessors or string conversion', () => {
  const value = {
    toString() {
      throw new Error('must not call');
    },
  };
  expect(postgresInstantMicros(value)).toBeNull();
});
