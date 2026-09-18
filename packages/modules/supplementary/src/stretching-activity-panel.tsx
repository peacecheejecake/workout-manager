'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { createStretchingApi } from './stretching-api';
import styles from './supplementary.module.css';

/** Read-only projection of the same stretching detail shown in S34. */
export function StretchingActivityPanel({
  athleteId,
  sessionId,
  activityId,
  transport,
}: {
  athleteId: string;
  sessionId: string;
  activityId: string;
  transport: AuthenticatedTransport;
}) {
  const api = useMemo(() => createStretchingApi(transport), [transport]);
  const logs = useQuery({
    queryKey: ['users', athleteId, 'sessions', sessionId, 'stretching', 'logs', activityId],
    queryFn: ({ signal }) => api.listLogs(activityId, signal),
  });
  return (
    <section className={styles.card} aria-labelledby="activity-stretching-title">
      <h3 id="activity-stretching-title">스트레칭 상세</h3>
      {logs.isPending ? <p role="status">스트레칭 상세 불러오는 중</p> : null}
      {logs.isError ? <p role="alert">스트레칭 상세를 불러오지 못했습니다.</p> : null}
      {logs.data?.items.length === 0 ? <p>확인한 스트레칭 상세가 없습니다.</p> : null}
      {logs.data?.hasMore ? <p role="status">최근 상세 일부만 표시됩니다.</p> : null}
      <ul className={styles.list}>
        {logs.data?.items.map((entry) =>
          entry.status === 'active' ? (
            <li key={entry.current.logId}>
              <p>
                {entry.current.occurredAt} · {entry.current.side} · {entry.current.state}
              </p>
              <p>
                유지 {entry.current.holdSeconds ?? '미확인'}초 · 반복{' '}
                {entry.current.repetitions ?? '미확인'}회{' · '}휴식{' '}
                {entry.current.restSeconds ?? '미확인'}초
              </p>
              <p>
                {entry.current.allocation.kind === 'activity_block'
                  ? '이 Activity의 일부'
                  : '단독 수행'}
                {' · '}출처 사용자 확인 · {entry.current.comfort}
              </p>
              {entry.current.reason ? <p>중단 이유: {entry.current.reason}</p> : null}
              {entry.current.discomfortNote ? <p>불편감: {entry.current.discomfortNote}</p> : null}
            </li>
          ) : null,
        )}
      </ul>
      <p>이 상세의 유지시간은 Activity 총시간에 다시 합산하지 않습니다.</p>
      <a href={`/stretching?activityId=${encodeURIComponent(activityId)}`}>스트레칭 상세 열기</a>
    </section>
  );
}
