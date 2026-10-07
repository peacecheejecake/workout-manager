import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { transportReplySchema } from '@workout/contracts/core';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { nutritionPlanVersionV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { createNutritionApi } from '../src/nutrition-api';
import { NutritionWorkspace } from '../src/nutrition-workspace';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';

afterEach(cleanup);
const planId = '81ae88de-3019-4de3-a4b4-9da31df90916';
const versionId = '49440716-5da4-43db-b5c5-8bcda106a8bb';
const eventId = 'ba41f001-1e35-46cf-ad27-d6e4c2c7f581';
function record() {
  const item = {
    planVersionId: versionId,
    category: 'before',
    foods: [
      {
        description: 'Known zero',
        foodVersionId: null,
        quantity: 0,
        unit: 'g',
        sourceBasis: 'unknown',
      },
      {
        description: 'Unknown portion',
        foodVersionId: null,
        quantity: null,
        unit: 'unspecified',
        sourceBasis: 'unknown',
      },
    ],
    targets: [
      {
        metric: 'energy',
        amount: { min: 0, max: 100, unit: 'kcal', basis: 'user_confirmed', evidenceIds: [] },
      },
    ],
    instructions: 'User instructions',
    evidenceIds: [],
    source: 'user_confirmed',
  };
  const pin = {
    pinVersion: 1,
    namespace: 'race-event-revision',
    eventId,
    eventRevision: 2,
    sourceDigestVersion: 'race-event-values-canonical-v1',
    sourceDigest: 'a'.repeat(64),
    localDate: '2026-10-06',
    localStartTime: '07:00',
    timezone: 'UTC',
    start: { state: 'known', instant: '2026-10-06T07:00:00Z' },
    end: { state: 'unknown', reason: 'race_end_not_recorded' },
  };
  return nutritionPlanVersionV4Schema.parse({
    schemaVersion: 4,
    planId,
    versionId,
    version: 1,
    previousVersionId: null,
    approvedAt: '2026-10-06T00:00:00Z',
    approvalId: '5ce5b145-8d14-45c7-8642-8cd2fd778523',
    period: { from: '2026-10-01', toInclusive: '2026-10-31' },
    timezone: 'UTC',
    purpose: 'Frozen approved nutrition',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        ...item,
        id: 'active',
        title: 'Frozen race',
        anchor: {
          kind: 'relative',
          entity: 'race',
          entityId: eventId,
          point: 'start',
          offsetMinutes: -30,
        },
      },
      {
        ...item,
        id: 'disconnected',
        title: 'Suspended race',
        anchor: { kind: 'disconnected', entity: 'race' },
      },
      {
        ...item,
        id: 'absolute',
        title: 'Absolute meal',
        anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'UTC' },
      },
    ],
    raceTimingPins: [pin],
    itemRaceTimingBindings: [
      { itemId: 'active', binding: { state: 'captured', eventId, eventRevision: 2 } },
    ],
  });
}
function read(head: unknown = record()) {
  return {
    schemaVersion: 4,
    planId,
    head,
    history: [{ versionId, version: 1, approvedAt: '2026-10-06T00:00:00Z' }],
  };
}
function boundary(body: unknown) {
  const request = vi.fn(async (_request: TransportRequest) =>
    transportReplySchema.parse({ status: 200, body, traceId: null }),
  );
  return { request, transport: { request } satisfies AuthenticatedTransport };
}
describe('explicit nutrition V4 read', () => {
  it('requests protocol4 list and detail, rejects legacy envelope and foreign paired ID', async () => {
    const detail = boundary(read());
    await createNutritionApi(detail.transport).readPlan(planId);
    expect(detail.request.mock.calls[0]?.[0].path).toBe(
      `/bff/v1/nutrition/plans/${planId}?maxSchemaVersion=4`,
    );
    const list = boundary({ schemaVersion: 4, plans: [record()], nextCursor: null });
    await createNutritionApi(list.transport).listPlans('2026-10-01', '2026-10-31');
    expect(
      new URL(list.request.mock.calls[0]?.[0].path ?? '', 'https://fixture.test').searchParams.get(
        'maxSchemaVersion',
      ),
    ).toBe('4');
    const { schemaVersion: _schema, ...legacy } = read();
    await expect(createNutritionApi(boundary(legacy).transport).readPlan(planId)).rejects.toThrow();
    await expect(
      createNutritionApi(boundary({ ...read(), planId: eventId, head: null }).transport).readPlan(
        planId,
      ),
    ).rejects.toThrow('INVALID_PLAN_RESPONSE');
  });
  it('shows frozen facts, disconnected timing suspension, zero/null foods/goals/history without write or current source fetch', async () => {
    const { transport, request } = boundary(read());
    render(
      <NutritionWorkspace
        athleteId="alice"
        sessionId="one"
        transport={transport}
        route={{ kind: 'plan', planId }}
      />,
    );
    await screen.findByRole('region', { name: '승인된 영양 계획 읽기 전용' });
    expect(screen.getByText(/저장된 대회 revision 2/).textContent).toContain(
      '2026-10-06T07:00:00Z',
    );
    expect(screen.getByText(/대회 연결 해제 · 시각 사용 중단/).textContent).toContain(
      '명시 재연결과 재승인 필요',
    );
    expect(screen.getAllByText(/Known zero · 0 g/)).toHaveLength(3);
    expect(screen.getAllByText(/Unknown portion · 수량 미상/)).toHaveLength(3);
    expect(screen.getAllByText(/energy 목표 0–100 kcal/)).toHaveLength(3);
    expect(screen.getByText(/2026-10-06 · 시각 미지정 · UTC/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '승인 버전 이력' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '확인한 계획 저장' })).toBeNull();
    expect(screen.queryByRole('button', { name: /복제/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '서버 최신 버전 확인' }));
    expect(
      request.mock.calls.every(
        ([input]) => input.method === 'GET' && input.path.includes('?maxSchemaVersion=4'),
      ),
    ).toBe(true);
  });
  it.each([2, 3])(
    'renders explicit V%s approved record read-only without converting it to V1',
    async (schemaVersion) => {
      const source = record();
      const head = {
        ...source,
        schemaVersion,
        items: schemaVersion === 2 ? [source.items[0]] : source.items,
      };
      const { transport, request } = boundary(read(head));
      render(
        <NutritionWorkspace
          athleteId="alice"
          sessionId="one"
          transport={transport}
          route={{ kind: 'plan', planId }}
        />,
      );
      await screen.findByRole('region', { name: '승인된 영양 계획 읽기 전용' });
      expect(screen.queryByRole('textbox', { name: '계획 목적' })).toBeNull();
      expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
    },
  );
  it('rejects malformed roster rather than displaying/repinning it, and retry is read-only', async () => {
    const { transport, request } = boundary(read({ ...record(), itemRaceTimingBindings: [] }));
    render(
      <NutritionWorkspace
        athleteId="alice"
        sessionId="one"
        transport={transport}
        route={{ kind: 'plan', planId }}
      />,
    );
    await screen.findByRole('alert');
    expect(screen.queryByRole('region', { name: '승인된 영양 계획 읽기 전용' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '다시 불러오기' }));
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
  it('keeps the V1 draft and blocks stale saving when the refreshed head becomes V4', async () => {
    const {
      schemaVersion: _schema,
      raceTimingPins: _pins,
      itemRaceTimingBindings: _bindings,
      ...base
    } = record();
    const legacy = nutritionPlanVersionSchema.parse({ ...base, items: [base.items[2]] });
    const { transport, request } = boundary(read(legacy));
    render(
      <NutritionWorkspace
        athleteId="alice"
        sessionId="one"
        transport={transport}
        route={{ kind: 'plan', planId }}
      />,
    );
    const purpose = await screen.findByRole('textbox', { name: '계획 목적' });
    await userEvent.clear(purpose);
    await userEvent.type(purpose, 'Unsent private draft');
    const current = record();
    const nextId = 'f940c86c-2b04-4aa9-81d5-3eddb45c4f41';
    const latest = nutritionPlanVersionV4Schema.parse({
      ...current,
      versionId: nextId,
      version: 2,
      previousVersionId: versionId,
      items: current.items.map((item) => ({ ...item, planVersionId: nextId })),
    });
    request.mockImplementation(async (_input: TransportRequest) =>
      transportReplySchema.parse({ status: 200, body: read(latest), traceId: null }),
    );
    await userEvent.click(screen.getByRole('button', { name: '서버 최신 버전 확인' }));
    await screen.findByText(/서버에는 버전 2/);
    expect(screen.getByDisplayValue('Unsent private draft')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /계획 내용을 직접 확인했고/ }));
    expect(screen.getByRole('button', { name: '확인한 계획 저장' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
  it('shows suspended list anchors with explicit V4 query and retains no private cache after session switch', async () => {
    const { transport, request } = boundary(null);
    request.mockImplementation(async (input: TransportRequest) =>
      transportReplySchema.parse({
        status: 200,
        traceId: null,
        body: input.path.startsWith('/bff/v1/nutrition/plans?')
          ? { schemaVersion: 4, plans: [record()], nextCursor: null }
          : input.path.startsWith('/bff/v1/nutrition/intakes?')
            ? {
                entries: [],
                coverage: {
                  from: '2026-10-01T00:00:00Z',
                  toExclusive: '2026-11-01T00:00:00Z',
                  status: 'unknown',
                  knownEntries: 0,
                  entriesWithUnknownNutrients: 0,
                },
                nextCursor: null,
              }
            : { foods: [], nextCursor: null },
      }),
    );
    const view = render(
      <NutritionWorkspace
        athleteId="alice"
        sessionId="one"
        transport={transport}
        route={{ kind: 'dashboard' }}
      />,
    );
    await screen.findByText(/Frozen approved nutrition · 버전 1/);
    expect(screen.getByText(/대회 연결 해제 · 시각 사용 중단/)).toBeTruthy();
    const other = boundary(read(null));
    view.rerender(
      <NutritionWorkspace
        athleteId="bob"
        sessionId="two"
        transport={other.transport}
        route={{ kind: 'plan', planId }}
      />,
    );
    await screen.findByText('계획을 찾을 수 없습니다.');
    expect(screen.queryByText(/Frozen approved nutrition/)).toBeNull();
  });
});
