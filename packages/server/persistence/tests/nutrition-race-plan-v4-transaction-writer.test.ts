import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  nutritionPlanVersionV4Schema,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import {
  createNutritionRacePlanV4Writer,
  saveNutritionPlanV4In,
} from '../src/nutrition-race-plan-v4-writer.js';
import type { Database, Transaction } from '../src/database.js';
const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const at = '2026-10-07T00:00:00Z';
const raceValues = {
  title: 'Synthetic owned race',
  localDate: '2026-10-07',
  localStartTime: '10:00',
  timezone: 'UTC',
  locationName: null,
  distance: { kind: 'standard', class: '10k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: null,
  targetSeconds: null,
  planVersionId: null,
};
const item = (id: string) => ({
  id,
  planVersionId: uuid(2),
  category: 'before',
  title: 'Meal',
  anchor: {
    kind: 'relative',
    entity: 'race',
    entityId: uuid(5),
    point: 'start',
    offsetMinutes: -30,
  },
  foods: [
    {
      foodVersionId: null,
      description: 'Preserved zero',
      quantity: 0,
      unit: 'g',
      sourceBasis: 'manual_total',
    },
    {
      foodVersionId: null,
      description: 'Preserved unknown',
      quantity: null,
      unit: 'unspecified',
      sourceBasis: 'unknown',
    },
  ],
  targets: [],
  instructions: 'Original',
  evidenceIds: [],
  source: 'user_confirmed',
});
const oldPin = {
  pinVersion: 1,
  namespace: 'race-event-revision',
  eventId: uuid(5),
  eventRevision: 1,
  sourceDigestVersion: 'race-event-values-canonical-v1',
  sourceDigest: 'a'.repeat(64),
  localDate: '2026-10-07',
  localStartTime: '07:00',
  timezone: 'UTC',
  start: { state: 'known', instant: '2026-10-07T07:00:00Z' },
  end: { state: 'unknown', reason: 'race_end_not_recorded' },
};
function original(): NutritionPlanVersionCompatibleV4 {
  return nutritionPlanVersionV4Schema.parse({
    schemaVersion: 4,
    planId: uuid(1),
    versionId: uuid(2),
    version: 1,
    previousVersionId: null,
    approvalId: uuid(3),
    approvedAt: at,
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'UTC',
    purpose: 'Own prior',
    linkedTrainingPlanVersionId: null,
    items: [item('a'), item('b')],
    raceTimingPins: [oldPin],
    itemRaceTimingBindings: ['a', 'b'].map((itemId) => ({
      itemId,
      binding: { state: 'captured', eventId: uuid(5), eventRevision: 1 },
    })),
  });
}
function intent(prior: NutritionPlanVersionCompatibleV4) {
  return {
    schemaVersion: 4,
    intent: {
      schemaVersion: 3,
      command: {
        kind: 'update',
        planId: prior.planId,
        expectedHeadVersionId: prior.versionId,
        idempotencyKey: 'synthetic-v4-key',
        confirmed: true,
        draft: {
          period: prior.period,
          timezone: prior.timezone,
          purpose: prior.purpose,
          linkedTrainingPlanVersionId: prior.linkedTrainingPlanVersionId,
          items: prior.items.map((entry) => {
            const { planVersionId, ...rest } = entry;
            void planVersionId;
            return rest;
          }),
        },
      },
      expectedRaceHeads: prior.items.some(
        (entry) => entry.anchor.kind === 'relative' && entry.anchor.entity === 'race',
      )
        ? [{ namespace: 'race-event', eventId: uuid(5), revision: 2 }]
        : [],
      reconnectItemIds: [] as string[],
    },
  };
}
function first<T>(list: readonly T[]): T {
  const value = list[0];
  if (value === undefined) throw new Error('MISSING_FIXTURE');
  return value;
}
type Options = {
  prior?: NutritionPlanVersionCompatibleV4;
  app?: boolean;
  origin?: boolean;
  receipt?: boolean;
  matches?: boolean;
  commitMismatch?: boolean;
  stale?: boolean;
  unknownStart?: boolean;
  raceId?: string;
  sourceBytes?: string;
  priorBytes?: string;
  foodCount?: string;
  foodBytes?: string;
  scopeMismatch?: boolean;
  malformedPrior?: boolean;
  extraReceipt?: boolean;
  absentPrior?: boolean;
  reverseOrigins?: boolean;
  duplicateOrigins?: boolean;
};
function fixture(options: Options = {}) {
  const prior = options.prior ?? original(),
    calls: { sql: string; values: unknown[] | undefined }[] = [],
    commits: unknown[] = [];
  const query: Transaction['query'] = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FROM command_receipt'))
      return {
        rows: options.receipt
          ? [
              {
                request: {
                  receiptVersion: 3,
                  digestVersion: 'postgres-jsonb-sha256-v1',
                  requestDigest: 'd'.repeat(64),
                },
                result: {
                  receiptVersion: 3,
                  outcome: 'committed',
                  kind: 'nutrition_plan',
                  planId: prior.planId,
                  versionId: prior.versionId,
                  version: prior.version,
                  approvalId: prior.approvalId,
                  ...(options.extraReceipt ? { copiedPins: [] } : {}),
                },
                matches: options.matches ?? true,
              },
            ]
          : [],
        rowCount: options.receipt ? 1 : 0,
      };
    if (sql.includes('FROM consent'))
      return {
        rows: options.app === false ? [] : [{ kind: 'app', granted: true, revision: 1 }],
        rowCount: 1,
      };
    if (sql.includes('FROM nutrition_plan_head') && options.absentPrior)
      return { rows: [], rowCount: 0 };
    if (sql.includes('FROM nutrition_plan_head'))
      return {
        rows: [
          {
            version: prior.version,
            version_id: prior.versionId,
            bytes: options.priorBytes ?? String(Buffer.byteLength(JSON.stringify(prior))),
            record_json: options.malformedPrior ? { ...prior, extra: true } : prior,
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('FROM nutrition_plan_version'))
      return {
        rows: [{ bytes: String(Buffer.byteLength(JSON.stringify(prior))), record_json: prior }],
        rowCount: 1,
      };
    if (sql.includes('read_nutrition_disconnection_origin')) {
      const ids = z.array(z.string()).parse(values?.[3]);
      const ordered = options.reverseOrigins ? [...ids].reverse() : ids;
      return {
        rows: ordered.map((item_id) => ({
          item_id: options.duplicateOrigins ? first(ids) : item_id,
          authorized: options.origin ?? true,
        })),
        rowCount: ids.length,
      };
    }
    if (sql.includes('FROM food_definition_version'))
      return {
        rows: [{ count: options.foodCount ?? '0', bytes: options.foodBytes ?? '0' }],
        rowCount: 1,
      };
    if (sql.includes("current_setting('app.athlete_id'"))
      return {
        rows: [{ athlete_id: options.scopeMismatch ? 'foreign' : 'synthetic' }],
        rowCount: 1,
      };
    if (sql.includes('AS matching_heads'))
      return {
        rows: [
          { heads: '1', matching_heads: options.stale ? '0' : '1', histories: '1', bytes: '2048' },
        ],
        rowCount: 1,
      };
    if (sql.includes('WITH requested'))
      return { rows: [{ bytes: options.sourceBytes ?? '2048' }], rowCount: 1 };
    if (sql.includes('SELECT h.id,h.revision,h.values_json'))
      return {
        rows: [
          {
            id: options.raceId ?? uuid(5),
            revision: 2,
            values_json: { ...raceValues, localStartTime: options.unknownStart ? null : '10:00' },
            history_revision: 2,
            history_values: {
              ...raceValues,
              localStartTime: options.unknownStart ? null : '10:00',
            },
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('commit_nutrition_plan_v4')) {
      const value = z.string().parse(values?.[3]),
        saved = nutritionPlanVersionV4Schema.parse(JSON.parse(value));
      commits.push(saved);
      return {
        rows: [
          {
            result: {
              receiptVersion: 3,
              outcome: 'committed',
              kind: 'nutrition_plan',
              planId: saved.planId,
              versionId: options.commitMismatch ? uuid(99) : saved.versionId,
              version: saved.version,
              approvalId: saved.approvalId,
            },
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const tx: Transaction = { athleteId: 'synthetic', query };
  const db: Database = {
    async tenant(_athlete, fn) {
      return fn(tx);
    },
    async exclusiveTenant(_athlete, fn) {
      return fn(tx);
    },
    async close() {},
  };
  let sequence = 30;
  const writer = createNutritionRacePlanV4Writer(db, {
    now: () => new Date(at),
    id: () => uuid(sequence++),
  });
  return { prior, calls, commits, writer, tx };
}
it('direct supplied transaction uses the exact SQL110 commit and injected IDs/clock', async () => {
  const s = fixture();
  let n = 60;
  const saved = await saveNutritionPlanV4In(s.tx, intent(s.prior), {
    now: () => new Date(at),
    id: () => uuid(n++),
  });
  expect(saved.plan.versionId).toBe(uuid(60));
  expect(saved.plan.approvalId).toBe(uuid(61));
  expect(saved.plan.approvedAt).toBe(new Date(at).toISOString());
  expect(s.commits).toHaveLength(1);
  expect(s.calls.filter((c) => c.sql.includes('commit_nutrition_plan_v4'))).toHaveLength(1);
});
it('direct seam validates unknown and size synchronously before transaction query', () => {
  const s = fixture();
  for (const input of [{}, { ...intent(s.prior), padding: 'x'.repeat(524289) }])
    expect(() => saveNutritionPlanV4In(s.tx, input)).toThrow();
  expect(s.calls).toHaveLength(0);
});
it('receipt first direct seam preserves withdrawn-app original result and notices', async () => {
  const s = fixture({ receipt: true, app: false });
  expect(
    (
      await saveNutritionPlanV4In(s.tx, intent(s.prior), {
        now: () => {
          throw new Error('CLOCK_MUST_NOT_RUN_ON_REPLAY');
        },
        id: () => {
          throw new Error('ID_MUST_NOT_RUN_ON_REPLAY');
        },
      })
    ).plan,
  ).toEqual(s.prior);
  expect(s.commits).toHaveLength(0);
  expect(
    s.calls.some((c) => c.sql.includes('FROM consent') || c.sql.includes('nutrition_plan_head')),
  ).toBe(false);
});
it.each([{ app: false }, { absentPrior: true }, { stale: true }, { commitMismatch: true }])(
  'direct seam maintains actual guard failures %j',
  async (options) => {
    const s = fixture(options);
    await expect(saveNutritionPlanV4In(s.tx, intent(s.prior))).rejects.toThrow();
  },
);
it('query permission failures propagate unchanged rather than continuing an aborted transaction', async () => {
  const error = new Error('42501 permission denied');
  const tx: Transaction = {
    athleteId: 'synthetic',
    query: async () => {
      throw error;
    },
  };
  await expect(saveNutritionPlanV4In(tx, intent(original()))).rejects.toBe(error);
});

it('wrapper and direct seam produce equal SQL requests/results and statement order', async () => {
  const wrapped = fixture(),
    direct = fixture();
  let n = 30;
  const result = await wrapped.writer.savePlanV4('synthetic', intent(wrapped.prior));
  const counterpart = await saveNutritionPlanV4In(direct.tx, intent(direct.prior), {
    now: () => new Date(at),
    id: () => uuid(n++),
  });
  expect(counterpart).toEqual(result);
  expect(direct.calls).toEqual(wrapped.calls);
});
