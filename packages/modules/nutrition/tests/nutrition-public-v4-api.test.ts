import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type TransportRequest } from '@workout/contracts/core';
import { nutritionPlanVersionV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import { createNutritionApi } from '../src/nutrition-api';
import { retainedNutritionReconnectDraft } from '../src/nutrition-race-reconnect-editor';
const planId = '81ae88de-3019-4de3-a4b4-9da31df90916',
  versionId = '49440716-5da4-43db-b5c5-8bcda106a8bb',
  eventId = 'ba41f001-1e35-46cf-ad27-d6e4c2c7f581';
const record = nutritionPlanVersionV3Schema.parse({
  schemaVersion: 3,
  planId,
  versionId,
  version: 1,
  previousVersionId: null,
  approvedAt: '2026-10-06T00:00:00Z',
  approvalId: eventId,
  period: { from: '2026-10-01', toInclusive: '2026-10-31' },
  timezone: 'UTC',
  purpose: 'Retained meal',
  linkedTrainingPlanVersionId: null,
  items: [
    {
      id: '한글-' + 'x'.repeat(201),
      planVersionId: versionId,
      title: 'Meal',
      category: 'before',
      anchor: { kind: 'disconnected', entity: 'race' },
      foods: [
        {
          description: 'Zero',
          foodVersionId: null,
          quantity: 0,
          unit: 'g',
          sourceBasis: 'unknown',
        },
      ],
      targets: [],
      instructions: 'Preserve',
      evidenceIds: [],
      source: 'user_confirmed',
    },
  ],
  raceTimingPins: [],
  itemRaceTimingBindings: [],
});
const draft = retainedNutritionReconnectDraft(record);
if (!draft) throw Error('FIXTURE');
const previewInput = {
  schemaVersion: 4,
  expectedHeadVersionId: versionId,
  draft: {
    ...draft,
    items: draft.items.map((item) => ({
      ...item,
      anchor: {
        kind: 'relative',
        entity: 'race',
        entityId: eventId,
        point: 'start',
        offsetMinutes: 0,
      },
    })),
  },
  expectedRaceHeads: [{ namespace: 'race-event', eventId, revision: 2 }],
  reconnectItemIds: [record.items[0]?.id],
};
const approveInput = {
  schemaVersion: 4,
  intent: {
    schemaVersion: 3,
    command: {
      kind: 'update',
      expectedHeadVersionId: versionId,
      confirmed: true,
      draft: previewInput.draft,
    },
    expectedRaceHeads: previewInput.expectedRaceHeads,
    reconnectItemIds: previewInput.reconnectItemIds,
  },
};
function boundary(body: unknown, status = 200) {
  const request = vi.fn(async (_: TransportRequest) =>
    transportReplySchema.parse({ status, body, traceId: null }),
  );
  return { request, api: createNutritionApi({ request }) };
}
describe('explicit public nutrition V4 transport boundary', () => {
  it('reads exact capability booleans without writing or treating them as permission', async () => {
    const b = boundary({
      schemaVersion: 1,
      readV4: true,
      previewV4: false,
      standaloneApprovalV4: true,
    });
    expect(await b.api.capabilitiesV4()).toEqual({
      schemaVersion: 1,
      readV4: true,
      previewV4: false,
      standaloneApprovalV4: true,
    });
    expect(b.request.mock.calls[0]?.[0]).toMatchObject({
      method: 'GET',
      path: '/bff/v1/nutrition/plans/capabilities',
      body: null,
      idempotencyKey: null,
    });
    await expect(
      boundary({
        schemaVersion: 1,
        readV4: true,
        previewV4: true,
        standaloneApprovalV4: true,
        permission: true,
      }).api.capabilitiesV4(),
    ).rejects.toThrow();
  });
  it('keeps preview non-stored without a key and puts approval key exclusively in transport metadata', async () => {
    const p = boundary({
      schemaVersion: 4,
      status: 'unavailable',
      persistence: 'not_stored',
      freshness: 'not_checked',
      approvalAllowed: false,
      blocks: [{ itemId: null, code: 'PRIOR_UNAVAILABLE' }],
    });
    expect((await p.api.previewPlanV4(planId, previewInput)).approvalAllowed).toBe(false);
    expect(p.request.mock.calls[0]?.[0]).toMatchObject({
      path: `/bff/v1/nutrition/plans/${planId}/preview-v4`,
      method: 'POST',
      body: previewInput,
      idempotencyKey: null,
    });
    const a = boundary({ schemaVersion: 4, plan: record, notices: [] });
    expect((await a.api.approvePlanV4(planId, approveInput, 'stable_key_123')).plan).toEqual(
      record,
    );
    expect(a.request.mock.calls[0]?.[0]).toMatchObject({
      path: `/bff/v1/nutrition/plans/${planId}/approve-v4`,
      method: 'POST',
      body: approveInput,
      idempotencyKey: 'stable_key_123',
    });
  });
  it('rejects body credentials/authority, invalid IDs/key and unsupported item source before transport', async () => {
    const b = boundary(null);
    for (const body of [
      { ...previewInput, planId },
      { ...previewInput, idempotencyKey: 'stable_key_123' },
      { ...previewInput, confirmed: true },
      { ...previewInput, pins: [] },
    ])
      expect(() => b.api.previewPlanV4(planId, body)).toThrow();
    expect(() =>
      b.api.approvePlanV4(planId, { ...approveInput, tenant: 'other' }, 'stable_key_123'),
    ).toThrow();
    expect(() => b.api.approvePlanV4('opaque', approveInput, 'stable_key_123')).toThrow();
    expect(() => b.api.approvePlanV4(planId, approveInput, 'bad')).toThrow();
    expect(b.request).not.toHaveBeenCalled();
  });
  it('rejects counterfeit approval flag and foreign approval result, forwards finite HTTP errors', async () => {
    await expect(
      boundary({
        schemaVersion: 4,
        status: 'unavailable',
        persistence: 'not_stored',
        freshness: 'not_checked',
        approvalAllowed: true,
        blocks: [{ itemId: null, code: 'PRIOR_UNAVAILABLE' }],
      }).api.previewPlanV4(planId, previewInput),
    ).rejects.toThrow();
    await expect(
      boundary({
        schemaVersion: 4,
        plan: { ...record, planId: eventId },
        notices: [],
      }).api.approvePlanV4(planId, approveInput, 'stable_key_123'),
    ).rejects.toThrow('INVALID_APPROVAL_RESPONSE');
    await expect(
      boundary({ error: { code: 'PRIOR_HEAD_STALE' } }, 409).api.approvePlanV4(
        planId,
        approveInput,
        'stable_key_123',
      ),
    ).rejects.toMatchObject({ status: 409, code: 'PRIOR_HEAD_STALE' });
  });
  it('does not turn reviewed/AI metadata into manual source while projecting a lossless long-ID draft', () => {
    expect(draft?.items[0]?.id).toBe(record.items[0]?.id);
    expect(draft?.items[0]?.foods[0]?.quantity).toBe(0);
    expect(draft).not.toHaveProperty('raceTimingPins');
    expect(draft?.items[0]).not.toHaveProperty('planVersionId');
    expect(
      retainedNutritionReconnectDraft({
        ...record,
        items: record.items.map((item) => ({ ...item, source: 'reviewed_rule' })),
      }),
    ).toBeNull();
    expect(record.items[0]?.source).toBe('user_confirmed');
  });
  it('rejects paired foreign race read and forwards abort signal without fetching competitor modules', async () => {
    const race = {
      id: eventId,
      revision: 2,
      title: 'Race',
      localDate: '2026-10-06',
      localStartTime: '07:00',
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard', class: '5k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: null,
      planVersionId: null,
    };
    const controller = new AbortController(),
      b = boundary(race);
    await b.api.readReconnectRace(eventId, controller.signal);
    expect(b.request.mock.calls[0]?.[0]).toMatchObject({
      path: `/bff/v1/races/${eventId}`,
      method: 'GET',
      signal: controller.signal,
    });
    await expect(boundary({ ...race, id: planId }).api.readReconnectRace(eventId)).rejects.toThrow(
      'INVALID_RACE_RESPONSE',
    );
  });
});
