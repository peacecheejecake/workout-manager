import type { ReactNode } from 'react';
import styles from './controls.module.css';

export type NoticeState =
  'loading' | 'empty' | 'partial' | 'error' | 'stale' | 'unavailable' | 'sync-pending';
const labels: Record<NoticeState, string> = {
  loading: '불러오는 중',
  empty: '기록 없음',
  partial: '일부 데이터',
  error: '오류',
  stale: '새 데이터로 재검토',
  unavailable: '사용 불가',
  'sync-pending': '동기화 대기',
};

export function StatusNotice({
  state,
  children,
  action,
}: {
  state: NoticeState;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.notice} data-state={state}>
      <div role={state === 'error' ? 'alert' : 'status'}>
        <strong>{labels[state]}</strong>
        <div>{children}</div>
      </div>
      {action}
    </div>
  );
}
