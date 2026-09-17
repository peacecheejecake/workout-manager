import { describe, expect, it } from 'vitest';
import type { SessionCompletion } from '@workout/contracts/session-completion';
import {
  plannedCompletionLabel,
  type PlannedCompletionState,
} from '../src/planned-completion-state';

const report: SessionCompletion = {
  sessionId: 'saved-session',
  revision: 1,
  planVersionId: '00000000-0000-4000-8000-000000000001',
  schedule: { blockId: 'block', date: '2026-09-17', localStartTime: null, timezone: 'Asia/Seoul' },
  status: 'completed',
  reportedAt: '2026-09-17T00:00:00Z',
  reason: null,
  source: 'user',
  method: 'self_report',
  definitionVersion: 'session-completion-v1',
};
function ready(reports: SessionCompletion[] = [report]): PlannedCompletionState {
  return {
    state: 'ready',
    planVersionId: '00000000-0000-4000-8000-000000000002',
    savedSessionIds: new Set(['saved-session', 'without-report']),
    reports: new Map(reports.map((entry) => [entry.sessionId, entry])),
  };
}
describe('planned completion labels', () => {
  it.each([
    ['loading', '완료 보고 조회 중'],
    ['error', '완료 보고 조회 실패'],
    ['stale', '완료 보고 버전 불일치'],
    ['unsaved', '저장 전 세션'],
  ] as const)('keeps %s distinct from absence of a report', (state, label) => {
    expect(plannedCompletionLabel({ state }, 'saved-session')).toBe(label);
  });
  it('retains a confirmed report from an earlier plan version for the same saved session', () => {
    expect(plannedCompletionLabel(ready(), 'saved-session')).toBe('사용자 완료 확인');
  });
  it('distinguishes a retraction from a missing report', () => {
    const state = ready([{ ...report, status: 'retracted', revision: 2, reason: '사용자 정정' }]);
    expect(plannedCompletionLabel(state, 'saved-session')).toBe('완료 확인 철회');
    expect(plannedCompletionLabel(state, 'without-report')).toBe('완료 확인 기록 없음');
  });
  it('does not transfer a report to a copied unsaved ID or an unrelated saved session', () => {
    expect(plannedCompletionLabel(ready(), 'copied-session')).toBe('저장 전 세션');
    expect(plannedCompletionLabel(ready(), 'without-report')).toBe('완료 확인 기록 없음');
  });
  it('does not display an orphan report as confirmation for an unsaved session', () => {
    expect(
      plannedCompletionLabel(ready([{ ...report, sessionId: 'copied-session' }]), 'copied-session'),
    ).toBe('저장 전 세션');
  });
});
