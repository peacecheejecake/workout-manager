import '@testing-library/jest-dom/vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import type { PlanSnapshot } from '@workout/contracts/planning';
import type { PeriodSummary } from '@workout/contracts/period-summary';
import { PeriodSummaryPanel } from '../src/period-summary-panel';
const id = '11111111-1111-4111-8111-111111111111';
const period: PeriodSummary['period'] = {
  id: 'season',
  parentId: null,
  level: 'season',
  title: '저장된 시즌',
  startDate: '2026-09-01',
  endDateExclusive: '2026-10-01',
  timezone: 'UTC',
  intent: '기반',
  isPartial: false,
};
const head: PlanSnapshot = {
  id,
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  draft: {
    title: '저장 계획',
    timezone: 'UTC',
    periods: [period, { ...period, id: 'another', title: '다른 시즌' }],
    sessions: [],
  },
};
const missing = { value: null, knownCount: 0, missingCount: 0 };
const data: PeriodSummary = {
  definitionVersion: 'period-summary-v1',
  observedAt: '2026-09-17T00:00:00Z',
  planVersion: { id, version: 1, title: '저장 계획' },
  currentPlanVersionId: id,
  period,
  planned: { count: 0, distanceMeters: missing, durationSeconds: missing },
  keySessions: [],
  actual: {
    status: 'available',
    totals: {
      count: 1,
      distanceMeters: { value: 0, knownCount: 1, missingCount: 0 },
      durationSeconds: {
        timer: { value: null, knownCount: 0, missingCount: 1 },
        elapsed: missing,
        moving: missing,
        unknown: missing,
      },
      sources: { fit: 1, fixture: 0, manual: 0 },
      overlayCount: 0,
    },
  },
  dataRevision: { activities: { count: 2, revisionSum: '3' } },
  unplacedActivityCount: 1,
  coverage: 'unknown',
};
function reply(body: PeriodSummary, status = 200) {
  return transportReplySchema.parse({ status, body, traceId: 'test' });
}
function setup(transport: AuthenticatedTransport) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const select = vi.fn();
  const view = (
    periodId: string | null = 'season',
    athleteId = 'alice',
    saved: PlanSnapshot | null = head,
  ) => (
    <QueryClientProvider client={client}>
      <PeriodSummaryPanel
        athleteId={athleteId}
        sessionId={`${athleteId}-session`}
        transport={transport}
        head={saved}
        periodId={periodId}
        onSelectSession={select}
      />
    </QueryClientProvider>
  );
  const result = render(view());
  return { ...result, view, client, select };
}
describe('saved period summary', () => {
  it('keeps actual zero distinct from unknown planned totals and exposes source/revision definitions', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>().mockResolvedValue(reply(data));
    setup({ request });
    const actual = await screen.findByRole('region', { name: '기간 실제 합계' });
    expect(within(actual).getByText('거리: 0 m · 알려진 1개 · 미정 0개')).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: '기간 계획 합계' })).getByText(
        '거리: 미정 · 알려진 0개 · 미정 0개',
      ),
    ).toBeVisible();
    expect(screen.getByText(/전체 계정에서 기간 미배정 활동 1개/)).toBeVisible();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/bff/v1/plans/versions/${id}/periods/season/summary`,
        method: 'GET',
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it('selects only explicit key sessions without writing or changing the saved summary', async () => {
    const keySession: PeriodSummary['keySessions'][number] = {
      id: 'key-session',
      blockId: 'block',
      date: '2026-09-09',
      localStartTime: null,
      title: '핵심 계획',
      sport: 'running',
      durationSeconds: 0,
      distanceMeters: null,
      purpose: '',
      notes: '',
      priority: 'high',
      locks: { date: false, time: false, intensity: false },
      steps: [],
      targetRpe: null,
    };
    const request = vi.fn<AuthenticatedTransport['request']>().mockResolvedValue(
      reply({
        ...data,
        keySessions: [keySession],
        planned: {
          count: 1,
          distanceMeters: { value: null, knownCount: 0, missingCount: 1 },
          durationSeconds: { value: 0, knownCount: 1, missingCount: 0 },
        },
      }),
    );
    const host = setup({ request });
    await userEvent.click(await screen.findByRole('button', { name: '주요 세션: 핵심 계획' }));
    expect(host.select).toHaveBeenCalledWith('key-session');
    expect(screen.getByText('계획 시간: 0 초 · 알려진 1개 · 미정 0개')).toBeVisible();
    host.rerender(host.view());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.every(([command]) => command.method === 'GET')).toBe(true);
  });
  it('does not fetch a new draft-only period or invalid version identifier', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>().mockResolvedValue(reply(data));
    const host = setup({ request });
    await screen.findByRole('region', { name: '기간 실제 합계' });
    host.rerender(host.view('draft-only'));
    expect(screen.getByText(/새 기간은 저장 후 조회/)).toBeVisible();
    host.rerender(host.view('season', 'alice', { ...head, id: 'invalid' }));
    expect(screen.getByRole('alert')).toHaveTextContent('식별자');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('hides last values after failed refresh, retries, and rejects mismatched response identity', async () => {
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValueOnce(reply(data))
      .mockResolvedValueOnce(reply(data, 503))
      .mockResolvedValueOnce(reply({ ...data, period: { ...period, id: 'wrong' } }))
      .mockResolvedValue(reply(data));
    setup({ request });
    await screen.findByRole('region', { name: '기간 실제 합계' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '기간 요약 다시 확인' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('region', { name: '기간 실제 합계' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '기간 요약 다시 확인' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('region', { name: '기간 실제 합계' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '기간 요약 다시 확인' }));
    await screen.findByRole('region', { name: '기간 실제 합계' });
  });
  it('ignores an old period response and a late account response without showing partial results', async () => {
    let resolveOld: ((value: ReturnType<typeof reply>) => void) | undefined;
    let resolveOther: ((value: ReturnType<typeof reply>) => void) | undefined;
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOther = resolve;
          }),
      )
      .mockResolvedValue(
        reply({ ...data, period: { ...period, id: 'another', title: '현재 계정 기간' } }),
      );
    const host = setup({ request });
    host.rerender(host.view('another'));
    expect(screen.queryByText('실제 활동 1개')).not.toBeInTheDocument();
    host.rerender(host.view('another', 'bob'));
    await screen.findByText(/현재 계정 기간/);
    await act(async () => {
      resolveOld?.(reply(data));
      resolveOther?.(
        reply({ ...data, period: { ...period, id: 'another', title: '이전 계정 기간' } }),
      );
    });
    expect(screen.queryByText(/이전 계정 기간/)).not.toBeInTheDocument();
    expect(screen.queryByText(/· 저장된 시즌/)).not.toBeInTheDocument();
  });
  it('shows unsupported calendar separately and warns when the observed head changed', async () => {
    const ancient = { ...period, startDate: '0000-01-01', endDateExclusive: '0000-02-01' };
    const request = vi.fn<AuthenticatedTransport['request']>().mockResolvedValue(
      reply({
        ...data,
        period: ancient,
        actual: { status: 'unavailable', reason: 'unsupported_calendar' },
        currentPlanVersionId: null,
      }),
    );
    setup({ request });
    expect(await screen.findByText(/지원하지 않는 달력 범위/)).toBeVisible();
    expect(screen.getByText(/서버의 현재 계획이 다릅니다/)).toBeVisible();
    expect(screen.queryByText('실제 활동 0개')).not.toBeInTheDocument();
  });
});

it('shows range aggregate bounds and partial counts without replacing unknown actual time', async () => {
  const ranged: PeriodSummary = {
    ...data,
    planned: {
      count: 2,
      distanceMeters: { value: null, knownCount: 0, missingCount: 2 },
      durationSeconds: { value: null, knownCount: 0, missingCount: 2 },
      targets: {
        definitionVersion: 'planned-targets-v1',
        distanceMeters: { min: 0, max: 1000, knownCount: 1, missingCount: 1, rangeCount: 1 },
        durationSeconds: { min: 60, max: 120, knownCount: 1, missingCount: 1, rangeCount: 1 },
      },
    },
  };
  setup({ request: async () => reply(ranged) });
  expect(
    await screen.findByText('거리: 0–1000 m · 알려진 1개 · 미정 1개 · 범위 목표 1개 · 부분 합계'),
  ).toBeVisible();
  expect(
    screen.getByText('계획 시간: 60–120 초 · 알려진 1개 · 미정 1개 · 범위 목표 1개 · 부분 합계'),
  ).toBeVisible();
  expect(screen.getByText('타이머 시간 (timer): 미정 · 알려진 0개 · 미정 1개')).toBeVisible();
});
