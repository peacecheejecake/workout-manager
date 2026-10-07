import { it, expect } from 'vitest';
import type { Transaction } from '../src/database.js';
import { readTrainingPlanAggregateSource } from '../src/training-plan-aggregate-source.js';
const version = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  aggregate = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(available: unknown, rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const tx: Transaction = {
    athleteId: 'synthetic',
    async query(sql, values) {
      calls.push({ sql, ...(values ? { values } : {}) });
      return {
        rows: sql.includes('to_regprocedure') ? [{ available }] : rows,
        rowCount: rows.length,
      };
    },
  };
  return { tx, calls };
}
it('exact owned SQL tuple is normalized with bounded reader, never a latest head lookup', async () => {
  const { tx, calls } = fixture(true, [
    { version_id: version.toUpperCase(), aggregate_id: aggregate.toUpperCase() },
  ]);
  expect(await readTrainingPlanAggregateSource(tx, version)).toEqual({
    versionId: version,
    aggregateId: aggregate,
  });
  expect(calls[1]?.values).toEqual([version]);
  expect(calls[1]?.sql).toContain('LIMIT 2');
  expect(calls.some((c) => c.sql.includes('plan_head'))).toBe(false);
});
it('historical schema without capability is unavailable without calling nonexistent reader', async () => {
  const { tx, calls } = fixture(false);
  expect(await readTrainingPlanAggregateSource(tx, version)).toBeNull();
  expect(calls).toHaveLength(1);
});
it('absent or foreign result stays contentless null', async () => {
  expect(await readTrainingPlanAggregateSource(fixture(true).tx, version)).toBeNull();
});
for (const [label, available, rows] of [
  ['invalid capability', 1, []],
  [
    'duplicate rows',
    true,
    [
      { version_id: version, aggregate_id: aggregate },
      { version_id: version, aggregate_id: aggregate },
    ],
  ],
  ['different version', true, [{ version_id: aggregate, aggregate_id: aggregate }]],
  ['extra authority', true, [{ version_id: version, aggregate_id: aggregate, authorized: true }]],
  ['malformed tuple', true, [{ version_id: version, aggregate_id: 'unknown' }]],
] as const)
  it(`rejects ${label}`, async () => {
    await expect(
      readTrainingPlanAggregateSource(fixture(available, [...rows]).tx, version),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  });
it('invalid requested version makes no SQL calls', async () => {
  const { tx, calls } = fixture(true);
  await expect(readTrainingPlanAggregateSource(tx, 'not-a-uuid')).rejects.toMatchObject({
    code: 'INVALID_CONTEXT',
  });
  expect(calls).toHaveLength(0);
});
