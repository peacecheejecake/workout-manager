import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import { integratedPlannerReadV5Schema } from '@workout/contracts/integrated-planner';
import { addDays } from '../src/lens';
import { IntegratedPlannerPanel } from '../src/integrated-planner-panel';

const nutritionVersionId = '11111111-1111-4111-8111-111111111111';
const activityId = '22222222-2222-4222-8222-222222222222';
const recoveryStrategyId = '33333333-3333-4333-8333-333333333333';
const recoveryVersionId = '44444444-4444-4444-8444-444444444444';
const recoveryOptionId = '55555555-5555-4555-8555-555555555555';
const recoveryActionId = '66666666-6666-4666-8666-666666666666';
const recoveryMethodId = '77777777-7777-4777-8777-777777777777';
const scheduleId = '88888888-8888-4888-8888-888888888888';
const scheduleVersionId = '99999999-9999-4999-8999-999999999999';
const blueprintVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const occurrenceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const known = (unit: 'kcal' | 'g' | 'mL' | 'mg', value: number) => ({
  unit,
  value,
  status: 'reported' as const,
  evidenceIds: [],
});
const unknown = (unit: 'kcal' | 'g' | 'mL' | 'mg') => ({
  unit,
  value: null,
  status: 'unknown' as const,
  evidenceIds: [],
});
const nutrientTotal = {
  energy: known('kcal', 0),
  carbohydrate: unknown('g'),
  protein: unknown('g'),
  fat: unknown('g'),
  fluid: unknown('mL'),
  sodium: unknown('mg'),
};
const emptyMetric = { value: null, knownCount: 0, missingCount: 0 };
const emptySummary = {
  training: {
    plannedSessionCount: 0,
    actualActivityCount: 0,
    supplementaryActivityCount: 0,
    distanceMeters: emptyMetric,
    durationSeconds: {
      timer: emptyMetric,
      elapsed: emptyMetric,
      moving: emptyMetric,
      unknown: emptyMetric,
    },
  },
  nutrition: {
    plannedItemCount: 0,
    intakeCount: 0,
    nutrients: {
      energyKcal: emptyMetric,
      carbohydrateGrams: emptyMetric,
      proteinGrams: emptyMetric,
      fatGrams: emptyMetric,
      fluidMl: emptyMetric,
      sodiumMg: emptyMetric,
    },
    intakeCoverage: 'unknown' as const,
  },
};
const emptySummaryV4 = {
  ...emptySummary,
  recovery: { plannedStrategyCount: 0, actualActionCount: 0 },
  routines: { occurrenceCount: 0, runCount: 0 },
  stretchingActivityCount: 0,
};
function emptyRead(from: string, toExclusive: string) {
  const days = [];
  for (let date = from; date < toExclusive; date = addDays(date, 1))
    days.push({
      date,
      plannedSessions: [],
      nutritionItems: [],
      activities: [],
      intakes: [],
      recoveryPlans: [],
      recoveryActions: [],
      routineOccurrences: [],
      routineRuns: [],
      stretchingActivityIds: [],
      summary: emptySummary,
    });
  return integratedPlannerReadV5Schema.parse({
    schemaVersion: 5,
    from,
    toExclusive,
    timezone: 'UTC',
    trainingPlanVersionId: null,
    nutritionPlanVersionIds: [],
    recoveryStrategyVersionIds: [],
    routineScheduleVersionIds: [],
    days,
    unresolvedNutritionItems: [],
    nutritionOperationalStates: [],
    unplacedActivityCount: 0,
    summary: emptySummaryV4,
  });
}
const session = {
  id: 'session-1',
  blockId: 'block',
  date: '2026-09-18',
  localStartTime: '08:00',
  title: '보강 계획',
  sport: 'strength',
  durationSeconds: null,
  distanceMeters: null,
  targetRpe: null,
  purpose: '',
  notes: '',
  priority: 'normal',
  locks: { date: false, time: false, intensity: false },
  steps: [],
};
function populatedRead() {
  const read = emptyRead('2026-09-18', '2026-09-20');
  return integratedPlannerReadV5Schema.parse({
    ...read,
    nutritionPlanVersionIds: [nutritionVersionId],
    recoveryStrategyVersionIds: [recoveryVersionId],
    routineScheduleVersionIds: [scheduleVersionId],
    days: [
      {
        ...read.days[0],
        plannedSessions: [session],
        nutritionItems: [
          {
            id: 'meal-1',
            planVersionId: nutritionVersionId,
            title: '아침',
            category: 'meal',
            source: 'user_confirmed',
            localTime: null,
          },
        ],
        activities: [
          {
            activityId,
            kind: 'strength',
            title: '실제 보강',
            startedAt: '2026-09-18T08:00:00Z',
            distanceMeters: null,
            durationSeconds: 0,
            durationKind: 'timer',
            hasSupplementaryDetail: true,
          },
        ],
        intakes: [
          { intakeId: 'intake-1', revision: 1, occurredAt: '2026-09-18T09:00:00Z', nutrientTotal },
        ],
        recoveryPlans: [
          {
            strategyId: recoveryStrategyId,
            versionId: recoveryVersionId,
            title: '휴식 중심 회복',
            selectedOptionId: recoveryOptionId,
          },
        ],
        recoveryActions: [
          {
            actionId: recoveryActionId,
            revision: 1,
            occurredAt: '2026-09-18T10:00:00Z',
            state: 'performed',
            methodVersionId: recoveryMethodId,
          },
        ],
        routineOccurrences: [
          {
            occurrenceId,
            scheduleId,
            scheduleVersionId,
            blueprintVersionId,
            scheduledAt: '2026-09-18T07:00:00Z',
          },
        ],
        routineRuns: [{ runId, revision: 0, state: 'ended', occurrenceId }],
        stretchingActivityIds: [activityId],
      },
      read.days[1],
    ],
    unresolvedNutritionItems: [
      {
        id: 'relative-1',
        planVersionId: nutritionVersionId,
        title: '훈련 후',
        category: 'after',
        source: 'user_confirmed',
        reason: 'missing_session_duration',
      },
    ],
    summary: {
      ...emptySummaryV4,
      training: {
        ...emptySummaryV4.training,
        plannedSessionCount: 1,
        actualActivityCount: 1,
        supplementaryActivityCount: 1,
      },
      nutrition: {
        ...emptySummaryV4.nutrition,
        plannedItemCount: 1,
        intakeCount: 1,
      },
      recovery: { plannedStrategyCount: 1, actualActionCount: 1 },
      routines: { occurrenceCount: 1, runCount: 1 },
      stretchingActivityCount: 1,
    },
  });
}
function mount(
  request: (input: TransportRequest) => Promise<unknown>,
  lens: { kind: 'calendar'; from: string; toExclusive: string } = {
    kind: 'calendar',
    from: '2026-09-18',
    toExclusive: '2026-09-20',
  },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSelectSession = vi.fn();
  const transport: AuthenticatedTransport = {
    request: async (input) => transportReplySchema.parse(await request(input)),
  };
  const result = render(
    <QueryClientProvider client={client}>
      <IntegratedPlannerPanel
        athleteId="athlete"
        sessionId="session"
        transport={transport}
        head={null}
        lens={lens}
        invalidLens={false}
        draftActive={true}
        onSelectSession={onSelectSession}
        activityHref={(id) => `/activities/${id}`}
      />
    </QueryClientProvider>,
  );
  return { ...result, onSelectSession };
}

describe('integrated Planner panel', () => {
  it('keeps plan, canonical Activity, intake, zero and unknown measurements distinct', async () => {
    const user = userEvent.setup();
    const request = vi.fn(async () => ({ status: 200, body: populatedRead(), traceId: null }));
    const { onSelectSession } = mount(request);
    const panel = screen.getByRole('region', { name: '통합 Planner' });
    expect(within(panel).getByText(/편집 중인 초안은 이 조회에 반영되지 않습니다/)).toBeVisible();
    expect(
      await within(panel).findByText(/실제 Activity 1건 \(세트 상세 연결 1건\)/),
    ).toBeVisible();
    expect(within(panel).getByRole('region', { name: '2026-09-18 훈련 계획' })).toHaveTextContent(
      '보강 계획',
    );
    expect(within(panel).getByRole('region', { name: '2026-09-18 운동 실제' })).toHaveTextContent(
      '시간 0초',
    );
    expect(within(panel).getByRole('region', { name: '2026-09-18 운동 실제' })).toHaveTextContent(
      '거리: 미상',
    );
    expect(within(panel).getByRole('region', { name: '2026-09-18 섭취 실제' })).toHaveTextContent(
      '0 kcal',
    );
    expect(
      within(panel).getByRole('region', { name: '2026-09-18 회복 계획과 실제' }),
    ).toHaveTextContent('회복 계획 1건');
    expect(
      within(panel).getByRole('region', { name: '2026-09-18 회복 계획과 실제' }),
    ).toHaveTextContent('회복 실제 1건');
    expect(
      within(panel).getByRole('region', { name: '2026-09-18 루틴 발생분과 실행' }),
    ).toHaveTextContent('루틴 발생분 1건');
    expect(
      within(panel).getByRole('region', { name: '2026-09-18 루틴 발생분과 실행' }),
    ).toHaveTextContent('RoutineRun 1건');
    expect(
      within(panel).getByRole('region', { name: '2026-09-18 스트레칭 Activity 상세' }),
    ).toHaveTextContent('스트레칭 Activity 상세 1건');
    expect(within(panel).getByText(/회복 계획 1건 · 회복 실제 1건/)).toBeVisible();
    expect(within(panel).getByText(/RoutineRun은 실제 기록을 연결하는 wrapper/)).toHaveTextContent(
      '실제 Activity 시간과 건수에는 다시 더하지 않습니다',
    );
    expect(within(panel).getByRole('region', { name: '날짜 미해결 영양 계획' })).toHaveTextContent(
      '세션 종료 시각 미정',
    );
    expect(within(panel).getByRole('link', { name: '실제 보강' })).toHaveAttribute(
      'href',
      `/activities/${activityId}`,
    );
    await user.click(within(panel).getByRole('button', { name: '보강 계획' }));
    expect(onSelectSession).toHaveBeenCalledWith('session-1');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/bff/v1/planner/integrated?from=2026-09-18&toExclusive=2026-09-20&timezone=UTC&maxSchemaVersion=5',
        method: 'GET',
      }),
    );
  });

  it('loads a 93-day URL range with one integrated request', async () => {
    const start = '2026-01-01';
    const end = addDays(start, 93);
    const request = vi.fn(async (input: TransportRequest) => {
      const url = new URL(input.path, 'https://example.test');
      const from = url.searchParams.get('from') ?? '';
      const toExclusive = url.searchParams.get('toExclusive') ?? '';
      return {
        status: 200,
        body: emptyRead(from, toExclusive),
        traceId: null,
      };
    });
    mount(request, { kind: 'calendar', from: start, toExclusive: end });
    expect(
      await screen.findByText('선택한 기간에 배치된 계획이나 실제 기록이 없습니다.'),
    ).toBeVisible();
    expect(screen.getByText('날짜 기준: UTC · 표시한 날짜 0/93일')).toBeVisible();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/bff/v1/planner/integrated?from=${start}&toExclusive=${end}&timezone=UTC&maxSchemaVersion=5`,
      }),
    );
  });

  it('rejects a read whose returned range does not match the requested range', async () => {
    const start = '2026-01-01';
    const end = addDays(start, 2);
    const request = vi.fn(async () => ({
      status: 200,
      body: emptyRead(start, addDays(end, 1)),
      traceId: null,
    }));
    mount(request, { kind: 'calendar', from: start, toExclusive: end });
    const panel = screen.getByRole('region', { name: '통합 Planner' });
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      '통합 기록을 확인하지 못했습니다',
    );
    expect(within(panel).queryByText(/표시한 날짜/)).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not fetch a range longer than 93 days', () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: emptyRead('2026-01-01', '2026-01-02'),
      traceId: null,
    }));
    mount(request, {
      kind: 'calendar',
      from: '2026-01-01',
      toExclusive: addDays('2026-01-01', 94),
    });
    expect(screen.getByText(/최대 93일/)).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });

  it('distinguishes an unsupported schema response and offers an update retry', async () => {
    const user = userEvent.setup();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 409,
        body: { message: 'UNSUPPORTED_SCHEMA_VERSION' },
        traceId: null,
      })
      .mockResolvedValueOnce({
        status: 200,
        body: emptyRead('2026-09-18', '2026-09-20'),
        traceId: null,
      });
    mount(request);

    expect(await screen.findByRole('alert')).toHaveTextContent('앱을 업데이트');
    const retry = screen.getByRole('button', { name: '앱 업데이트 후 다시 확인' });
    await user.click(retry);

    expect(
      await screen.findByText('선택한 기간에 배치된 계획이나 실제 기록이 없습니다.'),
    ).toBeVisible();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps the loading state and explicit refetch behavior for the v5 request', async () => {
    const user = userEvent.setup();
    let resolveFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({
        status: 200,
        body: emptyRead('2026-09-18', '2026-09-20'),
        traceId: null,
      });
    mount(request);

    expect(await screen.findByText('훈련·영양 기록을 확인하는 중입니다.')).toHaveAttribute(
      'role',
      'status',
    );
    expect(screen.getByRole('button', { name: '통합 기록 다시 확인' })).toBeDisabled();
    resolveFirst?.({
      status: 200,
      body: emptyRead('2026-09-18', '2026-09-20'),
      traceId: null,
    });
    await screen.findByText('선택한 기간에 배치된 계획이나 실제 기록이 없습니다.');

    await user.click(screen.getByRole('button', { name: '통합 기록 다시 확인' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });
});

it.each([
  { state: 'suspended', reason: 'race_disconnected', notice: '대회 연결 해제' },
  { state: 'suspended', reason: 'source_unavailable', notice: '연결된 시각 근거 사용 불가' },
  {
    state: 'unresolved',
    reason: 'legacy_unpinned',
    notice: '이전 계획의 시각 근거가 고정되지 않았습니다.',
  },
  {
    state: 'unresolved',
    reason: 'timing_unresolved',
    notice: '연결된 시각 근거를 해결하지 못했습니다.',
  },
] as const)(
  'shows $state/$reason only for its matching unresolved nutrition item',
  async ({ state, reason, notice }) => {
    const read = integratedPlannerReadV5Schema.parse({
      ...emptyRead('2026-09-18', '2026-09-20'),
      nutritionPlanVersionIds: [nutritionVersionId],
      unresolvedNutritionItems: [
        {
          id: 'linked',
          planVersionId: nutritionVersionId,
          title: '보존 식사',
          category: 'meal',
          source: 'user_confirmed',
          reason: 'missing_anchor',
        },
        {
          id: 'other',
          planVersionId: nutritionVersionId,
          title: '별도 미해결 식사',
          category: 'meal',
          source: 'user_confirmed',
          reason: 'missing_session_time',
        },
      ],
      nutritionOperationalStates: [
        { planVersionId: nutritionVersionId, itemId: 'linked', state, reason },
      ],
    });
    mount(vi.fn(async () => ({ status: 200, body: read, traceId: null })));
    const section = await screen.findByRole('region', { name: '날짜 미해결 영양 계획' });
    const linked = within(section)
      .getByText(/보존 식사/)
      .closest('li');
    const other = within(section)
      .getByText(/별도 미해결 식사/)
      .closest('li');
    expect(linked).toHaveTextContent(notice);
    expect(other).not.toHaveTextContent(notice);
    expect(section.textContent).not.toContain(nutritionVersionId);
    expect(section).not.toHaveTextContent('08:00');
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(within(section).queryByRole('link')).not.toBeInTheDocument();
    if (state === 'suspended') {
      expect(linked).toHaveTextContent('대회 유래 시각 사용이 중단되었습니다');
      expect(linked).toHaveTextContent('음식·수량과 실제 섭취 기록은 유지됩니다');
      expect(linked).toHaveTextContent('재연결·재승인 전까지 저장된 대회 시각을 사용하지 않습니다');
    } else {
      expect(linked).not.toHaveTextContent('대회 연결 해제');
      expect(linked).toHaveTextContent('시각은 미해결 상태');
    }
  },
);
it.each([4, 1])(
  'rejects legacy v%i replies to the current v5 request without fallback',
  async (schemaVersion) => {
    const read = emptyRead('2026-09-18', '2026-09-20');
    const { nutritionOperationalStates: _states, ...legacy } = read;
    const request = vi.fn(async () => ({
      status: 200,
      body: { ...legacy, schemaVersion },
      traceId: null,
    }));
    mount(request);
    expect(await screen.findByRole('alert')).toHaveTextContent('통합 기록을 확인하지 못했습니다');
    expect(screen.queryByText(/표시한 날짜/)).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it('matches plan UUID case aliases while keeping item IDs and different plan versions distinct', async () => {
  const lower = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const item = {
    id: 'Meal',
    planVersionId: lower.toUpperCase(),
    title: '대문자 UUID 식사',
    category: 'meal',
    source: 'user_confirmed',
    reason: 'missing_anchor',
  };
  const read = integratedPlannerReadV5Schema.parse({
    ...emptyRead('2026-09-18', '2026-09-20'),
    nutritionPlanVersionIds: [lower, nutritionVersionId],
    unresolvedNutritionItems: [
      item,
      { ...item, id: 'meal', title: '다른 항목 식사' },
      { ...item, planVersionId: nutritionVersionId, title: '다른 버전 식사' },
    ],
    nutritionOperationalStates: [
      { planVersionId: lower, itemId: 'Meal', state: 'suspended', reason: 'race_disconnected' },
    ],
  });
  mount(vi.fn(async () => ({ status: 200, body: read, traceId: null })));
  const section = await screen.findByRole('region', { name: '날짜 미해결 영양 계획' });
  expect(
    within(section)
      .getByText(/대문자 UUID 식사/)
      .closest('li'),
  ).toHaveTextContent('대회 연결 해제');
  expect(
    within(section)
      .getByText(/다른 항목 식사/)
      .closest('li'),
  ).not.toHaveTextContent('대회 연결 해제');
  expect(
    within(section)
      .getByText(/다른 버전 식사/)
      .closest('li'),
  ).not.toHaveTextContent('대회 연결 해제');
  expect(section.textContent).not.toContain(lower);
  expect(section.textContent).not.toContain(lower.toUpperCase());
});
