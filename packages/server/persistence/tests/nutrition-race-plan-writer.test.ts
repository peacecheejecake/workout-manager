import { expect, it } from 'vitest';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import {
  deriveNutritionAffectedItemIds,
  createNutritionRacePlanWriter,
} from '../src/nutrition-race-plan-writer.js';
import type { Database, Transaction } from '../src/database.js';
const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const item = {
  id: 'meal',
  category: 'meal',
  title: 'Meal',
  anchor: { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'UTC' },
  foods: [],
  targets: [],
  instructions: 'User action',
  evidenceIds: [],
  source: 'user_confirmed',
};
const draft = {
  period: { from: '2026-10-07', toInclusive: '2026-10-07' },
  timezone: 'UTC',
  purpose: 'Own schedule',
  linkedTrainingPlanVersionId: null,
  items: [item],
};
const prior = nutritionPlanVersionSchema.parse({
  ...draft,
  planId: uuid,
  versionId: uuid.replaceAll('a', 'b'),
  version: 1,
  previousVersionId: null,
  approvalId: uuid,
  approvedAt: '2026-10-07T00:00:00Z',
  items: [{ ...item, planVersionId: uuid.replaceAll('a', 'b') }],
});
it('derives changed IDs from owned prior while preserving immutable input and long item IDs', () => {
  const bytes = JSON.stringify(prior),
    long = '食事:"\\'.repeat(80);
  expect(deriveNutritionAffectedItemIds(prior, draft)).toEqual([]);
  expect(
    deriveNutritionAffectedItemIds(prior, {
      ...draft,
      items: [
        { ...item, id: long },
        { ...item, instructions: 'Changed' },
      ],
    }),
  ).toEqual(['meal', long]);
  expect(JSON.stringify(prior)).toBe(bytes);
});
it.each([
  { timezone: 'Asia/Seoul' },
  { linkedTrainingPlanVersionId: uuid },
  { period: { from: '2026-10-07', toInclusive: '2026-10-08' } },
])('marks each timing-context change as affected %j', (patch) => {
  expect(deriveNutritionAffectedItemIds(prior, { ...draft, ...patch })).toEqual(['meal']);
});
it('purpose alone does not retime unchanged items, and removed items are not invented', () => {
  expect(deriveNutritionAffectedItemIds(prior, { ...draft, purpose: 'New purpose' })).toEqual([]);
  expect(deriveNutritionAffectedItemIds(prior, { ...draft, items: [] })).toEqual([]);
});
function fixture(replayed: boolean) {
  const calls: string[] = [];
  const tx: Transaction = {
    athleteId: 'synthetic',
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FROM command_receipt'))
        return {
          rows: replayed
            ? [{ request: { operation: 'nutrition_plan_save' }, matches: true, result: prior }]
            : [],
          rowCount: replayed ? 1 : 0,
        };
      return { rows: [], rowCount: 0 };
    },
  };
  const db: Database = {
    async tenant(_athlete, fn) {
      return fn(tx);
    },
    async exclusiveTenant(_athlete, fn) {
      return fn(tx);
    },
    async close() {},
  };
  return { db, calls };
}
const intent = {
  schemaVersion: 2,
  command: { kind: 'create', idempotencyKey: 'synthetic-key', confirmed: true, draft },
  expectedRaceHeads: [],
};
it('successful exact receipt precedes app consent and source reads', async () => {
  const { db, calls } = fixture(true);
  expect(await createNutritionRacePlanWriter(db).savePlanV2('synthetic', intent)).toEqual(prior);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain('advisory');
  expect(calls[1]).toContain('command_receipt');
});
it('absent app consent refuses fresh work before source/body/storage queries', async () => {
  const { db, calls } = fixture(false);
  await expect(
    createNutritionRacePlanWriter(db).savePlanV2('synthetic', intent),
  ).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  expect(calls.some((sql) => sql.includes('INSERT'))).toBe(false);
});
it('rejects V3/client-affected/oversized input before opening a transaction', async () => {
  const { db, calls } = fixture(false),
    writer = createNutritionRacePlanWriter(db);
  expect(() => writer.savePlanV2('synthetic', { ...intent, schemaVersion: 3 })).toThrow();
  expect(() => writer.savePlanV2('synthetic', { ...intent, affectedItemIds: ['meal'] })).toThrow();
  expect(() => writer.savePlanV2('synthetic', { ...intent, padding: 'x'.repeat(524289) })).toThrow(
    'NUTRITION_SOURCE_LIMIT',
  );
  expect(calls).toHaveLength(0);
});
