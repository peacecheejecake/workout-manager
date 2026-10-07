import { expect, it, vi } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import {
  createNutritionRepository,
  NutritionReadLimitError,
  NutritionReadVersionError,
} from '../src/nutrition-core.js';

const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const record = {
  schemaVersion: 3,
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
  return { repository: createNutritionRepository(database), query, tenant };
}
function listRow(bodies: (typeof record)[] = [record]) {
  return {
    count: String(bodies.length),
    bytes: '2048',
    largest: '1024',
    records: bodies.map((body) => ({ plan_id: body.planId, record_json: body })),
  };
}

it('reads retained V3 food and history metadata with one tenant query and no fresh source/consent lookup', async () => {
  const { repository, query, tenant } = setup([head()]);
  const result = await repository.readPlanV3('owner', planId.toUpperCase());
  expect(result).toEqual({
    schemaVersion: 3,
    planId,
    head: record,
    history: [{ versionId, version: 1, approvedAt: '2026-10-07T00:00:00.000Z' }],
  });
  expect(result?.head?.items[0]?.foods.map((food) => food.quantity)).toEqual([0, null]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[1]).toEqual(['owner', planId]);
  expect(query.mock.calls[0]?.[0]).not.toMatch(/consent|race_event|UPDATE|INSERT/);
  expect(tenant).toHaveBeenCalledWith('owner', expect.any(Function));
});
it('preserves default V1 wire and wraps existing V1/V2 heads only under explicit compatible readers', async () => {
  const old = setup([head(legacy)]).repository;
  expect(await old.readPlan('owner', planId)).toEqual({
    planId,
    head: legacy,
    history: [{ versionId, version: 1, approvedAt: '2026-10-07T00:00:00.000Z' }],
  });
  expect((await old.readPlanV3('owner', planId))?.head).toEqual(legacy);
  const v2 = { ...legacy, schemaVersion: 2, raceTimingPins: [], itemRaceTimingBindings: [] };
  expect((await setup([head(v2)]).repository.readPlanV2('owner', planId))?.head).toEqual(v2);
});
it.each(['readPlan', 'readPlanV2'] as const)(
  'refuses V3 under %s without copying source or fabricating a legacy anchor',
  async (method) => {
    await expect(setup([head()]).repository[method]('owner', planId)).rejects.toBeInstanceOf(
      NutritionReadVersionError,
    );
  },
);
it('returns absent plan distinctly and gates oversized head before its body is returned', async () => {
  expect(await setup([]).repository.readPlanV3('owner', planId)).toBeNull();
  await expect(
    setup([head(null, '524289')]).repository.readPlanV3('owner', planId),
  ).rejects.toBeInstanceOf(NutritionReadLimitError);
});
it.each([
  { ...record, sourceSecret: 'never disclose' },
  { ...record, planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' },
  { ...record, version: 2 },
])('rejects malformed or row-inconsistent current head', async (body) => {
  await expect(setup([head(body)]).repository.readPlanV3('owner', planId)).rejects.toThrow();
});
it('does not deserialize historical copied-pin bodies when returning metadata', async () => {
  const previous = {
    ...head({ invalid: 'historical source body' }),
    version_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    version: 1,
  };
  const current = { ...record, version: 2, previousVersionId: previous.version_id };
  const { repository, query } = setup([{ ...head(current), version: 2 }, previous]);
  expect((await repository.readPlanV3('owner', planId))?.history).toHaveLength(2);
  expect(query.mock.calls[0]?.[0]).toContain('CASE WHEN v.version_id=h.version_id');
});
it('lists explicit V3 with bounded scalar preflight and body aggregation in one statement, preserving stable cursor', async () => {
  const second = { ...record, planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' };
  const { repository, query } = setup([listRow([record, second])]);
  const page = await repository.listPlansV3('owner', queryInput);
  expect(page.plans).toEqual([record]);
  expect(JSON.parse(Buffer.from(page.nextCursor ?? '', 'base64url').toString())).toEqual({
    planId,
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[1]).toEqual([
    'owner',
    queryInput.from,
    queryInput.toInclusive,
    null,
    2,
  ]);
  expect(query.mock.calls[0]?.[0]).toContain('WITH bounded AS MATERIALIZED');
  expect(query.mock.calls[0]?.[0]).toContain('octet_length(v.record_json::text)');
  expect(query.mock.calls[0]?.[0]).toContain(
    'CASE WHEN bytes::bigint<=4194304 AND largest::bigint<=524288',
  );
  await repository.listPlansV3('owner', { ...queryInput, cursor: page.nextCursor });
  expect(query.mock.calls[1]?.[1]?.[3]).toBe(planId);
});
it.each([
  { bytes: '4194305', largest: '1024' },
  { bytes: '525312', largest: '524289' },
])('rejects preflight limit rather than returning a truncated page/cursor', async (bounds) => {
  const { repository } = setup([{ ...listRow(), ...bounds, records: [] }]);
  await expect(repository.listPlansV3('owner', queryInput)).rejects.toBeInstanceOf(
    NutritionReadLimitError,
  );
});
it('refuses mismatched scalar inventory and malformed list bodies', async () => {
  await expect(
    setup([{ ...listRow(), count: '2' }]).repository.listPlansV3('owner', queryInput),
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
    ]).repository.listPlansV3('owner', queryInput),
  ).rejects.toThrow('INVALID_NUTRITION_PLAN_RECORD');
});
it('preserves empty legacy list and refuses a V3 head in legacy list', async () => {
  expect(await setup([]).repository.listPlans('owner', queryInput)).toEqual({
    plans: [],
    nextCursor: null,
  });
  await expect(
    setup([{ plan_id: planId, record_json: record }]).repository.listPlans('owner', queryInput),
  ).rejects.toBeInstanceOf(NutritionReadVersionError);
});

it('preserves an individually valid legacy list larger than the new V3 envelope bound', async () => {
  const plans = Array.from({ length: 13 }, (_, index) => ({
    ...legacy,
    planId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 10).padStart(12, '0')}`,
    items: [
      {
        ...record.items[0],
        id: 'x'.repeat(350000),
        anchor: { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'Asia/Seoul' },
      },
    ],
  }));
  expect(Buffer.byteLength(JSON.stringify(plans), 'utf8')).toBeGreaterThan(4194304);
  const { repository, query } = setup(
    plans.map((plan) => ({ plan_id: plan.planId, record_json: plan })),
  );
  expect((await repository.listPlans('owner', { ...queryInput, limit: 100 })).plans).toEqual(plans);
  expect(query.mock.calls[0]?.[0]).not.toContain('octet_length');
  expect(query.mock.calls[0]?.[1]?.[4]).toBe(101);
});
