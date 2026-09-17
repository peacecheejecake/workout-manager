import type { CoachingThreadList } from '@workout/contracts/coaching-threads';
import styles from './coaching.module.css';
import { coachingScopeLabels } from './scope-context';
type ListState =
  { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: CoachingThreadList };
export function ThreadList({
  state,
  selectedId,
  offset,
  locked,
  onNew,
  onRetry,
  onSelect,
  onPage,
}: {
  state: ListState;
  selectedId: string | null;
  offset: number;
  locked: boolean;
  onNew(): void;
  onRetry(): void;
  onSelect(id: string): void;
  onPage(offset: number): void;
}) {
  return (
    <nav className={styles.card} aria-label="상담 목록">
      <h2>저장된 상담</h2>
      <button type="button" disabled={locked} onClick={onNew}>
        새 상담 작성
      </button>
      {state.kind === 'loading' ? (
        <p role="status">상담 목록 조회 중</p>
      ) : state.kind === 'error' ? (
        <p role="alert">
          상담 목록 조회 실패{' '}
          <button type="button" onClick={onRetry}>
            상담 목록 다시 확인
          </button>
        </p>
      ) : (
        <>
          <p>
            전체 {state.data.total}개 · 현재 {state.data.items.length}개
          </p>
          <ul>
            {state.data.items.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  disabled={locked}
                  aria-pressed={selectedId === thread.id}
                  onClick={() => onSelect(thread.id)}
                >
                  {thread.title}
                </button>
                <p>
                  {coachingScopeLabels[thread.scope.kind]} · 사용자 기록 {thread.revision}
                </p>
              </li>
            ))}
          </ul>
          {state.data.total === 0 ? <p>저장된 상담이 없습니다.</p> : null}
          <div className={styles.actions}>
            <button
              type="button"
              disabled={locked || offset === 0}
              onClick={() => onPage(Math.max(0, offset - 20))}
            >
              이전 상담
            </button>
            <button
              type="button"
              disabled={locked || offset + 20 >= state.data.total || offset + 20 > 10000}
              onClick={() => onPage(offset + 20)}
            >
              다음 상담
            </button>
          </div>
        </>
      )}
    </nav>
  );
}
