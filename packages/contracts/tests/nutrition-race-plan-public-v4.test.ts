import { describe, expect, it } from 'vitest';
import {
  nutritionPlanPublicApproveV4RequestSchema,
  nutritionPlanPublicPreviewV4RequestSchema,
  nutritionPlanPublicPreviewV4Schema,
  nutritionPlanPublicCapabilitiesV4Schema,
  nutritionPlanPublicApprovalV4ResultSchema,
} from '../src/nutrition-race-plan-public-v4.js';
const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  eventId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const item = {
  id: '식사-' + '한'.repeat(1001),
  category: 'meal',
  title: 'Meal',
  anchor: { kind: 'disconnected', entity: 'race' },
  foods: [
    {
      foodVersionId: null,
      description: 'portion',
      quantity: 0,
      unit: 'g',
      sourceBasis: 'manual_total',
    },
  ],
  targets: [],
  instructions: 'preserved',
  evidenceIds: [],
  source: 'user_confirmed',
};
const draft = {
  period: { from: '2080-01-01', toInclusive: '2080-01-31' },
  timezone: 'UTC',
  purpose: 'Reconnect',
  linkedTrainingPlanVersionId: null,
  items: [item],
};
const body = {
  schemaVersion: 4,
  expectedHeadVersionId: versionId,
  draft,
  expectedRaceHeads: [],
  reconnectItemIds: [],
};
const approval = {
  schemaVersion: 4,
  intent: {
    schemaVersion: 3,
    command: { kind: 'update', expectedHeadVersionId: versionId, confirmed: true, draft },
    expectedRaceHeads: [],
    reconnectItemIds: [],
  },
};
function safePlan() {
  const { evidenceIds, source, ...safe } = item;
  void evidenceIds;
  void source;
  return { ...draft, items: [safe] };
}
const suspended = { state: 'suspended', reason: 'race_disconnected' };
function comparison() {
  return {
    schemaVersion: 4,
    status: 'projected',
    expectedPlan: { planId, versionId, version: 2 },
    expectedRaceHeads: [],
    before: safePlan(),
    after: safePlan(),
    items: [{ itemId: item.id, change: 'preserved', before: suspended, after: suspended }],
    notices: [],
    blocks: [],
    persistence: 'not_stored',
    freshness: 'not_checked',
    approvalAllowed: false,
  };
}
describe('explicit public nutrition V4 boundary without approval authority', () => {
  it('accepts canonical long IDs and preserves food zero/null and disconnected state', () => {
    expect(nutritionPlanPublicPreviewV4RequestSchema.parse(body)).toEqual(body);
    expect(nutritionPlanPublicApproveV4RequestSchema.parse(approval)).toEqual(approval);
    expect(nutritionPlanPublicPreviewV4Schema.parse(comparison())).toEqual(comparison());
  });
  it.each(['planId', 'idempotencyKey', 'confirmed', 'raceTimingPins', 'affectedItemIds'])(
    'rejects preview alias/server field %s',
    (key) => {
      expect(
        nutritionPlanPublicPreviewV4RequestSchema.safeParse({ ...body, [key]: planId }).success,
      ).toBe(false);
    },
  );
  it.each(['planId', 'idempotencyKey', 'approvalId'])(
    'rejects nested approval alias %s even equal',
    (key) => {
      expect(
        nutritionPlanPublicApproveV4RequestSchema.safeParse({
          ...approval,
          intent: { ...approval.intent, command: { ...approval.intent.command, [key]: planId } },
        }).success,
      ).toBe(false);
    },
  );
  it('requires explicit confirmation but no preview confirmation', () => {
    expect(
      nutritionPlanPublicApproveV4RequestSchema.safeParse({
        ...approval,
        intent: { ...approval.intent, command: { ...approval.intent.command, confirmed: false } },
      }).success,
    ).toBe(false);
  });
  it('requires exact sorted unique reconnect and race expectation roster', () => {
    const connected = {
      ...item,
      anchor: {
        kind: 'relative',
        entity: 'race',
        entityId: eventId,
        point: 'start',
        offsetMinutes: 0,
      },
    };
    const next = {
      ...body,
      draft: { ...draft, items: [connected] },
      reconnectItemIds: [item.id],
      expectedRaceHeads: [{ namespace: 'race-event', eventId, revision: 1 }],
    };
    expect(nutritionPlanPublicPreviewV4RequestSchema.safeParse(next).success).toBe(true);
    expect(
      nutritionPlanPublicPreviewV4RequestSchema.safeParse({
        ...next,
        reconnectItemIds: [item.id, item.id],
      }).success,
    ).toBe(false);
    expect(
      nutritionPlanPublicPreviewV4RequestSchema.safeParse({ ...next, expectedRaceHeads: [] })
        .success,
    ).toBe(false);
  });
  it('rejects empty IDs rather than assigning a scalar length maximum', () => {
    expect(
      nutritionPlanPublicPreviewV4RequestSchema.safeParse({
        ...body,
        draft: { ...draft, items: [{ ...item, id: '' }] },
      }).success,
    ).toBe(false);
  });
  it('distinguishes unknown quantities from zero without mutation', () => {
    const read = comparison();
    const unknown = {
      ...read,
      before: {
        ...read.before,
        items: read.before.items.map((i) => ({
          ...i,
          foods: i.foods.map((f) => ({ ...f, quantity: null })),
        })),
      },
      after: {
        ...read.after,
        items: read.after.items.map((i) => ({
          ...i,
          foods: i.foods.map((f) => ({ ...f, quantity: null })),
        })),
      },
    };
    const parsed = nutritionPlanPublicPreviewV4Schema.parse(unknown);
    if (parsed.status === 'unavailable') throw new Error('Expected comparison');
    expect(parsed.before.items[0]?.foods[0]?.quantity).toBeNull();
  });
  it('rejects private evidence, source digests and foreign unknown fields', () => {
    const result = comparison();
    expect(
      nutritionPlanPublicPreviewV4Schema.safeParse({
        ...result,
        before: {
          ...result.before,
          items: [{ ...result.before.items[0], evidenceIds: ['secret'] }],
        },
      }).success,
    ).toBe(false);
    expect(
      nutritionPlanPublicPreviewV4Schema.safeParse({ ...result, sourceDigest: 'a'.repeat(64) })
        .success,
    ).toBe(false);
  });
  it('rejects duplicate/missing timing rows and invented source availability', () => {
    const result = comparison();
    expect(
      nutritionPlanPublicPreviewV4Schema.safeParse({
        ...result,
        items: [...result.items, ...result.items],
      }).success,
    ).toBe(false);
    expect(nutritionPlanPublicPreviewV4Schema.safeParse({ ...result, items: [] }).success).toBe(
      false,
    );
    expect(
      nutritionPlanPublicPreviewV4Schema.safeParse({
        ...result,
        items: [
          {
            ...result.items[0],
            after: { state: 'unresolved', reason: 'missing_anchor', detail: null },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects a preserved body change and blocked result with no block', () => {
    const result = comparison();
    expect(
      nutritionPlanPublicPreviewV4Schema.safeParse({
        ...result,
        after: { ...result.after, purpose: 'changed' },
      }).success,
    ).toBe(true);
    expect(
      nutritionPlanPublicPreviewV4Schema.safeParse({
        ...result,
        after: {
          ...result.after,
          items: result.after.items.map((i) => ({ ...i, title: 'changed' })),
        },
      }).success,
    ).toBe(false);
    expect(
      nutritionPlanPublicPreviewV4Schema.safeParse({ ...result, status: 'blocked' }).success,
    ).toBe(false);
  });
  it('unavailable contains no fabricated item or planned body', () => {
    const base = {
      schemaVersion: 4,
      status: 'unavailable',
      blocks: [{ itemId: null, code: 'PRIOR_UNAVAILABLE' }],
      persistence: 'not_stored',
      freshness: 'not_checked',
      approvalAllowed: false,
    };
    expect(nutritionPlanPublicPreviewV4Schema.safeParse(base).success).toBe(true);
    expect(
      nutritionPlanPublicPreviewV4Schema.safeParse({ ...base, before: safePlan() }).success,
    ).toBe(false);
    expect(
      nutritionPlanPublicPreviewV4Schema.safeParse({
        ...base,
        blocks: [{ itemId: item.id, code: 'PRIOR_UNAVAILABLE' }],
      }).success,
    ).toBe(false);
  });
  it('support booleans cannot carry permission claims', () => {
    expect(
      nutritionPlanPublicCapabilitiesV4Schema.safeParse({
        schemaVersion: 1,
        readV4: true,
        previewV4: true,
        standaloneApprovalV4: true,
      }).success,
    ).toBe(true);
    expect(
      nutritionPlanPublicCapabilitiesV4Schema.safeParse({
        schemaVersion: 1,
        readV4: true,
        previewV4: true,
        standaloneApprovalV4: true,
        approvalAllowed: true,
      }).success,
    ).toBe(false);
  });
  it('requires exact result notice membership and bounded record', () => {
    const plan = {
      ...draft,
      schemaVersion: 4,
      planId,
      versionId,
      version: 2,
      previousVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      approvalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      approvedAt: '2080-01-01T00:00:00.000Z',
      items: [{ ...item, planVersionId: versionId }],
      raceTimingPins: [],
      itemRaceTimingBindings: [],
    };
    const result = { schemaVersion: 4, plan, notices: [] };
    expect(nutritionPlanPublicApprovalV4ResultSchema.parse(result)).toEqual(result);
    expect(
      nutritionPlanPublicApprovalV4ResultSchema.safeParse({
        ...result,
        notices: [{ itemId: 'absent', code: 'UNRESOLVED_PRESERVED' }],
      }).success,
    ).toBe(false);
    const notice = { itemId: item.id, code: 'UNRESOLVED_PRESERVED' };
    expect(
      nutritionPlanPublicApprovalV4ResultSchema.safeParse({ ...result, notices: [notice, notice] })
        .success,
    ).toBe(false);
    expect(
      nutritionPlanPublicApprovalV4ResultSchema.safeParse({ ...result, plan: {} }).success,
    ).toBe(false);
  });
  it('rejects bytes/depth/accessors/cycles before getter execution', () => {
    expect(
      nutritionPlanPublicPreviewV4RequestSchema.safeParse({
        ...body,
        draft: { ...draft, purpose: 'x'.repeat(524288) },
      }).success,
    ).toBe(false);
    let called = 0;
    const input = {
      get schemaVersion() {
        called++;
        return 4;
      },
    };
    expect(nutritionPlanPublicPreviewV4RequestSchema.safeParse(input).success).toBe(false);
    expect(called).toBe(0);
    const cycle: Record<string, unknown> = {};
    cycle['child'] = cycle;
    expect(nutritionPlanPublicPreviewV4Schema.safeParse(cycle).success).toBe(false);
    let deep: unknown = null;
    for (let i = 0; i < 65; i++) deep = { value: deep };
    expect(nutritionPlanPublicPreviewV4Schema.safeParse(deep).success).toBe(false);
  });
});
