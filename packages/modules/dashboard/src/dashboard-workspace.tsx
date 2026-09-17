'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { dashboardQuerySchema, dashboardReadModelSchema } from '@workout/contracts/dashboard';
import { Button } from '@workout/ui-foundation/button';
import { DashboardOverview } from './overview';
import { DashboardLayoutLifetime } from './dashboard-layout-lifetime';
import styles from './dashboard.module.css';

export interface DashboardLinks {
  planning: string;
  activities: string;
  activityRange(input: { from: string; toExclusive: string; timezone: string }): string;
  wellbeing: string;
  planDay(date: string): string;
  planBlock(id: string): string;
  checkIn(id: string): string;
}
export interface DashboardWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  search: string;
  onSearchChange(query: string): void;
  initialAnchor: string;
  initialTimezone: string;
  links: DashboardLinks;
  periodNavigation?: ReactNode;
}
export function readDashboardSearch(search: string, anchor: string, timezone: string) {
  const params = new URLSearchParams(search);
  return dashboardQuerySchema.safeParse({
    anchor: params.get('anchor') ?? anchor,
    window: params.get('window') ?? 10,
    timezone: params.get('timezone') ?? timezone,
  });
}
export function DashboardWorkspace(props: DashboardWorkspaceProps) {
  return <Lifetime key={JSON.stringify([props.athleteId, props.sessionId])} {...props} />;
}
function Lifetime(props: DashboardWorkspaceProps) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <DashboardLayoutLifetime athleteId={props.athleteId}>
        <Workspace {...props} />
      </DashboardLayoutLifetime>
    </QueryClientProvider>
  );
}
function Workspace({
  athleteId,
  sessionId,
  transport,
  search,
  onSearchChange,
  initialAnchor,
  initialTimezone,
  links,
  periodNavigation,
}: DashboardWorkspaceProps) {
  const headingId = useId();
  const parsed = readDashboardSearch(search, initialAnchor, initialTimezone);
  const params = new URLSearchParams(search);
  const query = parsed.success ? parsed.data : null;
  const dashboard = useQuery({
    queryKey: ['users', athleteId, 'sessions', sessionId, 'dashboard', query],
    enabled: query !== null,
    queryFn: async ({ signal }) => {
      if (!query) throw new Error('INVALID_QUERY');
      const suffix = new URLSearchParams({
        anchor: query.anchor,
        window: String(query.window),
        timezone: query.timezone,
      });
      const response = await transport.request({
        path: `/bff/v1/dashboard?${suffix}`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (signal.aborted || response.status !== 200) throw new Error('DASHBOARD_UNAVAILABLE');
      const model = dashboardReadModelSchema.parse(response.body);
      if (
        model.period.anchor !== query.anchor ||
        model.period.days !== query.window ||
        (model.period.timezoneSource === 'query' && model.period.timezone !== query.timezone)
      )
        throw new Error('DASHBOARD_PERIOD_MISMATCH');
      return model;
    },
  });
  function change(changes: Record<string, string>) {
    const next = new URLSearchParams(search);
    for (const [name, value] of Object.entries(changes)) next.set(name, value);
    onSearchChange(next.toString());
  }
  return (
    <section className={styles.workspace} aria-labelledby={headingId}>
      <h1 id={headingId}>오늘과 최근 기록</h1>
      {periodNavigation}
      <form
        key={`${params.get('anchor')}:${params.get('window')}:${params.get('timezone')}`}
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          change({
            anchor: String(values.get('anchor')),
            window: String(values.get('window')),
            timezone: String(values.get('timezone')),
          });
        }}
      >
        <label>
          기준일
          <input
            name="anchor"
            type="date"
            required
            defaultValue={params.get('anchor') ?? initialAnchor}
          />
        </label>
        <label>
          조회 일수
          <input
            name="window"
            type="number"
            min={3}
            max={90}
            required
            defaultValue={params.get('window') ?? '10'}
          />
        </label>
        <label>
          조회 시간대
          <input
            name="timezone"
            required
            defaultValue={params.get('timezone') ?? initialTimezone}
          />
        </label>
        <Button type="submit">조회 적용</Button>
      </form>
      <div className={styles.actions} aria-label="빠른 조회 기간">
        {[7, 10, 14, 28].map((days) => (
          <Button
            variant="secondary"
            key={days}
            aria-pressed={query?.window === days}
            onClick={() => change({ window: String(days) })}
          >
            {days}일
          </Button>
        ))}
      </div>
      {!query ? (
        <p role="alert">기준일·시간대와 3~90일의 조회 기간을 확인하세요.</p>
      ) : (
        <>
          <Button
            variant="secondary"
            disabled={dashboard.isFetching}
            onClick={() => void dashboard.refetch()}
          >
            최신 상태 다시 확인
          </Button>
          {dashboard.isFetching ? <p role="status">대시보드를 확인하고 있습니다.</p> : null}
          {dashboard.isError ? (
            <p role="alert">
              최신 확인 실패.{' '}
              {dashboard.data
                ? '아래는 마지막으로 확인한 기록이며 관측 시각 이후 변경되었을 수 있습니다.'
                : '기록을 불러오지 못했습니다. 다시 확인해 주세요.'}
            </p>
          ) : null}
          {dashboard.data ? <DashboardOverview model={dashboard.data} links={links} /> : null}
        </>
      )}
    </section>
  );
}
