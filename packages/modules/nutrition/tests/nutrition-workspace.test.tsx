import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { z } from 'zod';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  activeIntakeEntrySchema,
  nutritionPlanDraftSchema,
} from '@workout/contracts/nutrition-core';
import { NutritionWorkspace } from '../src/nutrition-workspace';
import { parseNutritionSegments } from '../src/nutrition-route';
import { unknownNutrients } from '../src/nutrition-model';

afterEach(() => cleanup());

const planId = '81ae88de-3019-4de3-a4b4-9da31df90916';
const versionId = '49440716-5da4-43db-b5c5-8bcda106a8bb';
const approvalId = '5ce5b145-8d14-45c7-8642-8cd2fd778523';
const nextVersionId = 'f940c86c-2b04-4aa9-81d5-3eddb45c4f41';
const trainingVersionId = 'c1274bb9-91ef-452e-8492-e4439574cde1';

function planVersion(targets: unknown[] = []) {
  return {
    planId,
    versionId,
    version: 1,
    previousVersionId: null,
    approvedAt: '2026-09-18T08:00:00Z',
    approvalId,
    period: { from: '2026-09-18', toInclusive: '2026-09-18' },
    timezone: 'Asia/Seoul',
    purpose: '원래 목적',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'morning',
        planVersionId: versionId,
        category: 'meal',
        title: '아침',
        anchor: { kind: 'absolute', date: '2026-09-18', localTime: null, timezone: 'Asia/Seoul' },
        foods: [
          {
            description: '바나나',
            foodVersionId: null,
            quantity: null,
            unit: 'unspecified',
            sourceBasis: 'unknown',
          },
        ],
        targets,
        instructions: '',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
}

function planRead(
  head: { versionId: string; version: number; approvedAt: string } = planVersion(),
) {
  return {
    planId,
    head,
    history: [{ versionId: head.versionId, version: head.version, approvedAt: head.approvedAt }],
  };
}

function intakeRecord(occurredAt = '2025-11-02T01:30:45.123-04:00') {
  return activeIntakeEntrySchema.parse({
    status: 'active',
    intakeId: 'intake-one',
    revisionId: versionId,
    revision: 1,
    occurredAt,
    recordedAt: '2025-11-03T00:00:00Z',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    foods: [
      {
        description: '바나나',
        foodVersionId: null,
        quantity: null,
        unit: 'unspecified',
        sourceBasis: 'unknown',
      },
    ],
    nutrientTotal: unknownNutrients(),
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: '원래 메모',
    nutrientValueCoverage: 'unknown',
  });
}

function transportWith(reply: (input: TransportRequest) => unknown) {
  const request = vi.fn(async (input: TransportRequest) => ({
    ...transportReplySchema.parse({ status: 200, body: reply(input), traceId: null }),
  }));
  return { transport: { request } satisfies AuthenticatedTransport, request };
}

describe('nutrition manual workspace', () => {
  it('does not create an actual when the user confirms a nutrition plan (V022-A11)', async () => {
    const navigate = vi.fn();
    const { transport, request } = transportWith((input) => {
      if (input.path !== '/bff/v1/nutrition/plans' || input.method !== 'POST')
        throw new Error(`Unexpected request ${input.method} ${input.path}`);
      const body = z
        .object({
          kind: z.literal('create'),
          confirmed: z.literal(true),
          draft: nutritionPlanDraftSchema,
        })
        .parse(input.body);
      return {
        ...body.draft,
        items: body.draft.items.map((item) => ({ ...item, planVersionId: versionId })),
        planId,
        versionId,
        version: 1,
        previousVersionId: null,
        approvedAt: new Date().toISOString(),
        approvalId,
      };
    });
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'plans-new' }}
        navigate={navigate}
      />,
    );
    const name = await screen.findByRole('textbox', { name: '계획 목적' });
    expect(request).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: '확인한 계획 저장' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(name, '훈련 전후 식사');
    expect(request).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('checkbox', { name: /계획 내용을 직접 확인했고/ }));
    await userEvent.click(save);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/nutrition/plans/${planId}`));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].idempotencyKey).toEqual(expect.any(String));
    expect(request.mock.calls.some(([input]) => input.path.includes('/intakes'))).toBe(false);
  });

  it('sends only an explicitly entered zero target and known planned quantity', async () => {
    const navigate = vi.fn();
    const { transport, request } = transportWith((input) => {
      const body = z.object({ draft: nutritionPlanDraftSchema }).parse(input.body);
      return {
        ...body.draft,
        items: body.draft.items.map((item) => ({ ...item, planVersionId: versionId })),
        planId,
        versionId,
        version: 1,
        previousVersionId: null,
        approvedAt: new Date().toISOString(),
        approvalId,
      };
    });
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'plans-new' }}
        navigate={navigate}
      />,
    );
    await userEvent.type(await screen.findByRole('textbox', { name: '계획 목적' }), '장거리 보급');
    await userEvent.click(screen.getByRole('button', { name: '항목 추가' }));
    await userEvent.type(screen.getByRole('textbox', { name: '항목 이름' }), '보급 확인');
    await userEvent.type(screen.getByRole('textbox', { name: '계획한 음식·음료 (선택)' }), '물');
    await userEvent.type(
      screen.getByRole('spinbutton', { name: '계획한 양 (모르면 빈칸)' }),
      '250',
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '계획한 양의 단위' }), 'mL');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: '영양 목표 (선택)' }),
      'fluid',
    );
    await userEvent.type(screen.getByRole('spinbutton', { name: '목표 최소값' }), '0');
    await userEvent.type(screen.getByRole('spinbutton', { name: '목표 최대값' }), '250');
    await userEvent.click(screen.getByRole('checkbox', { name: /계획 내용을 직접 확인했고/ }));
    await userEvent.click(screen.getByRole('button', { name: '확인한 계획 저장' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const write = request.mock.calls.find(([input]) => input.method === 'POST')?.[0];
    const draft = z.object({ draft: nutritionPlanDraftSchema }).parse(write?.body).draft;
    expect(draft.items[0]?.foods[0]).toMatchObject({
      description: '물',
      quantity: 250,
      unit: 'mL',
    });
    expect(draft.items[0]?.targets[0]).toMatchObject({
      metric: 'fluid',
      amount: { min: 0, max: 250, unit: 'mL' },
    });
  });

  it('clones a confirmed plan into a new aggregate without creating intake actuals (V022-A11)', async () => {
    const navigate = vi.fn();
    const originalItem = {
      id: 'original-item',
      planVersionId: versionId,
      category: 'meal',
      title: '아침',
      anchor: { kind: 'absolute', date: '2026-09-18', localTime: null, timezone: 'Asia/Seoul' },
      foods: [
        {
          description: '토스트',
          foodVersionId: null,
          quantity: null,
          unit: 'unspecified',
          sourceBasis: 'unknown',
        },
      ],
      targets: [],
      instructions: '',
      evidenceIds: [],
      source: 'user_confirmed',
    };
    const original = {
      planId,
      versionId,
      version: 1,
      previousVersionId: null,
      approvedAt: '2026-09-18T08:00:00Z',
      approvalId,
      period: { from: '2026-09-18', toInclusive: '2026-09-18' },
      timezone: 'Asia/Seoul',
      purpose: '아침 계획',
      linkedTrainingPlanVersionId: null,
      items: [originalItem],
    };
    const cloneId = '3a44a988-134a-47e9-9007-d0b314736279';
    const cloneVersionId = 'a131e807-88d2-45d6-8ed3-48cec6f03e0b';
    const { transport, request } = transportWith((input) => {
      if (input.method === 'GET' && input.path.endsWith(planId))
        return {
          planId,
          head: original,
          history: [{ versionId, version: 1, approvedAt: original.approvedAt }],
        };
      if (input.method === 'POST' && input.path === '/bff/v1/nutrition/plans') {
        const body = z
          .object({ kind: z.literal('create'), draft: nutritionPlanDraftSchema })
          .parse(input.body);
        return {
          ...body.draft,
          items: body.draft.items.map((item) => ({ ...item, planVersionId: cloneVersionId })),
          planId: cloneId,
          versionId: cloneVersionId,
          version: 1,
          previousVersionId: null,
          approvedAt: new Date().toISOString(),
          approvalId,
        };
      }
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    });
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'plan', planId }}
        navigate={navigate}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: '새 계획으로 복제' }));
    expect(screen.getByText(/섭취 기록은 생성되지 않습니다/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '확인한 계획 저장' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /계획 내용을 직접 확인했고/ }));
    await userEvent.click(screen.getByRole('button', { name: '확인한 계획 저장' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/nutrition/plans/${cloneId}`));
    const writes = request.mock.calls
      .map(([input]) => input)
      .filter((input) => input.method === 'POST');
    expect(writes).toHaveLength(1);
    const saved = z
      .object({ kind: z.literal('create'), draft: nutritionPlanDraftSchema })
      .parse(writes[0]?.body);
    expect(saved.draft.items[0]?.id).not.toBe(originalItem.id);
    expect(saved.draft.items[0]?.title).toBe(originalItem.title);
    expect(request.mock.calls.some(([input]) => input.path.includes('/intakes'))).toBe(false);
  });

  it('links one intake to two selected activities while sending one actual command (V022-A13)', async () => {
    const navigate = vi.fn();
    const ids = ['21c83f9d-3984-4624-b63e-ff2acf892979', 'ec9012b7-ea55-42f1-a369-780490469441'];
    const values = {
      title: '훈련',
      kind: 'running',
      startedAt: new Date().toISOString(),
      durationSeconds: 1200,
      durationKind: 'timer',
      timezone: 'UTC',
      distanceMeters: 3000,
    };
    const activities = ids.map((id, index) => ({
      id,
      revision: 1,
      source: {
        kind: 'manual',
        sourceId: `manual-${index}`,
        revision: 1,
        contentHash: 'a'.repeat(64),
      },
      original: { ...values, title: `달리기 ${index + 1}` },
      overlay: {},
      effective: { ...values, title: `달리기 ${index + 1}` },
    }));
    const { transport, request } = transportWith((input) => {
      if (input.path === '/bff/v1/nutrition/foods?limit=100')
        return { foods: [], nextCursor: null };
      if (input.path.startsWith('/bff/v1/activities?')) return { items: activities, total: 2 };
      if (input.path === '/bff/v1/nutrition/intakes' && input.method === 'POST') {
        const body = z
          .object({
            intakeId: z.string(),
            confirmed: z.literal(true),
            occurredAt: z.string(),
            timezone: z.string(),
            foods: z.array(z.unknown()),
            nutrientTotal: z.unknown(),
            plannedItemId: z.string().nullable(),
            relatedSessionIds: z.array(z.string()),
            relatedActivityIds: z.array(z.string()),
            source: z.literal('user'),
            sourceRecordId: z.null(),
            notes: z.string().nullable(),
          })
          .parse(input.body);
        const { confirmed, ...actual } = body;
        void confirmed;
        return {
          ...actual,
          revisionId: crypto.randomUUID(),
          revision: 1,
          recordedAt: new Date().toISOString(),
          status: 'active',
          nutrientValueCoverage: 'unknown',
        };
      }
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    });
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'log-new' }}
        navigate={navigate}
      />,
    );
    await userEvent.type(await screen.findByRole('textbox', { name: '먹은 음식·음료' }), '물');
    await userEvent.click(await screen.findByRole('checkbox', { name: /달리기 1/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /달리기 2/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /실제로 섭취한 시각/ }));
    await userEvent.click(screen.getByRole('button', { name: '섭취 저장' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const writes = request.mock.calls
      .map(([input]) => input)
      .filter((input) => input.method === 'POST');
    expect(writes).toHaveLength(1);
    const saved = z.object({ relatedActivityIds: z.array(z.uuid()) }).parse(writes[0]?.body);
    expect(saved.relatedActivityIds).toEqual(ids);
  });

  it('requires an explicit actual confirmation and preserves name-only unknown nutrients (V022-A12)', async () => {
    const navigate = vi.fn();
    const responseIssues: unknown[] = [];
    const { transport, request } = transportWith((input) => {
      if (input.path === '/bff/v1/nutrition/foods?limit=100')
        return { foods: [], nextCursor: null };
      if (input.path !== '/bff/v1/nutrition/intakes' || input.method !== 'POST')
        throw new Error(`Unexpected request ${input.method} ${input.path}`);
      const body = z
        .object({
          intakeId: z.string(),
          confirmed: z.literal(true),
          occurredAt: z.string(),
          timezone: z.string(),
          foods: z.array(z.unknown()),
          nutrientTotal: z.unknown(),
          plannedItemId: z.string().nullable(),
          relatedSessionIds: z.array(z.string()),
          relatedActivityIds: z.array(z.string()),
          source: z.literal('user'),
          sourceRecordId: z.null(),
          notes: z.string().nullable(),
        })
        .parse(input.body);
      const { confirmed, ...actual } = body;
      void confirmed;
      const response = {
        ...actual,
        revisionId: crypto.randomUUID(),
        revision: 1,
        recordedAt: new Date().toISOString(),
        status: 'active',
        nutrientValueCoverage: 'unknown',
      };
      const parsed = activeIntakeEntrySchema.safeParse(response);
      if (!parsed.success) responseIssues.push(parsed.error.issues);
      return response;
    });
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'log-new' }}
        navigate={navigate}
      />,
    );
    const food = await screen.findByRole('textbox', { name: '먹은 음식·음료' });
    await userEvent.type(food, '바나나');
    expect(request.mock.calls.filter(([input]) => input.method === 'POST')).toHaveLength(0);
    const save = screen.getByRole('button', { name: '섭취 저장' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /실제로 섭취한 시각/ }));
    await userEvent.click(save);
    await waitFor(() =>
      expect(request.mock.calls.some(([input]) => input.method === 'POST')).toBe(true),
    );
    expect(responseIssues).toEqual([]);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const write = request.mock.calls.find(([input]) => input.method === 'POST')?.[0];
    expect(write?.path).toBe('/bff/v1/nutrition/intakes');
    const nutrients = z
      .object({ energy: z.object({ value: z.number().nullable() }) })
      .parse(z.object({ nutrientTotal: z.unknown() }).parse(write?.body).nutrientTotal);
    expect(nutrients.energy.value).toBeNull();
  });

  it('keeps a plan draft across latest-version refresh and failed retry, with its original CAS base', async () => {
    let reads = 0;
    const latest = {
      ...planVersion(),
      versionId: nextVersionId,
      version: 2,
      previousVersionId: versionId,
      purpose: '서버 변경',
      items: planVersion().items.map((item) => ({ ...item, planVersionId: nextVersionId })),
    };
    const { transport, request } = transportWith((input) => {
      if (input.method === 'GET' && input.path.endsWith(planId)) {
        reads += 1;
        if (reads === 3) throw new Error('Network unavailable');
        return planRead(reads === 1 ? planVersion() : latest);
      }
      if (input.method === 'POST') {
        const saved = z.object({ draft: nutritionPlanDraftSchema }).parse(input.body).draft;
        return {
          ...planVersion(),
          ...saved,
          items: saved.items.map((item) => ({ ...item, planVersionId: nextVersionId })),
          versionId: nextVersionId,
          version: 2,
          previousVersionId: versionId,
        };
      }
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    });
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'plan', planId }}
        navigate={vi.fn()}
      />,
    );
    const purpose = await screen.findByRole('textbox', { name: '계획 목적' });
    await userEvent.clear(purpose);
    await userEvent.type(purpose, '내 미저장 변경');
    await userEvent.click(screen.getByRole('button', { name: '서버 최신 버전 확인' }));
    expect(await screen.findByText(/서버에는 버전 2/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '계획 목적' }) as HTMLInputElement).value).toBe(
      '내 미저장 변경',
    );
    await userEvent.click(screen.getByRole('button', { name: '서버 최신 버전 확인' }));
    expect(await screen.findByText(/최신 버전을 다시 조회하지 못했습니다/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '계획 목적' }) as HTMLInputElement).value).toBe(
      '내 미저장 변경',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /계획 내용을 직접 확인했고/ }));
    expect(
      (screen.getByRole('button', { name: '확인한 계획 저장' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(request.mock.calls.some(([input]) => input.method === 'POST')).toBe(false);
  });

  it('edits the first nutrient goal without dropping later goals', async () => {
    const goals = [
      {
        metric: 'energy',
        amount: { min: 300, max: 400, unit: 'kcal', basis: 'user_confirmed', evidenceIds: [] },
      },
      {
        metric: 'fluid',
        amount: { min: 200, max: 500, unit: 'mL', basis: 'user_confirmed', evidenceIds: [] },
      },
    ];
    const { transport, request } = transportWith((input) => {
      if (input.method === 'GET') return planRead(planVersion(goals));
      if (input.method === 'POST') {
        const draft = z.object({ draft: nutritionPlanDraftSchema }).parse(input.body).draft;
        return {
          ...planVersion(),
          ...draft,
          items: draft.items.map((item) => ({ ...item, planVersionId: nextVersionId })),
          versionId: nextVersionId,
          version: 2,
          previousVersionId: versionId,
        };
      }
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    });
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'plan', planId }}
        navigate={vi.fn()}
      />,
    );
    const min = await screen.findByRole('spinbutton', { name: '목표 최소값' });
    await userEvent.clear(min);
    await userEvent.type(min, '350');
    await userEvent.click(screen.getByRole('checkbox', { name: /계획 내용을 직접 확인했고/ }));
    await userEvent.click(screen.getByRole('button', { name: '확인한 계획 저장' }));
    await waitFor(() =>
      expect(request.mock.calls.some(([input]) => input.method === 'POST')).toBe(true),
    );
    const draft = z
      .object({ draft: nutritionPlanDraftSchema })
      .parse(request.mock.calls.find(([input]) => input.method === 'POST')?.[0].body).draft;
    expect(draft.items[0]?.targets).toHaveLength(2);
    expect(
      z
        .object({ expectedHeadVersionId: z.string() })
        .parse(request.mock.calls.find(([input]) => input.method === 'POST')?.[0].body)
        .expectedHeadVersionId,
    ).toBe(versionId);
    expect(draft.items[0]?.targets[0]?.amount.min).toBe(350);
    expect(draft.items[0]?.targets[1]).toEqual(goals[1]);
  });

  it('requires an owned training version and session before allowing relative timing', async () => {
    const training = {
      id: trainingVersionId,
      version: 1,
      createdAt: '2026-09-18T00:00:00Z',
      draft: {
        title: '달리기 계획',
        timezone: 'Asia/Seoul',
        periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
          id: level,
          parentId: index ? levels[index - 1] : null,
          level,
          title: level,
          startDate: '2026-09-01',
          endDateExclusive: '2026-10-01',
          timezone: 'Asia/Seoul',
          intent: '',
          isPartial: false,
        })),
        sessions: [
          {
            id: 'owned-session',
            blockId: 'block',
            date: '2026-09-18',
            localStartTime: '08:00',
            title: '아침 달리기',
            sport: 'running',
            durationSeconds: 1800,
            distanceMeters: null,
            targetRpe: null,
            purpose: '',
            notes: '',
            priority: 'normal',
            locks: { date: false, time: false, intensity: false },
            steps: [],
          },
        ],
      },
    };
    const { transport, request } = transportWith((input) => {
      if (input.path === '/bff/v1/plans/current') return { head: training, history: [] };
      if (input.path === `/bff/v1/plans/versions/${trainingVersionId}`) return training;
      if (input.method === 'POST') {
        const draft = z.object({ draft: nutritionPlanDraftSchema }).parse(input.body).draft;
        return {
          ...planVersion(),
          ...draft,
          items: draft.items.map((item) => ({ ...item, planVersionId: versionId })),
        };
      }
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    });
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'plans-new' }}
        navigate={vi.fn()}
      />,
    );
    await userEvent.type(await screen.findByRole('textbox', { name: '계획 목적' }), '운동 중 보급');
    await userEvent.click(screen.getByRole('button', { name: '항목 추가' }));
    await userEvent.type(screen.getByRole('textbox', { name: '항목 이름' }), '보급');
    await userEvent.type(screen.getByRole('textbox', { name: '계획한 음식·음료 (선택)' }), '물');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '시각 기준' }), 'relative');
    expect(await screen.findByText(/먼저 현재 훈련 계획을 연결하고/)).toBeTruthy();
    expect((screen.getByRole('combobox', { name: '시각 기준' }) as HTMLSelectElement).value).toBe(
      'absolute',
    );
    expect(request.mock.calls.some(([input]) => input.path === '/bff/v1/plans/current')).toBe(
      false,
    );
    await userEvent.click(screen.getByRole('button', { name: '현재 훈련 계획 연결' }));
    await screen.findByText(`연결 버전: ${trainingVersionId}`);
    await screen.findByText('훈련 세션 1개 연결됨');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '시각 기준' }), 'relative');
    await screen.findByRole('option', { name: '아침 달리기' });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: '연결할 훈련 세션' }),
      'owned-session',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /계획 내용을 직접 확인했고/ }));
    await userEvent.click(screen.getByRole('button', { name: '확인한 계획 저장' }));
    await waitFor(() =>
      expect(request.mock.calls.some(([input]) => input.method === 'POST')).toBe(true),
    );
    const draft = z
      .object({ draft: nutritionPlanDraftSchema })
      .parse(request.mock.calls.find(([input]) => input.method === 'POST')?.[0].body).draft;
    expect(draft.linkedTrainingPlanVersionId).toBe(trainingVersionId);
    expect(draft.items[0]?.anchor).toMatchObject({
      kind: 'relative',
      entity: 'session',
      entityId: 'owned-session',
    });
  });

  it('shows a recoverable validation message when the server rejects a plan with 422', async () => {
    const request = vi.fn(async (_input: TransportRequest) =>
      transportReplySchema.parse({
        status: 422,
        body: { error: { code: 'INVALID_PLAN' } },
        traceId: null,
      }),
    );
    const transport = { request } satisfies AuthenticatedTransport;
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'plans-new' }}
        navigate={vi.fn()}
      />,
    );
    await userEvent.type(await screen.findByRole('textbox', { name: '계획 목적' }), '거절된 계획');
    await userEvent.click(screen.getByRole('checkbox', { name: /계획 내용을 직접 확인했고/ }));
    await userEvent.click(screen.getByRole('button', { name: '확인한 계획 저장' }));
    expect(
      await screen.findByText(/계획 또는 세션 연결을 서버가 수락하지 않았습니다/),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '확인한 계획 저장' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect((screen.getByRole('textbox', { name: '계획 목적' }) as HTMLInputElement).value).toBe(
      '거절된 계획',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retains an intake correction draft across successful and failed refreshes', async () => {
    let reads = 0;
    const original = intakeRecord();
    const newer = { ...original, revisionId: nextVersionId, revision: 2, notes: '서버 변경' };
    const { transport, request } = transportWith((input) => {
      if (input.method === 'GET' && input.path === '/bff/v1/nutrition/intakes/intake-one') {
        reads += 1;
        if (reads === 3) throw new Error('Network unavailable');
        return reads === 1 ? original : newer;
      }
      if (input.path === '/bff/v1/nutrition/foods?limit=100')
        return { foods: [], nextCursor: null };
      if (input.path.startsWith('/bff/v1/activities?')) return { items: [], total: 0 };
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    });
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'log-edit', intakeId: 'intake-one' }}
        navigate={vi.fn()}
      />,
    );
    const notes = await screen.findByRole('textbox', { name: '메모·불편감 (선택)' });
    await userEvent.clear(notes);
    await userEvent.type(notes, '내 미저장 메모');
    await userEvent.click(screen.getByRole('button', { name: '서버 최신 기록 확인' }));
    expect(await screen.findByText(/서버 기록은 수정 2/)).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: '메모·불편감 (선택)' }) as HTMLTextAreaElement).value,
    ).toBe('내 미저장 메모');
    await userEvent.click(screen.getByRole('button', { name: '서버 최신 기록 확인' }));
    expect(await screen.findByText(/최신 기록을 다시 조회하지 못했습니다/)).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: '메모·불편감 (선택)' }) as HTMLTextAreaElement).value,
    ).toBe('내 미저장 메모');
    await userEvent.click(screen.getByRole('checkbox', { name: /실제로 섭취한 시각/ }));
    expect((screen.getByRole('button', { name: '정정 저장' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(request.mock.calls.some(([input]) => input.method === 'PATCH')).toBe(false);
  });

  it('preserves an untouched intake instant including seconds, fraction, and DST offset', async () => {
    const original = intakeRecord();
    const { transport, request } = transportWith((input) => {
      if (input.method === 'GET' && input.path === '/bff/v1/nutrition/intakes/intake-one')
        return original;
      if (input.path === '/bff/v1/nutrition/foods?limit=100')
        return { foods: [], nextCursor: null };
      if (input.path.startsWith('/bff/v1/activities?')) return { items: [], total: 0 };
      if (input.method === 'PATCH')
        return { ...original, revisionId: nextVersionId, revision: 2, notes: '정정 메모' };
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    });
    render(
      <NutritionWorkspace
        athleteId="athlete-a"
        sessionId="session-a"
        transport={transport}
        route={{ kind: 'log-edit', intakeId: 'intake-one' }}
        navigate={vi.fn()}
      />,
    );
    const notes = await screen.findByRole('textbox', { name: '메모·불편감 (선택)' });
    await userEvent.clear(notes);
    await userEvent.type(notes, '정정 메모');
    await userEvent.click(screen.getByRole('checkbox', { name: /실제로 섭취한 시각/ }));
    await userEvent.click(screen.getByRole('button', { name: '정정 저장' }));
    await waitFor(() =>
      expect(request.mock.calls.some(([input]) => input.method === 'PATCH')).toBe(true),
    );
    const write = request.mock.calls.find(([input]) => input.method === 'PATCH')?.[0];
    expect(
      z
        .object({ expectedRevision: z.number(), occurredAt: z.string(), notes: z.string() })
        .parse(write?.body),
    ).toMatchObject({
      expectedRevision: 1,
      occurredAt: original.occurredAt,
      notes: '정정 메모',
    });
  });

  it('accepts only the intended nutrition routes', () => {
    expect(parseNutritionSegments([])).toEqual({ kind: 'dashboard' });
    expect(parseNutritionSegments(['plans', planId])).toEqual({ kind: 'plan', planId });
    expect(parseNutritionSegments(['logs', 'entry-1', 'edit'])).toEqual({
      kind: 'log-edit',
      intakeId: 'entry-1',
    });
    expect(parseNutritionSegments(['plans', '../account'])).toBeNull();
    expect(parseNutritionSegments(['logs', 'x', 'delete'])).toBeNull();
  });
});
