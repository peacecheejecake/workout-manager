'use client';

import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { CompetitionWorkspace, type CompetitionWorkspaceProps } from './competition-workspace';
import { createCompetitionRelationApi } from './competition-relation-api';

export type CompetitionHostProps = Omit<CompetitionWorkspaceProps, 'relations'>;
export function CompetitionHost(props: CompetitionHostProps) {
  if (props.athleteId === null || props.athleteId.length === 0 || props.sessionId.length === 0)
    return <p role="status">로그인 후 대회와 기록을 관리할 수 있습니다.</p>;
  return (
    <Lifetime
      key={JSON.stringify([props.athleteId, props.sessionId])}
      {...props}
      athleteId={props.athleteId}
    />
  );
}
function Lifetime(props: CompetitionHostProps & { athleteId: string }) {
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
      <Content {...props} />
    </QueryClientProvider>
  );
}
function CatalogStatus({
  label,
  pending,
  failed,
  retry,
}: {
  label: string;
  pending: boolean;
  failed: boolean;
  retry: () => void;
}) {
  if (pending) return <p role="status">{label} 목록을 불러오는 중입니다.</p>;
  if (!failed) return null;
  return (
    <div role="status">
      <p>{label} 목록을 불러오지 못했습니다. 저장된 연결은 유지됩니다.</p>
      <button type="button" onClick={retry}>
        {label} 목록 다시 시도
      </button>
    </div>
  );
}
function Content(props: CompetitionHostProps & { athleteId: string }) {
  const api = useMemo(() => createCompetitionRelationApi(props.transport), [props.transport]);
  const scope = [props.athleteId, props.sessionId];
  const plans = useQuery({
    queryKey: ['competition-relations', ...scope, 'plans'],
    queryFn: ({ signal }) => api.plans(signal),
  });
  const courses = useQuery({
    queryKey: ['competition-relations', ...scope, 'courses'],
    queryFn: ({ signal }) => api.courses(signal),
  });
  const activities = useQuery({
    queryKey: [
      'competition-relations',
      ...scope,
      'activities',
      { limit: 100, offset: 0, sort: 'started_desc' },
    ],
    queryFn: ({ signal }) => api.activities(signal),
  });
  const relations = {
    plans: plans.isError ? undefined : plans.data?.choices,
    courses: courses.isError ? undefined : courses.data?.choices,
    activities: activities.isError ? undefined : activities.data?.choices,
  };
  return (
    <>
      <section aria-label="연결할 계획·코스·실제 활동 목록">
        <p>
          최근 계획 최대 100개, 현재 사용 가능한 코스 버전, 최근 실제 활동 최대 100개를 선택할 수
          있습니다. 목록에 없는 저장된 연결도 유지됩니다.
        </p>
        <CatalogStatus
          label="계획"
          pending={plans.isPending}
          failed={plans.isError}
          retry={() => {
            void plans.refetch();
          }}
        />
        <CatalogStatus
          label="코스"
          pending={courses.isPending}
          failed={courses.isError}
          retry={() => {
            void courses.refetch();
          }}
        />
        <CatalogStatus
          label="실제 활동"
          pending={activities.isPending}
          failed={activities.isError}
          retry={() => {
            void activities.refetch();
          }}
        />
        {activities.data &&
        !activities.isError &&
        activities.data.total > activities.data.choices.length ? (
          <p role="status">
            실제 활동 {activities.data.total}개 중 최근 {activities.data.choices.length}개를
            표시합니다.
          </p>
        ) : null}
      </section>
      <CompetitionWorkspace {...props} relations={relations} />
    </>
  );
}
