import { expect, it, vi } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import {
  createNutritionRepository,
  NutritionReadLimitError,
  NutritionReadVersionError,
} from '../src/nutrition-core.js';
import { PersistenceConflict } from '../src/outbox.js';

const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const approvalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const draft = {
  period: { from: '2026-10-07', toInclusive: '2026-10-07' },
  timezone: 'Asia/Seoul',
  purpose: 'Retained approval',
  linkedTrainingPlanVersionId: null,
  items: [],
};
const command = {
  kind: 'create' as const,
  confirmed: true as const,
  idempotencyKey: 'nutrition-replay-1',
  draft,
};
const legacy = {
  ...draft,
  planId,
  versionId,
  approvalId,
  version: 1,
  previousVersionId: null,
  approvedAt: '2026-10-07T00:00:00Z',
};
const record = {
  ...legacy,
  schemaVersion: 3,
  items: [
    {
      id: 'Meal',
      planVersionId: versionId,
      category: 'before',
      title: 'Retained',
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
const request = {
  receiptVersion: 2,
  digestVersion: 'postgres-jsonb-sha256-v1',
  requestDigest: 'a'.repeat(64),
};
const result = {
  receiptVersion: 2,
  outcome: 'committed',
  kind: 'nutrition_plan',
  planId,
  versionId,
  version: 1,
  approvalId,
};
function setup(
  receipt: Record<string, unknown> | null = { request, result, matches: true },
  versions: Record<string, unknown>[] = [{ bytes: '1024', record_json: record }],
) {
  const query = vi.fn<Transaction['query']>().mockImplementation(async (sql) => {
    const rows = sql.includes('FROM command_receipt')
      ? receipt
        ? [receipt]
        : []
      : sql.includes('FROM nutrition_plan_version')
        ? versions
        : [];
    return { rows, rowCount: rows.length };
  });
  async function tenant<T>(
    athleteId: string,
    operation: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return operation({ athleteId, query });
  }
  const database: Database = { tenant, exclusiveTenant: tenant, close: async () => {} };
  return { repository: createNutritionRepository(database), query };
}
function expectNoApproval(query: ReturnType<typeof setup>['query']) {
  expect(query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
    /INSERT|UPDATE|app_admission|nutrition_plan_head|outbox|consent/,
  );
}
it('replays scrubbed receipt through database JSONB digest and the original owned committed version without new approval', async () => {
  const { repository, query } = setup();
  expect(await repository.replayPlanV3('owner', command)).toEqual(record);
  expect(await repository.replayPlanV3('owner', command)).toEqual(record);
  const digest = query.mock.calls.find(([sql]) => sql.includes('FROM command_receipt'));
  expect(digest?.[0]).toContain("encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex')");
  expect(digest?.[1]?.slice(0, 2)).toEqual(['owner', 'nutrition-plan:nutrition-replay-1']);
  expect(JSON.parse(String(digest?.[1]?.[2]))).toEqual({
    operation: 'nutrition_plan_save',
    ...command,
  });
  expect(
    query.mock.calls.find(([sql]) => sql.includes('FROM nutrition_plan_version'))?.[1],
  ).toEqual(['owner', planId, versionId, 1, approvalId]);
  expectNoApproval(query);
});
it('keeps legacy full receipt replay unchanged for both legacy save and explicit replay reader', async () => {
  const { repository, query } = setup({
    request: { operation: 'nutrition_plan_save', ...command },
    result: legacy,
    matches: true,
  });
  expect(await repository.savePlan('owner', command)).toEqual(legacy);
  expect(await repository.replayPlanV3('owner', command)).toEqual(legacy);
  expect(query.mock.calls.some(([sql]) => sql.includes('FROM nutrition_plan_version'))).toBe(false);
  expectNoApproval(query);
});
it('returns null on missing receipt from replay-only operation, never creating a plan', async () => {
  const { repository, query } = setup(null);
  expect(await repository.replayPlanV3('owner', command)).toBeNull();
  expect(query).toHaveBeenCalledTimes(2);
  expectNoApproval(query);
});
it('refuses strict V1 save response compatibility after validating V3 replay rather than applying the command again', async () => {
  const { repository, query } = setup();
  await expect(repository.savePlan('owner', command)).rejects.toBeInstanceOf(
    NutritionReadVersionError,
  );
  expectNoApproval(query);
});
it.each([request, { operation: 'nutrition_plan_save', ...command }])(
  'rejects conflicting original command using DB equality/digest outcome',
  async (stored) => {
    const { repository, query } = setup({
      request: stored,
      result: stored === request ? result : legacy,
      matches: false,
    });
    await expect(repository.replayPlanV3('owner', command)).rejects.toBeInstanceOf(
      PersistenceConflict,
    );
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM nutrition_plan_version'))).toBe(
      false,
    );
    expectNoApproval(query);
  },
);
it.each([
  { request: { ...request, digestVersion: 'js-json-sha256' }, result },
  { request: { ...request, copiedSource: 'forbidden' }, result },
  { request, result: { ...result, copiedPin: 'forbidden' } },
  { request, result: { ...result, outcome: 'pending' } },
])('rejects unknown or noncommitted scrubbed receipt codecs before ref lookup', async (stored) => {
  const { repository, query } = setup({ ...stored, matches: true });
  await expect(repository.replayPlanV3('owner', command)).rejects.toThrow();
  expect(query.mock.calls.some(([sql]) => sql.includes('FROM nutrition_plan_version'))).toBe(false);
  expectNoApproval(query);
});
it.each([
  { rows: [] },
  {
    rows: [
      {
        bytes: '1024',
        record_json: { ...record, approvalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' },
      },
    ],
  },
])(
  'rejects absent/foreign or inconsistent committed refs without falling back to current head',
  async ({ rows }) => {
    const { repository, query } = setup(undefined, rows);
    await expect(repository.replayPlanV3('owner', command)).rejects.toThrow(
      'INVALID_NUTRITION_SAVE_RECEIPT',
    );
    expectNoApproval(query);
  },
);
it.each([legacy, { ...record, unknownSource: 'secret' }])(
  'requires explicit strict redacted V3 body for scrubbed receipt',
  async (body) => {
    const { repository, query } = setup(undefined, [{ bytes: '1024', record_json: body }]);
    await expect(repository.replayPlanV3('owner', command)).rejects.toThrow();
    expectNoApproval(query);
  },
);
it('rejects oversized owned body without parsing it or changing receipt/result', async () => {
  const { repository, query } = setup(undefined, [{ bytes: '524289', record_json: null }]);
  await expect(repository.replayPlanV3('owner', command)).rejects.toBeInstanceOf(
    NutritionReadLimitError,
  );
  expectNoApproval(query);
});
