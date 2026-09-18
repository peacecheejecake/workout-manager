'use client';

import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { createSupplementaryApi } from './supplementary-api';
import { ExerciseLibrary } from './exercise-library';
import { RoutineWorkspace } from './routine-workspace';
import { ExecutionWorkspace } from './execution-workspace';
import type { SupplementaryRoute } from './supplementary-route';
import styles from './supplementary.module.css';

export type SupplementaryScope = readonly ['users', string, 'sessions', string, 'supplementary'];
export interface SupplementaryWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  route: SupplementaryRoute;
}

export function SupplementaryWorkspace(props: SupplementaryWorkspaceProps) {
  return <Lifetime key={`${props.athleteId}:${props.sessionId}`} {...props} />;
}

function Lifetime(props: SupplementaryWorkspaceProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} />
    </QueryClientProvider>
  );
}

function Workspace({ athleteId, sessionId, transport, route }: SupplementaryWorkspaceProps) {
  const api = useMemo(() => createSupplementaryApi(transport), [transport]);
  const scope: SupplementaryScope = ['users', athleteId, 'sessions', sessionId, 'supplementary'];
  return (
    <section className={styles.workspace} aria-label="보강 운동 작업 공간">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>보강 · 수동 기록</p>
          <h1>보강 운동</h1>
          <p>루틴 계획과 확인한 실제 수행을 분리해 기록합니다.</p>
        </div>
        <nav aria-label="보강 화면" className={styles.nav}>
          <a href="/supplementary">루틴·수행</a>
          <a href="/supplementary/exercises">동작 라이브러리</a>
          <a href="/activities">활동 원장</a>
        </nav>
      </header>
      {route.kind === 'exercises' || route.kind === 'exercise' ? (
        <ExerciseLibrary
          api={api}
          scope={scope}
          exerciseId={route.kind === 'exercise' ? route.exerciseId : null}
        />
      ) : route.kind === 'routine' ? (
        <RoutineWorkspace api={api} scope={scope} routineId={route.routineId} />
      ) : route.kind === 'execution' ? (
        <ExecutionWorkspace api={api} scope={scope} executionId={route.executionId} />
      ) : (
        <div className={styles.stack}>
          <RoutineWorkspace api={api} scope={scope} routineId={null} />
          <ExecutionWorkspace api={api} scope={scope} executionId={null} />
        </div>
      )}
    </section>
  );
}
