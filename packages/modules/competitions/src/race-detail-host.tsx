'use client';

import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { raceEventSchema } from '@workout/contracts/races';
import { RaceEventDetailWorkspace, type RaceEventDetailWorkspaceProps } from './race-detail';
import { createCompetitionRelationApi } from './competition-relation-api';

export type RaceEventDetailHostProps = Omit<RaceEventDetailWorkspaceProps, 'relations'>;
export function RaceEventDetailHost(props: RaceEventDetailHostProps) {
  if (!props.athleteId || !props.sessionId)
    return <p role="status">로그인 후 대회 상세를 볼 수 있습니다.</p>;
  const id = raceEventSchema.shape.id.safeParse(props.raceId);
  if (!id.success) return <p role="alert">대회 주소가 올바르지 않습니다.</p>;
  return (
    <Lifetime
      key={JSON.stringify([props.athleteId, props.sessionId, id.data])}
      {...props}
      athleteId={props.athleteId}
      raceId={id.data}
    />
  );
}
function Lifetime(props: RaceEventDetailHostProps & { athleteId: string }) {
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
function Status({
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
      <p>{label} 목록을 불러오지 못했습니다. 기존 연결은 유지됩니다.</p>
      <button type="button" onClick={retry}>
        {label} 목록 다시 시도
      </button>
    </div>
  );
}
function Content(props: RaceEventDetailHostProps & { athleteId: string }) {
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
  const relations = {
    plans: plans.isError ? undefined : plans.data?.choices,
    courses: courses.isError ? undefined : courses.data?.choices,
  };
  return (
    <>
      <section aria-label="대회에 연결할 계획과 코스 목록">
        <p>
          최근 계획 최대 100개와 현재 사용 가능한 코스 버전을 표시합니다. 목록 밖의 저장된 연결도
          유지됩니다.
        </p>
        <Status
          label="계획"
          pending={plans.isPending}
          failed={plans.isError}
          retry={() => {
            void plans.refetch();
          }}
        />
        <Status
          label="코스"
          pending={courses.isPending}
          failed={courses.isError}
          retry={() => {
            void courses.refetch();
          }}
        />
      </section>
      <RaceEventDetailWorkspace {...props} relations={relations} />
    </>
  );
}
