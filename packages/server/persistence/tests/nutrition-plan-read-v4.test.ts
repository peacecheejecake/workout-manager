import { expect, it, vi } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import {
  createNutritionRepository,
  createNutritionPlanV4Reader,
  NutritionReadLimitError,
  NutritionReadVersionError,
} from '../src/nutrition-core.js';

const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const record = {
  schemaVersion: 4,
  planId,
  versionId,
  version: 1,
  previousVersionId: null,
  approvalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  approvedAt: '2026-10-07T00:00:00Z',
  period: { from: '2026-10-07', toInclusive: '2026-10-07' },
  timezone: 'Asia/Seoul',
  purpose: 'Retained approval',
  linkedTrainingPlanVersionId: null,
  items: [
    {
      id: 'Meal',
      planVersionId: versionId,
      category: 'before',
      title: 'Retained food',
      anchor: { kind: 'disconnected', entity: 'race' },
      foods: [
        {
          foodVersionId: null,
          description: 'Food',
          quantity: 0,
          unit: 'g',
          sourceBasis: 'manual_total',
        },
        {
          foodVersionId: null,
          description: 'Unknown',
          quantity: null,
          unit: 'unspecified',
          sourceBasis: 'unknown',
        },
      ],
      targets: [],
      instructions: '',
      evidenceIds: [],
      source: 'user_confirmed',
    },
  ],
  raceTimingPins: [],
  itemRaceTimingBindings: [],
};
const legacy = (() => {
  const {
    schemaVersion: _version,
    raceTimingPins: _pins,
    itemRaceTimingBindings: _bindings,
    ...own
  } = record;
  return { ...own, items: [] };
})();
const queryInput = { from: '2026-10-07', toInclusive: '2026-10-07', limit: 1, cursor: null };
function head(body: unknown = record, bytes = '1024') {
  return {
    version_id: versionId,
    version: 1,
    approved_at: new Date(record.approvedAt),
    head_id: versionId,
    bytes,
    record_json: body,
  };
}
function setup(rows: Record<string, unknown>[]) {
  const query = vi.fn<Transaction['query']>().mockResolvedValue({ rows, rowCount: rows.length });
  const tenant = vi.fn();
  async function transact<T>(
    athleteId: string,
    operation: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    tenant(athleteId, operation);
    return operation({ athleteId, query });
  }
  const database: Database = { tenant: transact, exclusiveTenant: transact, close: async () => {} };
  return {
    repository: createNutritionRepository(database),
    reader: createNutritionPlanV4Reader(database),
    query,
    tenant,
  };
}
function listRow(bodies: (typeof record)[] = [record]) {
  return {
    count: String(bodies.length),
    bytes: '2048',
    largest: '1024',
    records: bodies.map((body) => ({ plan_id: body.planId, record_json: body })),
  };
}

it('reads disconnected V4 preserving food, zero/null, history and tenant without fetching live race or consent', async () => {
  const { reader, query, tenant } = setup([head()]);
  const value = await reader.readPlanV4('owner', planId.toUpperCase());
  expect(value).toEqual({
    schemaVersion: 4,
    planId,
    head: record,
    history: [{ versionId, version: 1, approvedAt: '2026-10-07T00:00:00.000Z' }],
  });
  expect(value?.head?.items[0]?.foods.map((food) => food.quantity)).toEqual([0, null]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[1]).toEqual(['owner', planId]);
  expect(query.mock.calls[0]?.[0]).not.toMatch(/consent|race_event|UPDATE|INSERT/);
  expect(tenant).toHaveBeenCalledWith('owner', expect.any(Function));
});
it.each([
  legacy,
  { ...legacy, schemaVersion: 2, raceTimingPins: [], itemRaceTimingBindings: [] },
  { ...record, schemaVersion: 3 },
])('preserves original predecessor body under explicit V4 envelope', async (body) => {
  expect((await setup([head(body)]).reader.readPlanV4('owner', planId))?.head).toEqual(body);
});
it.each(['readPlan', 'readPlanV2', 'readPlanV3'] as const)(
  'rejects V4 under older %s negotiation',
  async (method) => {
    await expect(setup([head()]).repository[method]('owner', planId)).rejects.toBeInstanceOf(
      NutritionReadVersionError,
    );
  },
);
it('rejects V4 under older list negotiation', async () => {
  await expect(
    setup([listRow()]).repository.listPlansV3('owner', queryInput),
  ).rejects.toBeInstanceOf(NutritionReadVersionError);
  await expect(
    setup([{ plan_id: planId, record_json: record }]).repository.listPlans('owner', queryInput),
  ).rejects.toBeInstanceOf(NutritionReadVersionError);
});
it('returns mixed current records in stable bounded list and cursor', async () => {
  const second = { ...record, planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' };
  const { reader, query } = setup([listRow([record, second])]);
  const value = await reader.listPlansV4('owner', queryInput);
  expect(value.schemaVersion).toBe(4);
  expect(value.plans).toEqual([record]);
  expect(JSON.parse(Buffer.from(value.nextCursor ?? '', 'base64url').toString())).toEqual({
    planId,
  });
  await reader.listPlansV4('owner', { ...queryInput, cursor: value.nextCursor });
  expect(query.mock.calls[1]?.[1]?.[3]).toBe(planId);
  expect(query.mock.calls[0]?.[0]).toContain('WITH bounded AS MATERIALIZED');
});
it('distinguishes absent plans from oversized retained body', async () => {
  expect(await setup([]).reader.readPlanV4('owner', planId)).toBeNull();
  await expect(
    setup([head(null, '524289')]).reader.readPlanV4('owner', planId),
  ).rejects.toBeInstanceOf(NutritionReadLimitError);
});
it.each([
  { ...record, secret: 'no' },
  { ...record, version: 2 },
  { ...record, planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' },
])('rejects malformed or tuple-mismatched V4', async (body) => {
  await expect(setup([head(body)]).reader.readPlanV4('owner', planId)).rejects.toThrow();
});
it.each([
  { bytes: '4194305', largest: '1024' },
  { bytes: '525312', largest: '524289' },
])('rejects oversized aggregate before body decode', async (bounds) => {
  await expect(
    setup([{ ...listRow(), ...bounds }]).reader.listPlansV4('owner', queryInput),
  ).rejects.toBeInstanceOf(NutritionReadLimitError);
});
it('rejects scalar inventory and owned plan mismatch', async () => {
  await expect(
    setup([{ ...listRow(), count: '2' }]).reader.listPlansV4('owner', queryInput),
  ).rejects.toThrow('INVALID_NUTRITION_PLAN_RECORD');
  await expect(
    setup([
      {
        ...listRow(),
        records: [
          {
            plan_id: planId,
            record_json: { ...record, planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' },
          },
        ],
      },
    ]).reader.listPlansV4('owner', queryInput),
  ).rejects.toThrow('INVALID_NUTRITION_PLAN_RECORD');
});
