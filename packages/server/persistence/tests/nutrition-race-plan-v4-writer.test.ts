import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  nutritionPlanVersionCompatibleV4Schema,
  nutritionPlanVersionV4Schema,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import { saveNutritionPlanV3IntentSchema } from '@workout/contracts/nutrition-race-plan-v3';
import {
  createNutritionRacePlanV4Writer,
  deriveNutritionAffectedItemIdsV4,
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
  return { prior, calls, commits, writer };
}
it('keeps unchanged original pin1 and captures changed item pin2 separately without mutating prior/source/foods', async () => {
  const test = fixture(),
    input = intent(test.prior),
    before = JSON.stringify(test.prior);
  const changed = input.intent.command.draft.items.find((entry) => entry.id === 'b');
  if (!changed) throw new Error('MISSING_ITEM');
  changed.instructions = 'Explicit new approval';
  const result = await test.writer.savePlanV4('synthetic', input);
  expect(JSON.stringify(test.prior)).toBe(before);
  const saved = nutritionPlanVersionV4Schema.parse(result.plan);
  expect(saved.raceTimingPins.map((pin) => pin.eventRevision)).toEqual([1, 2]);
  expect(first(saved.raceTimingPins)).toEqual(oldPin);
  expect(
    saved.itemRaceTimingBindings.map((entry) =>
      entry.binding.state === 'captured' ? entry.binding.eventRevision : null,
    ),
  ).toEqual([1, 2]);
  expect(first(saved.items).foods).toEqual(first(test.prior.items).foods);
  expect(test.commits).toHaveLength(1);
  expect(test.calls.some((call) => /^(INSERT|UPDATE|DELETE) /u.test(call.sql))).toBe(false);
  const commit = test.calls.find((call) => call.sql.includes('commit_nutrition_plan_v4'));
  if (!commit) throw new Error('MISSING_COMMIT');
  const flat = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(z.string().parse(commit.values?.[2])));
  expect(flat).toMatchObject({
    operation: 'nutrition_plan_save',
    intentSchemaVersion: 4,
    kind: 'update',
    expectedHeadVersionId: test.prior.versionId,
  });
  expect(flat).not.toHaveProperty('intent');
  expect(flat).not.toHaveProperty('affectedItemIds');
  expect(flat).not.toHaveProperty('raceTimingPins');
});
it('a committed exact receipt precedes app/source/CAS and compares SQL jsonb digest without JS hash substitution', async () => {
  const test = fixture({ receipt: true, app: false });
  expect((await test.writer.savePlanV4('synthetic', intent(test.prior))).plan).toEqual(test.prior);
  expect(
    test.calls
      .map((call) => call.sql)
      .filter(
        (sql) =>
          sql.includes('race_event') ||
          sql.includes('consent') ||
          sql.includes('nutrition_plan_head'),
      ),
  ).toEqual([]);
  expect(test.calls.find((call) => call.sql.includes('command_receipt'))?.sql).toContain(
    "convert_to(($3::jsonb)::text,'UTF8')",
  );
  expect(test.commits).toHaveLength(0);
});
it('preserves unresolved notices on exact receipt replay without querying current race sources', async () => {
  const value = original();
  if (!('schemaVersion' in value)) throw new Error('MISSING_V4');
  const unknown = nutritionPlanVersionCompatibleV4Schema.parse({
    ...value,
    raceTimingPins: [
      {
        ...oldPin,
        start: { state: 'unknown', reason: 'start_time_not_recorded' },
        localStartTime: null,
      },
    ],
  });
  const test = fixture({ receipt: true, prior: unknown });
  const result = await test.writer.savePlanV4('synthetic', intent(unknown));
  expect(result.notices).toEqual([
    { itemId: 'a', code: 'UNRESOLVED_PRESERVED' },
    { itemId: 'b', code: 'UNRESOLVED_PRESERVED' },
  ]);
  expect(test.calls.some((call) => call.sql.includes('race_event'))).toBe(false);
});
it.each([{ matches: false }, { extraReceipt: true }])(
  'rejects conflicting or malformed minimal receipt %j without fresh writes',
  async (options) => {
    const test = fixture({ receipt: true, ...options });
    await expect(test.writer.savePlanV4('synthetic', intent(test.prior))).rejects.toThrow();
    expect(test.commits).toHaveLength(0);
  },
);
it('absent app and stale/foreign prior cannot reach source or commit', async () => {
  const denied = fixture({ app: false });
  await expect(denied.writer.savePlanV4('synthetic', intent(denied.prior))).rejects.toMatchObject({
    code: 'APP_CONSENT_REQUIRED',
  });
  const stale = fixture();
  const input = intent(stale.prior);
  input.intent.command.expectedHeadVersionId = uuid(99);
  await expect(stale.writer.savePlanV4('synthetic', input)).rejects.toThrow('REVISION_CONFLICT');
  const foreign = fixture({ absentPrior: true });
  await expect(foreign.writer.savePlanV4('synthetic', intent(foreign.prior))).rejects.toThrow(
    'PLAN_NOT_FOUND',
  );
  expect(
    [...denied.calls, ...stale.calls, ...foreign.calls].some(
      (call) => call.sql.includes('commit_nutrition_plan_v4') || call.sql.includes('race_event'),
    ),
  ).toBe(false);
});
function disconnected() {
  const originalRecord = original();
  const { schemaVersion, raceTimingPins, itemRaceTimingBindings, ...legacy } =
    nutritionPlanVersionV4Schema.parse(originalRecord);
  void schemaVersion;
  void raceTimingPins;
  void itemRaceTimingBindings;
  return nutritionPlanVersionCompatibleV4Schema.parse({
    ...legacy,
    schemaVersion: 3,
    items: [{ ...first(legacy.items), anchor: { kind: 'disconnected', entity: 'race' } }],
    raceTimingPins: [],
    itemRaceTimingBindings: [],
  });
}
it('retains authenticated disconnected food/actual facts while consuming no race source', async () => {
  const prior = disconnected(),
    test = fixture({ prior }),
    input = intent(prior);
  first(input.intent.command.draft.items).instructions = 'Approved instruction edit';
  const result = await test.writer.savePlanV4('synthetic', input);
  expect(first(result.plan.items).anchor).toEqual({ kind: 'disconnected', entity: 'race' });
  expect(first(result.plan.items).foods).toEqual(first(prior.items).foods);
  expect('schemaVersion' in result.plan ? result.plan.raceTimingPins : null).toEqual([]);
  expect(test.calls.some((call) => call.sql.includes('FROM race_event'))).toBe(false);
});
it('validates opaque Unicode origin IDs by exact unique membership independent of DB ordering', async () => {
  const base = disconnected();
  const prior = nutritionPlanVersionCompatibleV4Schema.parse({
    ...base,
    items: ['\u{10000}', '\uE000'].map((id) => ({ ...first(base.items), id })),
  });
  const input = intent(prior);
  const test = fixture({ prior, reverseOrigins: true });
  const result = await test.writer.savePlanV4('synthetic', input);
  expect(result.plan.items).toEqual(
    prior.items.map((entry) => ({ ...entry, planVersionId: result.plan.versionId })),
  );
  const duplicate = fixture({ prior, duplicateOrigins: true });
  await expect(duplicate.writer.savePlanV4('synthetic', input)).rejects.toThrow(
    'NUTRITION_V4_ORIGIN_REQUIRED',
  );
  expect(duplicate.commits).toHaveLength(0);
});
it('owned food preflight rejects absent refs and total byte overflow before materialization', async () => {
  const input = intent(original());
  first(first(input.intent.command.draft.items).foods).foodVersionId = uuid(90);
  for (const options of [{ foodCount: '0' }, { foodCount: '1', foodBytes: '4194304' }]) {
    const test = fixture(options);
    await expect(test.writer.savePlanV4('synthetic', input)).rejects.toThrow();
    expect(test.commits).toHaveLength(0);
    expect(test.calls.some((call) => call.sql.includes('FROM race_event'))).toBe(false);
  }
});
it('explicit reconnect captures only the user selected live source and requires exact prior origin', async () => {
  const prior = disconnected(),
    input = intent(original());
  input.intent.command.expectedHeadVersionId = prior.versionId;
  input.intent.command.draft.items = [first(input.intent.command.draft.items)];
  input.intent.reconnectItemIds = ['a'];
  const test = fixture({ prior });
  const saved = nutritionPlanVersionV4Schema.parse(
    (await test.writer.savePlanV4('synthetic', input)).plan,
  );
  expect(saved.raceTimingPins.map((pin) => pin.eventRevision)).toEqual([2]);
  expect(first(saved.items).anchor.kind).toBe('relative');
  const absent = fixture({ prior, origin: false });
  await expect(absent.writer.savePlanV4('synthetic', input)).rejects.toThrow(
    'NUTRITION_V4_ORIGIN_REQUIRED',
  );
  expect(absent.commits).toHaveLength(0);
});
it('blocks implicit reconnect/new disconnected forgery even when a boolean mock origin might be true', async () => {
  const prior = disconnected(),
    test = fixture({ prior }),
    input = intent(original());
  input.intent.command.draft.items = [first(input.intent.command.draft.items)];
  await expect(test.writer.savePlanV4('synthetic', input)).rejects.toThrow(
    'NUTRITION_V4_RECONNECT_REQUIRED',
  );
  const fake = fixture();
  const forged = intent(disconnected());
  await expect(fake.writer.savePlanV4('synthetic', forged)).rejects.toThrow(
    'NUTRITION_V4_ORIGIN_REQUIRED',
  );
  expect([...test.commits, ...fake.commits]).toHaveLength(0);
});
it.each([
  { stale: true },
  { scopeMismatch: true },
  { sourceBytes: '4194305' },
  { priorBytes: '524289' },
  { malformedPrior: true },
  { commitMismatch: true },
])('rejects stale/foreign/bounded/source/commit tuple errors %j', async (options) => {
  const test = fixture(options);
  await expect(test.writer.savePlanV4('synthetic', intent(test.prior))).rejects.toThrow();
  if (!options.commitMismatch) expect(test.commits).toHaveLength(0);
});
it('blocks changed unresolved race timing, while unchanged unknown prior remains an explicit notice', async () => {
  const changed = fixture({ unknownStart: true }),
    input = intent(changed.prior);
  first(input.intent.command.draft.items).instructions = 'Changed';
  await expect(changed.writer.savePlanV4('synthetic', input)).rejects.toThrow(
    'NUTRITION_V4_TIMING_UNRESOLVED',
  );
  expect(changed.commits).toHaveLength(0);
  const value = nutritionPlanVersionV4Schema.parse(original());
  const unknown = nutritionPlanVersionCompatibleV4Schema.parse({
    ...value,
    raceTimingPins: [
      {
        ...oldPin,
        localStartTime: null,
        start: { state: 'unknown', reason: 'start_time_not_recorded' },
      },
    ],
  });
  const preserved = fixture({ prior: unknown });
  expect((await preserved.writer.savePlanV4('synthetic', intent(unknown))).notices).toHaveLength(2);
});
it('preserves legacy unpinned binding and stable unresolved notices without live repinning', async () => {
  const { schemaVersion, raceTimingPins, itemRaceTimingBindings, ...legacy } =
    nutritionPlanVersionV4Schema.parse(original());
  void schemaVersion;
  void raceTimingPins;
  void itemRaceTimingBindings;
  const prior = nutritionPlanVersionCompatibleV4Schema.parse(legacy),
    test = fixture({ prior });
  const result = await test.writer.savePlanV4('synthetic', intent(prior)),
    saved = nutritionPlanVersionV4Schema.parse(result.plan);
  expect(saved.raceTimingPins).toEqual([]);
  expect(first(saved.itemRaceTimingBindings).binding.state).toBe('legacy_unpinned');
  expect(result.notices.filter((notice) => notice.code === 'UNRESOLVED_PRESERVED')).toHaveLength(2);
  const replay = fixture({ prior: saved, receipt: true });
  expect((await replay.writer.savePlanV4('synthetic', intent(saved))).notices).toEqual(
    result.notices,
  );
});
it('rejects client changed IDs/pins, unconfirmed and over-size intents before transaction reads', () => {
  const test = fixture(),
    input = intent(test.prior);
  for (const invalid of [
    { ...input, affectedItemIds: ['a'] },
    { ...input, raceTimingPins: [] },
    {
      ...input,
      intent: { ...input.intent, command: { ...input.intent.command, confirmed: false } },
    },
    { ...input, padding: 'x'.repeat(524289) },
  ])
    expect(() => test.writer.savePlanV4('synthetic', invalid)).toThrow();
  expect(test.calls).toHaveLength(0);
});
it('server difference preserves item identity and treats timezone/period/link changes as affected', () => {
  const prior = original(),
    input = intent(prior);
  expect(
    deriveNutritionAffectedItemIdsV4(prior, saveNutritionPlanV3IntentSchema.parse(input.intent)),
  ).toEqual([]);
  input.intent.command.draft.timezone = 'Asia/Seoul';
  expect(
    deriveNutritionAffectedItemIdsV4(prior, saveNutritionPlanV3IntentSchema.parse(input.intent)),
  ).toEqual(['a', 'b']);
});

it('writer ingress rejects accessors and custom array prototypes before receipt or DB reads', () => {
  const test = fixture();
  let called = false;
  expect(() =>
    test.writer.savePlanV4('synthetic', {
      get intent() {
        called = true;
        return {};
      },
    }),
  ).toThrow('SOURCE_INVALID');
  expect(called).toBe(false);
  expect(test.calls).toEqual([]);
  const input = intent(test.prior);
  Object.setPrototypeOf(input.intent.command.draft.items, {});
  expect(() => test.writer.savePlanV4('synthetic', input)).toThrow('SOURCE_INVALID');
  expect(test.calls).toEqual([]);
});
