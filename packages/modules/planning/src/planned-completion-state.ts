import type { SessionCompletion } from '@workout/contracts/session-completion';

export type PlannedCompletionState =
  | { state: 'loading' | 'error' | 'stale' | 'unsaved' }
  | {
      state: 'ready';
      planVersionId: string;
      savedSessionIds: ReadonlySet<string>;
      reports: ReadonlyMap<string, SessionCompletion>;
    };

export function plannedCompletionLabel(state: PlannedCompletionState, sessionId: string): string {
  switch (state.state) {
    case 'unsaved':
      return '저장 전 세션';
    case 'loading':
      return '완료 보고 조회 중';
    case 'error':
      return '완료 보고 조회 실패';
    case 'stale':
      return '완료 보고 버전 불일치';
    case 'ready': {
      if (!state.savedSessionIds.has(sessionId)) return '저장 전 세션';
      const report = state.reports.get(sessionId);
      if (!report) return '완료 확인 기록 없음';
      return report.status === 'completed' ? '사용자 완료 확인' : '완료 확인 철회';
    }
  }
}
