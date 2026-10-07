import { createNutritionRacePlanV4PreviewRepository } from '../src/nutrition-race-plan-v4-preview.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  nutritionPlanVersionV4Schema,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
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
    async snapshotTenant(_athlete, fn) {
      return fn(tx);
    },
    async close() {},
  };
  let sequence = 30;
  const writer = createNutritionRacePlanV4Writer(db, {
    now: () => new Date(at),
    id: () => uuid(sequence++),
  });
  return {
    prior,
    calls,
    commits,
    writer,
    preview: createNutritionRacePlanV4PreviewRepository(db),
    db,
  };
}

function request(prior: NutritionPlanVersionCompatibleV4) {
  const originalIntent = intent(prior),
    { idempotencyKey, confirmed, kind, ...command } = originalIntent.intent.command;
  void idempotencyKey;
  void confirmed;
  void kind;
  return {
    schemaVersion: 4,
    ...command,
    expectedRaceHeads: originalIntent.intent.expectedRaceHeads,
    reconnectItemIds: [],
  };
}
it('captures frozen before/current changed after with zero/null preserved and no writer/receipt calls', async () => {
  const f = fixture(),
    input = request(f.prior),
    original = JSON.stringify(f.prior);
  const changed = input.draft.items[1];
  if (!changed) throw Error('fixture');
  changed.instructions = 'Explicit changed action';
  const result = await f.preview.previewPlanV4('synthetic', input);
  expect(result).toMatchObject({
    status: 'projected',
    persistence: 'not_stored',
    approvalAllowed: false,
    items: [
      {
        itemId: 'a',
        change: 'preserved',
        before: { localTime: '06:30:00' },
        after: { localTime: '06:30:00' },
      },
      {
        itemId: 'b',
        change: 'affected',
        before: { localTime: '06:30:00' },
        after: { localTime: '09:30:00' },
      },
    ],
  });
  expect(JSON.stringify(f.prior)).toBe(original);
  expect(f.commits).toEqual([]);
  expect(
    f.calls.every(
      (c) => !/(^\s*(INSERT|UPDATE|DELETE)\b|command_receipt|commit_nutrition)/.test(c.sql),
    ),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain('sourceDigest');
  expect(JSON.stringify(result)).not.toContain('approvalId');
  if (result.status === 'unavailable') throw Error('fixture');
  expect(result.after.items[0]?.foods.map((food) => food.quantity)).toEqual([0, null]);
});
it('changed unknown timing preserves full comparison and explicit item block', async () => {
  const f = fixture({ unknownStart: true }),
    input = request(f.prior);
  const item = input.draft.items[1];
  if (!item) throw Error('fixture');
  item.instructions = 'changed';
  const result = await f.preview.previewPlanV4('synthetic', input);
  expect(result).toMatchObject({
    status: 'blocked',
    blocks: [{ itemId: 'b', code: 'TIMING_UNRESOLVED' }],
    items: [
      { itemId: 'a', change: 'preserved' },
      { itemId: 'b', after: { state: 'unresolved' } },
    ],
  });
  expect(f.commits).toEqual([]);
});
it('stale/absent source gives bodyless finite result; app withdrawal rejects processing', async () => {
  const absent = fixture({ absentPrior: true });
  expect(await absent.preview.previewPlanV4('synthetic', request(absent.prior))).toEqual({
    schemaVersion: 4,
    status: 'unavailable',
    persistence: 'not_stored',
    freshness: 'not_checked',
    approvalAllowed: false,
    blocks: [{ itemId: null, code: 'PRIOR_UNAVAILABLE' }],
  });
  const stale = fixture({ stale: true });
  expect(await stale.preview.previewPlanV4('synthetic', request(stale.prior))).toMatchObject({
    status: 'unavailable',
    blocks: [{ code: 'RACE_STALE' }],
  });
  const withdrawn = fixture({ app: false });
  await expect(
    withdrawn.preview.previewPlanV4('synthetic', request(withdrawn.prior)),
  ).rejects.toThrow('APP_CONSENT_REQUIRED');
  expect(withdrawn.calls.some((c) => c.sql.includes('nutrition_plan_head'))).toBe(false);
});
it('rejects approval metadata/getters/oversize before database and never falls back from snapshot', async () => {
  const f = fixture();
  for (const extra of [{ confirmed: true }, { idempotencyKey: 'fake' }, { raceTimingPins: [] }])
    await expect(
      f.preview.previewPlanV4('synthetic', { ...request(f.prior), ...extra }),
    ).rejects.toThrow();
  let read = false;
  const getter = {
    get planId() {
      read = true;
      return f.prior.planId;
    },
  };
  await expect(f.preview.previewPlanV4('synthetic', getter)).rejects.toThrow();
  expect(read).toBe(false);
  expect(f.calls).toEqual([]);
  delete f.db.snapshotTenant;
  expect(() => f.preview.previewPlanV4('synthetic', request(f.prior))).toThrow('SNAPSHOT_REQUIRED');
});

it('new/removed item union has exact null sides and no stored IDs leak', async () => {
  const f = fixture(),
    input = request(f.prior);
  const original = input.draft.items[0];
  if (!original) throw Error('fixture');
  input.draft.items = [
    original,
    { ...original, id: 'new opaque 식사', instructions: 'Explicit new action' },
  ];
  const result = await f.preview.previewPlanV4('synthetic', input);
  expect(result).toMatchObject({
    status: 'projected',
    items: [
      { itemId: 'a', change: 'preserved' },
      { itemId: 'b', change: 'removed', after: null },
      { itemId: 'new opaque 식사', change: 'new', before: null, after: { localTime: '09:30:00' } },
    ],
  });
  if (result.status === 'unavailable') throw Error('fixture');
  expect(Object.keys(result.after.items[0] ?? {})).not.toContain('planVersionId');
  expect(Object.keys(result.after.items[0] ?? {})).not.toContain('evidenceIds');
  expect(f.commits).toEqual([]);
});
