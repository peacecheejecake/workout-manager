import assert from 'node:assert/strict';
import { expect, it } from 'vitest';
import { parseConstraintRestoreLedger } from '../../../scripts/coaching-constraint-restore.mjs';
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
const owner = '00000000-0000-4000-8000-000000000001';
const itemId = '00000000-0000-4000-8000-000000000002';
const at = '2026-09-18T00:00:00.000Z';
function fixture() {
  return {
    schemaVersion: 1,
    capturedAt: at,
    subjects: [
      {
        athleteId: owner,
        head: { revision: 1, updatedAt: at },
        rows: [
          {
            id: itemId,
            revision: 1,
            text: 'Synthetic confirmed restriction' as string | null,
            confirmedAt: at,
            updatedAt: at,
            deleted: false,
          },
        ],
      },
    ],
  };
}
it('preserves only strictly validated current text and distinguishes absent head from deleted tombstone', () => {
  const input = fixture();
  expect(parseConstraintRestoreLedger(input, [owner])).toEqual(input);
  required(required(input.subjects[0]).rows[0]).deleted = true;
  required(required(input.subjects[0]).rows[0]).text = null;
  expect(parseConstraintRestoreLedger(input, [owner])).toEqual(input);
  const absent = { ...input, subjects: [{ athleteId: owner, head: null, rows: [] }] };
  expect(parseConstraintRestoreLedger(absent, [owner])).toEqual(absent);
});
it('rejects missing coverage, duplicate owners and rows, and omitted rows even if JSON is otherwise valid', () => {
  const input = fixture();
  expect(() => parseConstraintRestoreLedger({ ...input, subjects: [] }, [owner])).toThrow();
  expect(() =>
    parseConstraintRestoreLedger({ ...input, subjects: [...input.subjects, ...input.subjects] }, [
      owner,
    ]),
  ).toThrow();
  const subject = required(input.subjects[0]);
  expect(() =>
    parseConstraintRestoreLedger({ ...input, subjects: [{ ...subject, rows: [] }] }, [owner]),
  ).toThrow();
  expect(() =>
    parseConstraintRestoreLedger(
      {
        ...input,
        subjects: [
          {
            ...subject,
            head: { revision: 2, updatedAt: at },
            rows: [...subject.rows, ...subject.rows],
          },
        ],
      },
      [owner],
    ),
  ).toThrow();
});
it('rejects unknown fields, invalid version, noncanonical time, unsafe revisions and health text on a tombstone', () => {
  const input = fixture();
  expect(() => parseConstraintRestoreLedger({ ...input, secret: 'unexpected' }, [owner])).toThrow();
  expect(() => parseConstraintRestoreLedger({ ...input, schemaVersion: 2 }, [owner])).toThrow();
  expect(() =>
    parseConstraintRestoreLedger({ ...input, capturedAt: '2026-09-18' }, [owner]),
  ).toThrow();
  for (const revision of [0, -1, 1.5, 2147483647, NaN]) {
    const altered = structuredClone(input);
    required(altered.subjects[0]).head.revision = revision;
    expect(() => parseConstraintRestoreLedger(altered, [owner])).toThrow();
  }
  required(required(input.subjects[0]).rows[0]).deleted = true;
  expect(() => parseConstraintRestoreLedger(input, [owner])).toThrow();
});
it('rejects more than fifty active rows but permits bounded tombstones without counting them as active', () => {
  const input = fixture();
  const row = required(required(input.subjects[0]).rows[0]);
  const rows = Array.from({ length: 51 }, (_, index) => ({
    ...row,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  }));
  const ledger = {
    ...input,
    subjects: [{ athleteId: owner, head: { revision: 51, updatedAt: at }, rows }],
  };
  expect(() => parseConstraintRestoreLedger(ledger, [owner])).toThrow();
  rows[0] = { ...required(rows[0]), deleted: true, text: null };
  expect(parseConstraintRestoreLedger(ledger, [owner])).toEqual(ledger);
});
