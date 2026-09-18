import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import { integratedPlannerReadSchema } from '@workout/contracts/integrated-planner';
import { addDays } from '../src/lens';
import { IntegratedPlannerPanel } from '../src/integrated-planner-panel';

const nutritionVersionId = '11111111-1111-4111-8111-111111111111';
const activityId = '22222222-2222-4222-8222-222222222222';
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
function emptyRead(from: string, toExclusive: string) {
  const days = [];
  for (let date = from; date < toExclusive; date = addDays(date, 1))
    days.push({
      date,
      plannedSessions: [],
      nutritionItems: [],
      activities: [],
      intakes: [],
      summary: emptySummary,
    });
  return integratedPlannerReadSchema.parse({
    schemaVersion: 1,
    from,
    toExclusive,
    timezone: 'UTC',
    trainingPlanVersionId: null,
    nutritionPlanVersionIds: [],
    days,
    unresolvedNutritionItems: [],
    unplacedActivityCount: 0,
    summary: emptySummary,
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
  return integratedPlannerReadSchema.parse({
    ...read,
    nutritionPlanVersionIds: [nutritionVersionId],
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
        path: '/bff/v1/planner/integrated?from=2026-09-18&toExclusive=2026-09-20&timezone=UTC',
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
        path: `/bff/v1/planner/integrated?from=${start}&toExclusive=${end}&timezone=UTC`,
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
});
