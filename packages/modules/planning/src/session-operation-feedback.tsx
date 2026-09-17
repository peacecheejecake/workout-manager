import type { PlanDraft } from '@workout/contracts/planning';
import type { SessionOperationReason, SessionOperationResult } from './session-operation';

const errors: Record<SessionOperationReason, string> = {
  invalid_draft: '초안의 입력 오류를 먼저 수정하세요. 작성 내용은 유지됩니다.',
  invalid_baseline: '기준 계획을 확인할 수 없습니다. 최신 버전을 다시 확인하세요.',
  invalid_today: '현재 날짜를 확인할 수 없어 변경하지 않았습니다.',
  missing_session: '선택한 세션이 초안에 없습니다.',
  invalid_operation: '날짜와 시간 길이 입력을 확인하세요.',
  missing_block: '날짜가 속할 Block을 선택하세요.',
  outside_block: '선택한 날짜가 해당 Block의 범위 밖입니다.',
  locked: '잠긴 날짜·Block 또는 시간 길이는 바꿀 수 없습니다. 먼저 잠금 해제를 저장하세요.',
  past_session: '이미 지난 세션은 이 이동·길이 조절 도구로 변경하지 않습니다.',
  past_date: '지난 날짜로 이동할 수 없습니다. 실제 기록 정정은 실제 활동에서 진행하세요.',
};
export type SessionOperationFeedbackValue =
  | Exclude<SessionOperationResult, { status: 'changed' }>
  | {
      status: 'changed';
      summary: Extract<SessionOperationResult, { status: 'changed' }>['summary'];
    };
export function SessionOperationFeedback({
  result,
  draft,
  actualRecordsId,
}: {
  result: SessionOperationFeedbackValue;
  draft: PlanDraft;
  actualRecordsId: string;
}) {
  if (result.status === 'unchanged')
    return <p role="status">같은 값입니다. 초안을 변경하지 않았습니다.</p>;
  if (result.status === 'rejected') {
    return (
      <div role="alert">
        <p>{errors[result.reason]}</p>
        {result.reason === 'past_session' || result.reason === 'past_date' ? (
          <a href={`#${actualRecordsId}`}>실제 활동에서 기록 확인·정정</a>
        ) : null}
      </div>
    );
  }
  const { before, after } = result.summary;
  const block = (id: string) => draft.periods.find((period) => period.id === id);
  return (
    <div role="status">
      <p>
        {draft.sessions.find((session) => session.id === result.summary.sessionId)?.title ??
          '계획 세션'}{' '}
        초안 변경 · 아직 저장하지 않았습니다. 실행 취소로 되돌릴 수 있습니다.
      </p>
      {result.summary.kind === 'move' ? (
        <p>
          날짜 {before.date} → {after.date} · Block {block(before.blockId)?.title ?? '미확인'} →{' '}
          {block(after.blockId)?.title ?? '미확인'}. 새 Block 목적:{' '}
          {block(after.blockId)?.intent || '미입력'}. 세션 목적과 시작 시각은 유지했습니다. 저장 전
          목적·제약을 검토하세요.
        </p>
      ) : (
        <p>
          시간 길이 {before.durationSeconds === null ? '미정' : `${before.durationSeconds}초`} →{' '}
          {after.durationSeconds}초. 거리와 단계별 시간은 유지했습니다. 실제 수행 기록은 변경하지
          않습니다.
        </p>
      )}
    </div>
  );
}
