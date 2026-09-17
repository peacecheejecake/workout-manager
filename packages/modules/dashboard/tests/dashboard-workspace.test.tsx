import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import { shiftDashboardDate, type DashboardReadModel } from '@workout/contracts/dashboard';
import {
  DashboardWorkspace,
  readDashboardSearch,
  type DashboardWorkspaceProps,
} from '../src/dashboard-workspace';

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const missing = { value: null, knownCount: 0, missingCount: 0 };
const actual = {
  count: 0,
  distanceMeters: missing,
  durationSeconds: { timer: missing, elapsed: missing, moving: missing, unknown: missing },
  sources: { fit: 0, fixture: 0, manual: 0 },
  overlayCount: 0,
};
const planned = { count: 0, distanceMeters: missing, durationSeconds: missing };
const summary = { actual, planned, checkInCount: 0, checkInDays: 0 };
function model(window = 3): DashboardReadModel {
  return {
    definitionVersion: 'dashboard-v1',
    observedAt: '2026-03-09T12:00:00Z',
    period: {
      anchor: '2026-03-09',
      days: window,
      timezone: 'America/New_York',
      timezoneSource: 'query',
      from: shiftDashboardDate('2026-03-09', 1 - window),
      toExclusive: '2026-03-10',
      previousFrom: shiftDashboardDate('2026-03-09', 1 - window * 2),
      upcomingToExclusive: '2026-03-17',
    },
    planVersion: null,
    dataRevision: { activities: { count: 0, revisionSum: '0' }, checkIns: 0 },
    currentBlock: null,
    todaySessions: [],
    upcomingSessions: [],
    current: summary,
    previous: summary,
    days: Array.from({ length: window }, (_, index) => ({
      date: shiftDashboardDate('2026-03-09', 1 - window + index),
      actual,
      planned,
      checkInCount: 0,
    })),
    unplacedActivityCount: 0,
    latestCheckIn: null,
    availability: {
      coverage: 'unknown',
      comparison: 'unavailable',
      actualLoad: 'unavailable',
      providerMetrics: 'unavailable',
    },
    proposalSummary: { status: 'unavailable', reason: 'not_implemented' },
    connectionFreshness: {
      status: 'unavailable',
      reason: 'activity_sync_not_implemented',
      lastSuccessfulSyncAt: null,
    },
  };
}
const reply = (body: DashboardReadModel): Reply =>
  transportReplySchema.parse({ status: 200, body, traceId: null });
function setup(
  handler: (input: TransportRequest) => Promise<Reply> = async () => reply(model()),
  search = 'window=3',
) {
  const request = vi.fn(handler);
  const props: DashboardWorkspaceProps = {
    athleteId: 'alice',
    sessionId: 'session-alice',
    transport: { request },
    search,
    onSearchChange: vi.fn(),
    initialAnchor: '2026-03-09',
    initialTimezone: 'America/New_York',
    links: {
      planning: '/planner',
      activities: '/activities',
      wellbeing: '/wellbeing',
      planDay: (date) => `/planner?day=${date}`,
      planBlock: (id) => `/planner?block=${id}`,
      checkIn: (id) => `/wellbeing?selected=${id}`,
    },
  };
  function Host({ value }: { value: DashboardWorkspaceProps }) {
    const [query, setQuery] = useState(value.search);
    return <DashboardWorkspace {...value} search={query} onSearchChange={setQuery} />;
  }
  return {
    ...render(<Host value={props} />),
    props,
    request,
    tree: (value: DashboardWorkspaceProps) => <Host value={value} />,
  };
}
describe('dashboard actual read model', () => {
  it('rejects an invalid URL window without requesting data and defaults to ten local dates', async () => {
    const { request } = setup(undefined, 'window=91');
    expect(screen.getByRole('alert')).toHaveTextContent('3~90일');
    expect(request).not.toHaveBeenCalled();
    expect(readDashboardSearch('', '2026-03-09', 'America/New_York').data?.window).toBe(10);
  });
  it('uses identical date/value pairs for the graph and table and separates absent from known zero', async () => {
    const value = model();
    const zero = {
      ...actual,
      count: 1,
      distanceMeters: { value: 0, knownCount: 1, missingCount: 0 },
      durationSeconds: {
        ...actual.durationSeconds,
        unknown: { value: null, knownCount: 0, missingCount: 1 },
      },
      sources: { fit: 1, fixture: 0, manual: 0 },
    };
    const distance = { ...zero, distanceMeters: { value: 1500, knownCount: 1, missingCount: 0 } };
    value.days = value.days.map((day, index) => ({
      ...day,
      actual: index === 0 ? zero : index === 1 ? distance : actual,
    }));
    const { container } = setup(async () => reply(value));
    const table = await screen.findByRole('table', { name: '날짜별 거리와 보고 현황' });
    const rows = within(table).getAllByRole('row').slice(1);
    for (const [index, day] of value.days.entries()) {
      const row = rows[index];
      expect(row).toHaveTextContent(day.date);
      const point = container.querySelector(`[data-date="${day.date}"][data-series="actual"]`);
      if (day.actual.distanceMeters.value === null) {
        expect(point).toBeNull();
        expect(row).toHaveTextContent('미보고 · 알려진 0개');
      } else {
        expect(point).toHaveAttribute('data-value', String(day.actual.distanceMeters.value));
        expect(row).toHaveTextContent(`${day.actual.distanceMeters.value}m · 알려진 1개`);
      }
    }
    expect(screen.getByRole('img', { name: '날짜별 계획·실제 거리' })).toBeVisible();
    expect(screen.getByRole('link', { name: '활동 목록 보기' })).toHaveAttribute(
      'href',
      '/activities',
    );
  });
  it('offers keyboard-operable scroll buttons that target each data region', async () => {
    setup();
    const graph = await screen.findByRole('region', { name: '거리 그래프 가로 탐색' });
    const table = screen.getByRole('region', { name: '날짜별 기록 표 가로 탐색' });
    const graphScroll = vi.fn();
    const tableScroll = vi.fn();
    Object.defineProperty(graph, 'scrollBy', { value: graphScroll, configurable: true });
    Object.defineProperty(table, 'scrollBy', { value: tableScroll, configurable: true });
    const user = userEvent.setup();
    const graphButton = screen.getByRole('button', { name: '그래프 오른쪽으로 이동' });
    expect(graphButton).toHaveAttribute('aria-controls', graph.id);
    graphButton.focus();
    await user.keyboard('{Enter}');
    expect(graphButton).toHaveFocus();
    expect(graphScroll).toHaveBeenCalledWith({ left: 240, behavior: 'auto' });
    const tableButton = screen.getByRole('button', { name: '표 왼쪽으로 이동' });
    expect(tableButton).toHaveAttribute('aria-controls', table.id);
    tableButton.focus();
    await user.keyboard(' ');
    expect(tableButton).toHaveFocus();
    expect(tableScroll).toHaveBeenCalledWith({ left: -240, behavior: 'auto' });
  });
  it('keeps last valid same-period data with its observation time on refresh failure', async () => {
    let fail = false;
    setup(async () => {
      if (fail) throw new Error('offline');
      return reply(model());
    });
    await screen.findByText('2026-03-09T12:00:00Z');
    fail = true;
    await userEvent.click(screen.getByRole('button', { name: '최신 상태 다시 확인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('마지막으로 확인한 기록');
    expect(screen.getByText('2026-03-09T12:00:00Z')).toBeVisible();
    expect(screen.getByRole('table', { name: '날짜별 거리와 보고 현황' })).toBeVisible();
  });
  it('hides previous-period data while a newly requested window is unresolved', async () => {
    let finish: ((value: Reply) => void) | undefined;
    setup(async (input) =>
      new URL(input.path, 'http://local').searchParams.get('window') === '7'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : reply(model()),
    );
    await screen.findByRole('table', { name: '날짜별 거리와 보고 현황' });
    await userEvent.click(screen.getByRole('button', { name: '7일' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await act(async () => {
      finish?.(reply(model(7)));
    });
    expect(within(await screen.findByRole('table')).getAllByRole('row')).toHaveLength(8);
  });
  it('discards a delayed response when switching accounts', async () => {
    let finish: ((value: Reply) => void) | undefined;
    const { rerender, props, tree } = setup(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    rerender(
      tree({
        ...props,
        athleteId: 'bob',
        sessionId: 'session-bob',
        transport: {
          request: async () => reply({ ...model(), observedAt: '2026-03-09T13:00:00Z' }),
        },
      }),
    );
    await screen.findByText('2026-03-09T13:00:00Z');
    await act(async () => {
      finish?.(reply(model()));
    });
    expect(screen.queryByText('2026-03-09T12:00:00Z')).not.toBeInTheDocument();
    expect(screen.getByText('2026-03-09T13:00:00Z')).toBeVisible();
  });
  it('shows resolved plan timezone and links a check-in by ID rather than the projected date', async () => {
    const value = model();
    value.period = { ...value.period, timezone: 'Asia/Seoul', timezoneSource: 'plan' };
    value.latestCheckIn = {
      id: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      values: {
        observedAt: '2026-03-09T00:00:00Z',
        timezone: 'America/New_York',
        fatigue: 0,
        discomfort: null,
        bodyLocation: null,
        note: null,
      },
      localDate: '2026-03-08',
      recordedAt: '2026-03-09T00:00:00Z',
      updatedAt: '2026-03-09T00:00:00Z',
      source: 'user',
      method: 'self_report',
      definitionVersion: 'checkin-v1',
    };
    setup(async () => reply(value));
    await screen.findByText('적용 시간대: Asia/Seoul · 계획 시간대 적용');
    const checkIn = screen.getByRole('region', { name: '최신 체크인' });
    expect(checkIn).toHaveTextContent('피로 0 · 불편감 보고하지 않음');
    expect(within(checkIn).getByRole('link', { name: '이 체크인 상세 보기' })).toHaveAttribute(
      'href',
      `/wellbeing?selected=${value.latestCheckIn.id}`,
    );
    expect(screen.getByRole('link', { name: '체크인 기록 보기' })).toHaveAttribute(
      'href',
      '/wellbeing',
    );
  });
});
