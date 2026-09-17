'use client';

import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { planReadSchema, type PeriodDraft } from '@workout/contracts/planning';
import { idSchema } from '@workout/contracts/primitives';
import { Button } from '@workout/ui-foundation/button';
import { PeriodExplorer } from './period-explorer';
import styles from './planning-period-navigator.module.css';

export interface PlanningPeriodNavigatorProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  search: string;
  onSearchChange(query: string): void;
  onCalendar(period: PeriodDraft): void;
  planHref(periodId: string | null): string;
}

export function PlanningPeriodNavigator(props: PlanningPeriodNavigatorProps) {
  return <ScopedNavigator key={JSON.stringify([props.athleteId, props.sessionId])} {...props} />;
}

function ScopedNavigator(props: PlanningPeriodNavigatorProps) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  useEffect(
    () => () => {
      void client.cancelQueries();
      client.clear();
    },
    [client],
  );
  return (
    <QueryClientProvider client={client}>
      <Navigator {...props} />
    </QueryClientProvider>
  );
}

function Navigator({
  athleteId,
  sessionId,
  transport,
  search,
  onSearchChange,
  onCalendar,
  planHref,
}: PlanningPeriodNavigatorProps) {
  const query = useQuery({
    queryKey: ['planning-period-navigator', athleteId, sessionId],
    queryFn: async ({ signal }) => {
      const response = transportReplySchema.parse(
        await transport.request({
          path: '/bff/v1/plans/current',
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      if (signal.aborted) throw new Error('PLAN_READ_ABORTED');
      if (response.status !== 200) throw new Error('PLAN_READ_FAILED');
      return planReadSchema.parse(response.body);
    },
  });
  const params = new URLSearchParams(search);
  const selected = params.get('planPeriod');
  const validId = selected === null || idSchema.max(200).safeParse(selected).success;
  const rawView = params.get('planPeriodView') ?? 'orbit';
  const validView = rawView === 'orbit' || rawView === 'timeline';
  const head = query.data?.head;
  const selectedPeriod = head?.draft.periods.find((period) => period.id === selected);
  function change(key: 'planPeriod' | 'planPeriodView', value: string | null) {
    const next = new URLSearchParams(search);
    if (value === null) next.delete(key);
    else next.set(key, value);
    onSearchChange(next.toString());
  }
  return (
    <section aria-label="대시보드 기간 탐색" className={styles.navigator}>
      <h2>저장된 계획 기간 탐색</h2>
      <p>저장된 계획을 읽기 전용으로 탐색합니다. 계획 초안과 실제 활동은 변경하지 않습니다.</p>
      {query.data ? (
        <p>
          계획 조회 시각 (이 화면에서 확인한 시각):{' '}
          <time dateTime={new Date(query.dataUpdatedAt).toISOString()}>
            {new Date(query.dataUpdatedAt).toISOString()}
          </time>
          . 공급자 동기화 시각이 아닙니다.
        </p>
      ) : null}
      <Button variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>
        계획 기간 다시 확인
      </Button>
      {!validView ? (
        <div role="alert">
          <p>URL의 기간 보기 값이 유효하지 않아 원형 보기를 표시합니다.</p>
          <Button variant="secondary" onClick={() => change('planPeriodView', 'orbit')}>
            기간 원형 보기로 복구
          </Button>
        </div>
      ) : null}
      {!validId ? (
        <p role="alert">URL의 기간 식별자가 유효하지 않습니다. 전체 계획에서 다시 선택하세요.</p>
      ) : null}
      {query.isFetching ? (
        <p role="status">
          {query.data
            ? '최신 계획을 확인하고 있습니다. 아래는 마지막으로 확인한 저장 계획입니다.'
            : '저장된 계획 기간을 확인하고 있습니다.'}
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert">
          {query.data
            ? '최신 계획 확인에 실패했습니다. 아래는 마지막으로 확인한 저장 계획입니다.'
            : '계획 기간을 확인하지 못했습니다. 다시 확인해 주세요.'}
        </p>
      ) : null}
      {head ? (
        <>
          <p>
            저장 버전 {head.version} · {head.draft.title}
          </p>
          <PeriodExplorer
            plan={head.draft}
            selectedId={selected}
            view={rawView === 'timeline' ? 'timeline' : 'orbit'}
            onSelect={(id) => change('planPeriod', id)}
            onViewChange={(view) => change('planPeriodView', view)}
            onCalendar={onCalendar}
          />
          {selected === null || (validId && selectedPeriod) ? (
            <a href={planHref(selected)}>선택한 기간 계획 열기</a>
          ) : null}
        </>
      ) : head === null ? (
        <p>저장된 계획이 없습니다. 계획 화면에서 기간을 작성하고 저장해 주세요.</p>
      ) : null}
    </section>
  );
}
